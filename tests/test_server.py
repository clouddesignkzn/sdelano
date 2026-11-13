"""Тесты сервера и статические проверки безопасности.

Запуск: python -m unittest discover -s tests -v   (или 06_RUN_TESTS.bat)
Нужен только Python и waitress из requirements.txt.
"""
from __future__ import annotations

import gzip
import http.client
import json
import re
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.app import create_app  # noqa: E402
from server.config import ConfigError, load_config, normalize_host  # noqa: E402
from server.security import CONTENT_SECURITY_POLICY, CSP_DIRECTIVES, HEADER_ONLY_DIRECTIVES  # noqa: E402

PUBLIC = ROOT / 'public'


def call(app, path='/', method='GET', host='hvostdoc.online', remote='127.0.0.1', **headers):
    """Вызывает WSGI-приложение без сети и возвращает (код, заголовки, тело)."""
    environ = {
        'REQUEST_METHOD': method,
        'PATH_INFO': path,
        'QUERY_STRING': '',
        'SERVER_NAME': 'test',
        'SERVER_PORT': '80',
        'wsgi.url_scheme': 'http',
        'REMOTE_ADDR': remote,
    }
    if host is not None:
        environ['HTTP_HOST'] = host
    for key, value in headers.items():
        environ['HTTP_' + key.upper()] = value
    captured = {}

    def start_response(status, response_headers):
        captured['status'] = int(status.split()[0])
        captured['headers'] = {k.lower(): v for k, v in response_headers}

    body = b''.join(app(environ, start_response))
    return captured['status'], captured['headers'], body


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        cfg = load_config({})
        self.assertEqual(cfg.host, '127.0.0.1')
        self.assertEqual(cfg.port, 47391)
        self.assertEqual(cfg.public_url, 'https://hvostdoc.online')
        self.assertEqual(cfg.www_host, 'www.hvostdoc.online')
        self.assertTrue({'hvostdoc.online', 'www.hvostdoc.online', 'localhost', '127.0.0.1'} <= cfg.allowed_hosts)

    def test_custom_values(self):
        cfg = load_config({'SDELANO_PORT': '41000', 'SDELANO_HOST': '0.0.0.0', 'SDELANO_PUBLIC_URL': 'https://Example.ru/',
                           'SDELANO_EXTRA_HOSTS': 'todo.lan, 192.168.1.20', 'SDELANO_HSTS': '0'})
        self.assertEqual(cfg.port, 41000)
        self.assertEqual(cfg.public_url, 'https://Example.ru')
        self.assertIn('example.ru', cfg.allowed_hosts)
        self.assertIn('todo.lan', cfg.allowed_hosts)
        self.assertFalse(cfg.hsts)
        self.assertEqual(cfg.connect_host, '127.0.0.1')

    def test_invalid_values_are_rejected(self):
        bad = [
            {'SDELANO_PORT': '80'}, {'SDELANO_PORT': 'abc'}, {'SDELANO_PORT': '70000'},
            {'SDELANO_HOST': 'example.com'}, {'SDELANO_PUBLIC_URL': 'ftp://x.ru'},
            {'SDELANO_PUBLIC_URL': 'https://x.ru/path'}, {'SDELANO_PUBLIC_URL': 'https://user@x.ru'},
            {'SDELANO_PUBLIC_URL': 'https://bad_host!.ru'}, {'SDELANO_EXTRA_HOSTS': 'a b'},
            {'SDELANO_HSTS': 'maybe'}, {'SDELANO_THREADS': '0'},
        ]
        for env in bad:
            with self.subTest(env=env), self.assertRaises(ConfigError):
                load_config(env)

    def test_normalize_host(self):
        self.assertEqual(normalize_host('HvostDoc.Online:443'), 'hvostdoc.online')
        self.assertEqual(normalize_host('[::1]:8080'), '::1')
        self.assertEqual(normalize_host('example.ru.'), 'example.ru')


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app(load_config({}))

    def test_index_with_security_headers(self):
        status, headers, body = call(self.app, '/')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'text/html; charset=utf-8')
        self.assertEqual(headers['content-security-policy'], CONTENT_SECURITY_POLICY)
        for name in ('x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy',
                     'cross-origin-opener-policy', 'cross-origin-resource-policy', 'strict-transport-security'):
            self.assertIn(name, headers)
        self.assertNotIn('server', headers)
        self.assertIn(b'https://hvostdoc.online/assets/icons/og-image.png', body)
        self.assertNotIn(b'__PUBLIC_URL__', body)

    def test_head_has_no_body(self):
        status, headers, body = call(self.app, '/', method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertGreater(int(headers['content-length']), 1000)

    def test_only_get_and_head(self):
        for method in ('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT'):
            status, headers, _ = call(self.app, '/', method=method)
            self.assertEqual(status, 405, method)
            self.assertEqual(headers['allow'], 'GET, HEAD')

    def test_host_header_is_checked(self):
        for host in ('evil.example', 'hvostdoc.online.evil.com', '', None, '1.2.3.4'):
            status, headers, _ = call(self.app, '/', host=host)
            self.assertEqual(status, 421, host)
            self.assertIn('content-security-policy', headers, 'заголовки безопасности и на ошибках')
        for host in ('hvostdoc.online', 'HVOSTDOC.ONLINE:443', 'localhost:47391', '127.0.0.1'):
            self.assertEqual(call(self.app, '/', host=host)[0], 200, host)

    def test_www_redirects_to_main_domain(self):
        status, headers, _ = call(self.app, '/assets/css/app.css', host='www.hvostdoc.online')
        self.assertEqual(status, 301)
        self.assertEqual(headers['location'], 'https://hvostdoc.online/assets/css/app.css')
        status, headers, _ = call(self.app, '/unknown//evil.com', host='www.hvostdoc.online')
        self.assertEqual(headers['location'], 'https://hvostdoc.online/', 'неизвестный путь не попадает в Location')

    def test_health(self):
        status, headers, body = call(self.app, '/health')
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(body)['service'], 'sdelano')

    def test_not_found_page(self):
        status, headers, body = call(self.app, '/nope')
        self.assertEqual(status, 404)
        self.assertEqual(headers['x-robots-tag'], 'noindex')
        self.assertIn('Такой страницы нет'.encode(), body)
        self.assertEqual(call(self.app, '/404.html')[0], 404)

    def test_files_outside_public_are_unreachable(self):
        attacks = [
            '/../launcher.py', '/..%2flauncher.py', '/%2e%2e/VERSION.txt', '/../../etc/passwd', '/server/app.py',
            '/launcher.py', '/requirements.txt', '/local_config.bat', '/data/server.json', '/.git/config',
            '/assets/../../launcher.py', '/assets\\..\\launcher.py', '/index.html%00.png', '/C:/Windows/win.ini',
        ]
        for path in attacks:
            self.assertEqual(call(self.app, path)[0], 404, path)

    def test_long_path(self):
        self.assertEqual(call(self.app, '/' + 'a' * 300)[0], 414)

    def test_etag_and_304(self):
        _, headers, _ = call(self.app, '/assets/js/app.js')
        etag = headers['etag']
        status, headers304, body = call(self.app, '/assets/js/app.js', if_none_match=etag)
        self.assertEqual(status, 304)
        self.assertEqual(body, b'')
        self.assertIn('content-security-policy', headers304)
        self.assertEqual(call(self.app, '/assets/js/app.js', if_none_match='"other"')[0], 200)

    def test_gzip(self):
        _, plain_headers, plain = call(self.app, '/assets/js/app.js')
        _, headers, body = call(self.app, '/assets/js/app.js', accept_encoding='gzip, br')
        self.assertEqual(headers['content-encoding'], 'gzip')
        self.assertEqual(headers['vary'], 'Accept-Encoding')
        self.assertEqual(gzip.decompress(body), plain)
        self.assertNotEqual(headers['etag'], plain_headers['etag'])

    def test_cache_policy(self):
        self.assertEqual(call(self.app, '/')[1]['cache-control'], 'no-cache')
        self.assertEqual(call(self.app, '/sw.js')[1]['cache-control'], 'no-cache')
        self.assertIn('max-age', call(self.app, '/assets/fonts/inter-regular.woff')[1]['cache-control'])

    def test_content_types(self):
        expected = {
            '/assets/css/app.css': 'text/css; charset=utf-8',
            '/assets/js/app.js': 'text/javascript; charset=utf-8',
            '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
            '/favicon.svg': 'image/svg+xml',
            '/assets/fonts/inter-regular.woff': 'font/woff',
            '/robots.txt': 'text/plain; charset=utf-8',
            '/sitemap.xml': 'application/xml; charset=utf-8',
        }
        for path, ctype in expected.items():
            status, headers, _ = call(self.app, path)
            self.assertEqual((status, headers['content-type']), (200, ctype), path)

    def test_trusted_proxy_only(self):
        app = create_app(load_config({'SDELANO_HOST': '0.0.0.0', 'SDELANO_TRUSTED_PROXY': '192.168.1.10'}))
        self.assertEqual(call(app, '/', remote='192.168.1.10')[0], 200, 'прокси пускаем')
        self.assertEqual(call(app, '/', remote='127.0.0.1')[0], 200, 'этот компьютер пускаем')
        self.assertEqual(call(app, '/', remote='::ffff:192.168.1.10')[0], 200, 'IPv4 в IPv6-записи')
        for other in ('192.168.1.77', '8.8.8.8', '', 'garbage'):
            status, headers, _ = call(app, '/', remote=other)
            self.assertEqual(status, 403, other)
            self.assertIn('content-security-policy', headers)
        self.assertEqual(call(self.app, '/', remote='8.8.8.8')[0], 200, 'без настройки ограничения нет')
        with self.assertRaises(ConfigError):
            load_config({'SDELANO_TRUSTED_PROXY': 'npm.local'})

    def test_hsts_can_be_disabled(self):
        app = create_app(load_config({'SDELANO_HSTS': '0'}))
        self.assertNotIn('strict-transport-security', call(app, '/')[1])


class LiveServerTest(unittest.TestCase):
    """Настоящий waitress на случайном порту: как его запускает launcher.py."""

    def test_real_http(self):
        from waitress.server import create_server

        app = create_app(load_config({}))
        server = create_server(app, host='127.0.0.1', port=0, ident='', clear_untrusted_proxy_headers=True)
        port = server.effective_port
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            conn.request('GET', '/', headers={'Host': 'hvostdoc.online'})
            resp = conn.getresponse()
            body = resp.read()
            self.assertEqual(resp.status, 200)
            self.assertIsNone(resp.getheader('Server'), 'версия сервера не раскрывается')
            self.assertIn('Сделано'.encode(), body)
            conn.request('GET', '/', headers={'Host': 'attacker.example'})
            self.assertEqual(conn.getresponse().status, 421)
            conn.close()
        finally:
            server.close()


class StaticChecks(unittest.TestCase):
    """«Сторожа»: конфигурация согласована, опасные приёмы в код не попали."""

    html = (PUBLIC / 'index.html').read_text(encoding='utf-8')

    def test_meta_csp_matches_header(self):
        meta = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', self.html).group(1)
        meta_set = {d.strip() for d in meta.split(';') if d.strip()}
        self.assertEqual(meta_set, set(CSP_DIRECTIVES) - HEADER_ONLY_DIRECTIVES)

    def test_no_dangerous_sinks_in_client_code(self):
        banned = re.compile(r'\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function\s*\(|setTimeout\s*\(\s*[\'"`])')
        for path in [*(PUBLIC / 'assets' / 'js').glob('*.js'), PUBLIC / 'sw.js']:
            code = re.sub(r'/\*.*?\*/', '', path.read_text(encoding='utf-8'), flags=re.S)
            code = re.sub(r'^\s*//.*$', '', code, flags=re.M)
            self.assertIsNone(banned.search(code), path.name)

    def test_no_inline_scripts_styles_or_handlers(self):
        for path in PUBLIC.glob('*.html'):
            text = path.read_text(encoding='utf-8')
            self.assertIsNone(re.search(r'<script(?![^>]*\bsrc=)[^>]*>', text), path.name)
            self.assertNotIn(' style="', text, path.name)
            self.assertIsNone(re.search(r'\son[a-z]+="', text), path.name)

    def test_no_external_resources(self):
        for path in [*PUBLIC.glob('*.html'), *(PUBLIC / 'assets' / 'css').glob('*.css')]:
            text = path.read_text(encoding='utf-8')
            for url in re.findall(r'(?:src|href)="(https?:[^"]+)"|url\([\'"]?(https?:[^)\'"]+)', text):
                link = next(u for u in url if u)
                self.assertTrue(link.startswith('__PUBLIC_URL__'), f'{path.name}: внешний ресурс {link}')

    def test_precache_files_exist(self):
        sw = (PUBLIC / 'sw.js').read_text(encoding='utf-8')
        for rel in re.findall(r"'\./([^']+)'", sw):
            self.assertTrue((PUBLIC / rel).is_file(), rel)

    def test_no_long_dashes_in_interface_text(self):
        for path in [*PUBLIC.glob('*.html'), *(PUBLIC / 'assets' / 'js').glob('*.js')]:
            self.assertNotIn('\u2014', path.read_text(encoding='utf-8'), path.name)

    def test_bat_files_use_crlf(self):
        for path in [*ROOT.glob('*.bat'), *(ROOT / 'tools').glob('*.bat'), *(ROOT / 'tools').glob('*.cmd'), *(ROOT / 'tools').glob('*.ps1')]:
            data = path.read_bytes()
            self.assertEqual(data.count(b'\n'), data.count(b'\r\n'), f'{path.name}: нужны окончания строк CRLF')

    def test_background_server_has_no_console_window(self):
        launcher = (ROOT / 'launcher.py').read_text(encoding='utf-8')
        self.assertIn('pythonw.exe', launcher)
        self.assertIn('CREATE_NO_WINDOW', launcher)
        self.assertNotIn('DETACHED_PROCESS', launcher, 'с ним venv-python открывает лишнее окно консоли')

    def test_requirements_are_hash_pinned(self):
        req = (ROOT / 'requirements.txt').read_text(encoding='utf-8')
        self.assertIn('waitress==', req)
        self.assertGreaterEqual(req.count('--hash=sha256:'), 2)


if __name__ == '__main__':
    unittest.main()
