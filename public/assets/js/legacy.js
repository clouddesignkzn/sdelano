// Загружается только браузерами без поддержки ES-модулей (выпущены до 2017 года).
(function () {
  function show() {
    var box = document.createElement('div');
    box.className = 'legacy';
    box.setAttribute('role', 'alert');
    var p = document.createElement('p');
    p.appendChild(document.createTextNode('Этот браузер слишком старый для списка задач. Обновите его или откройте сайт в свежем Chrome, Firefox, Safari или Edge.'));
    box.appendChild(p);
    document.body.appendChild(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
