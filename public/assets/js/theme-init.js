// Выполняется синхронно в <head>, до отрисовки: тема применяется без мигания.
// Настройка ('auto' | 'light' | 'dark') хранится в localStorage.
(function () {
  var pref = 'auto';
  try {
    var saved = window.localStorage.getItem('sdelano:theme');
    if (saved === 'light' || saved === 'dark' || saved === 'auto') pref = saved;
  } catch (e) {
    /* хранилище недоступно: берём системную тему */
  }
  var dark = pref === 'dark' || (pref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
})();
