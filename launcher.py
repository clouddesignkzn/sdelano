"""Управление сервером «Сделано».

    python launcher.py start [--no-browser]   запустить в фоне и дождаться готовности
    python launcher.py stop                   остановить
    python launcher.py restart                перезапустить
    python launcher.py status                 показать состояние
    python launcher.py check                  проверить окружение перед запуском
    python launcher.py --serve                работать в текущем окне (так запускает автозапуск)

Останавливается только процесс этой установки: его PID берётся из data/server.json
и дополнительно сверяется командная строка процесса. Чужие программы не трогаются.
Работает на Windows (основная платформа) и на Linux/macOS (CI и разработка).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from server.config import DATA_DIR, VERSION, ConfigError, load_config  # noqa: E402

STATE_FILE = DATA_DIR / 'server.json'
LOG_DIR = DATA_DIR / 'logs'
TASK_NAME = 'Sdelano Web'
IS_WINDOWS = os.name == 'nt'
LAUNCHER = str(ROOT / 'launcher.py')


def say(text: str = '') -> None:
    print(text, flush=True)


# ───────────── Состояние ─────────────

def read_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(data: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    for _ in range(50):  # на Windows файл может быть кратко занят антивирусом
        try:
            os.replace(tmp, STATE_FILE)
            return
        except PermissionError:
            time.sleep(0.1)


def clear_state(pid: int | None = None) -> None:
    state = read_state()
    if pid is not None and state.get('pid') not in (None, pid):
        return
    try:
        STATE_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# ───────────── Проверки ─────────────

def health(cfg, timeout: float = 1.5) -> dict | None:
    try:
        req = urllib.request.Request(cfg.local_url + '/health', headers={'User-Agent': 'sdelano-launcher'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 только локальный адрес
            data = json.load(resp)
            return data if data.get('service') == 'sdelano' else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def port_free(cfg) -> bool:
    family = socket.AF_INET6 if ':' in cfg.host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        if not IS_WINDOWS:
            # Как и waitress: соединения в TIME_WAIT после остановки не должны считаться «занятым портом».
            # На Windows этот флаг означает другое (разрешает перехват порта), поэтому там его не ставим.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((cfg.host, cfg.port))
            return True
        except OSError:
            return False


def process_cmdline(pid: int) -> str:
    """Командная строка процесса или пустая строка, если процесса нет."""
    if pid <= 0:
        return ''
    if IS_WINDOWS:
        ps = f'(Get-CimInstance Win32_Process -Filter "ProcessId={int(pid)}").CommandLine'
        try:
            out = subprocess.run(
                ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
                capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return out.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ''
    try:
        return Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
    except OSError:
        try:
            out = subprocess.run(['ps', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True, timeout=5)
            return out.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ''


def is_our_server(pid: int) -> bool:
    cmd = process_cmdline(pid).lower().replace('\\', '/')
    return bool(cmd) and '--serve' in cmd and LAUNCHER.lower().replace('\\', '/') in cmd


def pid_on_port(cfg) -> int | None:
    """PID процесса, слушающего наш порт (только Windows; нужен, если state-файл потерян)."""
    if not IS_WINDOWS:
        return None
    ps = f'(Get-NetTCPConnection -LocalPort {int(cfg.port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess'
    try:
        out = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps],
            capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        value = out.stdout.strip()
        return int(value) if value.isdigit() else None
    except (OSError, subprocess.SubprocessError):
        return None


# ───────────── Автозапуск (Планировщик Windows) ─────────────

def task_exists() -> bool:
    if not IS_WINDOWS:
        return False
    try:
        out = subprocess.run(['schtasks', '/query', '/tn', TASK_NAME], capture_output=True, timeout=15,
                             creationflags=subprocess.CREATE_NO_WINDOW)
        return out.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def schtasks(action: str) -> bool:
    try:
        out = subprocess.run(['schtasks', f'/{action}', '/tn', TASK_NAME], capture_output=True, text=True, timeout=30,
                             creationflags=subprocess.CREATE_NO_WINDOW)
        return out.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ───────────── Команды ─────────────

def wait_healthy(cfg, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if health(cfg):
            return True
        time.sleep(0.4)
    return False


def explain_busy_port(cfg) -> None:
    say(f'[ОШИБКА] Порт {cfg.port} занят другой программой.')
    say('  Выберите другой порт: откройте local_config.bat и измените строку')
    say('      set "SDELANO_PORT=47391"')
    say('  на свободный номер от 20000 до 48000, затем запустите 02_START.bat снова.')
    say('  Не забудьте указать тот же порт в Nginx Proxy Manager.')
    if IS_WINDOWS:
        say('  Порты, зарезервированные Windows: netsh int ipv4 show excludedportrange protocol=tcp')


def background_python() -> str:
    """Интерпретатор для фонового сервера: на Windows без консольного окна."""
    if IS_WINDOWS:
        windowless = Path(sys.executable).with_name('pythonw.exe')
        if windowless.exists():
            return str(windowless)
    return sys.executable


def cmd_start(cfg, open_browser: bool) -> int:
    if health(cfg):
        say(f'[OK] Сайт уже работает: {cfg.local_url}')
        return 0

    if task_exists():
        say('Включён автозапуск: запускаю через Планировщик заданий...')
        if not schtasks('run'):
            say('[ОШИБКА] Не удалось запустить задание. Запустите 02_START.bat от имени администратора.')
            return 3
    else:
        if not port_free(cfg):
            explain_busy_port(cfg)
            return 2
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_file = open(LOG_DIR / 'server-console.log', 'ab')  # noqa: SIM115 передаётся дочернему процессу
        kwargs: dict = {'stdin': subprocess.DEVNULL, 'stdout': log_file, 'stderr': log_file, 'cwd': str(ROOT), 'close_fds': True}
        if IS_WINDOWS:
            # python.exe из .venv на Windows лишь перезапускает основной интерпретатор, и тот
            # открывает собственное консольное окно: закрыв его, человек случайно гасил сайт.
            # pythonw.exe работает без консоли, а CREATE_NO_WINDOW страхует, если его нет.
            kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kwargs['start_new_session'] = True
        subprocess.Popen([background_python(), LAUNCHER, '--serve'], **kwargs)  # noqa: S603 собственный скрипт
        log_file.close()

    if not wait_healthy(cfg, 25):
        say('[ОШИБКА] Сайт не ответил за 25 секунд.')
        say(f'  Подробности: {LOG_DIR / "server.log"} и {LOG_DIR / "server-console.log"}')
        return 1
    say(f'[OK] Сайт запущен: {cfg.local_url}')
    say(f'     Публичный адрес (через Nginx Proxy Manager): {cfg.public_url}')
    if open_browser:
        try:
            webbrowser.open(cfg.local_url)
        except Exception:  # noqa: BLE001 браузер не обязателен
            pass
    return 0


def terminate(pid: int) -> None:
    if IS_WINDOWS:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=30,
                       creationflags=subprocess.CREATE_NO_WINDOW)
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        time.sleep(0.1)
        if not process_cmdline(pid):
            return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def cmd_stop(cfg) -> int:
    if task_exists():
        schtasks('end')  # без прав администратора не сработает, тогда остановим процесс напрямую

    pids = []
    state_pid = read_state().get('pid')
    if isinstance(state_pid, int) and is_our_server(state_pid):
        pids.append(state_pid)
    port_pid = pid_on_port(cfg)
    if port_pid and port_pid not in pids and is_our_server(port_pid):
        pids.append(port_pid)

    for pid in pids:
        terminate(pid)

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and health(cfg, timeout=0.5):
        time.sleep(0.3)
    if health(cfg, timeout=0.5):
        say('[ОШИБКА] Сайт всё ещё отвечает. Запустите 03_STOP.bat от имени администратора.')
        return 1
    clear_state()
    say('[OK] Сайт остановлен.' if pids else '[OK] Сайт не был запущен.')
    return 0


def cmd_status(cfg) -> int:
    info = health(cfg)
    state = read_state()
    say(f'Сделано {VERSION}')
    say(f'  Локальный адрес:   {cfg.local_url}')
    say(f'  Публичный адрес:   {cfg.public_url}')
    say(f'  Слушает адрес:     {cfg.host}:{cfg.port}')
    say(f'  Разрешённые хосты: {", ".join(sorted(cfg.allowed_hosts))}')
    if cfg.trusted_proxies:
        say(f'  Доверенный прокси: {", ".join(sorted(cfg.trusted_proxies))} (остальным адресам доступ закрыт)')
    say(f'  Состояние:         {"РАБОТАЕТ" if info else "остановлен"}')
    if state.get('pid'):
        say(f'  PID:               {state["pid"]} (запущен {state.get("started", "?")})')
    if IS_WINDOWS:
        say(f'  Автозапуск:        {"включён" if task_exists() else "выключен"}')
    return 0 if info else 1


def cmd_check(cfg) -> int:
    ok = True
    say(f'Python {sys.version.split()[0]}')
    if sys.version_info < (3, 10):
        say('[ОШИБКА] Нужен Python 3.10 или новее.')
        ok = False
    try:
        import waitress  # noqa: F401

        say('[OK] waitress установлен')
    except ImportError:
        say('[ОШИБКА] waitress не установлен. Запустите 01_INSTALL.bat.')
        ok = False
    try:
        from server.app import create_app

        app = create_app(cfg)
        say(f'[OK] Файлы сайта загружены: {len(app.files) - 1}')
    except Exception as exc:  # noqa: BLE001
        say(f'[ОШИБКА] Сайт не собирается: {exc}')
        ok = False
    if health(cfg):
        say(f'[OK] Сайт уже работает на порту {cfg.port}')
    elif port_free(cfg):
        say(f'[OK] Порт {cfg.port} свободен')
    else:
        explain_busy_port(cfg)
        ok = False
    return 0 if ok else 1


def setup_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(LOG_DIR / 'server.log', maxBytes=1_000_000, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger('waitress.queue').setLevel(logging.WARNING)
    return logging.getLogger('sdelano')


def cmd_serve(cfg) -> int:
    log = setup_logging()
    try:
        from waitress import serve

        from server.app import create_app
        app = create_app(cfg)
    except Exception:
        log.exception('Не удалось подготовить сервер')
        raise

    if not port_free(cfg):
        log.error('Порт %s занят, сервер не запущен', cfg.port)
        say(f'Порт {cfg.port} занят.')
        return 2

    pid = os.getpid()
    write_state({'pid': pid, 'port': cfg.port, 'host': cfg.host, 'version': VERSION,
                 'started': time.strftime('%Y-%m-%d %H:%M:%S')})
    log.info('Сделано %s слушает %s:%s', VERSION, cfg.host, cfg.port)

    def shutdown(*_):
        clear_state(pid)
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT, getattr(signal, 'SIGBREAK', None)):
        if sig is not None:
            signal.signal(sig, shutdown)
    try:
        serve(
            app,
            host=cfg.host,
            port=cfg.port,
            threads=cfg.threads,
            ident='',  # не раскрываем, какой сервер работает
            connection_limit=500,
            channel_timeout=30,
            cleanup_interval=15,
            max_request_header_size=16_384,
            max_request_body_size=65_536,
            clear_untrusted_proxy_headers=True,
            expose_tracebacks=False,
        )
    finally:
        clear_state(pid)
        log.info('Сервер остановлен')
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Управление сервером «Сделано»')
    parser.add_argument('command', nargs='?', choices=['start', 'stop', 'restart', 'status', 'check'])
    parser.add_argument('--serve', action='store_true', help='работать в текущем окне')
    parser.add_argument('--no-browser', action='store_true', help='не открывать браузер после запуска')
    args = parser.parse_args(argv)

    try:
        cfg = load_config()
    except ConfigError as exc:
        say(f'[ОШИБКА] Неверная настройка: {exc}')
        say('  Исправьте local_config.bat и попробуйте снова.')
        return 4

    if args.serve:
        return cmd_serve(cfg)
    if args.command == 'start':
        return cmd_start(cfg, open_browser=not args.no_browser)
    if args.command == 'stop':
        return cmd_stop(cfg)
    if args.command == 'restart':
        code = cmd_stop(cfg)
        return code if code else cmd_start(cfg, open_browser=False)
    if args.command == 'status':
        return cmd_status(cfg)
    if args.command == 'check':
        return cmd_check(cfg)
    parser.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
