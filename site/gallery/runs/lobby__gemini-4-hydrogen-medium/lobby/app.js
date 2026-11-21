const I18N = {
  ko: {
    eyebrow: 'DIGITAL EXHIBITION LOBBY',
    heroTitle: '빛의 방에 오신 것을 환영합니다',
    heroBody: '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 천천히 머물며 빛과 색, 그리고 조용한 이야기가 빚어내는 풍경을 만나보세요.',
    roomsHeading: '전시 공간',
    emptyTitle: '아직 공개된 방이 없습니다.',
    emptyBody: '새로운 빛의 전시를 정성껏 준비하고 있습니다. 잠시 후 다시 방문해 주세요.',
    infoHeading: '관람 안내',
    infoBody: '빛의 박물관은 브라우저 안에서 열리는 고요한 디지털 전시관입니다. 각 전시실은 독립된 빛의 실험과 서사를 담고 있으며, 원하는 순서대로 자유롭게 오갈 수 있습니다.',
    hoursLabel: '개관 시간',
    hoursValue: '연중무휴 · 24시간',
    admissionLabel: '관람료',
    admissionValue: '무료 입장',
    locationLabel: '위치',
    locationValue: '서울 · 디지털 아카이브',
    backToLobby: '← 로비로 돌아가기',
    roomDetailNote: '이 전시실은 현재 감상 모드로 열려 있습니다. 빛의 결을 따라 천천히 머물러 보세요.',
    footerBrand: 'Museum of Light · Seoul',
    footerLobby: '로비',
    footerTop: '맨 위로',
    badgeOpen: '개관 중',
    badgeSoon: '준비 중',
    enterRoom: '전시실 입장 →',
    countText: (n) => `총 ${n}개의 전시실`,
    langBtn: 'EN',
    themeToDark: '다크 모드',
    themeToLight: '라이트 모드',
  },
  en: {
    eyebrow: 'DIGITAL EXHIBITION LOBBY',
    heroTitle: 'Welcome to the Museum of Light',
    heroBody: 'Each room is a quiet world shaped for a different sense and reflection. Take your time moving through light, color, and understated digital architecture.',
    roomsHeading: 'Exhibition Rooms',
    emptyTitle: 'No exhibition rooms are open yet.',
    emptyBody: 'We are carefully preparing our next collection of light studies. Please return soon to explore the upcoming rooms.',
    infoHeading: 'Visitor Information',
    infoBody: 'The Museum of Light is a calm digital gallery inside your browser. Every room holds an independent study of light and narrative, ready to be visited in any order.',
    hoursLabel: 'Hours',
    hoursValue: 'Open daily · 24 hours',
    admissionLabel: 'Admission',
    admissionValue: 'Free entry',
    locationLabel: 'Location',
    locationValue: 'Seoul · Digital Archive',
    backToLobby: '← Back to Lobby',
    roomDetailNote: 'This room is open in quiet viewing mode. Take a moment to observe its light and tone.',
    footerBrand: 'Museum of Light · Seoul',
    footerLobby: 'Lobby',
    footerTop: 'Back to top',
    badgeOpen: 'Open',
    badgeSoon: 'Coming Soon',
    enterRoom: 'Enter room →',
    countText: (n) => `${n} exhibition ${n === 1 ? 'room' : 'rooms'}`,
    langBtn: '한국어',
    themeToDark: 'Dark Mode',
    themeToLight: 'Light Mode',
  },
};

const roomsRoot = document.getElementById('rooms');
const roomsCountEl = document.getElementById('rooms-count');
const emptyStateEl = document.querySelector('[data-bench="empty-state"]');
const lobbyViewEl = document.getElementById('lobby-view');
const roomViewEl = document.getElementById('room-view');
const langToggleBtn = document.querySelector('[data-bench="lang-toggle"]');
const themeToggleBtn = document.querySelector('[data-bench="theme-toggle"]');

let currentLang = (() => {
  try {
    return localStorage.getItem('mol-lang') === 'en' ? 'en' : 'ko';
  } catch {
    return 'ko';
  }
})();
let themeOverride = null;
let seekTimeMs = null;
let lastLobbyScrollY = 0;
let activeRoute = 'lobby';
let listenerCount = 0;

function addTrackedListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listenerCount += 1;
}

function getRooms() {
  const raw = window.__benchHost?.params?.rooms;
  return Array.isArray(raw) ? raw : [];
}

function getEffectiveTheme() {
  if (themeOverride === 'light' || themeOverride === 'dark') {
    return themeOverride;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function formatOklch(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return 'var(--accent)';
  const [L, C, h] = arr;
  return `oklch(${Number(L)} ${Number(C)} ${Number(h)})`;
}

function updateThemeUI() {
  const theme = getEffectiveTheme();
  if (themeOverride) {
    document.documentElement.setAttribute('data-theme', themeOverride);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const copy = I18N[currentLang];
  themeToggleBtn.textContent = theme === 'dark' ? copy.themeToLight : copy.themeToDark;
  themeToggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
}

function updateLanguageUI() {
  document.documentElement.lang = currentLang;
  const copy = I18N[currentLang];
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (typeof copy[key] === 'string') {
      el.textContent = copy[key];
    }
  }
  langToggleBtn.textContent = copy.langBtn;
  langToggleBtn.setAttribute('aria-pressed', String(currentLang === 'en'));
  updateThemeUI();
}

function renderRooms() {
  const rooms = getRooms();
  const copy = I18N[currentLang];
  roomsRoot.replaceChildren();

  roomsCountEl.textContent = copy.countText(rooms.length);
  emptyStateEl.hidden = rooms.length > 0;

  rooms.forEach((room, idx) => {
    const isSoon = room.status === 'coming_soon';
    const card = document.createElement('article');
    card.className = isSoon ? 'room-card room-card--soon' : 'room-card';
    card.dataset.bench = 'room-card';
    card.dataset.status = isSoon ? 'coming_soon' : 'open';
    card.style.setProperty('--room-accent', formatOklch(room.accent_oklch));

    const meta = document.createElement('div');
    meta.className = 'room-card__meta';

    const dotEl = document.createElement('span');
    dotEl.className = 'room-card__dot';
    dotEl.setAttribute('aria-hidden', 'true');

    const indexEl = document.createElement('span');
    indexEl.className = 'room-card__index';
    indexEl.textContent = String(idx + 1).padStart(2, '0');

    const badge = document.createElement('span');
    badge.className = isSoon ? 'room-card__badge' : 'room-card__badge room-card__badge--open';
    badge.textContent = isSoon ? copy.badgeSoon : copy.badgeOpen;

    meta.append(dotEl, indexEl, badge);

    const titleEl = document.createElement('h3');
    titleEl.className = 'room-card__title';
    titleEl.textContent = currentLang === 'en' && room.title_en ? room.title_en : (room.title_ko || '');

    const summaryEl = document.createElement('p');
    summaryEl.className = 'room-card__summary';
    summaryEl.textContent = room.summary_ko || '';

    if (isSoon) {
      card.append(meta, titleEl, summaryEl);
    } else {
      const link = document.createElement('a');
      link.className = 'room-card__link';
      link.href = room.route || `#/room/${room.id}`;

      const cta = document.createElement('span');
      cta.className = 'room-card__cta';
      cta.textContent = copy.enterRoom;

      link.append(meta, titleEl, summaryEl, cta);
      card.append(link);
    }

    roomsRoot.append(card);
  });
}

function resolveRouteFromHash() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#/room/')) return 'lobby';
  const id = hash.slice(7);
  const rooms = getRooms();
  const match = rooms.find((r) => r.id === id && r.status !== 'coming_soon');
  return match ? match.id : 'lobby';
}

function animatePanelEnter(el) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.add('is-entering');
  void el.offsetHeight;
  requestAnimationFrame(() => {
    el.classList.remove('is-entering');
  });
}

function syncRouteView({ animate = false } = {}) {
  const nextRoute = resolveRouteFromHash();
  const prevRoute = activeRoute;

  if (prevRoute === 'lobby' && nextRoute !== 'lobby') {
    lastLobbyScrollY = window.scrollY;
  }

  activeRoute = nextRoute;

  if (nextRoute === 'lobby') {
    roomViewEl.hidden = true;
    lobbyViewEl.hidden = false;
    if (animate && prevRoute !== 'lobby') {
      animatePanelEnter(lobbyViewEl);
    }
    if (prevRoute !== 'lobby') {
      window.scrollTo({ top: lastLobbyScrollY, behavior: 'instant' });
    }
  } else {
    const room = getRooms().find((r) => r.id === nextRoute);
    if (room) {
      const swatch = document.getElementById('room-detail-swatch');
      const idEl = document.getElementById('room-detail-id');
      const titleEl = document.getElementById('room-detail-title');
      const summaryEl = document.getElementById('room-detail-summary');

      swatch.style.setProperty('--room-accent', formatOklch(room.accent_oklch));
      idEl.textContent = room.id.toUpperCase();
      titleEl.textContent = currentLang === 'en' && room.title_en ? room.title_en : room.title_ko;
      summaryEl.textContent = room.summary_ko || '';
    }
    lobbyViewEl.hidden = true;
    roomViewEl.hidden = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (animate && prevRoute !== nextRoute) {
      animatePanelEnter(roomViewEl);
    }
  }
}

addTrackedListener(langToggleBtn, 'click', () => {
  currentLang = currentLang === 'ko' ? 'en' : 'ko';
  try {
    localStorage.setItem('mol-lang', currentLang);
  } catch {
    // Ignore storage errors in restricted contexts
  }
  updateLanguageUI();
  renderRooms();
  syncRouteView({ animate: false });
});

addTrackedListener(themeToggleBtn, 'click', () => {
  const current = getEffectiveTheme();
  themeOverride = current === 'dark' ? 'light' : 'dark';
  updateThemeUI();
});

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
addTrackedListener(darkMedia, 'change', () => {
  if (!themeOverride) {
    updateThemeUI();
  }
});

addTrackedListener(window, 'hashchange', () => {
  syncRouteView({ animate: true });
});

function renderAll() {
  updateLanguageUI();
  renderRooms();
  syncRouteView({ animate: false });
}

renderAll();

window.__bench = {
  version: 1,
  ready: document.fonts.ready.then(() => undefined),
  setSeed(_seed) {
    seekTimeMs = null;
    renderAll();
  },
  seek(tMs) {
    seekTimeMs = Number(tMs) || 0;
  },
  resume() {
    seekTimeMs = null;
  },
  async renderFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },
  state() {
    return {
      route: resolveRouteFromHash(),
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
