// Сквозной тест: настоящий сервер (launcher.py --serve) + настоящий Chrome через DevTools Protocol.
// Без Puppeteer и других зависимостей. Нужны Node 22+, Python с waitress и Chrome/Chromium.
//
//   node tests/e2e.mjs
//   CHROME_PATH=...   путь к Chrome (по умолчанию ищется сам)
//   PYTHON=...        Python, в котором установлен waitress (по умолчанию .venv или python3)
//   SCREENSHOTS=1     сохранить скриншоты в tests/screenshots/
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.env.SCREENSHOTS === '1';
const shotDir = new URL('./screenshots/', import.meta.url);
const PORT = 40000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
       'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const c of candidates) {
    if (c.includes('/') ? existsSync(c) : spawnSync('which', [c]).status === 0) return c;
  }
  throw new Error('Chrome не найден. Укажите путь в CHROME_PATH.');
}
function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = process.platform === 'win32' ? join(ROOT, '.venv', 'Scripts', 'python.exe') : join(ROOT, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function waitFor(fn, { timeout = 10000, step = 100, what = 'условие' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* ещё не готово */ }
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await sleep(step);
  }
}

// ── Сервер ──
const server = spawn(findPython(), ['launcher.py', '--serve'], {
  cwd: ROOT,
  env: { ...process.env, SDELANO_PORT: String(PORT), SDELANO_HOST: '127.0.0.1' },
  stdio: 'ignore',
});

// ── Браузер ──
const profile = mkdtempSync(join(tmpdir(), 'sdelano-e2e-'));
const chrome = spawn(findChrome(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error('Chrome не запустился')));
  setTimeout(() => reject(new Error('Chrome: таймаут запуска')), 20000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) listeners.forEach((fn) => fn(msg));
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);

const problems = [];
let ignoreProblems = false;
listeners.push((msg) => {
  if (msg.sessionId !== sessionId || ignoreProblems) return;
  const p = msg.params;
  if (msg.method === 'Runtime.exceptionThrown') problems.push(`исключение: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) problems.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry.level)) problems.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
});
await page('Runtime.enable');
await page('Log.enable');
await page('Page.enable');
await page('Network.enable');

async function evaluate(expression) {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const ready = () => waitFor(() => evaluate(`document.readyState === 'complete' && document.documentElement.classList.contains('is-ready')`), { what: 'загрузка страницы' });
async function navigate(url) { await page('Page.navigate', { url }); await sleep(100); await ready(); }
async function reload() { await page('Page.reload', { ignoreCache: false }); await sleep(200); await ready(); }

async function center(selector) {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  assert.ok(box, `элемент не найден или не виден: ${selector}`);
  return box;
}
async function click(selector, clickCount = 1) {
  const { x, y } = await center(selector);
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
  await sleep(80);
}
const type = (text) => page('Input.insertText', { text });
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, Delete: { code: 'Delete', keyCode: 46 }, z: { code: 'KeyZ', keyCode: 90, text: 'z' },
  s: { code: 'KeyS', keyCode: 83, text: 's' }, e: { code: 'KeyE', keyCode: 69, text: 'e' }, n: { code: 'KeyN', keyCode: 78, text: 'n' },
  '/': { code: 'Slash', keyCode: 191, text: '/' }, 2: { code: 'Digit2', keyCode: 50, text: '2' }, 3: { code: 'Digit3', keyCode: 51, text: '3' },
  1: { code: 'Digit1', keyCode: 49, text: '1' }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
};
async function press(key, modifiers = 0) {
  const k = KEYS[key];
  const text = modifiers ? undefined : k.text;
  await page('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers, text });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
  await sleep(80);
}
const texts = () => evaluate(`[...document.querySelectorAll('#task-list .task__text')].map((n) => n.textContent)`);
const flags = () => evaluate(`[...document.querySelectorAll('#task-list .task')].map((n) => (n.classList.contains('is-done') ? 'D' : '-') + (n.classList.contains('is-important') ? '*' : ''))`);
const activeInfo = () => evaluate(`(() => { const a = document.activeElement; return { id: a.id, cls: a.className, task: a.closest('.task')?.querySelector('.task__text')?.textContent ?? null }; })()`);

async function viewport(width, height, mobile = false) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
}
async function scheme(value) {
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
}
async function screenshot(name) {
  if (!SHOTS) return;
  mkdirSync(shotDir, { recursive: true });
  await evaluate('window.scrollTo(0, 0)');
  await sleep(500);
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL(`${name}.png`, shotDir), Buffer.from(data, 'base64'));
}
async function noHorizontalScroll(label) {
  const r = await evaluate(`({ sw: document.documentElement.scrollWidth, w: window.innerWidth })`);
  assert.ok(r.sw <= r.w, `${label}: горизонтальная прокрутка ${r.sw} > ${r.w}`);
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['✔', name]);
  } catch (e) {
    results.push(['✘', name, e.message.split('\n').slice(0, 6).join('\n      ')]);
  }
}

try {
  await waitFor(async () => (await fetch(`${BASE}health`).catch(() => null))?.ok, { timeout: 20000, what: 'запуск сервера' });
  await viewport(1440, 900);
  await scheme('light');
  await navigate(BASE);

  await step('страница открывается: пустое состояние, приветствие, дата', async () => {
    assert.equal(await evaluate(`document.querySelector('#empty').hidden`), false);
    assert.equal(await evaluate(`document.title`), 'Сделано · список задач');
    assert.match(await evaluate(`document.querySelector('#greeting').textContent`), /^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи)$/);
    assert.ok((await evaluate(`document.querySelector('#today').textContent`)).length > 5);
    assert.equal(await evaluate(`document.querySelector('link[rel=canonical]').href`), 'https://hvostdoc.online/', 'адрес сайта подставлен сервером');
  });
  await screenshot('desktop-empty-light');

  await step('1. добавление: Enter, кнопка, важная задача', async () => {
    await click('#composer-input');
    await type('Позвонить в банк до 18:00');
    await press('Enter');
    await type('Купить корм коту');
    await click('#composer-submit');
    await click('#composer-star');
    await type('Подготовить отчёт для руководителя');
    await press('Enter');
    await type('Записаться к стоматологу');
    await press('Enter');
    await type('Прочитать главу книги');
    await press('Enter');
    assert.deepEqual(await texts(), ['Прочитать главу книги', 'Записаться к стоматологу', 'Подготовить отчёт для руководителя', 'Купить корм коту', 'Позвонить в банк до 18:00']);
    assert.deepEqual(await flags(), ['-', '-', '-*', '-', '-']);
    assert.equal((await activeInfo()).id, 'composer-input', 'фокус остаётся в поле ввода');
    assert.equal(await evaluate(`document.querySelector('#composer-star').getAttribute('aria-pressed')`), 'false', 'звезда сбрасывается');
  });

  await step('пустой и слишком длинный ввод не создают задач', async () => {
    await type('     ');
    await press('Enter');
    assert.match(await evaluate(`document.querySelector('#composer-error').textContent`), /пару слов/);
    await evaluate(`document.querySelector('#composer-input').value = ''`);
    await type('я'.repeat(300));
    assert.equal(await evaluate(`document.querySelector('#composer-counter').hidden`), false, 'счётчик символов виден');
    await press('Enter');
    assert.match(await evaluate(`document.querySelector('#composer-error').textContent`), /Слишком длинно/);
    await evaluate(`document.querySelector('#composer-input').value = ''`);
    assert.equal((await texts()).length, 5);
  });

  await step('XSS: HTML в задаче остаётся текстом', async () => {
    await type('<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>');
    await press('Enter');
    await sleep(200);
    assert.equal(await evaluate(`window.__pwned ?? null`), null);
    assert.equal(await evaluate(`document.querySelectorAll('#task-list img, #task-list script').length`), 0);
    assert.match((await texts())[0], /^<img src=x/);
  });

  await step('Trusted Types блокируют innerHTML на уровне браузера', async () => {
    ignoreProblems = true;
    const blocked = await evaluate(`(() => { try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); return false; } catch (e) { return e instanceof TypeError; } })()`);
    await sleep(100);
    ignoreProblems = false;
    assert.equal(blocked, true);
  });

  await step('2. отметка выполненных: прогресс и сортировка (готовые вниз)', async () => {
    await click('#task-list .task:nth-child(5) .task__toggle'); // «Купить корм коту»
    await click('#task-list .task:nth-child(2) .task__toggle'); // «Прочитать главу книги»
    const t = await texts();
    assert.equal(t.at(-1), 'Купить корм коту');
    assert.equal(t.at(-2), 'Прочитать главу книги', 'свежевыполненная выше');
    assert.equal(await evaluate(`document.querySelector('#stat-done').textContent + '/' + document.querySelector('#stat-total').textContent`), '2/6');
    assert.equal(await evaluate(`document.querySelector('#ring-percent').textContent`), '33');
  });
  await screenshot('desktop-list-light');

  await step('3. удаление с отменой (кнопка и Ctrl+Z)', async () => {
    await click('#task-list .task:nth-child(1) .task__delete');
    await sleep(400);
    assert.equal((await texts()).length, 5);
    assert.equal(await evaluate(`document.querySelector('#toast').hidden`), false);
    await click('#toast-action');
    assert.equal((await texts()).length, 6);
    await click('#task-list .task:nth-child(1) .task__delete');
    await sleep(400);
    await evaluate(`document.activeElement.blur()`);
    await press('z', 2); // Ctrl+Z
    assert.equal((await texts()).length, 6);
    await click('#task-list .task:nth-child(1) .task__delete');
    await sleep(400);
    assert.equal((await texts()).length, 5);
  });

  await step('редактирование: двойной клик, Enter сохраняет, Esc отменяет', async () => {
    await click('#task-list .task:nth-child(1) .task__text', 2);
    await waitFor(() => evaluate(`!!document.querySelector('.task__edit-input')`), { what: 'поле редактирования' });
    await evaluate(`document.querySelector('.task__edit-input').select()`);
    await type('Позвонить в банк до 17:00');
    await press('Enter');
    assert.equal((await texts())[0], 'Позвонить в банк до 17:00');
    await click('#task-list .task:nth-child(1) .task__edit');
    await evaluate(`document.querySelector('.task__edit-input').select()`);
    await type('это не сохранится');
    await press('Escape');
    assert.equal((await texts())[0], 'Позвонить в банк до 17:00');
  });

  await step('важные: звезда у задачи и фильтр', async () => {
    await click('#task-list .task:nth-child(1) .task__star');
    await click('[data-filter="important"]');
    assert.deepEqual(await texts(), ['Позвонить в банк до 17:00', 'Подготовить отчёт для руководителя']);
    assert.equal(await evaluate(`document.querySelector('#board-title').textContent`), 'Важные');
    await click('[data-filter="all"]');
  });

  await step('фильтры «В работе» и «Готово», цифровые клавиши', async () => {
    await evaluate(`document.activeElement.blur()`);
    await press('2');
    assert.equal((await texts()).length, 3);
    await press('1');
    assert.equal((await texts()).length, 5);
    await click('[data-filter="done"]');
    assert.equal((await texts()).length, 2);
    await click('[data-filter="all"]');
  });

  await step('поиск с подсветкой, без учёта регистра и «ё»', async () => {
    await evaluate(`document.activeElement.blur()`);
    await press('/');
    assert.equal((await activeInfo()).id, 'search-input');
    await type('ОТЧЕТ');
    assert.deepEqual(await texts(), ['Подготовить отчёт для руководителя']);
    assert.equal(await evaluate(`document.querySelector('#task-list mark')?.textContent`), 'отчёт');
    await type('ыыы');
    assert.equal(await evaluate(`document.querySelector('#empty-title').textContent`), 'Ничего не нашлось');
    await press('Escape');
    assert.equal((await texts()).length, 5);
  });

  await step('клавиатура: стрелки, S, пробел, Delete', async () => {
    await evaluate(`document.querySelector('#task-list .task:nth-child(1) .task__toggle').focus()`);
    await press('ArrowDown');
    assert.equal((await activeInfo()).task, 'Подготовить отчёт для руководителя');
    await press('s');
    assert.deepEqual((await flags())[1], '-', 'звезда снята клавишей S');
    await press('s');
    await press(' ');
    assert.ok((await flags()).some((f) => f === 'D*'), 'пробел отмечает задачу');
    await evaluate(`document.querySelector('#task-list .task:nth-child(1) .task__toggle').focus()`);
    const before = (await texts()).length;
    await press('Delete');
    await sleep(400);
    assert.equal((await texts()).length, before - 1);
    await click('#toast-action');
  });

  await step('4. всё сохраняется после перезагрузки', async () => {
    const snapshot = `[...document.querySelectorAll('#task-list .task')].map((n) => [n.querySelector('.task__text').textContent, n.classList.contains('is-done'), n.classList.contains('is-important')])`;
    const before = await evaluate(snapshot);
    await reload();
    assert.deepEqual(await evaluate(snapshot), before);
  });

  await step('повреждённые данные восстанавливаются из резервной копии', async () => {
    await evaluate(`localStorage.setItem('sdelano:tasks', '{broken')`);
    await reload();
    assert.ok((await texts()).length >= 4);
    assert.match(await evaluate(`document.querySelector('#toast-text').textContent`), /восстановили/);
  });

  await step('синхронизация между вкладками', async () => {
    const { targetId: t2 } = await send('Target.createTarget', { url: BASE });
    const { sessionId: s2 } = await send('Target.attachToTarget', { targetId: t2, flatten: true });
    await send('Runtime.enable', {}, s2);
    await waitFor(async () => (await send('Runtime.evaluate', { expression: `document.documentElement.classList.contains('is-ready')`, returnByValue: true }, s2)).result.value, { what: 'вторая вкладка' });
    await send('Runtime.evaluate', { expression: `(() => { const i = document.querySelector('#composer-input'); i.value = 'Из второй вкладки'; document.querySelector('#composer').requestSubmit(); })()` }, s2);
    await waitFor(async () => (await texts())[0] === 'Из второй вкладки', { what: 'задача из второй вкладки' });
    await send('Target.closeTarget', { targetId: t2 });
  });

  await step('тема: авто → светлая → тёмная, запоминается', async () => {
    await click('#theme-button');
    assert.equal(await evaluate(`document.documentElement.dataset.themePref`), 'light');
    await click('#theme-button');
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
    await reload();
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
  });
  await screenshot('desktop-list-dark');

  await step('окно горячих клавиш (?) и меню', async () => {
    await evaluate(`document.activeElement.blur()`);
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8, text: '?' });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8 });
    await sleep(150);
    assert.equal(await evaluate(`document.querySelector('#keys-dialog').open`), true);
    await screenshot('desktop-keys-dark');
    await press('Escape');
    assert.equal(await evaluate(`document.querySelector('#keys-dialog').open`), false);
    await click('#menu-button');
    assert.equal(await evaluate(`document.querySelector('#menu-list').hidden`), false);
    await press('Escape');
    assert.equal(await evaluate(`document.querySelector('#menu-list').hidden`), true);
  });

  await step('service worker и работа без интернета', async () => {
    await waitFor(() => evaluate(`navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))`), { timeout: 15000, what: 'service worker' });
    await reload(); // страница под управлением воркера
    await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    ignoreProblems = true;
    await reload();
    ignoreProblems = false;
    assert.ok((await texts()).length >= 4, 'список открылся офлайн');
    await page('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await reload();
  });

  const screens = [
    ['широкий монитор 1920×1080', 1920, 1080, false, 'wide-dark'],
    ['планшет 834×1112', 834, 1112, true, 'tablet-dark'],
    ['телефон 390×844', 390, 844, true, 'mobile-dark'],
    ['маленький телефон 320×640', 320, 640, true, 'tiny-dark'],
    ['телефон горизонтально 844×390', 844, 390, true, 'landscape-dark'],
  ];
  for (const [label, w, h, mobile, shot] of screens) {
    await step(`экран: ${label}, без горизонтальной прокрутки`, async () => {
      await viewport(w, h, mobile);
      await reload();
      await noHorizontalScroll(label);
      const inputVisible = await evaluate(`(() => { const r = document.querySelector('#composer-input').getBoundingClientRect(); return r.width > 80 && r.height >= 40; })()`);
      assert.ok(inputVisible, 'поле ввода нормального размера');
      await screenshot(shot);
    });
  }

  await step('телефон: нижняя панель фильтров и свайп для удаления', async () => {
    await viewport(390, 844, true);
    await click('#theme-button'); // тёмная → авто (светлая, т. к. система светлая)
    await reload();
    const navFixed = await evaluate(`getComputedStyle(document.querySelector('.nav')).position`);
    assert.equal(navFixed, 'fixed');
    await screenshot('mobile-light');
    const before = (await texts()).length;
    const box = await center('#task-list .task:nth-child(1) .task__body');
    await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    for (let i = 1; i <= 8; i += 1) {
      await page('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x - i * 30, y: box.y + 2 }] });
      await sleep(16);
    }
    await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    assert.equal((await texts()).length, before - 1, 'задача удалена свайпом');
    await click('#toast-action');
    assert.equal((await texts()).length, before);
    await click('[data-filter="done"]');
    await click('[data-filter="all"]');
  });

  if (SHOTS) {
    // Витрина для README: аккуратный демо-список на трёх экранах.
    await step('скриншоты для README', async () => {
      const now = Date.now();
      const demo = [
        ['Подготовить презентацию для встречи', false, true, 50],
        ['Позвонить в банк до 18:00', false, false, 40],
        ['Записаться к стоматологу', false, false, 35],
        ['Купить подарок маме на день рождения', false, true, 30],
        ['Оплатить интернет', true, false, 20],
        ['Прочитать главу книги', true, false, 10],
        ['Разобрать почту', true, false, 5],
      ].map(([text, done, important, minAgo], i) => ({
        id: `demo${i}`, text, done, important, createdAt: now - minAgo * 60_000 - 3_600_000,
        updatedAt: now - minAgo * 60_000, doneAt: done ? now - minAgo * 60_000 : null,
      }));
      await evaluate(`localStorage.setItem('sdelano:tasks', ${JSON.stringify(JSON.stringify({ app: 'sdelano', version: 2, tasks: demo }))}); localStorage.setItem('sdelano:filter', 'all')`);
      for (const [name, w, h, mobile, theme] of [
        ['showcase-desktop-light', 1440, 900, false, 'light'],
        ['showcase-desktop-dark', 1440, 900, false, 'dark'],
        ['showcase-mobile-light', 390, 844, true, 'light'],
      ]) {
        await viewport(w, h, mobile);
        await evaluate(`localStorage.setItem('sdelano:theme', '${theme}')`);
        await reload();
        await screenshot(name);
      }
    });
  }

  await step('нет ошибок в консоли и нарушений CSP', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  for (const [mark, name, err] of results) console.log(`${mark} ${name}${err ? `\n      ${err}` : ''}`);
  try { ws.close(); } catch { /* уже закрыт */ }
  chrome.kill('SIGKILL');
  server.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль занят */ }
}

const failed = results.filter(([m]) => m === '✘').length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
