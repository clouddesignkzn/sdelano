// Запуск: node --test tests/   (без зависимостей, встроенный раннер Node 18+)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, ERR, STORAGE_KEY, BACKUP_KEY,
  sanitizeText, textLength, validateTask, normalizeTasks, parseState, serializeState,
  addTask, toggleTask, updateTaskText, removeTask, restoreTask, clearCompleted,
  stats, filterTasks, createRepository, parseImport, probeStorage,
  toggleImportant, viewTasks, normalizeQuery, FILTERS,
} from '../public/assets/js/store.js';

/** Простейший in-memory аналог localStorage с возможностью эмулировать сбои. */
function memoryStorage({ quotaAfter = Infinity, broken = false } = {}) {
  const map = new Map();
  let writes = 0;
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (broken) throw new Error('SecurityError');
      if (k !== 'sdelano:probe' && ++writes > quotaAfter) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

const task = (over = {}) => ({ id: 'a1', text: 'Купить хлеб', done: false, important: false, createdAt: 1, updatedAt: 1, doneAt: null, ...over });

describe('sanitizeText', () => {
  test('обрезает пробелы и схлопывает пробельные символы', () => {
    assert.equal(sanitizeText('  Привет \n\t мир  '), 'Привет мир');
  });
  test('удаляет управляющие и bidi-символы (Trojan Source)', () => {
    assert.equal(sanitizeText('a\u0000b\u202Ec\u2066d\u200Be'), 'abcde');
  });
  test('не экранирует HTML — это задача рендера через textContent', () => {
    assert.equal(sanitizeText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  });
  test('ограничивает длину по символам, а не по UTF-16', () => {
    const long = '😀'.repeat(LIMITS.TEXT_MAX + 50);
    assert.equal(textLength(sanitizeText(long)), LIMITS.TEXT_MAX);
  });
  test('сохраняет составные эмодзи (ZWJ)', () => {
    assert.equal(sanitizeText('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'), '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}');
  });
  test('не-строки превращаются в пустую строку', () => {
    for (const v of [null, undefined, 42, {}, [], true]) assert.equal(sanitizeText(v), '');
  });
});

describe('validateTask / normalizeTasks', () => {
  test('пропускает корректную задачу без изменений', () => {
    assert.deepEqual(validateTask(task()), task());
  });
  test('отбрасывает лишние поля и опасные ключи', () => {
    const raw = JSON.parse('{"id":"x","text":"t","done":false,"__proto__":{"polluted":1},"evil":"<script>"}');
    const clean = validateTask(raw, 5);
    assert.deepEqual(Object.keys(clean).sort(), ['createdAt', 'done', 'doneAt', 'id', 'important', 'text', 'updatedAt']);
    assert.equal({}.polluted, undefined);
  });
  test('отклоняет плохие id и пустой текст', () => {
    assert.equal(validateTask(task({ id: '../etc' })), null);
    assert.equal(validateTask(task({ id: 'a'.repeat(65) })), null);
    assert.equal(validateTask(task({ text: '   ' })), null);
    assert.equal(validateTask('строка'), null);
    assert.equal(validateTask([task()]), null);
  });
  test('done строго boolean, даты восстанавливаются', () => {
    const t = validateTask({ id: 'q', text: 'x', done: 'true', createdAt: 'вчера' }, 100);
    assert.equal(t.done, false);
    assert.equal(t.createdAt, 100);
    const d = validateTask({ id: 'q', text: 'x', done: true, createdAt: 10, updatedAt: 20 }, 100);
    assert.equal(d.doneAt, 20);
  });
  test('убирает дубликаты id и соблюдает лимит количества', () => {
    const many = Array.from({ length: LIMITS.TASKS_MAX + 10 }, (_, i) => task({ id: `id${i}` }));
    many.push(task({ id: 'id0', text: 'дубль' }));
    const out = normalizeTasks(many);
    assert.equal(out.length, LIMITS.TASKS_MAX);
    assert.equal(out.filter((t) => t.id === 'id0').length, 1);
  });
});

describe('parseState', () => {
  test('читает собственный формат', () => {
    const r = parseState(serializeState([task()]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.tasks, [task()]);
  });
  test('читает «голый» массив', () => {
    assert.equal(parseState(JSON.stringify([task()])).tasks.length, 1);
  });
  test('битый JSON и чужие структуры не роняют приложение', () => {
    for (const bad of ['', '{', 'null', '42', '"str"', '{"tasks":5}', undefined]) {
      assert.equal(parseState(bad).ok, false, String(bad));
    }
  });
  test('считает отброшенные записи', () => {
    const r = parseState(JSON.stringify({ tasks: [task(), { id: 1 }, null] }));
    assert.equal(r.tasks.length, 1);
    assert.equal(r.dropped, 2);
  });
});

describe('операции со списком', () => {
  test('addTask: новая задача сверху, исходный массив не мутирует', () => {
    const base = [task()];
    const r = addTask(base, '  Новая  ', {}, 50);
    assert.equal(r.tasks.length, 2);
    assert.equal(r.tasks[0].text, 'Новая');
    assert.equal(r.tasks[0].createdAt, 50);
    assert.equal(base.length, 1);
  });
  test('addTask: пустой ввод и переполнение', () => {
    assert.equal(addTask([], '   ').error, ERR.EMPTY);
    const full = Array.from({ length: LIMITS.TASKS_MAX }, (_, i) => task({ id: `i${i}` }));
    assert.equal(addTask(full, 'ещё').error, ERR.LIMIT);
  });
  test('addTask: уникальные id', () => {
    let list = [];
    for (let i = 0; i < 200; i++) list = addTask(list, `t${i}`).tasks;
    assert.equal(new Set(list.map((t) => t.id)).size, 200);
  });
  test('toggleTask туда и обратно', () => {
    const on = toggleTask([task()], 'a1', 9).tasks[0];
    assert.equal(on.done, true);
    assert.equal(on.doneAt, 9);
    const off = toggleTask([on], 'a1', 10).tasks[0];
    assert.equal(off.done, false);
    assert.equal(off.doneAt, null);
    assert.equal(toggleTask([task()], 'nope').error, ERR.NOT_FOUND);
  });
  test('updateTaskText', () => {
    assert.equal(updateTaskText([task()], 'a1', ' Молоко ').tasks[0].text, 'Молоко');
    assert.equal(updateTaskText([task()], 'a1', '').error, ERR.EMPTY);
    const same = [task()];
    assert.equal(updateTaskText(same, 'a1', 'Купить хлеб').tasks[0], same[0]);
  });
  test('removeTask + restoreTask возвращают задачу на место', () => {
    const list = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    const r = removeTask(list, 'b');
    assert.deepEqual(r.tasks.map((t) => t.id), ['a', 'c']);
    const back = restoreTask(r.tasks, r.removed, r.index);
    assert.deepEqual(back.tasks.map((t) => t.id), ['a', 'b', 'c']);
    assert.equal(restoreTask(back.tasks, r.removed, 0).tasks.length, 3, 'повторное восстановление не дублирует');
  });
  test('clearCompleted, stats, filterTasks', () => {
    const list = [task({ id: 'a', done: true }), task({ id: 'b' }), task({ id: 'c', done: true })];
    assert.deepEqual(stats(list), { total: 3, done: 2, active: 1, important: 0, percent: 67 });
    assert.deepEqual(stats([]), { total: 0, done: 0, active: 0, important: 0, percent: 0 });
    assert.equal(filterTasks(list, 'active').length, 1);
    assert.equal(filterTasks(list, 'done').length, 2);
    assert.equal(filterTasks(list, 'что-угодно').length, 3);
    const c = clearCompleted(list);
    assert.deepEqual(c.tasks.map((t) => t.id), ['b']);
    assert.equal(c.removed.length, 2);
  });
});

describe('хранилище', () => {
  test('сохраняет и загружает после «перезагрузки»', () => {
    const s = memoryStorage();
    const list = addTask([], 'Пережить F5').tasks;
    assert.equal(createRepository(s).save(list).ok, true);
    const reloaded = createRepository(s).load();
    assert.equal(reloaded.source, 'main');
    assert.deepEqual(reloaded.tasks, list);
  });
  test('пустое хранилище', () => {
    assert.equal(createRepository(memoryStorage()).load().source, 'empty');
  });
  test('повреждённые данные восстанавливаются из резервной копии', () => {
    const s = memoryStorage();
    const repo = createRepository(s);
    repo.save([task({ id: 'first' })]);
    repo.save([task({ id: 'second' })]); // first уходит в backup
    s.map.set(STORAGE_KEY, '{oops');
    const r = createRepository(s).load();
    assert.equal(r.source, 'backup');
    assert.equal(r.tasks[0].id, 'first');
    assert.equal(parseState(s.map.get(STORAGE_KEY)).ok, true, 'основная запись починена');
  });
  test('всё повреждено — пустой список без исключений', () => {
    const s = memoryStorage();
    s.map.set(STORAGE_KEY, 'x'); s.map.set(BACKUP_KEY, 'y');
    assert.equal(createRepository(s).load().source, 'corrupt');
  });
  test('переполнение квоты возвращает код ошибки, а не исключение', () => {
    const repo = createRepository(memoryStorage({ quotaAfter: 0 }));
    assert.deepEqual(repo.save([task()]), { ok: false, error: ERR.QUOTA });
  });
  test('недоступное хранилище (приватный режим)', () => {
    const s = memoryStorage({ broken: true });
    assert.equal(probeStorage(s), false);
    assert.equal(probeStorage(null), false);
    const repo = createRepository(s);
    assert.equal(repo.available, false);
    assert.equal(repo.load().source, 'memory');
    assert.equal(repo.save([]).error, ERR.UNAVAILABLE);
  });
});

describe('импорт', () => {
  test('валидный файл', () => {
    assert.equal(parseImport(serializeState([task()])).tasks.length, 1);
  });
  test('слишком большой и мусорный файлы отклоняются', () => {
    assert.equal(parseImport('x'.repeat(LIMITS.IMPORT_BYTES_MAX + 1)).error, ERR.TOO_LARGE);
    assert.equal(parseImport('<html>').error, ERR.INVALID);
    assert.equal(parseImport(null).error, ERR.INVALID);
  });
});

describe('важные задачи, поиск и порядок отображения', () => {
  test('addTask с флагом important и toggleImportant', () => {
    const r = addTask([], 'Срочно', { important: true });
    assert.equal(r.task.important, true);
    const off = toggleImportant(r.tasks, r.task.id, 5).tasks[0];
    assert.equal(off.important, false);
    assert.equal(off.updatedAt, 5);
    assert.equal(toggleImportant([], 'x').error, ERR.NOT_FOUND);
    assert.equal(addTask([], 'x', { important: 'yes' }).task.important, false, 'только строгий boolean');
  });
  test('данные версии 1 (без поля important) читаются', () => {
    const v1 = JSON.stringify({ app: 'sdelano', version: 1, tasks: [{ id: 'a', text: 'старое', done: false, createdAt: 1 }] });
    const r = parseState(v1);
    assert.equal(r.ok, true);
    assert.equal(r.tasks[0].important, false);
  });
  test('фильтр «Важные»', () => {
    const list = [task({ id: 'a', important: true }), task({ id: 'b' }), task({ id: 'c', important: true, done: true, doneAt: 3 })];
    assert.deepEqual(filterTasks(list, 'important').map((t) => t.id), ['a', 'c']);
    assert.deepEqual(FILTERS, ['all', 'active', 'important', 'done']);
  });
  test('поиск без учёта регистра и буквы «ё»', () => {
    const list = [task({ id: 'a', text: 'Купить ЁЛКУ' }), task({ id: 'b', text: 'Позвонить маме' })];
    assert.deepEqual(viewTasks(list, 'all', 'елк').map((t) => t.id), ['a']);
    assert.deepEqual(viewTasks(list, 'all', '  МАМЕ ').map((t) => t.id), ['b']);
    assert.equal(viewTasks(list, 'all', 'нет такого').length, 0);
    assert.equal(normalizeQuery('x'.repeat(500)).length, 100);
    assert.equal(normalizeQuery(null), '');
  });
  test('выполненные уходят вниз, свежевыполненные выше', () => {
    const list = [
      task({ id: 'a', done: true, doneAt: 10 }),
      task({ id: 'b' }),
      task({ id: 'c', done: true, doneAt: 20 }),
      task({ id: 'd' }),
    ];
    assert.deepEqual(viewTasks(list).map((t) => t.id), ['b', 'd', 'c', 'a']);
    assert.equal(list[0].id, 'a', 'исходный массив не изменён');
  });
});
