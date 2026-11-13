"""Настройки сервера из переменных окружения SDELANO_*.

Все значения проверяются при старте: с неверной настройкой сервер не запустится
и объяснит, что не так, вместо того чтобы молча работать небезопасно.
"""
from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / 'public'
DATA_DIR = ROOT / 'data'
VERSION = (ROOT / 'VERSION.txt').read_text(encoding='utf-8').strip() if (ROOT / 'VERSION.txt').exists() else '0.0.0'

DEFAULT_PORT = 47391  # нестандартный порт: обычные 80/443/8000/8080 чаще всего заняты
DEFAULT_PUBLIC_URL = 'https://hvostdoc.online'

_HOSTNAME_RE = re.compile(r'^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$')


class ConfigError(ValueError):
    """Ошибка в настройках, понятная человеку."""


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def normalize_host(value: str) -> str:
    """Имя хоста в нижнем регистре, без порта и квадратных скобок IPv6."""
    host = value.strip().lower()
    if host.startswith('['):
        end = host.find(']')
        return host[1:end] if end != -1 else ''
    if host.count(':') == 1:
        host = host.split(':', 1)[0]
    return host.rstrip('.')


def _valid_host(host: str) -> bool:
    return bool(host) and (_is_ip(host) or bool(_HOSTNAME_RE.match(host)))


@dataclass(frozen=True)
class Config:
    host: str = '127.0.0.1'
    port: int = DEFAULT_PORT
    public_url: str = DEFAULT_PUBLIC_URL
    extra_hosts: tuple[str, ...] = ()
    hsts: bool = True
    threads: int = 8
    trusted_proxies: frozenset[str] = frozenset()
    public_dir: Path = PUBLIC_DIR
    allowed_hosts: frozenset[str] = field(default=frozenset(), compare=False)

    @property
    def public_host(self) -> str:
        return normalize_host(urlsplit(self.public_url).netloc)

    @property
    def www_host(self) -> str | None:
        host = self.public_host
        if _is_ip(host) or host.startswith('www.') or host in ('localhost',):
            return None
        return f'www.{host}'

    @property
    def connect_host(self) -> str:
        """Адрес, по которому до сервера можно достучаться с этого же компьютера."""
        if self.host in ('0.0.0.0', ''):
            return '127.0.0.1'
        if self.host == '::':
            return '::1'
        return self.host

    @property
    def local_url(self) -> str:
        h = self.connect_host
        return f'http://[{h}]:{self.port}' if ':' in h else f'http://{h}:{self.port}'


def _env_bool(env, name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or raw.strip() == '':
        return default
    value = raw.strip().lower()
    if value in ('1', 'true', 'yes', 'on', 'да'):
        return True
    if value in ('0', 'false', 'no', 'off', 'нет'):
        return False
    raise ConfigError(f'{name}: ожидается 1 или 0, получено «{raw}»')


def _env_int(env, name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == '':
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        raise ConfigError(f'{name}: ожидается число, получено «{raw}»') from None
    if not lo <= value <= hi:
        raise ConfigError(f'{name}: допустимо от {lo} до {hi}, получено {value}')
    return value


def load_config(env=None, public_dir: Path | None = None) -> Config:
    env = os.environ if env is None else env

    host = (env.get('SDELANO_HOST') or '127.0.0.1').strip()
    if host not in ('0.0.0.0', '::') and not _is_ip(host) and host != 'localhost':
        raise ConfigError(f'SDELANO_HOST: укажите IP-адрес (например 127.0.0.1 или 0.0.0.0), получено «{host}»')

    port = _env_int(env, 'SDELANO_PORT', DEFAULT_PORT, 1024, 65535)

    public_url = (env.get('SDELANO_PUBLIC_URL') or DEFAULT_PUBLIC_URL).strip().rstrip('/')
    parts = urlsplit(public_url)
    if parts.scheme not in ('http', 'https') or not parts.netloc or parts.path or parts.query or parts.fragment or '@' in parts.netloc:
        raise ConfigError(f'SDELANO_PUBLIC_URL: ожидается адрес вида https://example.ru, получено «{public_url}»')
    if not _valid_host(normalize_host(parts.netloc)):
        raise ConfigError(f'SDELANO_PUBLIC_URL: некорректное имя домена в «{public_url}»')

    extra = []
    for item in (env.get('SDELANO_EXTRA_HOSTS') or '').split(','):
        item = normalize_host(item)
        if not item:
            continue
        if not _valid_host(item):
            raise ConfigError(f'SDELANO_EXTRA_HOSTS: некорректное имя «{item}»')
        extra.append(item)

    proxies = set()
    for item in (env.get('SDELANO_TRUSTED_PROXY') or '').split(','):
        item = item.strip()
        if not item:
            continue
        if not _is_ip(item):
            raise ConfigError(f'SDELANO_TRUSTED_PROXY: ожидается IP-адрес, получено «{item}»')
        proxies.add(str(ipaddress.ip_address(item)))

    cfg = Config(
        host=host,
        port=port,
        public_url=public_url,
        extra_hosts=tuple(extra),
        hsts=_env_bool(env, 'SDELANO_HSTS', True),
        threads=_env_int(env, 'SDELANO_THREADS', 8, 1, 64),
        trusted_proxies=frozenset(proxies),
        public_dir=public_dir or PUBLIC_DIR,
    )

    allowed = {cfg.public_host, 'localhost', '127.0.0.1', '::1', *cfg.extra_hosts}
    if cfg.www_host:
        allowed.add(cfg.www_host)
    if cfg.host not in ('0.0.0.0', '::', 'localhost'):
        allowed.add(cfg.host)
    return Config(**{**cfg.__dict__, 'allowed_hosts': frozenset(allowed)})
