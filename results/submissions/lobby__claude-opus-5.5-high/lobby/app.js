/* Museum of Light — lobby runtime. No dependencies, no wall-clock time, no unseeded randomness. */
(function () {
  'use strict';

  var LANG_KEY = 'mol-lang';
  var ROUTE_PREFIX = '#/room/';

  var STRINGS = {
    ko: {
      brand: '빛의 미술관',
      langButton: 'English',
      langButtonLang: 'en',
      langButtonLabel: 'Switch to English',
      themeToDark: '어두운 화면',
      themeToLight: '밝은 화면',
      themeToDarkLabel: '어두운 화면으로 바꾸기',
      themeToLightLabel: '밝은 화면으로 바꾸기',
      eyebrow: 'Museum of Light · 디지털 상설관',
      heroTitle: '빛의 방에 오신 것을 환영합니다',
      lead: '이곳은 빛과 기억, 그리고 시간을 주제로 한 작은 디지털 전시실들의 입구입니다. 마음이 가는 방의 문을 열고, 서두르지 말고 천천히 머물러 보세요.',
      heroCta: '전시실 둘러보기',
      roomsHeading: '전시실',
      count: function (open, soon) {
        if (open + soon === 0) return '준비 중';
        return '열린 방 ' + open + '곳' + (soon ? ' · 준비 중 ' + soon + '곳' : '');
      },
      no: function (n) { return 'No. ' + n; },
      enter: '전시 보기',
      soon: '곧 공개',
      soonNote: '아직 문을 열지 않은 방입니다',
      enterLabel: function (t) { return t + ' 전시실로 들어가기'; },
      emptyTitle: '지금은 공개된 방이 없습니다',
      emptyText: '새 전시를 준비하고 있습니다. 조금 뒤에 다시 들러 주세요.',
      visitHeading: '관람 안내',
      visit1: '모든 방은 휴대폰과 태블릿, 데스크톱에서 같은 경험을 드리도록 만들어졌습니다. 키보드만으로도 모든 문을 열 수 있고, 움직임 줄이기 설정을 켜 두시면 화면 전환이 조용해집니다.',
      visit2: '전시실 안에서는 브라우저의 뒤로 가기로 언제든 로비에 돌아올 수 있습니다. 밝은 화면과 어두운 화면은 위쪽의 버튼으로 바꿀 수 있고, 언어 버튼으로 영어 안내를 볼 수 있습니다.',
      roomNote: '전시실의 문이 열렸습니다. 이 방의 작품은 고유한 주소에서 이어집니다.',
      roomEyebrow: function (n) { return 'No. ' + n + ' · 전시실'; },
      back: '로비로 돌아가기',
      footerNote: '© 빛의 미술관 · 서울. 모든 방은 오프라인에서도 열립니다.',
      footerNav: '바닥글',
      roomsList: '전시실 목록',
      linkRooms: '전시실',
      linkVisit: '관람 안내',
      linkTop: '맨 위로',
      docTitle: '빛의 미술관 · Museum of Light'
    },
    en: {
      brand: 'Museum of Light',
      langButton: '한국어',
      langButtonLang: 'ko',
      langButtonLabel: '한국어로 보기',
      themeToDark: 'Dark mode',
      themeToLight: 'Light mode',
      themeToDarkLabel: 'Switch to dark mode',
      themeToLightLabel: 'Switch to light mode',
      eyebrow: 'Museum of Light · Digital collection',
      heroTitle: 'Welcome to the Rooms of Light',
      lead: 'This is the entrance to a small collection of digital rooms about light, memory and time. Open the door that calls to you, and take your time inside.',
      heroCta: 'Browse the rooms',
      roomsHeading: 'Rooms',
      count: function (open, soon) {
        if (open + soon === 0) return 'In preparation';
        return open + (open === 1 ? ' room open' : ' rooms open') + (soon ? ' · ' + soon + ' coming soon' : '');
      },
      no: function (n) { return 'No. ' + n; },
      enter: 'Enter the room',
      soon: 'Coming soon',
      soonNote: 'This room has not opened yet',
      enterLabel: function (t) { return 'Enter ' + t; },
      emptyTitle: 'No rooms are open right now',
      emptyText: 'A new exhibition is being prepared. Please come back a little later.',
      visitHeading: 'Visiting',
      visit1: 'Every room is made to feel the same on a phone, a tablet or a desktop. You can open every door with the keyboard alone, and turning on reduced motion keeps the transitions quiet.',
      visit2: 'Inside a room, your browser’s back button always returns you to the lobby. Switch between light and dark with the button at the top, and use the language button to read the guide in Korean.',
      roomNote: 'The door is open. The works of this room continue at its own address.',
      roomEyebrow: function (n) { return 'No. ' + n + ' · Room'; },
      back: 'Back to the lobby',
      footerNote: '© Museum of Light · Seoul. Every room opens offline.',
      footerNav: 'Footer',
      roomsList: 'Room list',
      linkRooms: 'Rooms',
      linkVisit: 'Visiting',
      linkTop: 'Back to top',
      docTitle: 'Museum of Light · 빛의 미술관'
    }
  };

  var host = window.__benchHost || { params: {}, seed: 1 };
  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };

  var grid = $('room-grid');
  var emptyEl = $('empty-state');
  var countEl = $('rooms-count');
  var roomView = $('room-view');
  var themeBtn = $('theme-toggle');
  var langBtn = $('lang-toggle');
  var backBtn = $('room-back');

  var state = { lang: 'ko', themeOverride: null, route: 'lobby', seed: 1, clock: 0, frozen: false };
  var listenerCount = 0;
  var lastFocusedCard = null;
  var enteredFromLobby = false;
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listenerCount += 1;
  }

  function readStoredLang() {
    try {
      var v = window.localStorage.getItem(LANG_KEY);
      return v === 'en' || v === 'ko' ? v : null;
    } catch (e) { return null; }
  }
  function storeLang(v) {
    try { window.localStorage.setItem(LANG_KEY, v); } catch (e) { /* storage unavailable */ }
  }

  function rooms() {
    var list = host.params && Array.isArray(host.params.rooms) ? host.params.rooms : [];
    return list.filter(function (r) { return r && typeof r === 'object'; });
  }
  function isOpen(r) { return r.status !== 'coming_soon'; }
  function titleFor(r, lang) {
    var ko = r.title_ko || r.title_en || r.id || '';
    var en = r.title_en || r.title_ko || r.id || '';
    return lang === 'en' ? en : ko;
  }
  function altTitleFor(r, lang) {
    if (lang === 'en') return r.title_ko && r.title_ko !== r.title_en ? r.title_ko : '';
    return r.title_en && r.title_en !== r.title_ko ? r.title_en : '';
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function accentCss(r) {
    var a = r.accent_oklch;
    if (Array.isArray(a) && a.length >= 3 && a.every(function (x) { return typeof x === 'number' && isFinite(x); })) {
      return 'oklch(' + a[0] + ' ' + a[1] + ' ' + a[2] + ')';
    }
    return '';
  }
  function routeFor(r) {
    return typeof r.route === 'string' && r.route ? r.route : ROUTE_PREFIX + encodeURIComponent(r.id);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- Rendering ---------- */
  function renderRooms() {
    var t = STRINGS[state.lang];
    var list = rooms();
    var frag = document.createDocumentFragment();
    var open = 0;
    var soon = 0;
    list.forEach(function (r, i) {
      var openRoom = isOpen(r);
      if (openRoom) open += 1; else soon += 1;
      var title = titleFor(r, state.lang);
      var alt = altTitleFor(r, state.lang);
      var li = el('li');
      li.setAttribute('data-bench', 'room-card');
      li.setAttribute('data-status', openRoom ? 'open' : 'coming_soon');
      li.setAttribute('data-room-id', String(r.id));

      var card = el(openRoom ? 'a' : 'div', openRoom ? 'card' : 'card is-soon');
      var accent = accentCss(r);
      if (accent) card.style.setProperty('--accent', accent);
      if (openRoom) {
        card.href = routeFor(r);
        card.setAttribute('data-room-id', String(r.id));
      }
      var no = el('span', 'card-no', t.no(pad2(i + 1)));
      if (!openRoom) {
        var badge = el('span', 'badge', t.soon);
        no.appendChild(badge);
      }
      var h3 = el('h3', null, title);
      if (state.lang === 'en' && !r.title_en) h3.lang = 'ko';
      var altP = el('p', 'card-alt', alt);
      altP.lang = state.lang === 'en' ? 'ko' : 'en';
      if (!alt) altP.hidden = true;
      var summary = el('p', 'card-summary', r.summary_ko || '');
      summary.lang = 'ko';
      if (!r.summary_ko) summary.hidden = true;
      var cta = el('span', 'card-cta', openRoom ? t.enter : t.soonNote);

      card.appendChild(no);
      card.appendChild(h3);
      card.appendChild(altP);
      card.appendChild(summary);
      card.appendChild(cta);
      li.appendChild(card);
      frag.appendChild(li);
    });
    grid.replaceChildren(frag);
    grid.hidden = list.length === 0;
    grid.setAttribute('aria-label', t.roomsList);
    emptyEl.hidden = list.length > 0;
    countEl.textContent = t.count(open, soon);
  }

  function renderStatic() {
    var t = STRINGS[state.lang];
    root.lang = state.lang;
    document.title = t.docTitle;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (typeof t[key] === 'string') nodes[i].textContent = t[key];
    }
    var langSpan = langBtn.querySelector('span');
    langSpan.lang = t.langButtonLang;
    langBtn.setAttribute('aria-label', t.langButtonLabel);
    $('footer-nav').setAttribute('aria-label', t.footerNav);
    renderTheme();
  }

  function currentTheme() {
    if (state.themeOverride) return state.themeOverride;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }
  function renderTheme() {
    var t = STRINGS[state.lang];
    if (state.themeOverride) root.setAttribute('data-theme', state.themeOverride);
    else root.removeAttribute('data-theme');
    var dark = currentTheme() === 'dark';
    $('theme-label').textContent = dark ? t.themeToLight : t.themeToDark;
    themeBtn.setAttribute('aria-label', dark ? t.themeToLightLabel : t.themeToDarkLabel);
    themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  /* Seeded hero light: deterministic position from the bench rng, never Math.random(). */
  function applySeededLight() {
    var rng = host.rng && typeof host.rng.fork === 'function' ? host.rng.fork('lobby-light') : null;
    var a = rng ? rng.next() : 0.5;
    var b = rng ? rng.next() : 0.4;
    var c = rng ? rng.next() : 0.3;
    var hero = document.querySelector('.hero');
    hero.style.setProperty('--light-x', Math.round(62 + a * 28) + '%');
    hero.style.setProperty('--light-y', Math.round(16 + b * 32) + '%');
    hero.style.setProperty('--light-x2', Math.round(8 + c * 24) + '%');
  }

  /* ---------- Routing ---------- */
  function parseRoute() {
    var h = location.hash || '';
    if (h.indexOf(ROUTE_PREFIX) !== 0) return { route: 'lobby', room: null };
    var id = h.slice(ROUTE_PREFIX.length);
    try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
    var list = rooms();
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (String(r.id) === id || routeFor(r) === h) {
        if (!isOpen(r)) return { route: 'lobby', room: null, blocked: true };
        return { route: String(r.id), room: r, index: i };
      }
    }
    return { route: 'lobby', room: null };
  }

  var inertTargets = function () {
    return [document.querySelector('.site-header'), document.querySelector('.hero'),
      $('rooms'), $('visit'), document.querySelector('.site-footer')];
  };

  function setInert(flag) {
    inertTargets().forEach(function (n) {
      if (!n) return;
      if (flag) { n.setAttribute('inert', ''); n.setAttribute('aria-hidden', 'true'); }
      else { n.removeAttribute('inert'); n.removeAttribute('aria-hidden'); }
    });
  }

  function fillRoomView(parsed) {
    var t = STRINGS[state.lang];
    var r = parsed.room;
    $('room-view-no').textContent = t.roomEyebrow(pad2(parsed.index + 1));
    var title = $('room-view-title');
    title.textContent = titleFor(r, state.lang);
    title.lang = state.lang === 'en' && !r.title_en ? 'ko' : state.lang;
    var alt = altTitleFor(r, state.lang);
    var altEl = $('room-view-alt');
    altEl.textContent = alt;
    altEl.lang = state.lang === 'en' ? 'ko' : 'en';
    altEl.hidden = !alt;
    var sum = $('room-view-summary');
    sum.textContent = r.summary_ko || '';
    sum.hidden = !r.summary_ko;
    var accent = accentCss(r);
    if (accent) roomView.style.setProperty('--room-accent', accent);
    else roomView.style.removeProperty('--room-accent');
  }

  function syncRoute() {
    var parsed = parseRoute();
    if (parsed.blocked && history.replaceState) {
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    var prev = state.route;
    state.route = parsed.route;
    if (parsed.room) {
      fillRoomView(parsed);
      var title = $('room-view-title');
      if (prev !== parsed.route) {
        roomView.hidden = false;
        void roomView.offsetWidth; // commit the closed state so the open transition runs
        roomView.classList.add('is-open');
        setInert(true);
        try { title.focus({ preventScroll: true }); } catch (e) { title.focus(); }
      }
    } else if (prev !== 'lobby' || !roomView.hidden) {
      roomView.classList.remove('is-open');
      roomView.hidden = true;
      setInert(false);
      if (lastFocusedCard && document.contains(lastFocusedCard)) {
        try { lastFocusedCard.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    }
  }

  /* ---------- Events ---------- */
  on(grid, 'click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a.card') : null;
    if (!a) return;
    lastFocusedCard = a;
    enteredFromLobby = true;
    // Fragment navigation updates location synchronously; sync before hashchange is delivered.
    queueMicrotask(syncRoute);
  });
  on(window, 'hashchange', syncRoute);
  on(window, 'popstate', syncRoute);

  on(backBtn, 'click', function () {
    if (enteredFromLobby && history.length > 1) {
      enteredFromLobby = false;
      history.back();
    } else {
      history.pushState(null, '', location.pathname + location.search);
      syncRoute();
    }
  });
  on(document, 'keydown', function (ev) {
    if (ev.key === 'Escape' && state.route !== 'lobby') backBtn.click();
  });

  on(langBtn, 'click', function () {
    state.lang = state.lang === 'ko' ? 'en' : 'ko';
    storeLang(state.lang);
    renderStatic();
    renderRooms();
    if (state.route !== 'lobby') { var p = parseRoute(); if (p.room) fillRoomView(p); }
  });

  on(themeBtn, 'click', function () {
    state.themeOverride = currentTheme() === 'dark' ? 'light' : 'dark';
    renderTheme();
  });
  if (darkQuery) {
    var onScheme = function () { state.themeOverride = null; renderTheme(); };
    if (typeof darkQuery.addEventListener === 'function') { darkQuery.addEventListener('change', onScheme); listenerCount += 1; }
  }

  /* ---------- Boot ---------- */
  function boot(seed) {
    state.seed = seed >>> 0;
    applySeededLight();
    renderStatic();
    renderRooms();
    syncRoute();
  }

  // Korean is the museum's primary language; English only on an explicit, stored choice.
  state.lang = readStoredLang() || 'ko';
  boot(typeof host.seed === 'number' ? host.seed : 1);

  function nextFrame() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      // The harness may override rAF; a timeout keeps renderFrame from stalling.
      setTimeout(finish, 64);
      try { requestAnimationFrame(function () { requestAnimationFrame(finish); }); } catch (e) { finish(); }
    });
  }

  var ready = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
    .then(function () { return undefined; }, function () { return undefined; });

  window.__bench = {
    version: 1,
    ready: ready,
    setSeed: function (seed) {
      state.clock = 0;
      state.frozen = false;
      boot(Number(seed));
    },
    seek: function (tMs) {
      state.clock = Number(tMs) || 0;
      state.frozen = true;
    },
    resume: function () { state.frozen = false; },
    renderFrame: function () {
      void document.body.offsetHeight;
      return nextFrame();
    },
    state: function () {
      return { route: state.route, lang: state.lang, theme: currentTheme() };
    },
    stats: function () {
      return { drawCalls: 0, triangles: 0, listeners: listenerCount };
    }
  };
})();
