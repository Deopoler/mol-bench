/* Museum of Light — lobby. Classic script (works from file:// too). Room data comes from window.__benchHost. */
(function () {
  'use strict';

  var STR = {
    ko: {
      skip: '본문으로 건너뛰기',
      lead: '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 빛과 기억이 포개지는 전시를 천천히 거닐어 보세요. 머무는 동안 각자의 이야기를 발견할 수 있습니다.',
      roomsHeading: '전시 공간',
      emptyTitle: '아직 공개된 방이 없습니다.',
      emptyBody: '곧 새로운 방을 만나 보실 수 있어요.',
      infoHeading: '관람 안내',
      info1: '방 제목을 누르면 입장합니다. 브라우저의 뒤로 가기로 입구에 돌아올 수 있어요.',
      info2: '준비 중인 방은 아직 입장할 수 없습니다.',
      info3: '빛과 기억을 천천히 따라가 보세요. 서두를 필요는 없습니다.',
      back: '← 전시 공간으로',
      footerLink: '입구로 돌아가기',
      statusOpen: '공개 중',
      statusSoon: '준비 중',
      heroTitle: '빛의 방에 오신 것을 환영합니다',
      themeToDark: '어두운 테마',
      themeToLight: '밝은 테마',
      langToggle: 'English'
    },
    en: {
      skip: 'Skip to content',
      lead: 'Each room is a small world for a different sense and a different thought. Walk slowly through exhibitions where light and memory overlap. Discover your own story while you stay.',
      roomsHeading: 'Rooms',
      emptyTitle: 'No rooms are open yet.',
      emptyBody: 'New rooms will appear here soon.',
      infoHeading: 'Visitor guide',
      info1: 'Select a room title to enter. Use the browser Back button to return to the entrance.',
      info2: 'Rooms marked as coming soon cannot be entered yet.',
      info3: 'Follow light and memory at your own pace. There is no need to hurry.',
      back: '← Back to rooms',
      footerLink: 'Back to entrance',
      statusOpen: 'Open',
      statusSoon: 'Coming soon',
      heroTitle: 'Welcome to the Rooms of Light',
      themeToDark: 'Dark theme',
      themeToLight: 'Light theme',
      langToggle: '한국어'
    }
  };

  var root = document.documentElement;
  var mainEl = document.getElementById('main');
  var heroTitle = document.getElementById('hero-title');
  var lobbyView = document.getElementById('lobby-view');
  var roomView = document.getElementById('room-view');
  var roomsEl = document.getElementById('rooms');
  var emptyEl = document.querySelector('[data-bench="empty-state"]');
  var roomStatus = document.getElementById('room-status');
  var roomSummary = document.getElementById('room-summary');
  var roomSwatch = roomView.querySelector('.swatch');
  var themeBtn = document.querySelector('[data-bench="theme-toggle"]');
  var langBtn = document.querySelector('[data-bench="lang-toggle"]');
  var skipLink = document.querySelector('.skip-link');
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function readStored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writeStored(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }

  // Korean is the primary language; English only when the visitor picked it before.
  var stored = readStored('mol-lang');
  var lang = stored === 'en' ? 'en' : 'ko';

  var rendered = null; // 'lobby' or the open room id currently on screen
  var lastLobbyScroll = 0;

  function rooms() {
    var host = window.__benchHost;
    var list = host && host.params && host.params.rooms;
    return Array.isArray(list) ? list : [];
  }

  function findOpenRoom(id) {
    var list = rooms();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id && list[i].status === 'open') return list[i];
    }
    return null;
  }

  function routeFromHash() {
    var m = /^#\/room\/(.+)$/.exec(location.hash);
    if (!m) return 'lobby';
    var id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return 'lobby'; }
    return findOpenRoom(id) ? id : 'lobby';
  }

  function effectiveTheme() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return mq.matches ? 'dark' : 'light';
  }

  function titleOf(room) { return lang === 'en' && room.title_en ? room.title_en : room.title_ko; }
  function langOf(room) { return lang === 'en' && room.title_en ? 'en' : 'ko'; }

  function accentOf(room) {
    var a = room.accent_oklch;
    if (!Array.isArray(a) || a.length < 3) return 'var(--line)';
    var L = Number(a[0]) <= 1 ? Number(a[0]) * 100 : Number(a[0]);
    var C = Math.max(0, Math.min(0.4, Number(a[1])));
    var H = Number(a[2]);
    if (!isFinite(L) || !isFinite(C) || !isFinite(H)) return 'var(--line)';
    return 'oklch(' + L.toFixed(1) + '% ' + C.toFixed(3) + ' ' + H.toFixed(1) + ')';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function applyText() {
    root.lang = lang;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (STR[lang][key] !== undefined) {
        nodes[i].textContent = STR[lang][key];
        nodes[i].lang = lang;
      }
    }
    langBtn.textContent = STR[lang].langToggle;
    langBtn.lang = lang === 'ko' ? 'en' : 'ko';
    updateTheme();
  }

  function updateTheme() {
    themeBtn.textContent = STR[lang][effectiveTheme() === 'dark' ? 'themeToLight' : 'themeToDark'];
  }

  function buildCard(room) {
    var open = room.status === 'open';
    var card = el('article', 'room-card');
    card.setAttribute('data-bench', 'room-card');
    card.setAttribute('data-status', open ? 'open' : 'coming_soon');
    card.setAttribute('data-room-id', String(room.id));
    card.style.setProperty('--accent', accentOf(room));

    if (!open) {
      // Only coming-soon cards carry a badge; open cards stay quiet and the summary is shown inside the room.
      var badge = el('span', 'status-badge', STR[lang].statusSoon);
      badge.lang = lang;
      card.appendChild(badge);
    }

    var h3 = el('h3', 'card-title');
    h3.lang = langOf(room);
    var title = titleOf(room);
    if (open) {
      var link = document.createElement('a');
      link.href = room.route || ('#/room/' + encodeURIComponent(String(room.id)));
      link.textContent = title;
      h3.appendChild(link);
    } else {
      h3.textContent = title;
    }
    card.appendChild(h3);
    return card;
  }

  function renderRooms() {
    var list = rooms();
    var cards = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) cards.push(buildCard(list[i]));
    }
    roomsEl.replaceChildren.apply(roomsEl, cards);
    emptyEl.hidden = cards.length > 0;
  }

  // Sets the hero title and the room panel for whatever is currently rendered.
  function paintHero() {
    var room = rendered && rendered !== 'lobby' ? findOpenRoom(rendered) : null;
    if (room) {
      heroTitle.textContent = titleOf(room);
      heroTitle.lang = langOf(room);
      roomSwatch.style.setProperty('--accent', accentOf(room));
      roomStatus.textContent = STR[lang].statusOpen;
      roomStatus.lang = lang;
      roomSummary.textContent = room.summary_ko || '';
      roomSummary.lang = 'ko';
    } else {
      heroTitle.textContent = STR[lang].heroTitle;
      heroTitle.lang = lang;
    }
  }

  function animateIn(node, initial) {
    if (initial) return;
    node.classList.remove('is-entering');
    void node.offsetWidth; // restart the CSS animation
    node.classList.add('is-entering');
  }

  // Brings the screen in line with location.hash. Idempotent.
  function sync(opts) {
    var initial = !!(opts && opts.initial);
    var next = routeFromHash();
    if (next !== rendered) {
      var prev = rendered;
      if (next === 'lobby') {
        rendered = 'lobby';
        roomView.hidden = true;
        lobbyView.hidden = false;
        animateIn(lobbyView, initial);
        if (prev && prev !== 'lobby') window.scrollTo(0, lastLobbyScroll);
      } else {
        if (!prev || prev === 'lobby') lastLobbyScroll = window.scrollY;
        rendered = next;
        lobbyView.hidden = true;
        roomView.hidden = false;
        animateIn(roomView, initial);
        window.scrollTo(0, 0);
        if (!initial) heroTitle.focus({ preventScroll: true });
      }
      paintHero();
    }
  }

  function renderAll() {
    applyText();
    renderRooms();
    paintHero();
  }

  themeBtn.addEventListener('click', function () {
    root.setAttribute('data-theme', effectiveTheme() === 'dark' ? 'light' : 'dark');
    updateTheme();
  });

  langBtn.addEventListener('click', function () {
    lang = lang === 'ko' ? 'en' : 'ko';
    writeStored('mol-lang', lang);
    renderAll();
  });

  skipLink.addEventListener('click', function (event) {
    event.preventDefault();
    mainEl.focus();
  });

  mq.addEventListener('change', updateTheme);
  window.addEventListener('hashchange', function () { sync({}); });

  renderAll();
  sync({ initial: true });

  window.__bench = {
    version: 1,
    ready: document.fonts ? document.fonts.ready.then(function () { }) : Promise.resolve(),
    setSeed: function () {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      rendered = null;
      renderAll();
      sync({ initial: true });
    },
    seek: function () { /* no time-driven state in the lobby */ },
    resume: function () { /* no time-driven state in the lobby */ },
    renderFrame: function () {
      sync({});
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
      });
    },
    state: function () {
      sync({});
      return { route: rendered || 'lobby', lang: lang, theme: effectiveTheme() };
    },
    stats: function () { return { drawCalls: 0, triangles: 0 }; }
  };
})();
