// Museum of Light — Lobby Application Logic

const DICTIONARY = {
  ko: {
    kicker: '전시 컬렉션 · Exhibition Collection',
    heroTitle: '빛과 사유가 머무는 디지털 전시관',
    heroBody: '빛과 기억이 포개어지는 공간에서 새로운 사유의 가능성을 마주합니다. 일상의 번잡함을 내려놓고 고요하게 빛의 흐름을 따라 거닐어 보세요.',
    roomsHeading: '전시 공간',
    roomsSubtitle: '각각의 방은 고유한 빛과 감각의 세계를 담고 있습니다.',
    emptyTitle: '전시 준비 중',
    emptyDesc: '현재 공개된 전시 공간이 없습니다. 새로운 빛의 방이 곧 열립니다.',
    infoTitle: '관람 안내',
    infoBody: '모든 전시는 웹 브라우저를 통해 언제든 자유롭게 입장하실 수 있습니다. 키보드 탐색과 고대비 화면을 지원하며, 빛과 색이 빚어내는 고유한 감각을 천천히 감상해 보세요.',
    footerCopy: 'Museum of Light · Seoul',
    footerTop: '처음으로',
    langBtnText: 'EN',
    langBtnAria: '영문으로 변경 / Switch to English',
    themeLabel: '테마',
    themeAria: '테마 전환',
    badgeOpen: '개관중',
    badgeSoon: '공개 예정',
    roomBack: '← 로비로 돌아가기',
    roomBadge: '전시실',
    defaultRoomSummary: '조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.'
  },
  en: {
    kicker: 'Exhibition Collection · Museum of Light',
    heroTitle: 'Welcome to the Museum of Light',
    heroBody: 'Step into curated spaces where radiance and quiet memory meet. Leave daily rush behind and wander freely through the gallery of digital light.',
    roomsHeading: 'Exhibition Rooms',
    roomsSubtitle: 'Each digital room holds its own subtle world of light, tone, and pacing.',
    emptyTitle: 'No Active Exhibitions',
    emptyDesc: 'There are currently no open exhibition rooms. New digital rooms will open soon.',
    infoTitle: 'Visitor Guide',
    infoBody: 'All digital rooms are open directly in your browser. Explore keyboard navigation, mindful pacing, and high-contrast schemes as you wander through our light collections.',
    footerCopy: 'Museum of Light · Seoul',
    footerTop: 'Back to top',
    langBtnText: 'KO',
    langBtnAria: '한국어로 변경 / Switch to Korean',
    themeLabel: 'Theme',
    themeAria: 'Toggle color theme',
    badgeOpen: 'Open',
    badgeSoon: 'Coming Soon',
    roomBack: '← Back to Lobby',
    roomBadge: 'Exhibition Room',
    defaultRoomSummary: 'A quiet space for reflection and discovery. Take your time to experience this digital sanctuary.'
  }
};

let currentLang = (typeof localStorage !== 'undefined' && localStorage.getItem('mol-lang')) || 'ko';
if (currentLang !== 'en' && currentLang !== 'ko') currentLang = 'ko';

const roomsGrid = document.getElementById('rooms');
const emptyStateEl = document.getElementById('empty-state');
const langToggleBtn = document.querySelector('[data-bench="lang-toggle"]');
const themeToggleBtn = document.querySelector('[data-bench="theme-toggle"]');
const roomViewEl = document.getElementById('room-view');
const roomCloseBtn = document.getElementById('room-close-btn');

function getRooms() {
  const r = window.__benchHost?.params?.rooms;
  return Array.isArray(r) ? r : [];
}

function getTheme() {
  if (document.documentElement.dataset.theme) {
    return document.documentElement.dataset.theme;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateStaticText() {
  const dict = DICTIONARY[currentLang] || DICTIONARY.ko;
  document.documentElement.lang = currentLang;

  const kicker = document.getElementById('hero-kicker');
  if (kicker) kicker.textContent = dict.kicker;

  const heroTitle = document.getElementById('hero-title');
  if (heroTitle) heroTitle.textContent = dict.heroTitle;

  const heroBody = document.getElementById('hero-body');
  if (heroBody) heroBody.textContent = dict.heroBody;

  const roomsHeading = document.getElementById('rooms-heading');
  if (roomsHeading) roomsHeading.textContent = dict.roomsHeading;

  const roomsSub = document.getElementById('rooms-subtitle');
  if (roomsSub) roomsSub.textContent = dict.roomsSubtitle;

  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.textContent = dict.emptyTitle;

  const emptyDesc = document.getElementById('empty-desc');
  if (emptyDesc) emptyDesc.textContent = dict.emptyDesc;

  const infoHeading = document.getElementById('info-heading');
  if (infoHeading) infoHeading.textContent = dict.infoTitle;

  const infoBody = document.getElementById('info-body');
  if (infoBody) infoBody.textContent = dict.infoBody;

  const topLink = document.getElementById('footer-top-link');
  if (topLink) topLink.textContent = dict.footerTop;

  if (langToggleBtn) {
    langToggleBtn.textContent = dict.langBtnText;
    langToggleBtn.setAttribute('aria-label', dict.langBtnAria);
  }

  const themeLabel = document.querySelector('.theme-label');
  if (themeLabel) themeLabel.textContent = dict.themeLabel;
  if (themeToggleBtn) themeToggleBtn.setAttribute('aria-label', dict.themeAria);

  if (roomCloseBtn) roomCloseBtn.textContent = dict.roomBack;
  const roomViewBadge = document.getElementById('room-view-badge');
  if (roomViewBadge) roomViewBadge.textContent = dict.roomBadge;
}

function renderRooms() {
  const rooms = getRooms();
  const dict = DICTIONARY[currentLang] || DICTIONARY.ko;

  if (emptyStateEl) {
    if (rooms.length === 0) {
      emptyStateEl.hidden = false;
      emptyStateEl.style.display = 'block';
    } else {
      emptyStateEl.hidden = true;
      emptyStateEl.style.display = 'none';
    }
  }

  if (!roomsGrid) return;
  roomsGrid.replaceChildren();

  for (const room of rooms) {
    const isComingSoon = room.status === 'coming_soon';
    const card = document.createElement(isComingSoon ? 'article' : 'a');
    card.dataset.bench = 'room-card';
    card.className = `room-card ${isComingSoon ? 'card-coming-soon' : 'card-open'}`;
    card.setAttribute('data-status', room.status || 'open');

    if (!isComingSoon && room.route) {
      card.href = room.route;
      card.setAttribute('data-route', room.route);
    }

    const titleText = currentLang === 'en'
      ? (room.title_en || room.title_ko || '')
      : (room.title_ko || '');

    const summaryText = currentLang === 'en'
      ? (room.summary_en || dict.defaultRoomSummary)
      : (room.summary_ko || dict.defaultRoomSummary);

    // Card Meta
    const metaBar = document.createElement('div');
    metaBar.className = 'card-meta';

    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = isComingSoon ? dict.badgeSoon : dict.badgeOpen;
    metaBar.append(badge);

    card.append(metaBar);

    // Card Title (h3 with exact required text)
    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = titleText;
    card.append(title);

    // Card Summary
    const summary = document.createElement('p');
    summary.className = 'card-summary';
    summary.textContent = summaryText;
    card.append(summary);

    if (!isComingSoon) {
      card.addEventListener('click', () => {
        triggerNavTransition();
      });
    }

    roomsGrid.append(card);
  }
}

function triggerNavTransition() {
  if (roomViewEl) {
    roomViewEl.classList.remove('nav-active');
    void roomViewEl.offsetWidth; // Force reflow
    roomViewEl.classList.add('nav-active');
  }
}

function updateRouteView() {
  const hash = window.location.hash || '';
  const isRoomRoute = hash.startsWith('#/room/');

  if (isRoomRoute) {
    const roomId = hash.replace(/^#\/room\//, '');
    const rooms = getRooms();
    const room = rooms.find((r) => r.id === roomId || r.route === hash) || {
      id: roomId,
      title_ko: '전시실 ' + roomId,
      title_en: 'Room ' + roomId,
      summary_ko: DICTIONARY.ko.defaultRoomSummary,
      summary_en: DICTIONARY.en.defaultRoomSummary
    };

    if (roomViewEl) {
      const titleEl = document.getElementById('room-view-title');
      const descEl = document.getElementById('room-view-desc');

      const titleText = currentLang === 'en' ? (room.title_en || room.title_ko) : room.title_ko;
      const descText = currentLang === 'en'
        ? (room.summary_en || DICTIONARY.en.defaultRoomSummary)
        : (room.summary_ko || DICTIONARY.ko.defaultRoomSummary);

      if (titleEl) titleEl.textContent = titleText;
      if (descEl) descEl.textContent = descText;

      roomViewEl.hidden = false;
      triggerNavTransition();
    }
  } else {
    if (roomViewEl) {
      roomViewEl.hidden = true;
      roomViewEl.classList.remove('nav-active');
    }
  }
}

function toggleTheme() {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mol-theme', next);
  } catch {}
}

function toggleLanguage() {
  const next = currentLang === 'en' ? 'ko' : 'en';
  currentLang = next;
  try {
    localStorage.setItem('mol-lang', next);
  } catch {}
  updateStaticText();
  renderRooms();
  updateRouteView();
}

// Event Listeners
if (langToggleBtn) {
  langToggleBtn.addEventListener('click', toggleLanguage);
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', toggleTheme);
}

if (roomCloseBtn) {
  roomCloseBtn.addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.hash = '#/';
    }
  });
}

window.addEventListener('hashchange', () => {
  updateRouteView();
});

// Initial Setup
const savedTheme = (typeof localStorage !== 'undefined' && localStorage.getItem('mol-theme')) || null;
if (savedTheme) {
  document.documentElement.dataset.theme = savedTheme;
}
updateStaticText();
renderRooms();
updateRouteView();

// Bench Runtime Contract (contract/bench.d.ts)
window.__bench = {
  version: 1,
  ready: (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {}),
  setSeed(seed) {
    renderRooms();
    updateRouteView();
  },
  seek(tMs) {
    // Deterministic frozen virtual clock
  },
  resume() {
    // Resume live virtual clock
  },
  async renderFrame() {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  },
  state() {
    const hash = window.location.hash || '';
    let route = 'lobby';
    if (hash.startsWith('#/room/')) {
      route = hash.replace(/^#\/room\//, '');
    } else if (hash && hash !== '#/' && hash !== '#top') {
      route = hash.replace(/^#\/?/, '');
    }
    return {
      route,
      lang: currentLang,
      theme: getTheme()
    };
  },
  stats() {
    return {
      drawCalls: 0,
      triangles: 0
    };
  }
};
