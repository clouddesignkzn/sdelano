/**
 * Сделано · интерфейс.
 *
 * Текст задач попадает в DOM только через textContent/value и createElement.
 * innerHTML, insertAdjacentHTML и eval в проекте не используются, а CSP с Trusted Types
 * заблокирует их на уровне браузера, даже если кто-то добавит их позже.
 */
import * as S from './store.js';

/* ───────────── Утилиты ───────────── */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = window.matchMedia('(pointer: coarse)');

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const tasksWord = (n) => plural(n, ['задача', 'задачи', 'задач']);

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const todayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

function humanDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return `сегодня в ${timeFmt.format(d)}`;
  if (days === 1) return `вчера в ${timeFmt.format(d)}`;
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isTypingTarget(el) {
  return el instanceof HTMLElement && (el.isContentEditable || el.matches('input:not([type="checkbox"]), textarea, select'));
}

/* ───────────── Элементы ───────────── */

const els = {
  composer: $('#composer'),
  input: $('#composer-input'),
  star: $('#composer-star'),
  counter: $('#composer-counter'),
  error: $('#composer-error'),
  search: $('#search-input'),
  list: $('#task-list'),
  template: $('#task-template'),
  empty: $('#empty'),
  emptyTitle: $('#empty-title'),
  emptyText: $('#empty-text'),
  boardTitle: $('#board-title'),
  foot: $('#board-foot'),
  left: $('#left-count'),
  clearDone: $('#clear-done'),
  filters: $$('[data-filter]'),
  counts: Object.fromEntries($$('[data-count]').map((n) => [n.dataset.count, n])),
  today: $('#today'),
  greeting: $('#greeting'),
  heroSub: $('#hero-sub'),
  progress: $('#progress'),
  ring: $('#ring-value'),
  ringPercent: $('#ring-percent'),
  statDone: $('#stat-done'),
  statTotal: $('#stat-total'),
  note: $('#progress-note'),
  notice: $('#storage-notice'),
  toast: $('#toast'),
  toastText: $('#toast-text'),
  toastAction: $('#toast-action'),
  toastClose: $('#toast-close'),
  srStatus: $('#sr-status'),
  themeButton: $('#theme-button'),
  menuButton: $('#menu-button'),
  menuList: $('#menu-list'),
  importInput: $('#import-input'),
  importDialog: $('#import-dialog'),
  importText: $('#import-text'),
  keysDialog: $('#keys-dialog'),
};

function announce(text) {
  els.srStatus.textContent = '';
  window.setTimeout(() => { els.srStatus.textContent = text; }, 40);
}

/* ───────────── Состояние ───────────── */

const storage = safeLocalStorage();
const repo = S.createRepository(storage);
const PREF = { filter: 'sdelano:filter', theme: 'sdelano:theme' };

const state = {
  tasks: [],
  filter: 'all',
  query: '',
  editingId: null,
  composerImportant: false,
};

/** id задачи → <li>: список обновляется точечно, фокус не теряется. */
const nodes = new Map();
let justAddedId = null;
let justDoneId = null;
let undoAction = null;

function readPref(key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}
function writePref(key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* настройки не критичны */
  }
}

function persist() {
  const result = repo.save(state.tasks);
  if (result.ok) return;
  if (result.error === S.ERR.QUOTA) {
    showToast('В хранилище браузера закончилось место. Удалите часть выполненных задач.', { error: true });
  } else {
    els.notice.hidden = false;
  }
}

function commit(tasks, { save = true } = {}) {
  state.tasks = tasks;
  if (save) persist();
  render();
}

/* ───────────── Рендер ───────────── */

const FILTER_TITLES = { all: 'Все задачи', active: 'В работе', important: 'Важные', done: 'Выполненные' };

function renderHero(st) {
  const now = new Date();
  els.today.textContent = todayFmt.format(now);
  els.greeting.textContent = greetingFor(now.getHours());
  let sub;
  if (st.total === 0) sub = 'что сделаем сегодня?';
  else if (st.active === 0) sub = 'всё сделано, можно выдохнуть';
  else sub = `в работе ${st.active} ${tasksWord(st.active)}`;
  els.heroSub.textContent = sub;
}

function progressNote(st) {
  if (st.total === 0) return 'Начните с первой задачи.';
  if (st.done === st.total) return 'Список закрыт. Отличная работа!';
  if (st.done === 0) return 'Первая галочка самая важная.';
  if (st.percent < 50) return 'Хорошее начало, продолжайте.';
  return 'Больше половины позади.';
}

let lastPercent = -1;
function renderStats(st) {
  els.ring.style.strokeDashoffset = String(100 - st.percent);
  els.ringPercent.textContent = String(st.percent);
  els.statDone.textContent = String(st.done);
  els.statTotal.textContent = String(st.total);
  els.note.textContent = progressNote(st);
  els.progress.classList.toggle('is-complete', st.total > 0 && st.done === st.total);
  if (lastPercent !== -1 && st.percent !== lastPercent && st.total > 0 && st.done === st.total) {
    announce('Все задачи выполнены');
  }
  lastPercent = st.percent;

  els.counts.all.textContent = String(st.total);
  els.counts.active.textContent = String(st.active);
  els.counts.important.textContent = String(st.important);
  els.counts.done.textContent = String(st.done);
  for (const button of els.filters) button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  els.boardTitle.textContent = FILTER_TITLES[state.filter];

  els.foot.hidden = st.total === 0;
  els.left.textContent = st.active === 0 ? 'Все задачи выполнены' : `Осталось ${st.active} ${tasksWord(st.active)}`;
  els.clearDone.disabled = st.done === 0;
}

function renderEmpty(visibleCount, st) {
  els.empty.hidden = visibleCount > 0;
  if (visibleCount > 0) return;
  let title = 'Здесь пока пусто';
  let text = 'Запишите первую задачу. Она сохранится, даже если закрыть вкладку.';
  if (state.query) {
    title = 'Ничего не нашлось';
    text = 'Попробуйте другое слово или сбросьте поиск клавишей Esc.';
  } else if (st.total > 0 && state.filter === 'active') {
    title = 'Всё сделано';
    text = 'Активных задач нет. Самое время отдохнуть.';
  } else if (st.total > 0 && state.filter === 'important') {
    title = 'Важных задач нет';
    text = 'Нажмите на звезду у задачи, и она появится здесь.';
  } else if (st.total > 0 && state.filter === 'done') {
    title = 'Пока ничего не выполнено';
    text = 'Отмеченные задачи соберутся здесь.';
  }
  els.emptyTitle.textContent = title;
  els.emptyText.textContent = text;
}

/** Выводит текст с подсветкой совпадений поиска, без HTML-строк. */
function setHighlightedText(el, text, query) {
  const q = S.normalizeQuery(query);
  if (!q) {
    el.textContent = text;
    return;
  }
  const haystack = text.toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const parts = [];
  let from = 0;
  let at = haystack.indexOf(q);
  while (at !== -1 && q.length > 0) {
    if (at > from) parts.push(document.createTextNode(text.slice(from, at)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + q.length);
    parts.push(mark);
    from = at + q.length;
    at = haystack.indexOf(q, from);
  }
  if (from < text.length) parts.push(document.createTextNode(text.slice(from)));
  el.replaceChildren(...parts);
}

function createTaskNode(task) {
  const li = els.template.content.firstElementChild.cloneNode(true);
  li.dataset.id = task.id;
  return li;
}

function updateTaskNode(li, task) {
  li.classList.toggle('is-done', task.done);
  li.classList.toggle('is-important', task.important);
  $('.task__toggle', li).checked = task.done;
  $('.task__toggle-label', li).textContent = `${task.done ? 'Вернуть в работу' : 'Выполнено'}: ${task.text}`;
  const star = $('.task__star', li);
  star.setAttribute('aria-pressed', String(task.important));
  star.setAttribute('aria-label', `${task.important ? 'Убрать из важных' : 'Отметить как важную'}: ${task.text}`);
  $('.task__edit', li).setAttribute('aria-label', `Изменить: ${task.text}`);
  $('.task__delete', li).setAttribute('aria-label', `Удалить: ${task.text}`);
  if (li.dataset.editing) return; // не перетираем поле редактирования
  setHighlightedText($('.task__text', li), task.text, state.query);
  $('.task__time', li).textContent = task.done && task.doneAt
    ? `выполнено ${humanDate(task.doneAt)}`
    : `добавлено ${humanDate(task.createdAt)}`;
}

function render() {
  const st = S.stats(state.tasks);
  renderHero(st);
  renderStats(st);

  const visible = S.viewTasks(state.tasks, state.filter, state.query);
  const keep = new Set(visible.map((t) => t.id));
  for (const [id, li] of nodes) {
    if (!keep.has(id)) {
      li.remove();
      nodes.delete(id);
    }
  }

  let prev = null;
  for (const task of visible) {
    let li = nodes.get(task.id);
    if (!li) {
      li = createTaskNode(task);
      nodes.set(task.id, li);
      if (task.id === justAddedId && !motionOff.matches) {
        li.classList.add('is-entering');
        li.addEventListener('animationend', () => li.classList.remove('is-entering'), { once: true });
      }
    }
    updateTaskNode(li, task);
    if (task.id === justDoneId && task.done && !motionOff.matches) {
      li.classList.remove('just-done');
      void li.offsetWidth;
      li.classList.add('just-done');
    }
    const expected = prev ? prev.nextElementSibling : els.list.firstElementChild;
    if (expected !== li) els.list.insertBefore(li, expected);
    prev = li;
  }
  justAddedId = null;
  justDoneId = null;
  renderEmpty(visible.length, st);
}

/* ───────────── Уведомления и отмена ───────────── */

let toastTimer = 0;
let toastHandler = null;

function hideToast() {
  window.clearTimeout(toastTimer);
  els.toast.hidden = true;
  toastHandler = null;
}
function armToast(ms) {
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, ms);
}
function showToast(message, { actionLabel = null, onAction = null, error = false, duration = 6000 } = {}) {
  els.toastText.textContent = message;
  els.toast.classList.toggle('is-error', error);
  els.toastAction.hidden = !actionLabel;
  if (actionLabel) els.toastAction.textContent = actionLabel;
  toastHandler = onAction;
  els.toast.hidden = false;
  armToast(error ? 9000 : duration);
}

els.toastAction.addEventListener('click', () => {
  const handler = toastHandler;
  hideToast();
  handler?.();
});
els.toastClose.addEventListener('click', hideToast);
els.toast.addEventListener('pointerenter', () => window.clearTimeout(toastTimer));
els.toast.addEventListener('pointerleave', () => armToast(3000));
els.toast.addEventListener('focusin', () => window.clearTimeout(toastTimer));
els.toast.addEventListener('focusout', () => armToast(3000));

function offerUndo(message, undoFn) {
  undoAction = undoFn;
  showToast(message, { actionLabel: 'Отменить', onAction: undo });
}

function undo() {
  if (!undoAction) return;
  const fn = undoAction;
  undoAction = null;
  const next = fn();
  if (!next) return;
  commit(next);
  showToast('Вернули как было', { duration: 2500 });
  announce('Действие отменено');
}

/* ───────────── Новая задача ───────────── */

function setComposerError(message) {
  els.error.textContent = message;
  els.input.setAttribute('aria-invalid', message ? 'true' : 'false');
  els.composer.classList.toggle('is-invalid', Boolean(message));
  if (message && !motionOff.matches) {
    els.composer.classList.remove('is-shaking');
    void els.composer.offsetWidth;
    els.composer.classList.add('is-shaking');
  }
}

function updateCounter() {
  const len = S.textLength(els.input.value.trim());
  const max = S.LIMITS.TEXT_MAX;
  const show = len >= max - 40;
  els.counter.hidden = !show;
  els.counter.textContent = show ? `${len} / ${max}` : '';
  els.counter.classList.toggle('is-over', len > max);
  if (els.error.textContent && len > 0 && len <= max) setComposerError('');
}

function setComposerImportant(on) {
  state.composerImportant = on;
  els.star.setAttribute('aria-pressed', String(on));
  els.star.setAttribute('aria-label', on ? 'Новая задача будет важной' : 'Отметить новую задачу как важную');
}

function handleAdd(event) {
  event.preventDefault();
  const raw = els.input.value;
  if (S.textLength(raw.trim()) > S.LIMITS.TEXT_MAX) {
    setComposerError(`Слишком длинно: не больше ${S.LIMITS.TEXT_MAX} символов.`);
    return;
  }
  const result = S.addTask(state.tasks, raw, { important: state.composerImportant });
  if (result.error === S.ERR.EMPTY) {
    setComposerError('Напишите хотя бы пару слов.');
    els.input.focus();
    return;
  }
  if (result.error === S.ERR.LIMIT) {
    setComposerError(`В списке уже ${S.LIMITS.TASKS_MAX} задач. Удалите выполненные, чтобы добавить новые.`);
    return;
  }
  setComposerError('');
  justAddedId = result.task.id;
  // Новая задача должна быть видна: подстраиваем фильтр и поиск.
  if (state.filter === 'done' || (state.filter === 'important' && !result.task.important)) setFilter('all', { silent: true });
  if (state.query) setQuery('', { silent: true });
  commit(result.tasks);
  els.input.value = '';
  setComposerImportant(false);
  updateCounter();
  els.input.focus();
  announce(`Добавлено: ${result.task.text}`);
}

/* ───────────── Действия над задачами ───────────── */

function toggle(id) {
  const result = S.toggleTask(state.tasks, id);
  if (result.error) return;
  const task = result.tasks.find((t) => t.id === id);
  if (task?.done) justDoneId = id;
  commit(result.tasks);
  if (task) announce(task.done ? 'Отмечено как выполненное' : 'Возвращено в работу');
  const li = nodes.get(id);
  if (li) $('.task__toggle', li).focus({ preventScroll: true });
  else els.input.focus({ preventScroll: true });
}

/** Класс элемента задачи, на котором сейчас фокус: после перерисовки вернём фокус туда же. */
function focusedPart(id) {
  const li = nodes.get(id);
  const el = document.activeElement;
  if (!li || !li.contains(el)) return null;
  return [...el.classList].find((c) => c.startsWith('task__')) ?? null;
}

function toggleStar(id) {
  const part = focusedPart(id) ?? 'task__star';
  const result = S.toggleImportant(state.tasks, id);
  if (result.error) return;
  commit(result.tasks);
  const task = result.tasks.find((t) => t.id === id);
  if (task) announce(task.important ? 'Отмечено как важное' : 'Убрано из важных');
  const li = nodes.get(id);
  if (li) $(`.${part}`, li)?.focus({ preventScroll: true });
}

function neighbourId(id) {
  const visible = S.viewTasks(state.tasks, state.filter, state.query);
  const i = visible.findIndex((t) => t.id === id);
  return (visible[i + 1] ?? visible[i - 1])?.id ?? null;
}

function remove(id, { animate = true } = {}) {
  const li = nodes.get(id);
  if (!li || li.classList.contains('is-leaving')) return;
  if (state.editingId === id) finishEdit(false);
  const hadFocus = li.contains(document.activeElement);
  const nextId = neighbourId(id);

  const apply = () => {
    const result = S.removeTask(state.tasks, id);
    if (result.error) return;
    commit(result.tasks);
    const { removed, index } = result;
    offerUndo('Задача удалена', () => S.restoreTask(state.tasks, removed, index).tasks ?? null);
    announce(`Удалено: ${removed.text}`);
    if (hadFocus) {
      const next = nextId && nodes.get(nextId);
      (next ? $('.task__toggle', next) : els.input).focus({ preventScroll: true });
    }
  };

  if (!animate || motionOff.matches) {
    apply();
  } else {
    li.classList.add('is-leaving');
    window.setTimeout(apply, 220);
  }
}

function clearDone() {
  const indexed = state.tasks.map((t, i) => [t, i]).filter(([t]) => t.done);
  if (indexed.length === 0) return;
  commit(S.clearCompleted(state.tasks).tasks);
  const n = indexed.length;
  offerUndo(`Удалено ${n} ${plural(n, ['выполненная задача', 'выполненные задачи', 'выполненных задач'])}`, () => {
    let list = state.tasks;
    for (const [task, index] of indexed) list = S.restoreTask(list, task, index).tasks ?? list;
    return list;
  });
}

/* ── Редактирование ── */

function startEdit(id) {
  if (state.editingId === id) return;
  if (state.editingId) finishEdit(true);
  const li = nodes.get(id);
  const task = state.tasks.find((t) => t.id === id);
  if (!li || !task) return;

  state.editingId = id;
  li.dataset.editing = '1';
  const body = $('.task__body', li);
  $('.task__text', li).hidden = true;
  $('.task__meta', li).hidden = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task__edit-input';
  input.value = task.text;
  input.maxLength = 600;
  input.setAttribute('aria-label', 'Текст задачи');
  input.setAttribute('enterkeyhint', 'done');
  const hint = document.createElement('p');
  hint.className = 'task__edit-hint';
  hint.textContent = 'Enter сохранит, Esc отменит';
  body.append(input, hint);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEdit(true, { refocus: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishEdit(false, { refocus: true });
    }
  });
  input.addEventListener('blur', () => finishEdit(true));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function finishEdit(save, { refocus = false } = {}) {
  const id = state.editingId;
  if (!id) return;
  state.editingId = null;
  const li = nodes.get(id);
  if (!li) return;
  const input = $('.task__edit-input', li);
  const value = input ? input.value : '';
  input?.remove();
  $('.task__edit-hint', li)?.remove();
  $('.task__text', li).hidden = false;
  $('.task__meta', li).hidden = false;
  delete li.dataset.editing;

  if (save) {
    if (S.textLength(value.trim()) > S.LIMITS.TEXT_MAX) showToast(`Текст сокращён до ${S.LIMITS.TEXT_MAX} символов.`);
    const result = S.updateTaskText(state.tasks, id, value);
    if (result.error === S.ERR.EMPTY) showToast('Пустую задачу сохранить нельзя, оставили прежний текст.');
    else if (!result.error) commit(result.tasks);
  }
  render();
  const node = nodes.get(id);
  if (refocus && node) $('.task__toggle', node).focus({ preventScroll: true });
}

/* ── Фильтры и поиск ── */

function setFilter(filter, { silent = false } = {}) {
  if (!S.FILTERS.includes(filter)) return;
  if (state.editingId) finishEdit(true);
  state.filter = filter;
  writePref(PREF.filter, filter);
  if (!silent) {
    render();
    announce(`${FILTER_TITLES[filter]}: ${els.list.children.length}`);
  }
}

function setQuery(value, { silent = false } = {}) {
  state.query = S.sanitizeText(value, S.LIMITS.QUERY_MAX);
  if (els.search.value !== value && !value) els.search.value = '';
  if (!silent) render();
}

/* ───────────── Свайп для удаления (сенсорные экраны) ───────────── */

let swipe = null;

els.list.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || !e.isPrimary) return;
  const li = e.target.closest('.task');
  if (!li || li.dataset.editing || e.target.closest('input, .task__actions')) return;
  swipe = { li, row: $('.task__row', li), x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId };
});

els.list.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 12) { swipe = null; return; }
    if (dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swipe.active = true;
      swipe.li.classList.add('is-swiping', 'is-dragging');
      try { swipe.row.setPointerCapture(e.pointerId); } catch { /* не критично */ }
    } else return;
  }
  swipe.dx = Math.min(0, dx);
  swipe.row.style.transform = `translateX(${swipe.dx}px)`;
});

function endSwipe(e) {
  if (!swipe || (e && e.pointerId !== swipe.id)) return;
  const { li, row, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  li.classList.remove('is-dragging');
  li.dataset.swiped = '1'; // гасим клик, который придёт после жеста
  window.setTimeout(() => delete li.dataset.swiped, 400);
  const width = row.getBoundingClientRect().width || 1;
  if (e?.type === 'pointerup' && -dx > width * 0.35) {
    row.style.transform = 'translateX(-110%)';
    window.setTimeout(() => remove(li.dataset.id, { animate: false }), 180);
  } else {
    row.style.transform = '';
    window.setTimeout(() => li.classList.remove('is-swiping'), 280);
  }
}
els.list.addEventListener('pointerup', endSwipe);
els.list.addEventListener('pointercancel', endSwipe);

/* ───────────── Тема ───────────── */

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: 'как в системе', light: 'светлая', dark: 'тёмная' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(pref) {
  const mode = THEMES.includes(pref) ? pref : 'auto';
  const theme = mode === 'auto' ? (systemDark.matches ? 'dark' : 'light') : mode;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', mode);
  els.themeButton.setAttribute('aria-label', `Тема: ${THEME_LABELS[mode]}. Нажмите, чтобы сменить`);
  els.themeButton.title = `Тема: ${THEME_LABELS[mode]}`;
  for (const meta of $$('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#0d0d12' : '#f4f2ec');
}

els.themeButton.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme-pref') || 'auto';
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  applyTheme(next);
  writePref(PREF.theme, next);
  showToast(`Тема: ${THEME_LABELS[next]}`, { duration: 1600 });
});
systemDark.addEventListener('change', () => applyTheme(document.documentElement.getAttribute('data-theme-pref')));

/* ───────────── Меню ───────────── */

const menuItems = () => $$('[role="menuitem"]', els.menuList);

function openMenu() {
  els.menuList.hidden = false;
  els.menuButton.setAttribute('aria-expanded', 'true');
  menuItems()[0]?.focus();
}
function closeMenu({ refocus = false } = {}) {
  if (els.menuList.hidden) return;
  els.menuList.hidden = true;
  els.menuButton.setAttribute('aria-expanded', 'false');
  if (refocus) els.menuButton.focus();
}

els.menuButton.addEventListener('click', () => (els.menuList.hidden ? openMenu() : closeMenu()));
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});
els.menuList.addEventListener('keydown', (e) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items.at(-1).focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ refocus: true }); }
  else if (e.key === 'Tab') closeMenu();
});
els.menuList.addEventListener('click', (e) => {
  const item = e.target.closest('[data-action]');
  if (!item) return;
  closeMenu();
  if (item.dataset.action === 'export') exportTasks();
  if (item.dataset.action === 'import') els.importInput.click();
  if (item.dataset.action === 'keys') openDialog(els.keysDialog);
});

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
    return true;
  }
  return false;
}

/* ───────────── Резервная копия ───────────── */

function exportTasks() {
  const blob = new Blob([S.serializeState(state.tasks)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sdelano-${new Date().toISOString().slice(0, 10)}.json`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  const n = state.tasks.length;
  showToast(`Сохранено в файл: ${n} ${tasksWord(n)}`, { duration: 3000 });
}

function mergeTasks(current, incoming) {
  const ids = new Set(current.map((t) => t.id));
  return S.normalizeTasks([...current, ...incoming.filter((t) => !ids.has(t.id))]);
}

function applyImport(mode, incoming) {
  const previous = state.tasks;
  const next = mode === 'replace' ? incoming : mergeTasks(previous, incoming);
  if (state.editingId) finishEdit(false);
  commit(next);
  const n = mode === 'replace' ? next.length : next.length - previous.length;
  offerUndo(mode === 'replace' ? `Загружено: ${n} ${tasksWord(n)}` : `Добавлено: ${n} ${tasksWord(n)}`, () => previous);
}

els.importInput.addEventListener('change', async () => {
  const file = els.importInput.files?.[0];
  els.importInput.value = '';
  if (!file) return;
  if (file.size > S.LIMITS.IMPORT_BYTES_MAX) {
    showToast('Файл слишком большой: максимум 1 МБ.', { error: true });
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    showToast('Не удалось прочитать файл.', { error: true });
    return;
  }
  const result = S.parseImport(text);
  if (result.error) {
    showToast('Это не похоже на копию списка «Сделано».', { error: true });
    return;
  }
  if (result.tasks.length === 0) {
    showToast('В файле нет ни одной корректной задачи.', { error: true });
    return;
  }
  if (state.tasks.length === 0) {
    applyImport('replace', result.tasks);
    return;
  }
  const n = result.tasks.length;
  els.importText.textContent =
    `В файле ${n} ${tasksWord(n)}, в списке сейчас ${state.tasks.length}. ` +
    'Можно добавить новые задачи к текущим или заменить список целиком. Любой вариант можно будет отменить.';
  els.importDialog.returnValue = 'cancel';
  els.importDialog.addEventListener('close', () => {
    const mode = els.importDialog.returnValue;
    if (mode === 'replace' || mode === 'merge') applyImport(mode, result.tasks);
  }, { once: true });
  if (!openDialog(els.importDialog)) applyImport('merge', result.tasks); // старый браузер: безопасный вариант
});

/* ───────────── Синхронизация между вкладками ───────────── */

window.addEventListener('storage', (e) => {
  if (e.storageArea !== storage) return;
  if (e.key === S.STORAGE_KEY || e.key === null) {
    const parsed = e.newValue === null ? { ok: true, tasks: [] } : S.parseState(e.newValue);
    if (!parsed.ok) return;
    if (state.editingId && !parsed.tasks.some((t) => t.id === state.editingId)) finishEdit(false);
    state.tasks = parsed.tasks;
    render();
  }
  if (e.key === PREF.theme) applyTheme(e.newValue);
});

/* ───────────── События ───────────── */

els.composer.addEventListener('submit', handleAdd);
els.input.addEventListener('input', updateCounter);
els.star.addEventListener('click', () => setComposerImportant(!state.composerImportant));
els.search.addEventListener('input', () => setQuery(els.search.value));
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.search.value) {
    e.preventDefault();
    e.stopPropagation();
    els.search.value = '';
    setQuery('');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const first = els.list.querySelector('.task__toggle');
    first?.focus();
  }
});
els.clearDone.addEventListener('click', clearDone);
for (const button of els.filters) button.addEventListener('click', () => setFilter(button.dataset.filter));

els.list.addEventListener('change', (e) => {
  if (!e.target.matches('.task__toggle')) return;
  const id = e.target.closest('.task')?.dataset.id;
  if (id) toggle(id);
});

els.list.addEventListener('click', (e) => {
  const li = e.target.closest('.task');
  if (!li) return;
  if (li.dataset.swiped) {
    e.preventDefault();
    return;
  }
  const id = li.dataset.id;
  if (e.target.closest('.task__delete')) remove(id);
  else if (e.target.closest('.task__edit')) startEdit(id);
  else if (e.target.closest('.task__star')) toggleStar(id);
  else if (coarsePointer.matches && e.target.closest('.task__text')) startEdit(id);
});

els.list.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.task__text')) return;
  const id = e.target.closest('.task')?.dataset.id;
  if (id) startEdit(id);
});

// Клавиши внутри списка: стрелки, E, S, Delete.
els.list.addEventListener('keydown', (e) => {
  const li = e.target.closest('.task');
  if (!li || li.dataset.editing || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const id = li.dataset.id;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const sibling = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
    if (!sibling) return;
    const cls = [...e.target.classList].find((c) => c.startsWith('task__')) || 'task__toggle';
    ($(`.${cls}`, sibling) || $('.task__toggle', sibling)).focus();
  } else if (e.code === 'KeyE') {
    e.preventDefault();
    startEdit(id);
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    toggleStar(id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    remove(id);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if ($$('dialog[open]').length) return;
  const typing = isTypingTarget(e.target);
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    if (!els.menuList.hidden) { closeMenu({ refocus: true }); return; }
    if (!els.toast.hidden) { hideToast(); return; }
    if (state.query) { els.search.value = ''; setQuery(''); return; }
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyZ' && !typing && undoAction) {
    e.preventDefault();
    undo();
    return;
  }
  if (typing || mod || e.altKey) return;
  if (e.code === 'KeyN') { e.preventDefault(); els.input.focus(); }
  else if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); }
  else if (e.key === '?') { e.preventDefault(); openDialog(els.keysDialog); }
  else if (['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code) && !e.target.closest?.('.task')) {
    e.preventDefault();
    setFilter(S.FILTERS[Number(e.code.slice(-1)) - 1]);
  }
});

// Возвращение на вкладку и смена часа: обновляем приветствие и «сегодня/вчера».
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});
window.setInterval(() => {
  if (document.visibilityState === 'visible' && !state.editingId) renderHero(S.stats(state.tasks));
}, 60_000);

// Непредвиденная ошибка не должна оставлять человека в неведении.
let errorShown = false;
function reportUnexpected() {
  if (errorShown) return;
  errorShown = true;
  showToast('Что-то пошло не так. Задачи сохранены, просто обновите страницу.', { error: true });
}
window.addEventListener('error', (e) => {
  if (e.filename && !e.filename.startsWith(window.location.origin)) return;
  reportUnexpected();
});
window.addEventListener('unhandledrejection', reportUnexpected);

/* ───────────── Старт ───────────── */

function init() {
  const loaded = repo.load();
  state.tasks = loaded.tasks;
  const savedFilter = readPref(PREF.filter);
  if (S.FILTERS.includes(savedFilter)) state.filter = savedFilter;
  applyTheme(readPref(PREF.theme) || 'auto');

  if (!loaded.available) els.notice.hidden = false;
  if (loaded.source === 'backup') {
    showToast('Данные были повреждены, мы восстановили их из резервной копии.', { duration: 8000 });
  } else if (loaded.source === 'corrupt') {
    showToast('Сохранённые данные повреждены и не читаются. Начинаем с чистого списка.', { error: true });
  }
  render();
  document.documentElement.classList.add('is-ready');
}

init();

/* ───────────── Офлайн-режим ───────────── */

if (window.isSecureContext && 'serviceWorker' in navigator) {
  let swUrl = './sw.js';
  // Под Trusted Types адрес воркера должен пройти через разрешённую политику.
  if (window.trustedTypes?.createPolicy) {
    const policy = window.trustedTypes.createPolicy('sdelano-sw', {
      createScriptURL: (url) => {
        if (url === './sw.js') return url;
        throw new TypeError('Запрещённый адрес скрипта');
      },
    });
    swUrl = policy.createScriptURL('./sw.js');
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swUrl, { scope: './' }).catch(() => {
      /* офлайн-режим лишь улучшение, сайт работает и без него */
    });
  });
}
