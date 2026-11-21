/**
 * Museum of Light — Lobby runtime
 * Consumes window.__benchHost.params.rooms and implements window.__bench (BenchRoom v1).
 */

const COPY = {
  ko: {
    pageTitle: '빛의 미술관 — Museum of Light',
    brandSub: '빛의 미술관',
    controlsNav: '화면 설정',
    langToggleLabel: '영어로 전환',
    langToggleText: 'EN',
    themeToDark: '다크',
    themeToLight: '라이트',
    themeToDarkLabel: '다크 테마로 전환',
    themeToLightLabel: '라이트 테마로 전환',
    heroEyebrow: 'SEOUL · DIGITAL EXHIBITION',
    heroTitle: '빛이 머무는 방으로',
    heroBody:
      '빛의 미술관은 서로 다른 감각과 사유를 담은 디지털 전시실의 모음입니다. 각 방은 고요한 관찰과 천천히 머무는 시간을 위해 열려 있습니다.',
    collectionTitle: '전시실',
    roomsAriaLabel: '전시 공간 목록',
    roomCount: (n) => (n === 0 ? '준비 중' : `총 ${n}개의 공간`),
    statusOpen: '전시 중',
    statusSoon: '준비 중',
    emptyTitle: '현재 공개된 전시실이 없습니다',
    emptyDesc: '새로운 빛의 전시를 정성껏 준비하고 있습니다. 잠시 후 다시 방문해 주세요.',
    visitTitle: '관람 안내',
    visitBody:
      '모든 전시실은 별도의 설치 없이 브라우저에서 바로 감상할 수 있도록 구성되었습니다. 밝은 화면과 어두운 화면 모두에서 편안한 명암을 유지하며, 키보드만으로도 모든 공간을 자유롭게 오갈 수 있습니다.',
    hoursLabel: '개관 시간',
    hoursValue: '매일 상시 개방 · 온라인 전시',
    admissionLabel: '관람료',
    admissionValue: '무료 관람',
    locationLabel: '위치',
    locationValue: '서울 · 디지털 아카이브',
    footerColophon: 'Museum of Light · Seoul',
    footerNav: '푸터 바로가기',
    footerCollection: '전시실',
    footerVisit: '관람 안내',
    backToLobby: '로비로 돌아가기',
    roomEntered: '전시실 입장',
    summaryFallbackEn: 'A quiet digital room open for unhurried observation and discovery.',
  },
  en: {
    pageTitle: 'Museum of Light — Lobby',
    brandSub: 'Seoul',
    controlsNav: 'Display controls',
    langToggleLabel: 'Switch to Korean',
    langToggleText: '한국어',
    themeToDark: 'Dark',
    themeToLight: 'Light',
    themeToDarkLabel: 'Switch to dark theme',
    themeToLightLabel: 'Switch to light theme',
    heroEyebrow: 'SEOUL · DIGITAL EXHIBITION',
    heroTitle: 'Welcome to the Museum of Light',
    heroBody:
      'The Museum of Light gathers quiet digital rooms devoted to perception, memory, and stillness. Move at your own pace through each exhibition space.',
    collectionTitle: 'Exhibition Rooms',
    roomsAriaLabel: 'Exhibition rooms',
    roomCount: (n) => (n === 0 ? 'Coming soon' : `${n} ${n === 1 ? 'Room' : 'Rooms'}`),
    statusOpen: 'Open',
    statusSoon: 'Coming soon',
    emptyTitle: 'No exhibition rooms are open yet',
    emptyDesc: 'Curators are preparing the next collection of light studies. Please return shortly.',
    visitTitle: 'Visitor Information',
    visitBody:
      'Every exhibition room runs directly in the browser without additional downloads. Each space maintains clear contrast in both light and dark themes and supports complete keyboard navigation.',
    hoursLabel: 'Hours',
    hoursValue: 'Open daily · Online exhibition',
    admissionLabel: 'Admission',
    admissionValue: 'Free entry',
    locationLabel: 'Location',
    locationValue: 'Seoul · Digital Archive',
    footerColophon: 'Museum of Light · Seoul',
    footerNav: 'Footer navigation',
    footerCollection: 'Rooms',
    footerVisit: 'Visit',
    backToLobby: 'Back to Lobby',
    roomEntered: 'Now Viewing',
    summaryFallbackEn: 'A quiet digital room open for unhurried observation and discovery.',
  },
};

const LANG_STORAGE_KEY = 'mol-lang';

const els = {
  lobbyShell: document.getElementById('lobby-shell'),
  roomsGrid: document.getElementById('rooms'),
  roomCount: document.getElementById('room-count'),
  emptyState: document.querySelector('[data-bench="empty-state"]'),
  heroTitle: document.querySelector('[data-bench="hero-title"]'),
  langToggle: document.querySelector('[data-bench="lang-toggle"]'),
  themeToggle: document.querySelector('[data-bench="theme-toggle"]'),
  headerControls: document.querySelector('.header-controls'),
  footerNav: document.querySelector('.footer-nav'),
  roomView: document.getElementById('room-view'),
  roomViewBack: document.getElementById('room-view-back'),
  roomViewCode: document.getElementById('room-view-code'),
  roomViewTitle: document.getElementById('room-view-title'),
  roomViewSubtitle: document.getElementById('room-view-subtitle'),
  roomViewSummary: document.getElementById('room-view-summary'),
};

const colorSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');

let userThemeOverride = null; // null | 'light' | 'dark'
let currentLang = readStoredLang();
let currentRoute = 'lobby';
let savedLobbyScrollY = 0;
let activeListeners = 0;
let frozenTimeMs = 0;

function readStoredLang() {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    // Ignore storage access restrictions
  }
  return 'ko';
}

function getEffectiveTheme() {
  if (userThemeOverride === 'light' || userThemeOverride === 'dark') {
    return userThemeOverride;
  }
  return colorSchemeMql.matches ? 'dark' : 'light';
}

function getRooms() {
  const rooms = window.__benchHost?.params?.rooms;
  return Array.isArray(rooms) ? rooms : [];
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function parseAccent(room) {
  const arr = Array.isArray(room?.accent_oklch) ? room.accent_oklch : [0.68, 0.12, 210];
  const l = Number.isFinite(Number(arr[0])) ? clamp(Number(arr[0]), 0.3, 0.85) : 0.68;
  const c = Number.isFinite(Number(arr[1])) ? clamp(Number(arr[1]), 0, 0.22) : 0.12;
  const h = Number.isFinite(Number(arr[2])) ? ((Number(arr[2]) % 360) + 360) % 360 : 210;
  return { l, c, h };
}

function applyTheme() {
  const theme = getEffectiveTheme();
  document.documentElement.dataset.theme = theme;
  const copy = COPY[currentLang];
  if (els.themeToggle) {
    const isDark = theme === 'dark';
    els.themeToggle.setAttribute('aria-pressed', String(isDark));
    els.themeToggle.textContent = isDark ? copy.themeToLight : copy.themeToDark;
    els.themeToggle.setAttribute('aria-label', isDark ? copy.themeToLightLabel : copy.themeToDarkLabel);
  }
  updateRoomPlateTones(theme);
}

function updateRoomPlateTones(theme) {
  const cards = els.roomsGrid ? els.roomsGrid.querySelectorAll('[data-bench="room-card"]') : [];
  const rooms = getRooms();
  cards.forEach((card, idx) => {
    const room = rooms[idx];
    if (!room) return;
    const { l, c, h } = parseAccent(room);
    const lMain = theme === 'dark' ? clamp(l - 0.16, 0.36, 0.6) : clamp(l + 0.08, 0.64, 0.82);
    const lSoft = theme === 'dark' ? clamp(lMain - 0.14, 0.22, 0.44) : clamp(lMain + 0.12, 0.78, 0.94);
    const cMain = clamp(c * 0.7, 0.02, 0.1);
    card.style.setProperty('--accent-l', lMain.toFixed(3));
    card.style.setProperty('--accent-l2', lSoft.toFixed(3));
    card.style.setProperty('--accent-c', cMain.toFixed(3));
    card.style.setProperty('--accent-c2', (cMain * 0.35).toFixed(3));
    card.style.setProperty('--accent-h', h.toFixed(1));
  });
}

function applyLanguageCopy() {
  const copy = COPY[currentLang];
  document.documentElement.lang = currentLang;
  document.title = copy.pageTitle;

  if (els.heroTitle) els.heroTitle.textContent = copy.heroTitle;
  if (els.roomsGrid) els.roomsGrid.setAttribute('aria-label', copy.roomsAriaLabel);
  if (els.headerControls) els.headerControls.setAttribute('aria-label', copy.controlsNav);
  if (els.footerNav) els.footerNav.setAttribute('aria-label', copy.footerNav);

  if (els.langToggle) {
    els.langToggle.textContent = copy.langToggleText;
    els.langToggle.setAttribute('aria-label', copy.langToggleLabel);
  }

  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key && typeof copy[key] === 'string') {
      el.textContent = copy[key];
    }
  }

  applyTheme();
}

function createRoomCard(room, index) {
  const copy = COPY[currentLang];
  const isSoon = room.status === 'coming_soon';
  const primaryTitle = currentLang === 'en' && room.title_en ? room.title_en : (room.title_ko || room.title_en || room.id);
  const secondaryTitle = currentLang === 'en' ? (room.title_ko || '') : (room.title_en || '');
  const summaryText = currentLang === 'en'
    ? (room.summary_en || copy.summaryFallbackEn)
    : (room.summary_ko || '');

  const article = document.createElement('article');
  article.className = isSoon ? 'room-card room-card--coming-soon' : 'room-card';
  article.dataset.bench = 'room-card';
  article.dataset.status = isSoon ? 'coming_soon' : 'open';
  article.dataset.roomId = String(room.id || `room-${index + 1}`);
  if (isSoon) {
    article.setAttribute('aria-disabled', 'true');
  }

  const wrapper = document.createElement(isSoon ? 'div' : 'a');
  wrapper.className = isSoon ? 'room-card__inner' : 'room-card__link';
  if (!isSoon && room.route) {
    wrapper.setAttribute('href', room.route);
  }

  const plate = document.createElement('div');
  plate.className = 'room-card__plate';
  plate.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'room-card__body';

  const meta = document.createElement('p');
  meta.className = 'room-card__meta';

  const idxSpan = document.createElement('span');
  idxSpan.className = 'room-card__index';
  idxSpan.textContent = String(index + 1).padStart(2, '0');

  const statusSpan = document.createElement('span');
  statusSpan.className = isSoon ? 'room-card__status room-card__status--soon' : 'room-card__status';
  statusSpan.textContent = isSoon ? copy.statusSoon : copy.statusOpen;

  if (isSoon) {
    meta.append(idxSpan, statusSpan);
  } else {
    const sep = document.createElement('span');
    sep.className = 'room-card__meta-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = ' · ';
    meta.append(idxSpan, sep, statusSpan);
  }

  const titleEl = document.createElement('h3');
  titleEl.className = 'room-card__title';
  titleEl.textContent = primaryTitle;

  body.append(meta, titleEl);

  if (secondaryTitle) {
    const subEl = document.createElement('p');
    subEl.className = 'room-card__subtitle';
    subEl.lang = currentLang === 'en' ? 'ko' : 'en';
    subEl.textContent = secondaryTitle;
    body.append(subEl);
  }

  if (summaryText) {
    const sumEl = document.createElement('p');
    sumEl.className = 'room-card__summary';
    sumEl.textContent = summaryText;
    body.append(sumEl);
  }

  wrapper.append(plate, body);
  article.append(wrapper);
  return article;
}

function renderRooms() {
  const rooms = getRooms();
  const copy = COPY[currentLang];

  if (els.roomCount) {
    els.roomCount.textContent = copy.roomCount(rooms.length);
  }

  if (els.roomsGrid) {
    const frag = document.createDocumentFragment();
    rooms.forEach((room, i) => {
      frag.append(createRoomCard(room, i));
    });
    els.roomsGrid.replaceChildren(frag);
    els.roomsGrid.hidden = rooms.length === 0;
  }

  if (els.emptyState) {
    els.emptyState.hidden = rooms.length > 0;
  }

  updateRoomPlateTones(getEffectiveTheme());
}

function parseRoomIdFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#/room/')) return null;
  const raw = hash.slice('#/room/'.length).replace(/\/+$/, '');
  return raw ? decodeURIComponent(raw) : null;
}

function findOpenRoom(id) {
  if (!id) return null;
  return getRooms().find((r) => r.id === id && r.status !== 'coming_soon') || null;
}

function populateRoomView(room, index) {
  const copy = COPY[currentLang];
  const { l, c, h } = parseAccent(room);
  const primaryTitle = currentLang === 'en' && room.title_en ? room.title_en : (room.title_ko || room.title_en || room.id);
  const secondaryTitle = currentLang === 'en' ? (room.title_ko || '') : (room.title_en || '');
  const summaryText = currentLang === 'en'
    ? (room.summary_en || copy.summaryFallbackEn)
    : (room.summary_ko || '');

  els.roomView.style.setProperty('--room-accent-l', l.toFixed(3));
  els.roomView.style.setProperty('--room-accent-c', c.toFixed(3));
  els.roomView.style.setProperty('--room-accent-h', h.toFixed(1));
  els.roomViewCode.textContent = `ROOM ${String(index + 1).padStart(2, '0')}`;
  els.roomViewTitle.textContent = primaryTitle;
  els.roomViewSubtitle.textContent = secondaryTitle;
  els.roomViewSubtitle.hidden = !secondaryTitle;
  els.roomViewSummary.textContent = summaryText;
}

function syncRoute({ animate = true } = {}) {
  const prevRoute = currentRoute;
  const requestedId = parseRoomIdFromHash(window.location.hash);
  const room = findOpenRoom(requestedId);

  if (room) {
    if (prevRoute === 'lobby') {
      savedLobbyScrollY = window.scrollY;
    }
    currentRoute = room.id;
    const idx = getRooms().findIndex((r) => r.id === room.id);
    populateRoomView(room, idx >= 0 ? idx : 0);

    const entering = prevRoute !== currentRoute;
    els.roomView.hidden = false;
    if (els.lobbyShell) {
      els.lobbyShell.setAttribute('aria-hidden', 'true');
      els.lobbyShell.inert = true;
    }

    els.roomView.classList.remove('is-entering');
    if (animate && entering && !reducedMotionMql.matches) {
      // Force reflow so CSS keyframe animation starts cleanly at t=0
      void els.roomView.offsetWidth;
      els.roomView.classList.add('is-entering');
    }
  } else {
    currentRoute = 'lobby';
    els.roomView.classList.remove('is-entering');
    els.roomView.hidden = true;
    if (els.lobbyShell) {
      els.lobbyShell.removeAttribute('aria-hidden');
      els.lobbyShell.inert = false;
    }
    if (prevRoute !== 'lobby') {
      window.scrollTo({ top: savedLobbyScrollY, behavior: 'instant' });
    }
  }
}

function onLangToggleClick() {
  currentLang = currentLang === 'ko' ? 'en' : 'ko';
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch {
    // Ignore storage errors
  }
  applyLanguageCopy();
  renderRooms();
  if (currentRoute !== 'lobby') {
    const room = findOpenRoom(currentRoute);
    if (room) {
      const idx = getRooms().findIndex((r) => r.id === room.id);
      populateRoomView(room, idx >= 0 ? idx : 0);
    }
  }
}

function onThemeToggleClick() {
  userThemeOverride = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  applyTheme();
}

function onColorSchemeChange() {
  userThemeOverride = null;
  applyTheme();
}

function onHashChange() {
  syncRoute({ animate: true });
}

function addTrackedListener(target, type, handler, opts) {
  if (!target) return;
  target.addEventListener(type, handler, opts);
  activeListeners += 1;
}

addTrackedListener(els.langToggle, 'click', onLangToggleClick);
addTrackedListener(els.themeToggle, 'click', onThemeToggleClick);
addTrackedListener(colorSchemeMql, 'change', onColorSchemeChange);
addTrackedListener(window, 'hashchange', onHashChange);

// Initial render
applyLanguageCopy();
renderRooms();
syncRoute({ animate: false });

const readyPromise = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => undefined);

window.__bench = {
  version: 1,
  ready: readyPromise,
  setSeed() {
    userThemeOverride = null;
    currentLang = readStoredLang();
    applyLanguageCopy();
    renderRooms();
    syncRoute({ animate: false });
  },
  seek(tMs) {
    frozenTimeMs = Number(tMs) || 0;
  },
  resume() {
    // Pure DOM/CSS lobby: live clock resumes cleanly without background rAF loops.
  },
  async renderFrame() {
    applyTheme();
    if (window.__benchHostControl?.isRafOverrideActive?.()) {
      await Promise.resolve();
      return;
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  },
  state() {
    return {
      route: currentRoute,
      lang: currentLang,
      theme: getEffectiveTheme(),
    };
  },
  stats() {
    return {
      drawCalls: 0,
      triangles: 0,
      listeners: activeListeners,
    };
  },
};
