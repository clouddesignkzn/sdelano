"""WSGI-приложение «Сделано».

Сайт статический, поэтому сервер устроен максимально просто и строго:
  * при старте все файлы из public/ читаются в память по белому списку расширений;
    запрос ищется в словаре, файловая система во время работы не трогается,
    обход путей (../, %2e%2e, обратные слэши) невозможен в принципе;
  * если задан SDELANO_TRUSTED_PROXY, соединения принимаются только от прокси и с этого компьютера;
  * разрешены только GET и HEAD;
  * заголовок Host проверяется (защита от DNS rebinding и подмены хоста);
  * www.<домен> перенаправляется на основной домен;
  * на каждый ответ, включая ошибки, ставятся заголовки безопасности;
  * поддерживаются ETag/304 и gzip.
"""
from __future__ import annotations

import gzip
import hashlib
import html
import json
import ipaddress
import logging
from dataclasses import dataclass
from pathlib import Path

from .config import VERSION, Config, normalize_host
from .security import security_headers

log = logging.getLogger('sdelano')

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
}
COMPRESSIBLE = {'.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt', '.xml'}
PLACEHOLDER_FILES = {'.html', '.txt', '.xml'}
NO_CACHE = 'no-cache'
LONG_CACHE = 'public, max-age=2592000'  # 30 дней: шрифты и иконки
MAX_PATH = 256
MAX_FILES = 500
MAX_TOTAL_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class Entry:
    body: bytes
    gz: bytes | None
    content_type: str
    etag: str
    cache: str


def _etag(data: bytes, suffix: str = '') -> str:
    return '"' + hashlib.sha256(data).hexdigest()[:24] + suffix + '"'


def load_files(public_dir: Path, public_url: str) -> dict[str, Entry]:
    """Читает публичные файлы в память. Скрытые файлы и неизвестные типы пропускаются."""
    root = public_dir.resolve()
    if not root.is_dir():
        raise RuntimeError(f'Папка с сайтом не найдена: {root}')
    files: dict[str, Entry] = {}
    total = 0
    safe_url = html.escape(public_url, quote=True).encode('utf-8')
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(part.startswith('.') for part in rel.parts) or not path.is_file() or path.is_symlink():
            continue
        ext = path.suffix.lower()
        if ext not in CONTENT_TYPES:
            continue
        if path.resolve().parent != root and root not in path.resolve().parents:
            continue  # на всякий случай: ссылка за пределы папки
        data = path.read_bytes()
        if ext in PLACEHOLDER_FILES:
            data = data.replace(b'__PUBLIC_URL__', safe_url)
        total += len(data)
        if len(files) >= MAX_FILES or total > MAX_TOTAL_BYTES:
            raise RuntimeError('Слишком много файлов в public/: проверьте, что туда не попало лишнее')
        gz = gzip.compress(data, compresslevel=9, mtime=0) if ext in COMPRESSIBLE and len(data) > 1024 else None
        if gz is not None and len(gz) >= len(data):
            gz = None
        cache = LONG_CACHE if rel.parts[:2] in (('assets', 'fonts'), ('assets', 'icons')) else NO_CACHE
        files['/' + rel.as_posix()] = Entry(data, gz, CONTENT_TYPES[ext], _etag(data), cache)
    if '/index.html' not in files:
        raise RuntimeError('В public/ нет index.html')
    files['/'] = files['/index.html']
    return files


def _etag_matches(header: str, etag: str) -> bool:
    if not header:
        return False
    if header.strip() == '*':
        return True
    candidates = {tag.strip().removeprefix('W/') for tag in header.split(',')}
    return etag in candidates


class SdelanoApp:
    def __init__(self, config: Config):
        self.config = config
        self.files = load_files(config.public_dir, config.public_url)
        self.base_headers = security_headers(config.hsts)
        self.not_found = self.files.get('/404.html')
        self.health_body = json.dumps({'status': 'ok', 'service': 'sdelano', 'version': VERSION}).encode()

    # ── вспомогательное ──
    def _respond(self, start_response, status: str, body: bytes, headers: list[tuple[str, str]], head: bool):
        out = [*self.base_headers, *headers, ('Content-Length', str(len(body)))]
        start_response(status, out)
        return [b''] if head else [body]

    def _plain(self, start_response, status: str, text: str, head: bool, extra=()):
        body = text.encode('utf-8')
        return self._respond(
            start_response, status, body,
            [('Content-Type', 'text/plain; charset=utf-8'), ('Cache-Control', 'no-store'), *extra], head,
        )

    # ── WSGI ──
    def __call__(self, environ, start_response):
        method = environ.get('REQUEST_METHOD', 'GET')
        head = method == 'HEAD'
        try:
            return self._handle(environ, start_response, method, head)
        except Exception:  # noqa: BLE001 последняя линия обороны: без трассировок наружу
            log.exception('Необработанная ошибка при запросе %s', environ.get('PATH_INFO', '')[:MAX_PATH])
            return self._plain(start_response, '500 Internal Server Error', 'Внутренняя ошибка сервера', head)

    def _client_allowed(self, environ) -> bool:
        if not self.config.trusted_proxies:
            return True
        try:
            addr = ipaddress.ip_address(environ.get('REMOTE_ADDR', ''))
        except ValueError:
            return False
        if addr.is_loopback:
            return True
        if getattr(addr, 'ipv4_mapped', None):
            addr = addr.ipv4_mapped
        return str(addr) in self.config.trusted_proxies

    def _handle(self, environ, start_response, method: str, head: bool):
        if not self._client_allowed(environ):
            return self._plain(start_response, '403 Forbidden', 'Доступ только через прокси', head)
        if method not in ('GET', 'HEAD'):
            return self._plain(start_response, '405 Method Not Allowed', 'Метод не поддерживается', head, [('Allow', 'GET, HEAD')])

        host = normalize_host(environ.get('HTTP_HOST', ''))
        if not host or host not in self.config.allowed_hosts:
            return self._plain(start_response, '421 Misdirected Request', 'Неизвестный адрес сайта', head)

        path = environ.get('PATH_INFO') or '/'
        if len(path) > MAX_PATH:
            return self._plain(start_response, '414 URI Too Long', 'Слишком длинный адрес', head)

        if self.config.www_host and host == self.config.www_host:
            target = path if path in self.files else '/'
            return self._respond(
                start_response, '301 Moved Permanently', b'',
                [('Location', self.config.public_url + target), ('Cache-Control', 'public, max-age=3600')], head,
            )

        if path == '/health':
            return self._respond(
                start_response, '200 OK', self.health_body,
                [('Content-Type', 'application/json; charset=utf-8'), ('Cache-Control', 'no-store')], head,
            )

        entry = self.files.get(path)
        if entry is None or path == '/404.html':
            if self.not_found is not None:
                return self._respond(
                    start_response, '404 Not Found', self.not_found.body,
                    [('Content-Type', self.not_found.content_type), ('Cache-Control', 'no-store'),
                     ('X-Robots-Tag', 'noindex')], head,
                )
            return self._plain(start_response, '404 Not Found', 'Страница не найдена', head)

        use_gzip = entry.gz is not None and 'gzip' in environ.get('HTTP_ACCEPT_ENCODING', '').lower()
        body = entry.gz if use_gzip else entry.body
        etag = entry.etag[:-1] + '-gz"' if use_gzip else entry.etag
        headers = [('Content-Type', entry.content_type), ('Cache-Control', entry.cache), ('ETag', etag)]
        if entry.gz is not None:
            headers.append(('Vary', 'Accept-Encoding'))
        if use_gzip:
            headers.append(('Content-Encoding', 'gzip'))
        if path.endswith('/sw.js'):
            headers.append(('Service-Worker-Allowed', '/'))

        if _etag_matches(environ.get('HTTP_IF_NONE_MATCH', ''), etag):
            out = [*self.base_headers, *headers]
            start_response('304 Not Modified', out)
            return [b'']
        return self._respond(start_response, '200 OK', body, headers, head)


def create_app(config: Config) -> SdelanoApp:
    return SdelanoApp(config)
