/**
 * Museum of Light — Lobby runtime
 * Implements window.__bench (contract/bench.d.ts) with deterministic rendering,
 * language toggling (ko/en), theme toggling (light/dark), and hash routing.
 */

const COPY = {
  ko: {
    pageTitle: '빛의 미술관 — Museum of Light',
    brand: 'MUSEUM OF LIGHT',
    eyebrow: 'MUSEUM OF LIGHT · SEOUL',
    heroTitle: '빛의 방에 오신 것을 환영합니다',
    heroBody:
      '각각의 방은 빛과 시간, 그리고 오래된 기억이 조용히 포개지는 작은 디지털 전시 공간입니다. 서두르지 않고 천천히 머물며 익숙한 감각 너머의 새로운 풍경을 만나 보세요.',
    roomsHeading: '전시 공간',
    roomsCount: (n) => `${n}개의 전시실`,
    emptyTitle: '현재 공개된 전시가 없습니다',
    emptyDesc: '새로운 빛의 방을 준비하고 있습니다. 잠시 후 다시 방문해 주세요.',
    infoHeading: '관람 안내',
    infoBody:
      '빛의 미술관은 언제나 열려 있는 온라인 전시관입니다. 화면의 밝기와 소리를 편안하게 맞추고, 관심 있는 방을 선택해 각 작품이 품은 고요한 호흡을 따라가 보세요.',
    hoursTitle: '개관 시간',
    hoursText: '연중무휴 24시간 온라인 관람 가능',
    admissionTitle: '관람료',
    admissionText: '모든 상설 및 기획 전시 무료 입장',
    accessTitle: '접근성',
    accessText: '키보드 탐색, 라이트·다크 테마 및 동작 줄이기 지원',
    footerBrand: 'Museum of Light · Seoul',
    footerRooms: '전시 공간',
    footerInfo: '관람 안내',
    footerNavLabel: '바닥글 탐색',
    statusOpen: '관람 가능',
    statusSoon: '준비 중',
    enterRoom: '입장하기 →',
    openingSoon: '곧 공개됩니다',
    backToLobby: '← 로비로 돌아가기',
    langBtnLabel: 'EN',
    langAria: '영어로 전환',
    themeToDark: '다크',
    themeToLight: '라이트',
    themeAriaDark: '다크 테마로 전환',
    themeAriaLight: '라이트 테마로 전환',
  },
  en: {
    pageTitle: 'Museum of Light — Seoul',
    brand: 'MUSEUM OF LIGHT',
    eyebrow: 'MUSEUM OF LIGHT · SEOUL',
    heroTitle: 'Welcome to the Rooms of Light',
    heroBody:
      'Each room is a quiet digital exhibition space where light, time, and lingering memory gently overlap. Take an unhurried moment to step inside and discover unfamiliar landscapes.',
    roomsHeading: 'Exhibition Rooms',
    roomsCount: (n) => (n === 1 ? '1 Room' : `${n} Rooms`),
    emptyTitle: 'No exhibitions are open right now',
    emptyDesc: 'New rooms of light are currently being prepared. Please visit again soon.',
    infoHeading: 'Visitor Guide',
    infoBody:
      'Museum of Light is an online gallery open at any hour. Adjust your screen brightness and sound to a comfortable level, then choose a room to follow its quiet rhythm.',
    hoursTitle: 'Opening Hours',
    hoursText: 'Open 24 hours online, every day of the year',
    admissionTitle: 'Admission',
    admissionText: 'Free entry to all permanent and curated rooms',
    accessTitle: 'Accessibility',
    accessText: 'Keyboard navigation, light and dark themes, and reduced motion',
    footerBrand: 'Museum of Light · Seoul',
    footerRooms: 'Exhibition Rooms',
    footerInfo: 'Visitor Guide',
    footerNavLabel: 'Footer navigation',
    statusOpen: 'Open',
    statusSoon: 'Coming soon',
    enterRoom: 'Enter room →',
    openingSoon: 'Opening soon',
    backToLobby: '← Back to Lobby',
    langBtnLabel: '한국어',
    langAria: 'Switch to Korean',
    themeToDark: 'Dark',
    themeToLight: 'Light',
    themeAriaDark: 'Switch to dark theme',
    themeAriaLight: 'Switch to light theme',
  },
};

const STORAGE_LANG_KEY = 'mol-lang';

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

const dom = {
  roomsGrid: document.querySelector('#rooms'),
  roomsCount: document.querySelector('#rooms-count'),
  emptyState: document.querySelector('[data-bench="empty-state"]'),
  langToggle: document.querySelector('[data-bench="lang-toggle"]'),
  themeToggle: document.querySelector('[data-bench="theme-toggle"]'),
  footerNav: document.querySelector('.footer-nav'),
  roomView: document.querySelector('#room-view'),
  roomBackLink: document.querySelector('#room-back-link'),
  roomViewIndex: document.querySelector('#room-view-index'),
  roomViewAccent: document.querySelector('#room-view-accent'),
  roomViewTitle: document.querySelector('#room-view-title'),
  roomViewSubtitle: document.querySelector('#room-view-subtitle'),
  roomViewSummary: document.querySelector('#room-view-summary'),
};

let currentLang = detectInitialLang();
let manualTheme = null; // null follows prefers-color-scheme; 'light' | 'dark' overrides
let currentRoute = 'lobby';
let savedScrollY = 0;
let currentTimeMs = 0;
let isLive = true;
let listenerCount = 0;

function detectInitialLang() {
  try {
    const saved = window.localStorage.getItem(STORAGE_LANG_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    // Ignore storage access errors
  }
  return 'ko';
}

function getEffectiveTheme() {
  if (manualTheme === 'light' || manualTheme === 'dark') {
    return manualTheme;
  }
  return darkMedia.matches ? 'dark' : 'light';
}

function getRooms() {
  const rooms = window.__benchHost?.params?.rooms;
  return Array.isArray(rooms) ? rooms : [];
}

function formatOklch(accent) {
  if (Array.isArray(accent) && accent.length >= 3) {
    const [l, c, h] = accent;
    return `oklch(${Number(l).toFixed(3)} ${Number(c).toFixed(3)} ${Number(h).toFixed(1)})`;
  }
  return 'oklch(0.65 0.10 60)';
}

function formatIndex(i) {
  return String(i + 1).padStart(2, '0');
}

function parseHashRoute() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#/room/')) {
    const id = decodeURIComponent(hash.slice('#/room/'.length));
    const rooms = getRooms();
    const match = rooms.find((r) => r.id === id);
    if (match && match.status === 'coming_soon') {
      return 'lobby';
    }
    if (match) {
      return match.id;
    }
    // If rooms list is present and id does not exist, treat as lobby
    return rooms.length > 0 ? 'lobby' : id || 'lobby';
  }
  return 'lobby';
}

function applyTheme() {
  const root = document.documentElement;
  if (manualTheme === 'light' || manualTheme === 'dark') {
    root.setAttribute('data-theme', manualTheme);
  } else {
    root.removeAttribute('data-theme');
  }
  updateThemeButton();
}

function updateThemeButton() {
  const t = COPY[currentLang];
  const activeTheme = getEffectiveTheme();
  if (dom.themeToggle) {
    dom.themeToggle.textContent = activeTheme === 'dark' ? t.themeToLight : t.themeToDark;
    dom.themeToggle.setAttribute(
      'aria-label',
      activeTheme === 'dark' ? t.themeAriaLight : t.themeAriaDark,
    );
    dom.themeToggle.setAttribute('aria-pressed', activeTheme === 'dark' ? 'true' : 'false');
  }
}

function applyCopy() {
  const t = COPY[currentLang];
  document.documentElement.lang = currentLang;
  document.title = t.pageTitle;

  const nodes = document.querySelectorAll('[data-i18n]');
  for (const el of nodes) {
    const key = el.getAttribute('data-i18n');
    if (key && typeof t[key] === 'string') {
      el.textContent = t[key];
    }
  }

  if (dom.langToggle) {
    dom.langToggle.textContent = t.langBtnLabel;
    dom.langToggle.setAttribute('aria-label', t.langAria);
  }
  if (dom.footerNav) {
    dom.footerNav.setAttribute('aria-label', t.footerNavLabel);
  }
  updateThemeButton();
}

function renderRooms() {
  const rooms = getRooms();
  const t = COPY[currentLang];

  if (dom.roomsCount) {
    dom.roomsCount.textContent = t.roomsCount(rooms.length);
  }

  if (dom.emptyState) {
    dom.emptyState.hidden = rooms.length > 0;
  }

  if (!dom.roomsGrid) return;
  dom.roomsGrid.replaceChildren();

  const frag = document.createDocumentFragment();
  rooms.forEach((room, idx) => {
    const isSoon = room.status === 'coming_soon';
    const card = document.createElement('article');
    card.className = isSoon ? 'room-card room-card--coming-soon' : 'room-card';
    card.dataset.bench = 'room-card';
    card.dataset.roomId = room.id || `room-${idx + 1}`;
    card.dataset.status = isSoon ? 'coming_soon' : 'open';
    if (isSoon) {
      card.setAttribute('aria-disabled', 'true');
    }

    const accentColor = formatOklch(room.accent_oklch);
    card.style.setProperty('--card-accent', accentColor);

    const accentBar = document.createElement('div');
    accentBar.className = 'room-accent-bar';
    accentBar.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'room-card-body';

    const meta = document.createElement('div');
    meta.className = 'room-meta';

    const indexEl = document.createElement('span');
    indexEl.className = 'room-index';
    indexEl.textContent = formatIndex(idx);

    const statusEl = document.createElement('span');
    statusEl.className = 'room-status';
    statusEl.textContent = isSoon ? t.statusSoon : t.statusOpen;

    meta.append(indexEl, statusEl);

    const title = document.createElement('h3');
    title.className = 'room-title';
    const displayTitle =
      currentLang === 'en' && room.title_en ? room.title_en : (room.title_ko || room.title_en || '');
    title.textContent = displayTitle;

    const summary = document.createElement('p');
    summary.className = 'room-summary';
    if (currentLang === 'en') {
      summary.textContent =
        room.summary_en ||
        'Step inside this curated exhibition space to experience its quiet play of light and atmosphere.';
    } else {
      summary.textContent = room.summary_ko || '';
    }

    const cta = document.createElement('div');
    cta.className = 'room-cta';
    cta.textContent = isSoon ? t.openingSoon : t.enterRoom;

    body.append(accentBar, meta, title, summary, cta);

    if (isSoon) {
      card.append(body);
    } else {
      const link = document.createElement('a');
      link.className = 'room-card-link';
      link.href = room.route || `#/room/${room.id}`;
      link.append(body);
      card.append(link);
    }

    frag.append(card);
  });

  dom.roomsGrid.append(frag);
}

function syncRoomView() {
  const nextRoute = parseHashRoute();
  const prevRoute = currentRoute;
  currentRoute = nextRoute;

  if (!dom.roomView) return;

  if (nextRoute !== 'lobby') {
    if (prevRoute === 'lobby') {
      savedScrollY = window.scrollY;
    }
    const rooms = getRooms();
    const idx = rooms.findIndex((r) => r.id === nextRoute);
    const room = idx >= 0 ? rooms[idx] : null;

    if (room) {
      const accentColor = formatOklch(room.accent_oklch);
      dom.roomView.style.setProperty('--room-accent', accentColor);
      if (dom.roomViewIndex) dom.roomViewIndex.textContent = `ROOM ${formatIndex(idx)}`;
      if (dom.roomViewTitle) {
        dom.roomViewTitle.textContent =
          currentLang === 'en' && room.title_en ? room.title_en : (room.title_ko || room.title_en || '');
      }
      if (dom.roomViewSubtitle) {
        dom.roomViewSubtitle.textContent =
          currentLang === 'en' ? (room.title_ko || '') : (room.title_en || '');
      }
      if (dom.roomViewSummary) {
        dom.roomViewSummary.textContent =
          currentLang === 'en'
            ? (room.summary_en ||
                'Step inside this curated exhibition space to experience its quiet play of light and atmosphere.')
            : (room.summary_ko || '');
      }
    }

    dom.roomView.removeAttribute('inert');
    dom.roomView.setAttribute('aria-hidden', 'false');
    dom.roomView.dataset.open = 'true';
  } else {
    dom.roomView.dataset.open = 'false';
    dom.roomView.setAttribute('aria-hidden', 'true');
    dom.roomView.setAttribute('inert', '');
    if (prevRoute !== 'lobby' && Math.abs(window.scrollY - savedScrollY) > 2) {
      window.scrollTo({ top: savedScrollY, behavior: 'instant' });
    }
  }
}

function renderAll() {
  applyCopy();
  applyTheme();
  renderRooms();
  syncRoomView();
}

function addTrackedListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listenerCount += 1;
}

if (dom.langToggle) {
  addTrackedListener(dom.langToggle, 'click', () => {
    currentLang = currentLang === 'ko' ? 'en' : 'ko';
    try {
      window.localStorage.setItem(STORAGE_LANG_KEY, currentLang);
    } catch {
      // Ignore storage access errors
    }
    renderAll();
  });
}

if (dom.themeToggle) {
  addTrackedListener(dom.themeToggle, 'click', () => {
    const active = getEffectiveTheme();
    manualTheme = active === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
}

addTrackedListener(darkMedia, 'change', () => {
  manualTheme = null;
  applyTheme();
});

addTrackedListener(window, 'hashchange', () => {
  syncRoomView();
});

addTrackedListener(window, 'keydown', (event) => {
  if (event.key === 'Escape' && currentRoute !== 'lobby') {
    window.location.hash = '#/';
  }
});

renderAll();

const readyPromise =
  document.fonts && document.fonts.ready
    ? document.fonts.ready.then(() => undefined)
    : Promise.resolve();

window.__bench = {
  version: 1,
  ready: readyPromise,
  setSeed(_seed) {
    manualTheme = null;
    currentTimeMs = 0;
    renderAll();
  },
  seek(tMs) {
    currentTimeMs = Number(tMs) || 0;
    isLive = false;
  },
  resume() {
    isLive = true;
  },
  async renderFrame() {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
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
      listeners: listenerCount,
    };
  },
};
