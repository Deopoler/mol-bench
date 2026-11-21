/* Museum of Light — lobby behaviour.
 *
 * - Room cards are generated from window.__benchHost.params.rooms (never hard-coded).
 * - Hash routes (#/room/<id>) swap the hero + sections in place; the lobby DOM is kept alive
 *   so keyboard focus, scroll position and history behave like a real page.
 * - Implements the MoL-Bench runtime contract (window.__bench, version 1). Nothing here reads
 *   wall-clock time or randomness, so a fixed (seed, viewport, media) always renders the same pixels.
 */
(() => {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const host = window.__benchHost || null;
  const KEY_LANG = 'mol-lang';
  const KEY_THEME = 'mol-theme';

  const COPY = {
    ko: {
      docTitle: 'Museum of Light · 빛의 박물관',
      skip: '본문으로 건너뛰기',
      langButton: 'English',
      langButtonLang: 'en',
      toDark: '다크 테마로 전환',
      toLight: '라이트 테마로 전환',
      eyebrow: '서울 · 디지털 전시관',
      heroTitle: '빛의 방에 오신 것을 환영합니다',
      heroLead: '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 천천히 걸으며, 마음이 머무는 곳으로 들어가 보세요.',
      explore: '전시 공간 둘러보기',
      back: '로비로 돌아가기',
      roomsTitle: '전시 공간',
      emptyTitle: '아직 공개된 방이 없습니다.',
      emptyBody: '새로운 전시가 준비되는 대로 이곳에 문을 엽니다.',
      roomWord: 'Room',
      statusOpen: '입장 가능',
      statusSoon: '준비 중',
      enter: '입장하기',
      soonCta: '곧 문을 엽니다',
      doorNote: '문 앞까지 오셨습니다. 이 방의 전시는 별도의 공간에서 이어집니다.',
      infoTitle: '방문 안내',
      info1Title: '열린 시간',
      info1Body: '연중무휴, 하루 24시간 열려 있습니다. 언제든 천천히 머물러 주세요.',
      info2Title: '함께 걷는 법',
      info2Body: '마음이 가는 방의 카드를 선택하면 입장합니다. 키보드에서는 Tab 키로 이동하고 Enter 키로 들어갑니다.',
      info3Title: '편안한 보기',
      info3Body: '화면 설정에 맞춰 밝은 테마와 어두운 테마를 보여 주며, 움직임 줄이기 설정을 존중합니다.',
      footerNote: '서울의 작은 디지털 전시관',
      footerNav: '바로가기',
      navRooms: '전시 공간',
      navInfo: '방문 안내',
      navTop: '맨 위로',
      count: (total, open, soon) => {
        const parts = [`총 ${total}개의 방`];
        if (open) parts.push(`${open}개 입장 가능`);
        if (soon) parts.push(`${soon}개 준비 중`);
        return parts.join(' · ');
      },
    },
    en: {
      docTitle: 'Museum of Light',
      skip: 'Skip to content',
      langButton: '한국어',
      langButtonLang: 'ko',
      toDark: 'Switch to dark theme',
      toLight: 'Switch to light theme',
      eyebrow: 'Seoul · Digital museum',
      heroTitle: 'Welcome to the rooms of light',
      heroLead: 'Each room is a small world for a different way of sensing and thinking. Walk slowly, and step into whichever one holds your attention.',
      explore: 'Explore the rooms',
      back: 'Back to the lobby',
      roomsTitle: 'Rooms',
      emptyTitle: 'No rooms are open yet.',
      emptyBody: 'New exhibitions will open their doors here as soon as they are ready.',
      roomWord: 'Room',
      statusOpen: 'Open',
      statusSoon: 'Coming soon',
      enter: 'Enter room',
      soonCta: 'Opening soon',
      doorNote: 'You have reached the door. This room continues in a space of its own.',
      infoTitle: 'Visit',
      info1Title: 'Opening hours',
      info1Body: 'Open every day, at any hour. Stay as long as you like.',
      info2Title: 'How to wander',
      info2Body: 'Select a room card to step inside. With a keyboard, move with the Tab key and press Enter to go in.',
      info3Title: 'Comfortable viewing',
      info3Body: 'Light and dark themes follow your screen settings, and reduced-motion preferences are respected.',
      footerNote: 'A small digital museum in Seoul',
      footerNav: 'Shortcuts',
      navRooms: 'Rooms',
      navInfo: 'Visit',
      navTop: 'Back to top',
      count: (total, open, soon) => {
        const parts = [`${total} ${total === 1 ? 'room' : 'rooms'}`];
        if (open) parts.push(`${open} open`);
        if (soon) parts.push(`${soon} coming soon`);
        return parts.join(' · ');
      },
    },
  };

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ } },
  };

  const $ = (selector) => doc.querySelector(selector);
  const el = {
    main: $('#main'),
    veil: $('#veil'),
    eyebrow: $('#hero-eyebrow'),
    title: $('#hero-title'),
    alt: $('#hero-alt'),
    lead: $('#hero-lead'),
    explore: $('#cta-explore'),
    back: $('#cta-back'),
    spectrum: $('#hero-spectrum'),
    art: $('#hero-art'),
    rooms: $('#rooms'),
    roomsNote: $('#rooms-note'),
    grid: $('#room-grid'),
    empty: $('#empty-state'),
    info: $('#info'),
    langToggle: $('#lang-toggle'),
    themeToggle: $('#theme-toggle'),
    footerNav: $('#footer-nav'),
  };

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  let lang = store.get(KEY_LANG) === 'en' ? 'en' : 'ko';
  let rooms = [];
  let route = 'lobby';
  let lobbyScroll = 0;
  let lastInvoker = null;
  let clockMs = 0;

  /* ---------- data ---------- */

  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const pad = (n) => String(n).padStart(2, '0');

  function readRooms() {
    const list = host && host.params && Array.isArray(host.params.rooms) ? host.params.rooms : [];
    return list
      .filter((room) => room && typeof room === 'object')
      .map((room, index) => {
        const accent = Array.isArray(room.accent_oklch) ? room.accent_oklch : [];
        const id = String(room.id == null ? `room-${index + 1}` : room.id);
        const titleKo = String(room.title_ko == null ? '' : room.title_ko);
        return {
          id,
          index,
          route: typeof room.route === 'string' && room.route.startsWith('#/') ? room.route : `#/room/${encodeURIComponent(id)}`,
          titleKo,
          titleEn: room.title_en == null || room.title_en === '' ? titleKo : String(room.title_en),
          summary: String(room.summary_ko == null ? '' : room.summary_ko),
          l: num(accent[0], 0.68),
          c: num(accent[1], 0.12),
          h: num(accent[2], 250),
          open: room.status !== 'coming_soon',
        };
      });
  }

  const roomTitle = (room) => (lang === 'ko' ? room.titleKo : room.titleEn);
  const roomAltTitle = (room) => (lang === 'ko' ? room.titleEn : room.titleKo);
  const altLang = () => (lang === 'ko' ? 'en' : 'ko');

  function accentVars(node, room) {
    node.style.setProperty('--l', String(room.l));
    node.style.setProperty('--c', String(room.c));
    node.style.setProperty('--h', String(room.h));
  }

  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------- rendering ---------- */

  function buildCard(room, position) {
    const copy = COPY[lang];
    const item = make('li', 'card-item');
    item.dataset.bench = 'room-card';
    item.dataset.status = room.open ? 'open' : 'coming_soon';
    item.dataset.room = room.id;
    accentVars(item, room);

    const card = room.open ? make('a', 'card card--open') : make('div', 'card card--soon');
    const titleId = `room-title-${position}`;
    const summaryId = `room-summary-${position}`;
    if (room.open) {
      card.setAttribute('href', room.route);
      card.setAttribute('aria-labelledby', titleId);
    }

    const plate = make('div', 'card__plate');
    plate.setAttribute('aria-hidden', 'true');

    const body = make('div', 'card__body');
    const meta = make('p', 'card__meta', `${copy.roomWord} ${pad(position + 1)} · ${room.open ? copy.statusOpen : copy.statusSoon}`);
    const title = make('h3', 'card__title', roomTitle(room));
    title.id = titleId;
    const alt = make('p', 'card__alt', roomAltTitle(room));
    alt.lang = altLang();
    const cta = make('p', 'card__cta', room.open ? copy.enter : copy.soonCta);

    body.append(meta, title, alt);
    if (room.summary) {
      const summary = make('p', 'card__summary', room.summary);
      summary.id = summaryId;
      summary.lang = 'ko';
      summary.dataset.bench = 'body';
      body.append(summary);
      if (room.open) card.setAttribute('aria-describedby', summaryId);
    }
    body.append(cta);
    card.append(plate, body);
    item.append(card);
    return item;
  }

  function renderRooms() {
    const copy = COPY[lang];
    el.grid.replaceChildren(...rooms.map(buildCard));

    const open = rooms.filter((room) => room.open).length;
    const soon = rooms.length - open;
    const summary = copy.count(rooms.length, open, soon);
    el.roomsNote.textContent = summary;
    el.roomsNote.hidden = rooms.length === 0;
    el.empty.hidden = rooms.length > 0;
    el.grid.hidden = rooms.length === 0;

    el.spectrum.replaceChildren(...rooms.map((room) => {
      const bar = make('span', room.open ? '' : 'is-soon');
      accentVars(bar, room);
      return bar;
    }));
  }

  function renderStatic() {
    const copy = COPY[lang];
    root.lang = lang;
    doc.querySelectorAll('[data-i18n]').forEach((node) => {
      const value = copy[node.dataset.i18n];
      if (typeof value === 'string') node.textContent = value;
    });
    el.langToggle.textContent = copy.langButton;
    el.langToggle.lang = copy.langButtonLang;
    el.footerNav.setAttribute('aria-label', copy.footerNav);
    updateThemeToggle();
  }

  function activeRoom() {
    return route === 'lobby' ? null : rooms.find((room) => room.id === route) || null;
  }

  function renderView() {
    const copy = COPY[lang];
    const room = activeRoom();
    const inRoom = Boolean(room);

    el.rooms.hidden = inRoom;
    el.info.hidden = inRoom;
    el.explore.hidden = inRoom;
    el.back.hidden = !inRoom;
    el.alt.hidden = !inRoom;
    el.spectrum.hidden = inRoom || rooms.length === 0;
    el.art.dataset.mode = inRoom ? 'room' : 'lobby';

    if (room) {
      el.eyebrow.textContent = `${copy.roomWord} ${pad(room.index + 1)} · ${copy.statusOpen}`;
      el.title.textContent = roomTitle(room);
      el.alt.textContent = roomAltTitle(room);
      el.alt.lang = altLang();
      el.lead.textContent = room.summary;
      el.lead.lang = 'ko';
      accentVars(el.art, room);
      doc.title = `${roomTitle(room)} — Museum of Light`;
    } else {
      el.eyebrow.textContent = copy.eyebrow;
      el.title.textContent = copy.heroTitle;
      el.alt.textContent = '';
      el.lead.textContent = copy.heroLead;
      el.lead.removeAttribute('lang');
      el.art.style.removeProperty('--l');
      el.art.style.removeProperty('--c');
      el.art.style.removeProperty('--h');
      doc.title = copy.docTitle;
    }
  }

  /* ---------- routing ---------- */

  function parseRoute() {
    const hash = window.location.hash;
    const match = /^#\/room\/(.+)$/.exec(hash);
    if (!match) return 'lobby';
    let id = match[1];
    try { id = decodeURIComponent(id); } catch (_) { /* keep raw id */ }
    const room = rooms.find((candidate) => candidate.open && (candidate.route === hash || candidate.id === id));
    return room ? room.id : 'lobby';
  }

  function restartTransition() {
    el.main.classList.remove('is-entering');
    el.veil.classList.remove('is-playing');
    void el.main.offsetWidth; // restart the CSS animations
    el.main.classList.add('is-entering');
    el.veil.classList.add('is-playing');
  }

  function applyRoute(initial) {
    const next = parseRoute();
    if (!initial && next === route) return;
    if (route === 'lobby' && !initial) lobbyScroll = window.scrollY;
    route = next;
    renderView();
    if (initial) return;

    restartTransition();
    if (route === 'lobby') {
      window.scrollTo(0, lobbyScroll);
      const hash = window.location.hash;
      const anchor = hash.length > 1 && !hash.startsWith('#/') ? doc.getElementById(decodeURIComponent(hash.slice(1))) : null;
      if (anchor) anchor.scrollIntoView();
      if (lastInvoker && lastInvoker.isConnected) lastInvoker.focus({ preventScroll: true });
      lastInvoker = null;
    } else {
      window.scrollTo(0, 0);
      el.title.focus({ preventScroll: true });
    }
  }

  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href^="#/"]') : null;
    if (!link) return;
    event.preventDefault();
    lastInvoker = link.closest('[data-bench="room-card"]') ? link : null;
    const href = link.getAttribute('href');
    if (window.location.hash !== href) window.location.hash = href;
    applyRoute(false);
    if (link.id === 'brand') window.scrollTo(0, 0);
  }

  /* ---------- language + theme ---------- */

  function setLang(next, persist) {
    lang = next === 'en' ? 'en' : 'ko';
    if (persist) store.set(KEY_LANG, lang);
    renderStatic();
    renderRooms();
    renderView();
  }

  function effectiveTheme() {
    const chosen = root.getAttribute('data-theme');
    if (chosen === 'dark' || chosen === 'light') return chosen;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function updateThemeToggle() {
    const copy = COPY[lang];
    const label = effectiveTheme() === 'dark' ? copy.toLight : copy.toDark;
    el.themeToggle.setAttribute('aria-label', label);
    el.themeToggle.setAttribute('title', label);
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store.set(KEY_THEME, next);
    updateThemeToggle();
  }

  /* ---------- runtime contract ---------- */

  function settleAnimations() {
    if (typeof doc.getAnimations !== 'function') return;
    doc.getAnimations().forEach((animation) => {
      try { animation.finish(); } catch (_) { /* infinite or detached animation */ }
    });
  }

  function nextFrame() {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => { if (!finished) { finished = true; resolve(); } };
      window.requestAnimationFrame(() => window.requestAnimationFrame(done));
      window.setTimeout(done, 100); // never hang if frames are paused by the harness
    });
  }

  function reloadData() {
    rooms = readRooms();
    renderRooms();
    const next = parseRoute();
    if (next !== route) route = next;
    renderView();
  }

  window.__bench = {
    version: 1,
    ready: Promise.resolve(doc.fonts && doc.fonts.ready).then(() => undefined),
    setSeed() {
      reloadData();
      clockMs = 0;
    },
    seek(tMs) {
      clockMs = Number.isFinite(Number(tMs)) ? Number(tMs) : 0;
      settleAnimations();
    },
    resume() {},
    renderFrame: nextFrame,
    state() {
      return { route, lang, theme: effectiveTheme(), rooms: rooms.length, t: clockMs };
    },
    stats() {
      return { drawCalls: 0, triangles: 0 };
    },
  };

  /* ---------- boot ---------- */

  el.langToggle.addEventListener('click', () => setLang(lang === 'ko' ? 'en' : 'ko', true));
  el.themeToggle.addEventListener('click', toggleTheme);
  doc.addEventListener('click', onClick);
  window.addEventListener('hashchange', () => applyRoute(false));
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', updateThemeToggle);
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

  rooms = readRooms();
  route = parseRoute();
  renderStatic();
  renderRooms();
  renderView();
})();
