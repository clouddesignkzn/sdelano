/**
 * Сделано · ядро списка задач.
 *
 * Модуль не трогает DOM: только данные, валидация и хранилище,
 * поэтому полностью покрыт тестами (tests/store.test.mjs).
 *
 * Принципы:
 *  - всё, что приходит извне (localStorage, файл импорта, другая вкладка),
 *    считается недоверенным и проходит через validateTask();
 *  - объекты задач собираются заново из белого списка полей,
 *    без Object.assign/spread от сырых данных (защита от prototype pollution);
 *  - операции чистые: возвращают новый массив и не мутируют исходный;
 *  - ошибки хранилища возвращаются кодом и никогда не роняют приложение.
 */

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'sdelano:tasks';
export const BACKUP_KEY = 'sdelano:tasks:backup';

export const LIMITS = Object.freeze({
  TEXT_MAX: 280, // символов (code points) в одной задаче
  TASKS_MAX: 1000, // задач в списке
  IMPORT_BYTES_MAX: 1_000_000, // размер файла импорта
  QUERY_MAX: 100, // длина поискового запроса
});

export const ERR = Object.freeze({
  EMPTY: 'empty',
  LIMIT: 'limit',
  NOT_FOUND: 'not_found',
  QUOTA: 'quota',
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
  TOO_LARGE: 'too_large',
});

export const FILTERS = Object.freeze(['all', 'active', 'important', 'done']);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Собирает класс символов из числовых диапазонов: так в исходнике нет невидимых символов. */
function charClass(ranges, flags = 'g') {
  const body = ranges
    .map(([from, to = from]) => String.fromCodePoint(from) + (to !== from ? `-${String.fromCodePoint(to)}` : ''))
    .join('');
  return new RegExp(`[${body}]`, flags);
}

// Управляющие символы (C0/C1, кроме пробельных, их нормализуем отдельно).
const CONTROL_RE = charClass([[0x00, 0x08], [0x0b], [0x0c], [0x0e, 0x1f], [0x7f, 0x9f]]);
// Bidi-override и изолирующие символы: защита от атаки «Trojan Source» и подмены вида текста.
const BIDI_RE = charClass([[0x061c], [0x200e], [0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]);
// Невидимые разделители и BOM. ZWJ (U+200D) сохраняем: на нём держатся составные эмодзи.
const INVISIBLE_RE = charClass([[0x200b], [0x2028], [0x2029], [0x2060], [0xfeff]]);
// Любые пробельные символы приводим к обычному пробелу.
const SPACE_RE = charClass([[0x09, 0x0a], [0x0d], [0xa0], [0x1680], [0x2000, 0x200a], [0x202f], [0x205f], [0x3000]]);

/** Приводит пользовательский ввод к безопасной однострочной строке. */
export function sanitizeText(input, max = LIMITS.TEXT_MAX) {
  if (typeof input !== 'string') return '';
  let text = input.normalize('NFC');
  text = text.replace(SPACE_RE, ' ');
  text = text.replace(CONTROL_RE, '').replace(BIDI_RE, '').replace(INVISIBLE_RE, '');
  text = text.replace(/ {2,}/g, ' ').trim();
  const points = Array.from(text);
  if (points.length > max) text = points.slice(0, max).join('').trimEnd();
  return text;
}

/** Длина строки в символах так, как её видит человек (эмодзи = 1). */
export function textLength(text) {
  return Array.from(text ?? '').length;
}

/** Криптостойкий идентификатор. */
export function generateId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Фолбэк для очень старых окружений; уникальность в списке дополнительно гарантирует normalizeTasks().
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 8.64e15;

/** Проверяет «сырую» задачу и возвращает чистую копию или null. */
export function validateTask(raw, now = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
  const text = sanitizeText(raw.text);
  if (!id || !text) return null;
  const done = raw.done === true;
  const important = raw.important === true;
  const createdAt = isTime(raw.createdAt) ? raw.createdAt : now;
  const updatedAt = isTime(raw.updatedAt) ? Math.max(raw.updatedAt, createdAt) : createdAt;
  const doneAt = done ? (isTime(raw.doneAt) ? raw.doneAt : updatedAt) : null;
  return { id, text, done, important, createdAt, updatedAt, doneAt };
}

/** Валидирует массив, убирает дубликаты id и обрезает по лимиту. */
export function normalizeTasks(list, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= LIMITS.TASKS_MAX) break;
    const task = validateTask(raw, now);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/**
 * Разбирает JSON из хранилища или файла.
 * Понимает текущий формат { app, version, tasks }, формат версии 1 и «голый» массив.
 */
export function parseState(json) {
  if (typeof json !== 'string' || json.length === 0) return { ok: false, tasks: [], dropped: 0 };
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, tasks: [], dropped: 0 };
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray(data.tasks)) list = data.tasks;
  else return { ok: false, tasks: [], dropped: 0 };
  const tasks = normalizeTasks(list);
  return { ok: true, tasks, dropped: list.length - tasks.length };
}

export function serializeState(tasks) {
  return JSON.stringify({ app: 'sdelano', version: SCHEMA_VERSION, savedAt: Date.now(), tasks });
}

/* ───────────── Чистые операции над списком ───────────── */

export function createTask(text, { important = false } = {}, now = Date.now()) {
  return { id: generateId(), text, done: false, important: important === true, createdAt: now, updatedAt: now, doneAt: null };
}

/** Новая задача встаёт наверх списка. */
export function addTask(tasks, rawText, options = {}, now = Date.now()) {
  const text = sanitizeText(rawText);
  if (!text) return { error: ERR.EMPTY };
  if (tasks.length >= LIMITS.TASKS_MAX) return { error: ERR.LIMIT };
  const task = createTask(text, options, now);
  return { tasks: [task, ...tasks], task };
}

function patch(tasks, id, fn) {
  let found = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    found = true;
    return fn(t);
  });
  return found ? { tasks: next } : { error: ERR.NOT_FOUND };
}

export function toggleTask(tasks, id, now = Date.now()) {
  return patch(tasks, id, (t) => {
    const done = !t.done;
    return { ...t, done, updatedAt: now, doneAt: done ? now : null };
  });
}

export function toggleImportant(tasks, id, now = Date.now()) {
  return patch(tasks, id, (t) => ({ ...t, important: !t.important, updatedAt: now }));
}

export function updateTaskText(tasks, id, rawText, now = Date.now()) {
  const text = sanitizeText(rawText);
  if (!text) return { error: ERR.EMPTY };
  return patch(tasks, id, (t) => (t.text === text ? t : { ...t, text, updatedAt: now }));
}

export function removeTask(tasks, id) {
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return { error: ERR.NOT_FOUND };
  return { tasks: tasks.filter((t) => t.id !== id), removed: tasks[index], index };
}

/** Возвращает удалённую задачу на прежнее место (для «Отменить»). */
export function restoreTask(tasks, task, index) {
  if (tasks.some((t) => t.id === task.id)) return { tasks };
  if (tasks.length >= LIMITS.TASKS_MAX) return { error: ERR.LIMIT };
  const at = Math.max(0, Math.min(index, tasks.length));
  return { tasks: [...tasks.slice(0, at), task, ...tasks.slice(at)] };
}

export function clearCompleted(tasks) {
  return { tasks: tasks.filter((t) => !t.done), removed: tasks.filter((t) => t.done) };
}

export function stats(tasks) {
  let done = 0;
  let important = 0;
  for (const t of tasks) {
    if (t.done) done += 1;
    if (t.important) important += 1;
  }
  const total = tasks.length;
  return { total, done, active: total - done, important, percent: total ? Math.round((done / total) * 100) : 0 };
}

/** Нормализация для поиска: регистр, «ё», лишние пробелы. */
export function normalizeQuery(query) {
  return sanitizeText(typeof query === 'string' ? query : '', LIMITS.QUERY_MAX).toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

export function matchesQuery(task, normalizedQuery) {
  if (!normalizedQuery) return true;
  return task.text.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalizedQuery);
}

export function filterTasks(tasks, filter) {
  if (filter === 'active') return tasks.filter((t) => !t.done);
  if (filter === 'done') return tasks.filter((t) => t.done);
  if (filter === 'important') return tasks.filter((t) => t.important);
  return tasks;
}

/**
 * То, что видит пользователь: фильтр + поиск + порядок.
 * Активные задачи идут первыми в своём порядке, выполненные ниже, свежие сверху.
 */
export function viewTasks(tasks, filter = 'all', query = '') {
  const q = normalizeQuery(query);
  const list = filterTasks(tasks, filter).filter((t) => matchesQuery(t, q));
  const active = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return [...active, ...done];
}

/* ───────────── Хранилище ───────────── */

function isQuotaError(e) {
  return (
    e instanceof Error &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014)
  );
}

/** Проверяет, что хранилище реально пишет (приватный режим, запреты политик и т. п.). */
export function probeStorage(storage) {
  if (!storage) return false;
  try {
    const k = 'sdelano:probe';
    storage.setItem(k, '1');
    const ok = storage.getItem(k) === '1';
    storage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Обёртка над localStorage с резервной копией.
 * Перед каждой записью предыдущее валидное состояние копируется в BACKUP_KEY,
 * поэтому повреждённые основные данные восстанавливаются автоматически.
 */
export function createRepository(storage) {
  const available = probeStorage(storage);

  function load() {
    if (!available) return { tasks: [], source: 'memory', available };
    let main;
    let backup;
    try {
      main = storage.getItem(STORAGE_KEY);
      backup = storage.getItem(BACKUP_KEY);
    } catch {
      return { tasks: [], source: 'memory', available: false };
    }
    if (main === null && backup === null) return { tasks: [], source: 'empty', available };

    const parsed = parseState(main);
    if (parsed.ok) return { tasks: parsed.tasks, source: 'main', dropped: parsed.dropped, available };

    const fromBackup = parseState(backup);
    if (fromBackup.ok) {
      try {
        storage.setItem(STORAGE_KEY, serializeState(fromBackup.tasks));
      } catch {
        /* починим при следующем сохранении */
      }
      return { tasks: fromBackup.tasks, source: 'backup', recovered: true, available };
    }
    return { tasks: [], source: 'corrupt', recovered: false, available };
  }

  function save(tasks) {
    if (!available) return { ok: false, error: ERR.UNAVAILABLE };
    const payload = serializeState(tasks);
    try {
      const previous = storage.getItem(STORAGE_KEY);
      if (previous !== null && parseState(previous).ok) {
        try {
          storage.setItem(BACKUP_KEY, previous);
        } catch {
          storage.removeItem(BACKUP_KEY); // места нет даже под копию: основная запись важнее
        }
      }
      storage.setItem(STORAGE_KEY, payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: isQuotaError(e) ? ERR.QUOTA : ERR.UNAVAILABLE };
    }
  }

  return { load, save, available };
}

/** Разбор файла резервной копии при импорте. */
export function parseImport(text) {
  if (typeof text !== 'string') return { error: ERR.INVALID };
  if (text.length > LIMITS.IMPORT_BYTES_MAX) return { error: ERR.TOO_LARGE };
  const parsed = parseState(text);
  if (!parsed.ok) return { error: ERR.INVALID };
  return { tasks: parsed.tasks, dropped: parsed.dropped };
}
