/**
 * Museum of Light — Lobby Application
 * Deterministic, accessible museum entrance implementing the BenchRoom v1 contract.
 */

// DOM Elements
const appEl = document.querySelector('#app');
const roomsContainer = document.querySelector('#rooms');
const emptyStateEl = document.querySelector('#empty-state');
const langToggleBtn = document.querySelector('[data-bench="lang-toggle"]');
const langBtnText = document.querySelector('#lang-btn-text');
const themeToggleBtn = document.querySelector('[data-bench="theme-toggle"]');
const themeBtnText = document.querySelector('#theme-btn-text');

const heroHeading = document.querySelector('#hero-heading');
const heroDesc = document.querySelector('#hero-desc');
const heroTag = document.querySelector('#hero-tag');
const brandSub = document.querySelector('#brand-sub');
const collectionHeading = document.querySelector('#collection-heading');
const roomCountMeta = document.querySelector('#room-count-meta');
const footerDesc = document.querySelector('#footer-desc');

const roomModal = document.querySelector('#room-modal');
const modalRoomTitle = document.querySelector('#modal-room-title');
const modalRoomSummary = document.querySelector('#modal-room-summary');
const modalAccentBar = document.querySelector('#modal-accent-bar');
const modalBadge = document.querySelector('#modal-badge');
const backLinkText = document.querySelector('#back-link-text');

// Translations
const I18N = {
  ko: {
    heroTitle: '빛의 방에 오신 것을 환영합니다',
    heroDesc: '빛과 어둠, 시선과 침묵이 교차하는 전시 공간입니다. 열려 있는 각 방을 거닐며 천천히 머물러 보세요. 예술과 사유가 만나는 고요한 순간을 전합니다.',
    brandSub: '빛의 미술관 · Seoul',
    heroTag: '전시 컬렉션 · Exhibition Collection',
    collectionTitle: '전시 공간',
    roomCount: (n) => `${n}개의 전시실`,
    emptyState: '아직 공개된 방이 없습니다. 새로운 전시 준비 중입니다.',
    footerDesc: '빛과 기억, 디지털 사유를 위한 공간 · Seoul 37.5665° N, 126.9780° E',
    langBtn: 'English',
    themeBtnDark: '다크 모드',
    themeBtnLight: '라이트 모드',
    openBadge: '입장 가능',
    comingSoonBadge: '준비 중',
    enterAction: '입장하기 →',
    comingSoonAction: '공개 예정',
    backBtn: '로비로 돌아가기',
  },
  en: {
    heroTitle: 'Welcome to the Rooms of Light',
    heroDesc: 'A curated sanctuary exploring quiet light, space, and memory. Wander through each open room at your own pace, discovering intimate perspectives and contemplative moments.',
    brandSub: 'Museum of Light · Seoul',
    heroTag: 'Exhibition Collection',
    collectionTitle: 'Exhibition Galleries',
    roomCount: (n) => `${n} ${n === 1 ? 'gallery' : 'galleries'}`,
    emptyState: 'There are currently no open galleries. A new exhibition is being prepared.',
    footerDesc: 'A sanctuary for light, memory, and contemplative space · Seoul 37.5665° N, 126.9780° E',
    langBtn: '한국어',
    themeBtnDark: 'Dark Mode',
    themeBtnLight: 'Light Mode',
    openBadge: 'Open',
    comingSoonBadge: 'Coming Soon',
    enterAction: 'Enter Room →',
    comingSoonAction: 'Coming Soon',
    backBtn: 'Back to Lobby',
  },
};

// Initial state resolution: Korean is always the primary museum entrance default
function getStoredLang() {
  const stored = localStorage.getItem('mol-lang');
  if (stored === 'en' || stored === 'ko') return stored;
  return 'ko';
}

function getStoredTheme() {
  const stored = localStorage.getItem('mol-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

let currentLang = getStoredLang();
let currentTheme = getStoredTheme();

function getRoute() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#/room/')) {
    const id = hash.slice(7).trim();
    if (id) return id;
  }
  return 'lobby';
}

// Apply theme to DOM
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const strings = I18N[currentLang];
  if (themeBtnText) {
    themeBtnText.textContent = theme === 'dark' ? strings.themeBtnLight : strings.themeBtnDark;
  }
}

function setTheme(theme, persist = false) {
  applyTheme(theme);
  if (persist) {
    localStorage.setItem('mol-theme', theme);
  }
}

// Apply language to DOM
function setLanguage(lang) {
  currentLang = lang;
  document.documentElement.lang = lang;
  localStorage.setItem('mol-lang', lang);

  const t = I18N[lang];
  if (heroHeading) heroHeading.textContent = t.heroTitle;
  if (heroDesc) heroDesc.textContent = t.heroDesc;
  if (heroTag) heroTag.textContent = t.heroTag;
  if (brandSub) brandSub.textContent = t.brandSub;
  if (collectionHeading) collectionHeading.textContent = t.collectionTitle;
  if (emptyStateEl) emptyStateEl.textContent = t.emptyState;
  if (footerDesc) footerDesc.textContent = t.footerDesc;
  if (langBtnText) langBtnText.textContent = t.langBtn;
  if (backLinkText) backLinkText.textContent = t.backBtn;

  applyTheme(currentTheme);
  renderRooms();
}

// Render room cards from host params
function renderRooms() {
  const rooms = Array.isArray(window.__benchHost?.params?.rooms) ? window.__benchHost.params.rooms : [];
  const t = I18N[currentLang];

  if (roomCountMeta) {
    roomCountMeta.textContent = t.roomCount(rooms.length);
  }

  // Handle empty state landmark
  if (emptyStateEl) {
    const isEmpty = rooms.length === 0;
    emptyStateEl.hidden = !isEmpty;
    emptyStateEl.style.display = isEmpty ? 'block' : 'none';
  }

  roomsContainer.replaceChildren();

  for (const room of rooms) {
    const isComingSoon = room.status === 'coming_soon';
    const card = document.createElement('article');
    card.dataset.bench = 'room-card';
    card.dataset.status = room.status || 'open';
    card.className = `room-card ${isComingSoon ? 'is-coming-soon' : ''}`;

    const [L, C, h] = Array.isArray(room.accent_oklch) && room.accent_oklch.length === 3
      ? room.accent_oklch
      : [0.65, 0.12, 45];
    const accentColor = `oklch(${L} ${C} ${h})`;

    const titleText = currentLang === 'en' ? (room.title_en || room.title_ko) : (room.title_ko || room.title_en);
    const summaryText = room.summary_ko || '';

    if (isComingSoon) {
      // Non-interactive container: no <a> tag, no href
      const inner = document.createElement('div');
      inner.className = 'card-body-wrapper';

      const bar = document.createElement('div');
      bar.className = 'card-accent-bar';
      bar.style.backgroundColor = accentColor;
      card.append(bar);

      const headerRow = document.createElement('div');
      headerRow.className = 'card-header-row';

      const badge = document.createElement('span');
      badge.className = 'status-badge coming-soon';
      badge.textContent = `${t.comingSoonBadge} · ${room.id}`;

      headerRow.append(badge);

      const h3 = document.createElement('h3');
      h3.textContent = titleText;

      const p = document.createElement('p');
      p.className = 'card-summary';
      p.textContent = summaryText;

      const actionRow = document.createElement('div');
      actionRow.className = 'card-action-row';

      const actionText = document.createElement('span');
      actionText.className = 'card-action-text';
      actionText.textContent = t.comingSoonAction;

      actionRow.append(actionText);

      inner.append(headerRow, h3, p, actionRow);
      card.append(inner);
    } else {
      // Open room: contains <a> link to room route
      const bar = document.createElement('div');
      bar.className = 'card-accent-bar';
      bar.style.backgroundColor = accentColor;
      card.append(bar);

      const link = document.createElement('a');
      link.className = 'card-link-wrapper card-body-wrapper';
      link.href = room.route || `#/room/${room.id}`;
      link.setAttribute('aria-label', `${titleText} — ${t.enterAction}`);

      const headerRow = document.createElement('div');
      headerRow.className = 'card-header-row';

      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.textContent = `${t.openBadge} · ${room.id}`;

      headerRow.append(badge);

      const h3 = document.createElement('h3');
      h3.textContent = titleText;

      const p = document.createElement('p');
      p.className = 'card-summary';
      p.textContent = summaryText;

      const actionRow = document.createElement('div');
      actionRow.className = 'card-action-row';

      const actionText = document.createElement('span');
      actionText.className = 'card-action-text';
      actionText.textContent = t.enterAction;

      actionRow.append(actionText);

      link.append(headerRow, h3, p, actionRow);
      card.append(link);
    }

    roomsContainer.append(card);
  }
}

// Router & navigation handling
let isNavigatingTransition = false;

function handleRouteChange() {
  const route = getRoute();
  const rooms = Array.isArray(window.__benchHost?.params?.rooms) ? window.__benchHost.params.rooms : [];

  if (route !== 'lobby') {
    const room = rooms.find((r) => r.id === route);
    if (room && room.status !== 'coming_soon') {
      const [L, C, h] = Array.isArray(room.accent_oklch) && room.accent_oklch.length === 3
        ? room.accent_oklch
        : [0.65, 0.12, 45];
      if (modalAccentBar) modalAccentBar.style.backgroundColor = `oklch(${L} ${C} ${h})`;
      if (modalRoomTitle) modalRoomTitle.textContent = currentLang === 'en' ? (room.title_en || room.title_ko) : (room.title_ko || room.title_en);
      if (modalRoomSummary) modalRoomSummary.textContent = room.summary_ko || '';
      if (modalBadge) modalBadge.textContent = `${I18N[currentLang].openBadge} · ${room.id}`;
      if (roomModal) roomModal.hidden = false;
    }

    if (!isNavigatingTransition) {
      isNavigatingTransition = true;
      appEl.classList.add('is-navigating');
      setTimeout(() => {
        appEl.classList.remove('is-navigating');
        isNavigatingTransition = false;
      }, 350);
    }
  } else {
    if (roomModal) roomModal.hidden = true;
    appEl.classList.remove('is-navigating');
    isNavigatingTransition = false;
  }
}

// Event Listeners
if (langToggleBtn) {
  langToggleBtn.addEventListener('click', () => {
    setLanguage(currentLang === 'ko' ? 'en' : 'ko');
  });
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    setTheme(currentTheme === 'light' ? 'dark' : 'light', true);
  });
}

window.addEventListener('hashchange', () => {
  handleRouteChange();
});

// React to OS dark mode preference changes when not explicitly overridden
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('mol-theme')) {
      setTheme(e.matches ? 'dark' : 'light', false);
    }
  });
}

// Initial initialization
document.documentElement.lang = currentLang;
applyTheme(currentTheme);
renderRooms();
handleRouteChange();

// BenchRoom v1 implementation
window.__bench = {
  version: 1,
  ready: (async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    }
  })(),
  setSeed(seed) {
    renderRooms();
    handleRouteChange();
  },
  seek(tMs) {
    // DOM-based room; time-frozen frames resolve deterministically
  },
  resume() {
    // Resume live loop
  },
  async renderFrame() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },
  state() {
    return {
      route: getRoute(),
      lang: currentLang,
      theme: currentTheme,
    };
  },
  stats() {
    return {
      drawCalls: 0,
      triangles: 0,
    };
  },
};
