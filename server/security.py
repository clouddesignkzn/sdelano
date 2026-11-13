"""HTTP-заголовки безопасности. Единственный источник правды для сервера.

CSP в <meta> страницы (public/index.html) обязан совпадать с этой политикой
без директив, которые в meta не работают; это проверяет tests/test_server.py.
"""
from __future__ import annotations

CSP_DIRECTIVES = (
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types sdelano-sw',
)
# Директивы, которые браузер игнорирует в <meta> и понимает только в заголовке.
HEADER_ONLY_DIRECTIVES = frozenset({"frame-ancestors 'none'"})

CONTENT_SECURITY_POLICY = '; '.join(CSP_DIRECTIVES)

PERMISSIONS_POLICY = ', '.join(
    f'{feature}=()'
    for feature in (
        'accelerometer', 'autoplay', 'camera', 'display-capture', 'encrypted-media',
        'fullscreen', 'geolocation', 'gyroscope', 'hid', 'magnetometer', 'microphone', 'midi',
        'payment', 'picture-in-picture', 'publickey-credentials-get', 'screen-wake-lock',
        'serial', 'usb', 'xr-spatial-tracking',
    )
)

BASE_HEADERS = (
    ('Content-Security-Policy', CONTENT_SECURITY_POLICY),
    ('X-Content-Type-Options', 'nosniff'),
    ('X-Frame-Options', 'DENY'),
    ('Referrer-Policy', 'no-referrer'),
    ('Permissions-Policy', PERMISSIONS_POLICY),
    ('Cross-Origin-Opener-Policy', 'same-origin'),
    ('Cross-Origin-Resource-Policy', 'same-origin'),
    ('Cross-Origin-Embedder-Policy', 'require-corp'),
    ('Origin-Agent-Cluster', '?1'),
    ('X-Permitted-Cross-Domain-Policies', 'none'),
    ('X-DNS-Prefetch-Control', 'off'),
)

HSTS_HEADER = ('Strict-Transport-Security', 'max-age=31536000')


def security_headers(hsts: bool) -> list[tuple[str, str]]:
    headers = list(BASE_HEADERS)
    if hsts:
        headers.append(HSTS_HEADER)
    return headers
