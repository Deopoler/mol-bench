/* Museum of Light — lobby runtime.
 * Rooms come from window.__benchHost.params.rooms. No wall-clock time, no randomness:
 * the rendered state is a pure function of (params, hash route, language, theme, media). */
(function () {
  'use strict';

  var root = document.documentElement;
  var $ = function (s) { return document.querySelector(s); };

  var STR = {
    skip: { ko: '본문으로 건너뛰기', en: 'Skip to content' },
    eyebrow: { ko: '디지털 전시관 · 로비', en: 'Digital galleries · Lobby' },
    hero: { ko: '빛의 방에 오신 것을 환영합니다', en: 'Welcome to the rooms of light' },
    lede: {
      ko: '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 서두르지 않고 천천히 거닐며, 마음이 머무는 방의 문을 열어 보세요.',
      en: 'Each room is a small world made for a different sense and a different thought. Wander without hurry, and open the door of whichever room holds your attention.'
    },
    cta: { ko: '전시 공간 둘러보기', en: 'Browse the rooms' },
    roomsTitle: { ko: '전시 공간', en: 'Rooms' },
    empty: {
      ko: '아직 공개된 방이 없습니다. 새로운 전시가 준비되면 이곳에서 가장 먼저 만나 보실 수 있습니다.',
      en: 'No rooms are open yet. When a new exhibition is ready, you will meet it here first.'
    },
    infoTitle: { ko: '관람 안내', en: 'Visitor guide' },
    info1: {
      ko: 'Museum of Light는 빛으로 지은 디지털 방들을 모아 둔 작은 박물관입니다. 별도의 설치나 예약 없이 이 페이지에서 바로 각 방으로 들어갈 수 있고, 돌아올 때는 브라우저의 뒤로 가기를 쓰면 보던 자리로 돌아옵니다.',
      en: "Museum of Light is a small museum of digital rooms built from light. There is nothing to install and no ticket to book: enter any room straight from this page, and use your browser's back button to return to the place where you left off."
    },
    info2: {
      ko: '키보드만으로도 모든 방을 둘러볼 수 있습니다. 탭 키로 이동하고 엔터 키로 입장하세요. 화면 오른쪽 위에서 언어와 밝기를 바꿀 수 있으며, 움직임을 줄이는 설정을 켜 두셨다면 전환 효과는 거의 보이지 않습니다.',
      en: 'Every room can be reached by keyboard alone. Press Tab to move and Enter to step inside. Language and brightness can be changed at the top right, and if you have asked your system to reduce motion, transitions are almost invisible.'
    },
    tagline: { ko: '빛으로 지은 디지털 방들', en: 'Digital rooms built from light' },
    back: { ko: '← 로비로 돌아가기', en: '← Back to the lobby' },
    enter: { ko: '입장하기 →', en: 'Enter →' },
    soon: { ko: '곧 공개', en: 'Coming soon' },
    soonCta: { ko: '준비 중입니다', en: 'In preparation' },
    themeToDark: { ko: '다크 모드', en: 'Dark mode' },
    themeToLight: { ko: '라이트 모드', en: 'Light mode' },
    titleLobby: { ko: 'Museum of Light — 로비', en: 'Museum of Light — Lobby' },
    room: { ko: '방', en: 'Room' }
  };

  var state = {
    lang: root.lang === 'en' ? 'en' : 'ko',
    theme: root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    route: 'lobby',
    rooms: [],
    lobbyScroll: 0,
    lastCardId: null,
    ready: false
  };

  function t(key) { return STR[key][state.lang]; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function str(v) { return typeof v === 'string' ? v : ''; }

  function el(tag, cls, text, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (attrs) for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---------- data ---------- */
  function readRooms() {
    var p = window.__benchHost && window.__benchHost.params;
    var list = p && Array.isArray(p.rooms) ? p.rooms : [];
    return list.filter(function (r) { return r && typeof r === 'object' && r.id != null; }).map(function (r) {
      var a = Array.isArray(r.accent_oklch) ? r.accent_oklch : [];
      var L = +a[0], C = +a[1], H = +a[2];
      return {
        id: String(r.id),
        route: str(r.route) || '#/room/' + encodeURIComponent(String(r.id)),
        title_ko: str(r.title_ko) || str(r.title_en) || String(r.id),
        title_en: str(r.title_en),
        summary_ko: str(r.summary_ko),
        accent: [isFinite(L) ? L : 0.68, isFinite(C) ? C : 0.12, isFinite(H) ? H : 80],
        status: r.status === 'coming_soon' ? 'coming_soon' : 'open'
      };
    });
  }

  /* Title in the active language; falls back to Korean when no English title exists. */
  function titleOf(r) {
    if (state.lang === 'en' && r.title_en) return { text: r.title_en, lang: 'en' };
    return { text: r.title_ko, lang: 'ko' };
  }
  function altOf(r) {
    if (state.lang === 'en') return r.title_en ? { text: r.title_ko, lang: 'ko' } : null;
    return r.title_en ? { text: r.title_en, lang: 'en' } : null;
  }
  function accentStyle(node, r) {
    node.style.setProperty('--l', String(r.accent[0]));
    node.style.setProperty('--c', String(r.accent[1]));
    node.style.setProperty('--h', String(r.accent[2]));
  }

  /* ---------- rendering ---------- */
  function renderRooms() {
    var list = $('#rooms');
    list.replaceChildren();
    var open = 0, soon = 0;
    state.rooms.forEach(function (r, i) {
      var isOpen = r.status === 'open';
      if (isOpen) open++; else soon++;
      var ttl = titleOf(r), alt = altOf(r);

      var li = el('li');
      var card = el('article', 'card' + (isOpen ? '' : ' card-soon'), null, {
        'data-bench': 'room-card',
        'data-status': r.status,
        'data-room-id': r.id
      });
      accentStyle(card, r);
      var body = isOpen ? el('a', 'card-body', null, { href: r.route }) : el('div', 'card-body');

      body.appendChild(el('span', 'swatch', null, { 'aria-hidden': 'true' }));
      var meta = el('span', 'card-meta');
      meta.appendChild(el('span', null, t('room') + ' ' + pad2(i + 1)));
      if (!isOpen) meta.appendChild(el('span', 'badge', t('soon')));
      body.appendChild(meta);
      body.appendChild(el('h3', 'card-title', ttl.text, ttl.lang !== state.lang ? { lang: ttl.lang } : null));
      if (alt) body.appendChild(el('span', 'card-alt', alt.text, { lang: alt.lang }));
      if (r.summary_ko) body.appendChild(el('p', 'card-summary', r.summary_ko, { lang: 'ko' }));
      body.appendChild(el('span', 'card-cta', isOpen ? t('enter') : t('soonCta')));

      card.appendChild(body);
      li.appendChild(card);
      list.appendChild(li);
    });

    var has = state.rooms.length > 0;
    list.hidden = !has;
    $('[data-bench="empty-state"]').hidden = has;
    var count = $('#count');
    count.hidden = !has;
    count.textContent = state.lang === 'en'
      ? open + ' open' + (soon ? ' · ' + soon + ' coming soon' : '')
      : '열린 방 ' + open + '곳' + (soon ? ' · 곧 공개 ' + soon + '곳' : '');
  }

  function renderRoomView() {
    var r = state.rooms.filter(function (x) { return x.id === state.route; })[0];
    if (!r) return;
    var idx = state.rooms.indexOf(r) + 1;
    var ttl = titleOf(r), alt = altOf(r);
    var h1 = $('#room-title');
    h1.textContent = ttl.text;
    if (ttl.lang !== state.lang) h1.setAttribute('lang', ttl.lang); else h1.removeAttribute('lang');
    var altEl = $('#room-alt');
    altEl.hidden = !alt;
    if (alt) { altEl.textContent = alt.text; altEl.setAttribute('lang', alt.lang); }
    $('#room-eyebrow').textContent = t('room') + ' ' + pad2(idx);
    $('#room-summary').textContent = r.summary_ko;
    $('#room-summary').hidden = !r.summary_ko;
    accentStyle($('#room-swatch'), r);
    document.title = ttl.text + ' — Museum of Light';
  }

  function applyStatic() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    root.lang = state.lang;
    var lt = $('#lang-toggle');
    lt.textContent = state.lang === 'en' ? '한국어' : 'English';
    lt.setAttribute('lang', state.lang === 'en' ? 'ko' : 'en');
    var tt = $('#theme-toggle');
    tt.textContent = state.theme === 'dark' ? t('themeToLight') : t('themeToDark');
    if (state.route === 'lobby') document.title = t('titleLobby');
  }

  function renderAll() {
    applyStatic();
    renderRooms();
    if (state.route !== 'lobby') renderRoomView();
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    var h = location.hash;
    var m = /^#\/room\/(.+)$/.exec(h);
    if (m) {
      var id;
      try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
      for (var i = 0; i < state.rooms.length; i++) {
        if (state.rooms[i].id === id && state.rooms[i].status === 'open') return id;
      }
      return 'lobby';
    }
    if (h === '' || h === '#' || h === '#/' || h === '#/lobby') return 'lobby';
    return state.route; // in-page anchors keep the current view
  }

  function route(opts) {
    opts = opts || {};
    var next = parseRoute();
    if (next === state.route && !opts.force) return;
    var prev = state.route;
    if (prev === 'lobby' && next !== 'lobby') state.lobbyScroll = window.scrollY;
    state.route = next;

    var lobby = $('#lobby-view'), room = $('#room-view');
    var show = next === 'lobby' ? lobby : room;
    var hide = next === 'lobby' ? room : lobby;
    hide.hidden = true;
    hide.classList.remove('enter');
    if (next !== 'lobby') renderRoomView(); else document.title = t('titleLobby');
    show.hidden = false;
    if (opts.animate !== false) {
      show.classList.remove('enter');
      void show.offsetWidth;
      show.classList.add('enter');
    }
    window.scrollTo(0, next === 'lobby' ? state.lobbyScroll : 0);

    if (opts.focus !== false) {
      if (next === 'lobby') {
        var card = state.lastCardId && document.querySelector('[data-room-id="' + CSS.escape(state.lastCardId) + '"] a');
        if (card) card.focus({ preventScroll: true });
      } else {
        $('#room-title').focus({ preventScroll: true });
      }
    }
  }

  /* ---------- events ---------- */
  function setTheme(th) {
    state.theme = th;
    root.setAttribute('data-theme', th);
    applyStatic();
  }
  function setLang(l) {
    state.lang = l;
    try { localStorage.setItem('mol-lang', l); } catch (e) { /* storage may be blocked */ }
    renderAll();
  }

  function wire() {
    $('#lang-toggle').addEventListener('click', function () { setLang(state.lang === 'en' ? 'ko' : 'en'); });
    $('#theme-toggle').addEventListener('click', function () { setTheme(state.theme === 'dark' ? 'light' : 'dark'); });

    // Follow the system scheme whenever it changes (a manual choice lasts until then).
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { setTheme(mq.matches ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);

    $('#cta').addEventListener('click', function () {
      var h = $('#rooms-title');
      h.scrollIntoView({ block: 'start' });
      h.focus({ preventScroll: true });
    });
    document.querySelector('.skip').addEventListener('click', function (e) {
      e.preventDefault();
      $('#main').focus({ preventScroll: false });
    });

    // Room links: keep the router in sync inside the click so the transition starts immediately.
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href^="#/"]');
      if (!a) return;
      var href = a.getAttribute('href');
      var card = a.closest('[data-room-id]');
      if (card) state.lastCardId = card.getAttribute('data-room-id');
      e.preventDefault();
      if (location.hash !== href) location.hash = href;
      route();
    });
    window.addEventListener('hashchange', function () { route(); });
  }

  /* ---------- bench contract ---------- */
  function raf() {
    return new Promise(function (resolve) {
      var done = false;
      var fin = function () { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(function () { requestAnimationFrame(fin); });
      setTimeout(fin, 120);
    });
  }

  function load() {
    state.rooms = readRooms();
    state.route = 'lobby';
    $('#lobby-view').hidden = false;
    $('#room-view').hidden = true;
    renderAll();
    if (parseRoute() !== 'lobby') route({ animate: false, focus: false });
  }

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  wire();
  load();
  state.ready = true;
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { readyResolve(); }, function () { readyResolve(); });

  window.__bench = {
    version: 1,
    ready: ready,
    setSeed: function () {
      // The harness may swap params together with the seed: re-read them and re-render.
      load();
    },
    seek: function () {
      // Static page: finish running CSS transitions so the frame is a pure function of state.
      var anims = document.getAnimations ? document.getAnimations() : [];
      for (var i = 0; i < anims.length; i++) { try { anims[i].finish(); } catch (e) { /* ignore */ } }
    },
    resume: function () {},
    renderFrame: raf,
    state: function () { return { route: state.route, lang: state.lang, theme: state.theme }; },
    stats: function () { return { drawCalls: 0, triangles: 0 }; }
  };
})();
