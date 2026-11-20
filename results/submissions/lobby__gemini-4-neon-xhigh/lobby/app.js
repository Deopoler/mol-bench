const LANG_STORAGE_KEY = 'mol-lang';

const COPY = {
  ko: {
    pageTitle: '빛의 미술관 — Museum of Light',
    skipToMain: '본문으로 바로가기',
    brandAria: '빛의 미술관 로비',
    headerControlsLabel: '화면 설정',
    langButtonText: 'EN',
    langButtonAria: '영어로 전환',
    themeLabelToDark: '다크',
    themeLabelToLight: '라이트',
    themeAriaToDark: '어두운 테마로 전환',
    themeAriaToLight: '밝은 테마로 전환',
    heroEyebrow: '서울 · 디지털 상설 전시',
    heroTitle: '빛이 머무는 방으로 초대합니다',
    heroBody:
      '빛의 미술관은 고요한 빛과 감각을 탐구하는 작은 디지털 전시관입니다. 정해진 순서 없이 원하는 공간을 천천히 거닐며 머물러 보세요.',
    collectionTitle: '전시 공간',
    emptyTitle: '아직 공개된 방이 없습니다',
    emptyBody:
      '새로운 빛의 전시를 정성껏 준비하고 있습니다. 잠시 후 다시 방문하시면 열려 있는 전시 공간을 둘러보실 수 있습니다.',
    guideTitle: '관람 안내',
    guideBody:
      '모든 전시 공간은 별도의 설치나 외부 연결 없이 브라우저 안에서 바로 열립니다. 키보드 탭 이동과 어두운 화면 모드, 동작 줄이기 설정을 모두 지원하여 누구나 자신만의 속도로 고요히 관람할 수 있습니다.',
    infoHoursTerm: '개관 시간',
    infoHoursDesc: '상시 개관 · 오프라인 관람 지원',
    infoAdmissionTerm: '관람 안내',
    infoAdmissionDesc: '무료 입장 · 순서 없는 자유 관람',
    infoAccessTerm: '접근성',
    infoAccessDesc: '키보드 탐색 · 명암비 준수 · 동작 축소',
    footerTitle: '빛의 미술관 · 서울',
    footerNote: '디지털 빛과 감각의 아카이브',
    footerNavLabel: '하단 탐색',
    navCollection: '전시 공간',
    navGuide: '관람 안내',
    navTop: '맨 위로',
    statusOpen: '관람 가능',
    statusComingSoon: '준비 중',
    ctaOpen: '방에 들어가기 →',
    ctaComingSoon: '전시 준비 중',
    backToLobby: '로비로 돌아가기',
    stageStatus: '현재 관람 중인 공간',
    roomCountEmpty: '현재 공개된 전시가 없습니다',
    roomCountFormat(total, open, soon) {
      if (soon > 0) {
        return `총 ${total}개의 방 · ${open}개 관람 가능 · ${soon}개 준비 중`;
      }
      return `총 ${total}개의 방 · ${open}개 관람 가능`;
    },
    fallbackSummary: '고요한 빛과 색의 결을 천천히 관찰하는 디지털 전시 공간입니다.',
  },
  en: {
    pageTitle: 'Museum of Light — Seoul',
    skipToMain: 'Skip to main content',
    brandAria: 'Museum of Light lobby',
    headerControlsLabel: 'Display preferences',
    langButtonText: '한국어',
    langButtonAria: 'Switch language to Korean',
    themeLabelToDark: 'Dark',
    themeLabelToLight: 'Light',
    themeAriaToDark: 'Switch to dark theme',
    themeAriaToLight: 'Switch to light theme',
    heroEyebrow: 'SEOUL · DIGITAL PERMANENT COLLECTION',
    heroTitle: 'Step into quiet rooms shaped by light',
    heroBody:
      'The Museum of Light is a quiet digital exhibition space shaped by color and stillness. Wander at your own pace through rooms tuned to distinct moods of light.',
    collectionTitle: 'Exhibition Rooms',
    emptyTitle: 'No exhibition rooms are open yet',
    emptyBody:
      'New exhibitions of digital light are currently being prepared. Please return shortly to explore the rooms as they open.',
    guideTitle: 'Visitor Guide',
    guideBody:
      'Every room in the collection opens directly in your browser without external dependencies. Full keyboard navigation, light and dark themes, and reduced-motion preferences are supported so every visitor can explore at ease.',
    infoHoursTerm: 'Hours',
    infoHoursDesc: 'Open daily · Available offline',
    infoAdmissionTerm: 'Admission',
    infoAdmissionDesc: 'Free entry · Self-guided order',
    infoAccessTerm: 'Accessibility',
    infoAccessDesc: 'Keyboard reach · High contrast · Reduced motion',
    footerTitle: 'Museum of Light · Seoul',
    footerNote: 'An archive of digital light and perception',
    footerNavLabel: 'Footer navigation',
    navCollection: 'Rooms',
    navGuide: 'Visitor Guide',
    navTop: 'Back to top',
    statusOpen: 'Open',
    statusComingSoon: 'Coming soon',
    ctaOpen: 'Enter room →',
    ctaComingSoon: 'Opening soon',
    backToLobby: 'Back to lobby',
    stageStatus: 'Now viewing exhibition room',
    roomCountEmpty: 'No rooms currently published',
    roomCountFormat(total, open, soon) {
      const noun = total === 1 ? 'room' : 'rooms';
      if (soon > 0) {
        return `${total} ${noun} · ${open} open · ${soon} coming soon`;
      }
      return `${total} ${noun} · ${open} open`;
    },
    fallbackSummary: 'A quiet digital room tuned to light, color temperature, and unhurried observation.',
  },
};

const EN_SUMMARY_VARIANTS = [
  'Wander through layered light and memory where familiar landscapes soften into a quieter perspective.',
  'A calm space designed for unhurried observation, subtle color shifts, and personal discovery.',
];

const lobbyShell = document.getElementById('lobby-shell');
const roomsRoot = document.getElementById('rooms');
const roomCountEl = document.getElementById('room-count');
const emptyStateEl = document.querySelector('[data-bench="empty-state"]');
const langToggleBtn = document.querySelector('[data-bench="lang-toggle"]');
const langLabelEl = langToggleBtn?.querySelector('[data-role="lang-label"]');
const themeToggleBtn = document.querySelector('[data-bench="theme-toggle"]');
const themeLabelEl = themeToggleBtn?.querySelector('[data-role="theme-label"]');
const brandLink = document.querySelector('.brand');

const roomStageEl = document.getElementById('room-stage');
const stageBackLink = document.getElementById('stage-back');
const stageIndexEl = document.getElementById('stage-index');
const stageFieldEl = document.getElementById('stage-field');
const stageStatusEl = document.getElementById('stage-status');
const stageTitleEl = document.getElementById('stage-title');
const stageSubtitleEl = document.getElementById('stage-subtitle');
const stageSummaryEl = document.getElementById('stage-summary');
const stageSpectrumEl = document.getElementById('stage-spectrum');

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');

let roomsData = [];
let currentLang = detectInitialLang();
let manualLangOverride = hasStoredLang();
let currentTheme = darkMedia.matches ? 'dark' : 'light';
let manualThemeOverride = false;
let currentRoute = 'lobby';
let savedLobbyScrollY = 0;
let lastFocusedCardId = null;
let pendingRestoreFocus = false;
let frozenTimeMs = null;

function safeReadStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage restriction in private/isolated contexts
  }
}

function hasStoredLang() {
  const stored = safeReadStorage(LANG_STORAGE_KEY);
  return stored === 'ko' || stored === 'en';
}

function detectInitialLang() {
  const stored = safeReadStorage(LANG_STORAGE_KEY);
  if (stored === 'ko' || stored === 'en') return stored;
  // Museum of Light defaults to Korean primary; user can switch via lang-toggle
  // or runtime languagechange event.
  return 'ko';
}

function detectLocaleLang() {
  const navLang = String(navigator.language || '').toLowerCase();
  return /^en\b/.test(navLang) ? 'en' : 'ko';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function formatIndex(n) {
  return String(n).padStart(2, '0');
}

function normalizeRooms(rawRooms) {
  if (!Array.isArray(rawRooms)) return [];
  return rawRooms
    .filter((item) => item && typeof item === 'object')
    .map((item, idx) => {
      const id = String(item.id || `room-${idx + 1}`);
      const route = typeof item.route === 'string' && item.route.trim()
        ? item.route.trim()
        : `#/room/${id}`;
      const titleKo = String(item.title_ko ?? item.title_en ?? id);
      const titleEn = typeof item.title_en === 'string' && item.title_en.length > 0
        ? item.title_en
        : '';
      const summaryKo = typeof item.summary_ko === 'string' && item.summary_ko.length > 0
        ? item.summary_ko
        : COPY.ko.fallbackSummary;
      const summaryEn = typeof item.summary_en === 'string' && item.summary_en.length > 0
        ? item.summary_en
        : EN_SUMMARY_VARIANTS[idx % EN_SUMMARY_VARIANTS.length];
      const status = item.status === 'coming_soon' ? 'coming_soon' : 'open';
      const rawAccent = Array.isArray(item.accent_oklch) && item.accent_oklch.length >= 3
        ? item.accent_oklch
        : [0.68, 0.12, (idx * 37 + 30) % 360];
      const l = clamp(Number(rawAccent[0]) || 0.68, 0.45, 0.82);
      const c = clamp(Number(rawAccent[1]) || 0.12, 0.04, 0.16);
      const h = ((Number(rawAccent[2]) || 0) % 360 + 360) % 360;
      return {
        index: idx + 1,
        id,
        route,
        title_ko: titleKo,
        title_en: titleEn,
        summary_ko: summaryKo,
        summary_en: summaryEn,
        status,
        accent_oklch: [l, c, h],
      };
    });
}

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = currentTheme;
  updateThemeControl();
}

function updateThemeControl() {
  if (!themeToggleBtn) return;
  const t = COPY[currentLang];
  const isDark = currentTheme === 'dark';
  themeToggleBtn.setAttribute('aria-pressed', String(isDark));
  themeToggleBtn.setAttribute('aria-label', isDark ? t.themeAriaToLight : t.themeAriaToDark);
  if (themeLabelEl) {
    themeLabelEl.textContent = isDark ? t.themeLabelToLight : t.themeLabelToDark;
  }
}

function applyLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'ko';
  document.documentElement.lang = currentLang;
  const t = COPY[currentLang];
  document.title = t.pageTitle;

  if (brandLink) {
    brandLink.setAttribute('aria-label', t.brandAria);
  }
  if (langToggleBtn) {
    langToggleBtn.setAttribute('aria-label', t.langButtonAria);
    if (langLabelEl) {
      langLabelEl.lang = currentLang === 'ko' ? 'en' : 'ko';
      langLabelEl.textContent = t.langButtonText;
    } else {
      langToggleBtn.textContent = t.langButtonText;
    }
  }

  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key && typeof t[key] === 'string') {
      el.textContent = t[key];
    }
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    const key = el.getAttribute('data-i18n-aria');
    if (key && typeof t[key] === 'string') {
      el.setAttribute('aria-label', t[key]);
    }
  }

  updateThemeControl();
  renderRooms();
  if (currentRoute !== 'lobby') {
    const activeRoom = findOpenRoomById(currentRoute);
    if (activeRoom) {
      populateStage(activeRoom);
    }
  }
}

function getRoomPrimaryTitle(room) {
  if (currentLang === 'en' && room.title_en) {
    return room.title_en;
  }
  return room.title_ko;
}

function getRoomSecondaryTitle(room) {
  if (currentLang === 'en') {
    return room.title_en && room.title_ko !== room.title_en
      ? { text: room.title_ko, lang: 'ko' }
      : null;
  }
  return room.title_en && room.title_en !== room.title_ko
    ? { text: room.title_en, lang: 'en' }
    : null;
}

function getRoomSummary(room) {
  return currentLang === 'en' ? room.summary_en : room.summary_ko;
}

function renderRooms() {
  const t = COPY[currentLang];
  roomsRoot.replaceChildren();

  const openCount = roomsData.filter((r) => r.status === 'open').length;
  const soonCount = roomsData.length - openCount;
  if (roomCountEl) {
    roomCountEl.textContent = roomsData.length === 0
      ? t.roomCountEmpty
      : t.roomCountFormat(roomsData.length, openCount, soonCount);
  }

  if (emptyStateEl) {
    emptyStateEl.hidden = roomsData.length > 0;
  }

  if (roomsData.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const room of roomsData) {
    const isComingSoon = room.status === 'coming_soon';
    const article = document.createElement('article');
    article.className = isComingSoon ? 'room-card room-card--coming-soon' : 'room-card';
    article.dataset.bench = 'room-card';
    article.dataset.status = room.status;
    article.dataset.roomId = room.id;
    article.style.setProperty('--room-h', String(room.accent_oklch[2]));
    article.style.setProperty('--room-c', String(room.accent_oklch[1]));
    if (isComingSoon) {
      article.setAttribute('aria-disabled', 'true');
    }

    const wrapper = isComingSoon ? document.createElement('div') : document.createElement('a');
    wrapper.className = isComingSoon ? 'room-card-static' : 'room-card-link';
    if (!isComingSoon) {
      wrapper.href = room.route;
      wrapper.dataset.roomId = room.id;
    }

    const band = document.createElement('div');
    band.className = 'room-card-band';
    band.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'room-card-main';

    const meta = document.createElement('p');
    meta.className = 'room-card-meta';

    const num = document.createElement('span');
    num.className = 'room-num';
    num.textContent = formatIndex(room.index);

    const sep = document.createElement('span');
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = ' · ';

    const status = document.createElement('span');
    status.className = 'room-status';
    status.textContent = isComingSoon ? t.statusComingSoon : t.statusOpen;

    meta.append(num, sep, status);

    const heading = document.createElement('h3');
    heading.className = 'room-card-title';
    heading.textContent = getRoomPrimaryTitle(room);

    main.append(meta, heading);

    const secondary = getRoomSecondaryTitle(room);
    if (secondary) {
      const sub = document.createElement('p');
      sub.className = 'room-card-sub';
      sub.lang = secondary.lang;
      sub.textContent = secondary.text;
      main.append(sub);
    }

    const summary = document.createElement('p');
    summary.className = 'room-card-summary';
    summary.textContent = getRoomSummary(room);
    main.append(summary);

    const foot = document.createElement('div');
    foot.className = 'room-card-foot';

    const cta = document.createElement('span');
    cta.className = 'room-card-cta';
    cta.textContent = isComingSoon ? t.ctaComingSoon : t.ctaOpen;
    foot.append(cta);

    wrapper.append(band, main, foot);
    article.append(wrapper);
    fragment.append(article);
  }

  roomsRoot.append(fragment);
}

function findOpenRoomByHash(hash) {
  if (!hash || hash === '#' || hash === '#/' || hash === '#/lobby') return null;
  const exact = roomsData.find((r) => r.status === 'open' && r.route === hash);
  if (exact) return exact;
  if (hash.startsWith('#/room/')) {
    const id = decodeURIComponent(hash.slice('#/room/'.length));
    return roomsData.find((r) => r.status === 'open' && r.id === id) || null;
  }
  return null;
}

function findOpenRoomById(id) {
  return roomsData.find((r) => r.status === 'open' && r.id === id) || null;
}

function populateStage(room) {
  const t = COPY[currentLang];
  const [l, c, h] = room.accent_oklch;
  roomStageEl.style.setProperty('--room-h', String(h));
  roomStageEl.style.setProperty('--room-c', String(c));

  stageIndexEl.lang = 'en';
  stageIndexEl.textContent = `ROOM ${formatIndex(room.index)} / ${formatIndex(roomsData.length)}`;
  stageStatusEl.textContent = t.stageStatus;
  stageTitleEl.textContent = getRoomPrimaryTitle(room);

  const secondary = getRoomSecondaryTitle(room);
  if (secondary) {
    stageSubtitleEl.hidden = false;
    stageSubtitleEl.lang = secondary.lang;
    stageSubtitleEl.textContent = secondary.text;
  } else {
    stageSubtitleEl.hidden = true;
    stageSubtitleEl.textContent = '';
  }

  stageSummaryEl.textContent = getRoomSummary(room);
  stageSpectrumEl.lang = 'en';
  stageSpectrumEl.textContent = `OKLCH · L ${l.toFixed(2)} · C ${c.toFixed(2)} · H ${Math.round(h)}°`;
  stageFieldEl.dataset.roomId = room.id;
}

function openRoomStage(room, { animate = true } = {}) {
  const enteringFromLobby = currentRoute === 'lobby';
  if (enteringFromLobby) {
    savedLobbyScrollY = window.scrollY;
  }
  currentRoute = room.id;
  populateStage(room);

  roomStageEl.classList.remove('is-entering');
  roomStageEl.hidden = false;
  if (lobbyShell) {
    lobbyShell.inert = true;
    lobbyShell.setAttribute('aria-hidden', 'true');
  }

  if (animate && !reducedMotionMedia.matches) {
    void roomStageEl.offsetWidth;
    roomStageEl.classList.add('is-entering');
  }
  roomStageEl.scrollTop = 0;
}

function closeRoomStage({ restoreFocus = false } = {}) {
  const wasInRoom = currentRoute !== 'lobby';
  currentRoute = 'lobby';
  roomStageEl.classList.remove('is-entering');
  roomStageEl.hidden = true;

  if (lobbyShell) {
    lobbyShell.inert = false;
    lobbyShell.removeAttribute('aria-hidden');
  }

  if (wasInRoom) {
    const targetY = savedLobbyScrollY;
    window.scrollTo({ top: targetY, behavior: 'instant' });
    Promise.resolve().then(() => {
      if (currentRoute === 'lobby') {
        window.scrollTo({ top: targetY, behavior: 'instant' });
      }
    });
    if (restoreFocus && lastFocusedCardId) {
      const link = roomsRoot.querySelector(
        `[data-bench="room-card"][data-room-id="${CSS.escape(lastFocusedCardId)}"] a`,
      );
      if (link) link.focus({ preventScroll: true });
    }
  }
}

function syncRouteFromHash({ animate = true, restoreFocus = false } = {}) {
  const shouldRestore = restoreFocus || pendingRestoreFocus;
  pendingRestoreFocus = false;
  const room = findOpenRoomByHash(window.location.hash);
  if (room) {
    if (currentRoute !== room.id) {
      openRoomStage(room, { animate });
    } else {
      populateStage(room);
    }
  } else if (currentRoute !== 'lobby') {
    closeRoomStage({ restoreFocus: shouldRestore });
  }
}

function syncRoomsFromHost() {
  const raw = window.__benchHost?.params?.rooms;
  roomsData = normalizeRooms(raw);
  renderRooms();
  syncRouteFromHash({ animate: false });
}

// Event Listeners
roomsRoot.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a.room-card-link') : null;
  if (!link) return;
  savedLobbyScrollY = window.scrollY;
  lastFocusedCardId = link.dataset.roomId || null;
});

if (stageBackLink) {
  stageBackLink.addEventListener('click', (event) => {
    event.preventDefault();
    if (window.location.hash) {
      pendingRestoreFocus = true;
      window.location.hash = '#/';
    } else {
      closeRoomStage({ restoreFocus: true });
    }
  });
}

if (brandLink) {
  brandLink.addEventListener('click', () => {
    if (currentRoute !== 'lobby') {
      closeRoomStage();
    }
  });
}

if (langToggleBtn) {
  langToggleBtn.addEventListener('click', () => {
    manualLangOverride = true;
    const nextLang = currentLang === 'ko' ? 'en' : 'ko';
    safeWriteStorage(LANG_STORAGE_KEY, nextLang);
    applyLang(nextLang);
  });
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    manualThemeOverride = true;
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
}

darkMedia.addEventListener('change', (event) => {
  manualThemeOverride = false;
  applyTheme(event.matches ? 'dark' : 'light');
});

window.addEventListener('languagechange', () => {
  if (!manualLangOverride) {
    applyLang(detectLocaleLang());
  }
});

window.addEventListener('hashchange', () => {
  syncRouteFromHash({ animate: true });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && currentRoute !== 'lobby') {
    event.preventDefault();
    pendingRestoreFocus = true;
    window.location.hash = '#/';
  }
});

window.addEventListener('scroll', () => {
  if (currentRoute === 'lobby') {
    savedLobbyScrollY = window.scrollY;
  }
}, { passive: true });

// Initial Boot
applyTheme(currentTheme);
syncRoomsFromHost();
applyLang(currentLang);

const readyPromise = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
  .then(() => undefined);

// BenchRoom v1 Contract
window.__bench = {
  version: 1,
  ready: readyPromise,

  setSeed() {
    if (!manualThemeOverride) {
      applyTheme(darkMedia.matches ? 'dark' : 'light');
    }
    if (!manualLangOverride) {
      currentLang = detectInitialLang();
    }
    syncRoomsFromHost();
    applyLang(currentLang);
  },

  seek(tMs) {
    frozenTimeMs = Number(tMs);
    if (!Number.isFinite(frozenTimeMs)) {
      frozenTimeMs = 0;
    }
  },

  resume() {
    frozenTimeMs = null;
  },

  async renderFrame() {
    if (!manualThemeOverride) {
      const mediaTheme = darkMedia.matches ? 'dark' : 'light';
      if (mediaTheme !== currentTheme) {
        applyTheme(mediaTheme);
      }
    }
    void document.documentElement.offsetHeight;
    if (window.__benchHostControl?.isRafOverrideActive?.()) {
      return;
    }
    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };
      const timer = setTimeout(done, 120);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          clearTimeout(timer);
          done();
        });
      });
    });
  },

  state() {
    return {
      route: currentRoute,
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
