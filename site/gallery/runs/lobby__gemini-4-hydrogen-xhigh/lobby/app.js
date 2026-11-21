const SVG_NS = 'http://www.w3.org/2000/svg';

const COPY = {
  ko: {
    pageTitle: '빛의 미술관 · Museum of Light',
    skipLink: '본문으로 건너뛰기',
    brandAria: '빛의 미술관 로비',
    brandTitle: '빛의 미술관',
    navAria: '표시 설정',
    langButton: 'EN',
    langAria: '영어로 전환',
    themeButtonToDark: '다크',
    themeButtonToLight: '라이트',
    themeAriaToDark: '어두운 테마로 전환',
    themeAriaToLight: '밝은 테마로 전환',
    heroTitle: '빛이 머무는 디지털 전시실',
    heroLead:
      '빛의 미술관은 빛과 색채, 그리고 시간의 결을 따라 사유하는 디지털 공간입니다. 방문객이 천천히 머물며 자신만의 속도로 풍경을 읽을 수 있도록 열려 있습니다.',
    collectionHeading: '전시 공간',
    collectionCaption: '각 방을 선택해 빛의 공간으로 입장하세요',
    emptyTitle: '아직 공개된 방이 없습니다',
    emptyCopy:
      '새로운 빛의 전시가 준비되는 대로 이 로비에서 차례로 공개됩니다. 잠시 후 다시 방문해 주세요.',
    guideHeading: '관람 안내',
    guideBody:
      '이곳의 모든 방은 별도의 설치 없이 오프라인 환경에서도 온전하게 작동하도록 지어졌습니다. 상단의 언어와 화면 테마 전환을 통해 낮의 석회석 갤러리와 밤의 고요한 어둠을 오가며 차분하게 전시를 둘러보실 수 있습니다.',
    factHoursLabel: '개관 안내',
    factHoursVal: '상시 개방 · 24시간 디지털 아카이브',
    factAccessLabel: '관람 환경',
    factAccessVal: '키보드 탐색, 동작 감소 및 고대비 지원',
    statusOpen: '관람 가능',
    statusSoon: '준비 중',
    enterRoom: '방으로 들어가기 →',
    openingSoon: '전시 준비 중',
    backToLobby: '로비로 돌아가기',
    openExhibition: 'OPEN EXHIBITION',
    specSpectrumLabel: '빛의 스펙트럼',
    specStatusLabel: '전시 상태',
    specStatusOpen: '관람 가능',
    footerColophon: '빛의 미술관 · Museum of Light · Seoul',
    footerTop: '로비 처음으로',
    summaryAllOpen: (total) => `전체 ${total}개 전시실 모두 관람 가능합니다`,
    summaryMixed: (open, total) => `총 ${total}개 공간 중 ${open}개 전시실 개방 중`,
    summaryEmpty: '현재 개방된 전시실이 없습니다',
    fallbackRoomSummary: '빛과 공간의 결이 어우러지는 고요한 전시실입니다.',
  },
  en: {
    pageTitle: 'Museum of Light · Lobby',
    skipLink: 'Skip to main content',
    brandAria: 'Museum of Light Lobby',
    brandTitle: 'Museum of Light',
    navAria: 'Display settings',
    langButton: 'KO',
    langAria: 'Switch to Korean',
    themeButtonToDark: 'Dark',
    themeButtonToLight: 'Light',
    themeAriaToDark: 'Switch to dark theme',
    themeAriaToLight: 'Switch to light theme',
    heroTitle: 'Quiet Rooms Shaped by Light',
    heroLead:
      'The Museum of Light is a quiet collection of digital pavilions devoted to illumination, color, and stillness, inviting visitors to pause and observe at their own pace.',
    collectionHeading: 'Exhibition Rooms',
    collectionCaption: 'Select an open gallery to cross into its light threshold',
    emptyTitle: 'No Exhibition Rooms Open Yet',
    emptyCopy:
      'Upcoming light installations are currently being calibrated. Please return soon to explore the newly opened pavilions.',
    guideHeading: 'Visitor Guide',
    guideBody:
      'Every room in this pavilion is crafted to open instantaneously without external dependencies or visual noise. Switch freely between Korean and English or between daylight paper and nocturnal dark themes as you explore the collection.',
    factHoursLabel: 'Hours',
    factHoursVal: 'Always Open · 24-Hour Digital Archive',
    factAccessLabel: 'Accessibility',
    factAccessVal: 'Keyboard navigation, reduced motion, and high contrast',
    statusOpen: 'Open',
    statusSoon: 'Coming Soon',
    enterRoom: 'Enter Room →',
    openingSoon: 'Opening Soon',
    backToLobby: 'Back to Lobby',
    openExhibition: 'OPEN EXHIBITION',
    specSpectrumLabel: 'Light Spectrum',
    specStatusLabel: 'Status',
    specStatusOpen: 'Currently Open',
    footerColophon: 'Museum of Light · Seoul',
    footerTop: 'Return to Lobby',
    summaryAllOpen: (total) => `All ${total} exhibition rooms are open`,
    summaryMixed: (open, total) => `${open} of ${total} exhibition rooms open`,
    summaryEmpty: 'No exhibition rooms are currently open',
    fallbackRoomSummary: 'A contemplative digital gallery shaped around light, hue, and stillness.',
  },
};

const elements = {
  skipLink: document.getElementById('skip-link'),
  brandLink: document.getElementById('brand-link'),
  brandTitle: document.getElementById('brand-title'),
  headerNav: document.getElementById('header-nav'),
  langToggle: document.getElementById('lang-toggle'),
  themeToggle: document.getElementById('theme-toggle'),
  lobbyView: document.getElementById('lobby-view'),
  roomView: document.getElementById('room-view'),
  heroTitle: document.getElementById('hero-title'),
  heroLead: document.getElementById('hero-lead'),
  collectionSummary: document.getElementById('collection-summary'),
  pavilionArt: document.getElementById('pavilion-art'),
  collectionHeading: document.getElementById('collection-heading'),
  collectionCaption: document.getElementById('collection-caption'),
  roomsGrid: document.getElementById('rooms'),
  emptyState: document.querySelector('[data-bench="empty-state"]'),
  emptyTitle: document.getElementById('empty-title'),
  emptyCopy: document.getElementById('empty-copy'),
  guideHeading: document.getElementById('guide-heading'),
  guideBody: document.getElementById('guide-body'),
  factHoursLabel: document.getElementById('fact-hours-label'),
  factHoursVal: document.getElementById('fact-hours-val'),
  factAccessLabel: document.getElementById('fact-access-label'),
  factAccessVal: document.getElementById('fact-access-val'),
  roomBackLink: document.getElementById('room-back-link'),
  roomBackLabel: document.getElementById('room-back-label'),
  roomViewIndex: document.getElementById('room-view-index'),
  roomStageVisual: document.getElementById('room-stage-visual'),
  roomViewEyebrow: document.getElementById('room-view-eyebrow'),
  roomViewTitle: document.getElementById('room-view-title'),
  roomViewSummary: document.getElementById('room-view-summary'),
  specSpectrumLabel: document.getElementById('spec-spectrum-label'),
  specSpectrumVal: document.getElementById('spec-spectrum-val'),
  specStatusLabel: document.getElementById('spec-status-label'),
  specStatusVal: document.getElementById('spec-status-val'),
  footerColophon: document.getElementById('footer-colophon'),
  footerTopLink: document.getElementById('footer-top-link'),
  transitionVeil: document.getElementById('transition-veil'),
};

const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let currentSeed = Number(window.__benchHost?.seed ?? 1);
let currentRoute = 'lobby';
let manualTheme = null;
let savedLobbyScrollY = 0;
let activeAnimations = [];
let clockTimeMs = 0;

function readInitialLang() {
  try {
    const saved = localStorage.getItem('mol-lang');
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    // Ignore storage access restrictions
  }
  return 'ko';
}

let currentLang = readInitialLang();

function getEffectiveTheme() {
  if (manualTheme === 'light' || manualTheme === 'dark') return manualTheme;
  return darkSchemeQuery.matches ? 'dark' : 'light';
}

function getRooms() {
  const raw = window.__benchHost?.params?.rooms;
  if (!Array.isArray(raw)) return [];
  return raw.map((room, index) => {
    const id = String(room?.id || `room-${index + 1}`);
    const status = room?.status === 'coming_soon' ? 'coming_soon' : 'open';
    const titleKo = String(room?.title_ko ?? room?.title_en ?? id);
    const titleEn = String(room?.title_en ?? room?.title_ko ?? id);
    const summaryKo = String(room?.summary_ko ?? COPY.ko.fallbackRoomSummary);
    const summaryEn = String(room?.summary_en ?? COPY.en.fallbackRoomSummary);
    const route = String(room?.route || `#/room/${id}`);
    const oklch = Array.isArray(room?.accent_oklch) && room.accent_oklch.length === 3
      ? room.accent_oklch.map(Number)
      : [0.68, 0.12, (index * 47 + 28) % 360];
    return {
      index,
      id,
      route,
      title_ko: titleKo,
      title_en: titleEn,
      summary_ko: summaryKo,
      summary_en: summaryEn,
      accent_oklch: oklch,
      status,
    };
  });
}

function makeRng(label) {
  if (window.__benchHost?.rng?.fork) {
    return window.__benchHost.rng.fork(label);
  }
  let s = (currentSeed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    s = (Math.imul(s ^ label.charCodeAt(i), 16777619)) >>> 0;
  }
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) {
      return Math.floor(this.next() * n);
    },
  };
}

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function buildOklchCss(oklch, theme, variant = 'beam') {
  const [rawL, rawC, rawH] = oklch;
  const h = ((Number(rawH) || 0) % 360 + 360) % 360;
  const c = Math.max(0.02, Math.min(0.16, Number(rawC) || 0.1));
  const l = Number(rawL) || 0.68;

  if (variant === 'bg') {
    return theme === 'dark'
      ? `oklch(0.20 ${(c * 0.25).toFixed(3)} ${h.toFixed(1)})`
      : `oklch(0.93 ${(c * 0.22).toFixed(3)} ${h.toFixed(1)})`;
  }
  if (variant === 'band') {
    return theme === 'dark'
      ? `oklch(${Math.max(0.28, Math.min(0.48, l * 0.6)).toFixed(3)} ${(c * 0.6).toFixed(3)} ${h.toFixed(1)})`
      : `oklch(${Math.max(0.74, Math.min(0.87, l + 0.1)).toFixed(3)} ${(c * 0.55).toFixed(3)} ${h.toFixed(1)})`;
  }
  return theme === 'dark'
    ? `oklch(${Math.max(0.55, Math.min(0.74, l)).toFixed(3)} ${(c * 0.85).toFixed(3)} ${h.toFixed(1)})`
    : `oklch(${Math.max(0.58, Math.min(0.76, l)).toFixed(3)} ${(c * 0.8).toFixed(3)} ${h.toFixed(1)})`;
}

function renderPavilionArtwork(rooms, theme) {
  const rng = makeRng(`pavilion-${currentSeed}`);
  const svg = createSvgElement('svg', {
    viewBox: '0 0 420 260',
    class: 'pavilion-svg',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const bgFill = theme === 'dark' ? '#131210' : '#f6f2ea';
  const archStroke = theme === 'dark' ? 'rgba(239,234,224,0.14)' : 'rgba(31,29,26,0.10)';

  svg.append(
    createSvgElement('rect', { x: 0, y: 0, width: 420, height: 260, rx: 4, fill: bgFill }),
  );

  const openRooms = rooms.filter((r) => r.status !== 'coming_soon');
  const beamSource = openRooms.length > 0 ? openRooms.slice(0, 2) : [
    { accent_oklch: [0.68, 0.12, 42] },
    { accent_oklch: [0.70, 0.11, 188] },
  ];

  const cx = 210 + Math.round((rng.next() - 0.5) * 28);
  const defs = createSvgElement('defs');

  const haloGrad = createSvgElement('radialGradient', {
    id: 'pav-halo',
    cx: `${Math.round((cx / 420) * 100)}%`,
    cy: '45%',
    r: '55%',
  });
  const mainColor = buildOklchCss(beamSource[0].accent_oklch, theme, 'beam');
  const secondColor = buildOklchCss((beamSource[1] || beamSource[0]).accent_oklch, theme, 'band');
  haloGrad.append(
    createSvgElement('stop', { offset: '0%', 'stop-color': mainColor, 'stop-opacity': theme === 'dark' ? '0.38' : '0.42' }),
    createSvgElement('stop', { offset: '55%', 'stop-color': secondColor, 'stop-opacity': theme === 'dark' ? '0.18' : '0.2' }),
    createSvgElement('stop', { offset: '100%', 'stop-color': bgFill, 'stop-opacity': '0' }),
  );
  defs.append(haloGrad);
  svg.append(defs);

  svg.append(
    createSvgElement('rect', { x: 0, y: 0, width: 420, height: 260, fill: 'url(#pav-halo)' }),
    createSvgElement('line', {
      x1: 36, y1: 196, x2: 384, y2: 196,
      stroke: archStroke, 'stroke-width': 1,
    }),
    createSvgElement('path', {
      d: `M ${cx - 76} 196 L ${cx - 76} 112 A 76 76 0 0 1 ${cx + 76} 112 L ${cx + 76} 196`,
      fill: 'none',
      stroke: archStroke,
      'stroke-width': 1.25,
    }),
    createSvgElement('circle', {
      cx,
      cy: 108,
      r: 14,
      fill: mainColor,
      opacity: '0.78',
    }),
  );

  elements.pavilionArt.replaceChildren(svg);
}

function renderCardApertureSvg(room, theme, seedOffset, large = false) {
  const w = large ? 880 : 320;
  const h = large ? 260 : 64;
  const rng = makeRng(`room-${room.id}-${currentSeed}-${seedOffset}`);
  const svg = createSvgElement('svg', {
    viewBox: `0 0 ${w} ${h}`,
    class: large ? 'room-stage-svg' : 'card-aperture-svg',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const bg = buildOklchCss(room.accent_oklch, theme, 'bg');
  const band = buildOklchCss(room.accent_oklch, theme, 'band');
  const core = buildOklchCss(room.accent_oklch, theme, 'beam');

  const gradId = `rg-${room.index}-${large ? 'lg' : 'sm'}`;
  const defs = createSvgElement('defs');
  const grad = createSvgElement('radialGradient', {
    id: gradId,
    cx: `${32 + rng.int(36)}%`,
    cy: `${38 + rng.int(24)}%`,
    r: '70%',
  });
  grad.append(
    createSvgElement('stop', { offset: '0%', 'stop-color': core, 'stop-opacity': theme === 'dark' ? '0.52' : '0.56' }),
    createSvgElement('stop', { offset: '55%', 'stop-color': band, 'stop-opacity': '0.24' }),
    createSvgElement('stop', { offset: '100%', 'stop-color': bg, 'stop-opacity': '0' }),
  );
  defs.append(grad);
  svg.append(defs);

  svg.append(createSvgElement('rect', { x: 0, y: 0, width: w, height: h, fill: bg }));
  svg.append(createSvgElement('rect', { x: 0, y: 0, width: w, height: h, fill: `url(#${gradId})` }));

  if (large) {
    const lineStroke = theme === 'dark' ? 'rgba(239,234,224,0.2)' : 'rgba(31,29,26,0.15)';
    const horizonY = Math.round(h * 0.74);
    const cx = Math.round(w * (0.38 + rng.next() * 0.24));
    svg.append(
      createSvgElement('line', {
        x1: 72, y1: horizonY, x2: w - 72, y2: horizonY,
        stroke: lineStroke, 'stroke-width': 1,
      }),
      createSvgElement('path', {
        d: `M ${cx - 72} ${horizonY} A 72 72 0 0 1 ${cx + 72} ${horizonY}`,
        fill: 'none', stroke: lineStroke, 'stroke-width': 1.25,
      }),
      createSvgElement('circle', {
        cx, cy: horizonY - 40, r: 12,
        fill: core, opacity: '0.85',
      }),
    );
  }

  return svg;
}

function applyThemeAttributes() {
  const theme = getEffectiveTheme();
  if (manualTheme === 'light' || manualTheme === 'dark') {
    document.documentElement.dataset.theme = manualTheme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const t = COPY[currentLang];
  const isDark = theme === 'dark';
  elements.themeToggle.textContent = isDark ? t.themeButtonToLight : t.themeButtonToDark;
  elements.themeToggle.setAttribute('aria-pressed', String(isDark));
  elements.themeToggle.setAttribute('aria-label', isDark ? t.themeAriaToLight : t.themeAriaToDark);
}

function applyLanguageStrings(rooms) {
  const t = COPY[currentLang];
  document.documentElement.lang = currentLang;
  document.title = t.pageTitle;

  elements.skipLink.textContent = t.skipLink;
  elements.brandLink.setAttribute('aria-label', t.brandAria);
  elements.brandTitle.textContent = t.brandTitle;
  elements.headerNav.setAttribute('aria-label', t.navAria);
  elements.langToggle.textContent = t.langButton;
  elements.langToggle.setAttribute('aria-label', t.langAria);

  elements.heroTitle.textContent = t.heroTitle;
  elements.heroLead.textContent = t.heroLead;
  elements.collectionHeading.textContent = t.collectionHeading;
  elements.collectionCaption.textContent = t.collectionCaption;
  elements.emptyTitle.textContent = t.emptyTitle;
  elements.emptyCopy.textContent = t.emptyCopy;
  elements.guideHeading.textContent = t.guideHeading;
  elements.guideBody.textContent = t.guideBody;
  elements.factHoursLabel.textContent = t.factHoursLabel;
  elements.factHoursVal.textContent = t.factHoursVal;
  elements.factAccessLabel.textContent = t.factAccessLabel;
  elements.factAccessVal.textContent = t.factAccessVal;
  elements.roomBackLabel.textContent = t.backToLobby;
  elements.roomViewEyebrow.textContent = t.openExhibition;
  elements.specSpectrumLabel.textContent = t.specSpectrumLabel;
  elements.specStatusLabel.textContent = t.specStatusLabel;
  elements.specStatusVal.textContent = t.specStatusOpen;
  elements.footerColophon.textContent = t.footerColophon;
  elements.footerTopLink.textContent = t.footerTop;

  const openCount = rooms.filter((r) => r.status !== 'coming_soon').length;
  if (rooms.length === 0) {
    elements.collectionSummary.textContent = t.summaryEmpty;
  } else if (openCount === rooms.length) {
    elements.collectionSummary.textContent = t.summaryAllOpen(rooms.length);
  } else {
    elements.collectionSummary.textContent = t.summaryMixed(openCount, rooms.length);
  }
}

function renderRoomsGrid(rooms, theme) {
  const t = COPY[currentLang];
  const fragment = document.createDocumentFragment();

  for (const room of rooms) {
    const isSoon = room.status === 'coming_soon';
    const card = document.createElement('article');
    card.className = 'room-card';
    card.dataset.bench = 'room-card';
    card.dataset.status = room.status;
    card.dataset.route = room.route;
    card.dataset.roomId = room.id;
    if (isSoon) {
      card.setAttribute('aria-disabled', 'true');
    }

    const innerContainer = document.createElement(isSoon ? 'div' : 'a');
    if (isSoon) {
      innerContainer.className = 'room-card-body-wrap';
    } else {
      innerContainer.className = 'room-card-link';
      innerContainer.href = room.route;
    }

    const aperture = document.createElement('div');
    aperture.className = 'card-aperture';
    aperture.append(renderCardApertureSvg(room, theme, room.index + 1, false));

    const content = document.createElement('div');
    content.className = 'card-content';

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta-row';

    const indexSpan = document.createElement('span');
    indexSpan.className = 'card-index';
    indexSpan.textContent = String(room.index + 1).padStart(2, '0');

    const statusBadge = document.createElement('span');
    statusBadge.className = `card-status ${isSoon ? 'card-status--soon' : 'card-status--open'}`;
    statusBadge.textContent = `· ${isSoon ? t.statusSoon : t.statusOpen}`;

    metaRow.append(indexSpan, statusBadge);

    const heading = document.createElement('h3');
    heading.className = 'card-title';
    heading.textContent = currentLang === 'en' ? room.title_en : room.title_ko;

    const summary = document.createElement('p');
    summary.className = 'card-summary';
    summary.textContent = currentLang === 'en' ? room.summary_en : room.summary_ko;

    const actionRow = document.createElement('div');
    actionRow.className = 'card-action';
    actionRow.textContent = isSoon ? t.openingSoon : t.enterRoom;

    content.append(metaRow, heading, summary, actionRow);
    innerContainer.append(aperture, content);
    card.append(innerContainer);
    fragment.append(card);
  }

  elements.roomsGrid.replaceChildren(fragment);
  const hasRooms = rooms.length > 0;
  elements.roomsGrid.hidden = !hasRooms;
  elements.emptyState.hidden = hasRooms;
}

function resolveRouteFromHash(rooms) {
  const hash = location.hash || '';
  if (!hash.startsWith('#/room/')) return 'lobby';
  const candidate = decodeURIComponent(hash.slice(7));
  const match = rooms.find((r) => r.id === candidate && r.status !== 'coming_soon');
  return match ? match.id : 'lobby';
}

function renderActiveRoom(rooms, theme) {
  const room = rooms.find((r) => r.id === currentRoute);
  if (!room) {
    elements.lobbyView.hidden = false;
    elements.roomView.hidden = true;
    return;
  }

  elements.lobbyView.hidden = true;
  elements.roomView.hidden = false;
  elements.roomViewIndex.textContent = `ROOM ${String(room.index + 1).padStart(2, '0')}`;
  elements.roomViewTitle.textContent = currentLang === 'en' ? room.title_en : room.title_ko;
  elements.roomViewSummary.textContent = currentLang === 'en' ? room.summary_en : room.summary_ko;

  const [l, c, h] = room.accent_oklch;
  elements.specSpectrumVal.textContent = `OKLCH(${Number(l).toFixed(2)}, ${Number(c).toFixed(2)}, ${Math.round(Number(h))}°)`;
  elements.roomStageVisual.replaceChildren(renderCardApertureSvg(room, theme, 99, true));
}

function cancelActiveTransitions() {
  for (const anim of activeAnimations) {
    try {
      anim.cancel();
    } catch {
      // Ignore already-finished animations
    }
  }
  activeAnimations = [];
  elements.transitionVeil.hidden = true;
}

function playRouteTransition(enteringRoom) {
  cancelActiveTransitions();
  if (reducedMotionQuery.matches) {
    return;
  }

  const targetEl = enteringRoom ? elements.roomView : elements.lobbyView;
  elements.transitionVeil.hidden = false;

  if (typeof elements.transitionVeil.animate === 'function') {
    const veilAnim = elements.transitionVeil.animate(
      [
        { opacity: 0.92 },
        { opacity: 0 },
      ],
      {
        duration: 360,
        easing: 'linear',
        fill: 'forwards',
      },
    );
    veilAnim.onfinish = () => {
      elements.transitionVeil.hidden = true;
    };
    activeAnimations.push(veilAnim);
  } else {
    elements.transitionVeil.hidden = true;
  }

  if (typeof targetEl.animate === 'function') {
    const stageAnim = targetEl.animate(
      [
        { opacity: 0.25, transform: 'translateY(14px)' },
        { opacity: 1, transform: 'translateY(0px)' },
      ],
      {
        duration: 360,
        easing: 'linear',
        fill: 'none',
      },
    );
    activeAnimations.push(stageAnim);
  }
}

function renderAll() {
  const rooms = getRooms();
  const theme = getEffectiveTheme();
  currentRoute = resolveRouteFromHash(rooms);

  applyThemeAttributes();
  applyLanguageStrings(rooms);
  renderPavilionArtwork(rooms, theme);
  renderRoomsGrid(rooms, theme);
  renderActiveRoom(rooms, theme);
}

function handleHashChange() {
  const rooms = getRooms();
  const prevRoute = currentRoute;
  const nextRoute = resolveRouteFromHash(rooms);

  if (prevRoute === 'lobby' && nextRoute !== 'lobby') {
    savedLobbyScrollY = window.scrollY;
  }

  currentRoute = nextRoute;
  const theme = getEffectiveTheme();
  renderActiveRoom(rooms, theme);

  if (nextRoute === 'lobby') {
    cancelActiveTransitions();
    window.scrollTo({ top: savedLobbyScrollY, behavior: 'instant' });
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (prevRoute !== nextRoute) {
      playRouteTransition(true);
    }
  }
}

elements.langToggle.addEventListener('click', () => {
  currentLang = currentLang === 'ko' ? 'en' : 'ko';
  try {
    localStorage.setItem('mol-lang', currentLang);
  } catch {
    // Ignore storage access restrictions
  }
  renderAll();
});

elements.themeToggle.addEventListener('click', () => {
  manualTheme = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  renderAll();
});

darkSchemeQuery.addEventListener('change', () => {
  manualTheme = null;
  renderAll();
});

window.addEventListener('hashchange', handleHashChange);

renderAll();

const readyPromise = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
  .then(() => undefined);

window.__bench = {
  version: 1,
  ready: readyPromise,
  setSeed(seed) {
    currentSeed = Number(seed) >>> 0;
    cancelActiveTransitions();
    renderAll();
  },
  seek(tMs) {
    clockTimeMs = Number(tMs) || 0;
  },
  resume() {
    clockTimeMs = window.__benchHost?.clock?.now?.() ?? clockTimeMs;
  },
  async renderFrame() {
    clockTimeMs = window.__benchHost?.clock?.now?.() ?? clockTimeMs;
    void document.documentElement.offsetHeight;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const timer = setTimeout(finish, 32);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
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
    };
  },
};
