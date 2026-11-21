(function () {
  'use strict';
  var host = window.__benchHost || { params: {} };
  var rooms = Array.isArray(host.params && host.params.rooms) ? host.params.rooms : [];
  var root = document.documentElement;
  var $ = function (s) { return document.querySelector(s); };

  var T = {
    ko: {
      skip: '본문으로 건너뛰기', eyebrow: '디지털 전시관 · Seoul', hero: '빛의 방에 오신 것을 환영합니다',
      intro: '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 천천히 걸으며 마음이 이끄는 문을 열어 보세요.',
      roomsTitle: '전시 공간', empty: '아직 공개된 방이 없습니다. 곧 새로운 빛이 켜질 거예요.',
      infoTitle: '관람 안내',
      info1: '입장은 언제나 무료이며 예약이 필요하지 않습니다. 모든 방은 화면 어디에서나 열 수 있도록 가볍게 만들어졌습니다.',
      info2: '어두운 화면이 편하다면 오른쪽 위의 버튼으로 밝기를 바꿀 수 있고, 움직임을 줄이는 설정도 그대로 존중합니다.',
      footer: 'Museum of Light · Seoul', back: '← 로비로 돌아가기', enter: '입장하기', soon: '준비 중',
      langBtn: 'EN', langLabel: 'Switch to English', toDark: '다크 모드', toLight: '라이트 모드', themeLabel: '화면 밝기 전환',
      roomLabel: '방'
    },
    en: {
      skip: 'Skip to content', eyebrow: 'A digital museum · Seoul', hero: 'Welcome to the rooms of light',
      intro: 'Each room is a small world for a different sense or thought. Walk slowly and open whichever door calls to you.',
      roomsTitle: 'The rooms', empty: 'No rooms are open yet. New light will be switched on soon.',
      infoTitle: 'Visitor information',
      info1: 'Admission is always free and no reservation is needed. Every room is built to be light enough to open on any screen.',
      info2: 'If a dark screen is easier on your eyes, switch the brightness with the button at the top right. Reduced-motion settings are respected too.',
      footer: 'Museum of Light · Seoul', back: '← Back to the lobby', enter: 'Enter', soon: 'Coming soon',
      langBtn: '한국어', langLabel: '한국어로 전환', toDark: 'Dark mode', toLight: 'Light mode', themeLabel: 'Toggle theme',
      roomLabel: 'Room'
    }
  };

  var lang = 'ko';
  try {
    var saved = localStorage.getItem('mol-lang');
    if (saved === 'en' || saved === 'ko') lang = saved;
  } catch (e) {}

  var theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var lastFocus = null;
  var route = 'lobby';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function accent(r) {
    var a = r.accent_oklch;
    return Array.isArray(a) && a.length === 3 ? 'oklch(' + a[0] + ' ' + a[1] + ' ' + a[2] + ')' : '';
  }
  function title(r) { return lang === 'en' ? (r.title_en || r.title_ko) : r.title_ko; }
  function other(r) { return lang === 'en' ? r.title_ko : r.title_en; }
  function otherLang(r) { return lang === 'en' ? 'ko' : 'en'; }

  function renderRooms() {
    var list = $('#rooms');
    var t = T[lang];
    list.replaceChildren();
    rooms.forEach(function (r) {
      var soon = r.status === 'coming_soon';
      var li = el('li');
      var card = el('article', 'card' + (soon ? ' soon' : ''));
      card.setAttribute('data-bench', 'room-card');
      card.setAttribute('data-status', soon ? 'coming_soon' : 'open');
      card.setAttribute('data-room-id', r.id);
      var ac = accent(r);
      if (ac) card.style.setProperty('--accent', ac);
      var h = el('h3');
      if (soon) {
        h.textContent = title(r);
      } else {
        var a = el('a', null, title(r));
        a.href = r.route;
        h.appendChild(a);
      }
      card.appendChild(h);
      var o = other(r);
      if (o) {
        var sub = el('p', 'sub', o);
        sub.lang = otherLang(r);
        card.appendChild(sub);
      }
      if (r.summary_ko) {
        var sum = el('p', 'sum', r.summary_ko);
        sum.lang = 'ko';
        card.appendChild(sum);
      }
      if (soon) card.appendChild(el('span', 'badge', t.soon));
      else card.appendChild(el('span', 'go', t.enter + ' →')).setAttribute('aria-hidden', 'true');
      li.appendChild(card);
      list.appendChild(li);
    });
    $('#empty-state').hidden = rooms.length > 0;
    $('#rooms-title').parentNode.querySelector('#rooms').hidden = rooms.length === 0;
  }

  function applyText() {
    var t = T[lang];
    root.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (n) { n.textContent = t[n.getAttribute('data-i18n')]; });
    var lb = $('#lang-toggle');
    lb.textContent = t.langBtn; lb.setAttribute('aria-label', t.langLabel);
    lb.lang = lang === 'en' ? 'ko' : 'en';
    var tb = $('#theme-toggle');
    tb.textContent = theme === 'dark' ? t.toLight : t.toDark;
    tb.setAttribute('aria-label', t.themeLabel + ': ' + (theme === 'dark' ? t.toLight : t.toDark));
    tb.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    document.title = lang === 'en' ? 'Museum of Light' : 'Museum of Light — 로비';
  }

  function findOpen(id) {
    for (var i = 0; i < rooms.length; i++) if (rooms[i].id === id && rooms[i].status !== 'coming_soon') return rooms[i];
    return null;
  }

  function renderRoom(r) {
    var t = T[lang];
    $('#room-title').textContent = title(r);
    var sub = $('#room-sub');
    sub.textContent = other(r) || '';
    sub.lang = otherLang(r);
    var sum = $('#room-summary');
    sum.textContent = r.summary_ko || '';
    sum.lang = 'ko';
    var ac = accent(r);
    $('#room').style.setProperty('--accent', ac || '');
    $('#room-back').textContent = t.back;
  }

  var currentRoom = null;
  function syncRoute(initial) {
    var m = /^#\/room\/(.+)$/.exec(location.hash);
    var r = m ? findOpen(decodeURIComponent(m[1])) : null;
    var panel = $('#room'), lobby = $('#lobby');
    var prev = route;
    route = r ? r.id : 'lobby';
    currentRoom = r;
    if (r) {
      renderRoom(r);
      lobby.inert = true;
      lobby.setAttribute('aria-hidden', 'true');
      panel.classList.add('open');
      if (prev === 'lobby' && !initial) lastFocus = document.activeElement;
      if (!initial || true) $('#room-title').focus({ preventScroll: true });
    } else {
      panel.classList.remove('open');
      lobby.inert = false;
      lobby.removeAttribute('aria-hidden');
      if (prev !== 'lobby') {
        var target = lastFocus && document.contains(lastFocus) ? lastFocus : null;
        if (target) target.focus({ preventScroll: true });
      }
    }
    panel.setAttribute('aria-hidden', r ? 'false' : 'true');
  }

  function setLang(l) {
    lang = l;
    try { localStorage.setItem('mol-lang', l); } catch (e) {}
    applyText(); renderRooms();
    if (currentRoom) renderRoom(currentRoom);
  }
  function setTheme(th) {
    theme = th;
    root.setAttribute('data-theme', th);
    applyText();
  }

  $('#lang-toggle').addEventListener('click', function () { setLang(lang === 'ko' ? 'en' : 'ko'); });
  $('#theme-toggle').addEventListener('click', function () { setTheme(theme === 'dark' ? 'light' : 'dark'); });
  window.addEventListener('hashchange', function () { syncRoute(false); });

  root.setAttribute('data-theme', theme);
  applyText();
  renderRooms();
  // Initial route: apply open state without a transition on first paint.
  syncRoute(true);

  function frame() {
    return new Promise(function (res) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { res(); }); });
    });
  }
  var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready.then(function () {}) : Promise.resolve();

  window.__bench = {
    version: 1,
    ready: fontsReady,
    setSeed: function () {
      var h = window.__benchHost;
      rooms = Array.isArray(h && h.params && h.params.rooms) ? h.params.rooms : [];
      renderRooms();
      syncRoute(true);
    },
    seek: function () {},
    resume: function () {},
    renderFrame: function () { return frame(); },
    state: function () { return { route: route, lang: lang, theme: theme }; },
    stats: function () { return { drawCalls: 0, triangles: 0 }; }
  };
})();
