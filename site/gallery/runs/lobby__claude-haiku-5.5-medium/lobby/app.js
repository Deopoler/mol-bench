// Museum of Light lobby.
// Deterministic: no timers, no wall-clock reads, no randomness. Room data comes from the host.

const STR = {
  ko: {
    'hero.title': '빛의 방에 오신 것을 환영합니다',
    'hero.lead': '각각의 방은 서로 다른 감각과 생각을 위한 작은 세계입니다. 천천히 걸으며 마음에 드는 방을 골라 보세요.',
    'rooms.title': '전시 공간',
    'rooms.empty': '아직 공개된 방이 없습니다. 새로운 방이 열리면 이곳에 알려 드릴게요.',
    'info.title': '관람 안내',
    'info.body': '방은 한 번에 모두 보지 않으셔도 됩니다. 한 곳에 머무르며 천천히 살펴보세요. 준비 중인 방은 공개되면 여기에서 바로 입장할 수 있습니다.',
    'room.back': '로비로 돌아가기',
    'room.note': '전시 내용은 방이 열리면 이곳에 소개됩니다.',
    'status.open': '입장 가능',
    'status.comingSoon': '준비 중',
    'lang.toggle': 'English',
    'theme.toDark': '다크 모드',
    'theme.toLight': '라이트 모드',
  },
  en: {
    'hero.title': 'Welcome to the Rooms of Light',
    'hero.lead': 'Each room is a small world made for a different sense and thought. Walk slowly and choose the room that draws you in.',
    'rooms.title': 'Galleries',
    'rooms.empty': 'No rooms are open yet. New rooms will appear here as they open.',
    'info.title': 'Visitor information',
    'info.body': 'You do not need to see every room at once. Stay in one place and look slowly. Rooms in preparation become available here when they open.',
    'room.back': 'Back to the lobby',
    'room.note': 'The exhibition content appears here when the room opens.',
    'status.open': 'Open',
    'status.comingSoon': 'Coming soon',
    'lang.toggle': '한국어',
    'theme.toDark': 'Dark mode',
    'theme.toLight': 'Light mode',
  },
};

const LANG_KEY = 'mol-lang';
const root = document.documentElement;
const listEl = document.querySelector('#rooms-list');
const emptyEl = document.querySelector('[data-bench="empty-state"]');
const lobbyEl = document.querySelector('#lobby');
const roomEl = document.querySelector('#room');
const roomTitleEl = document.querySelector('#room-title');
const roomSummaryEl = document.querySelector('#room-summary');
const roomSwatchEl = document.querySelector('#room-swatch');
const langBtn = document.querySelector('[data-bench="lang-toggle"]');
const themeBtn = document.querySelector('[data-bench="theme-toggle"]');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

let lang = initialLang();
let themeChoice = null; // null = follow the system color scheme
let rooms = readRooms();
let route = 'lobby';
let lobbyScrollY = 0;

// Korean is the primary language. The visitor's saved choice wins; navigator.language is
// deliberately ignored so the default rendering is the same in every browser locale.
function initialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch (_) { /* storage unavailable: fall through */ }
  return 'ko';
}

function readRooms() {
  const list = window.__benchHost?.params?.rooms;
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}

function effectiveTheme() {
  return themeChoice ?? (systemDark.matches ? 'dark' : 'light');
}

function accentOf(room) {
  const a = room.accent_oklch;
  const valid = Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n));
  return valid ? `oklch(${a[0]} ${a[1]} ${a[2]})` : 'var(--focus)';
}

function titleOf(room) {
  const en = lang === 'en' && typeof room.title_en === 'string' && room.title_en.trim() !== '';
  return en ? { text: room.title_en, lang: 'en' } : { text: String(room.title_ko ?? ''), lang: 'ko' };
}

function isOpen(room) {
  return room.status === 'open' && typeof room.route === 'string' && room.route.length > 0;
}

// The open room whose hash route matches the current location, or null (lobby).
function activeRoom() {
  const hash = location.hash;
  return rooms.find((r) => isOpen(r) && r.route === hash) ?? null;
}

function applyTheme() {
  root.dataset.theme = effectiveTheme();
}

function applyStrings() {
  const s = STR[lang];
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = s[el.dataset.i18n];
  }
  langBtn.textContent = s['lang.toggle'];
  themeBtn.textContent = effectiveTheme() === 'dark' ? s['theme.toLight'] : s['theme.toDark'];
}

function cardFor(room, index) {
  const open = isOpen(room);
  const li = document.createElement('li');
  const card = document.createElement('article');
  card.className = open ? 'room-card' : 'room-card is-soon';
  card.dataset.bench = 'room-card';
  card.dataset.status = open ? 'open' : 'coming_soon';
  card.style.setProperty('--accent', accentOf(room));

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.append(`${String(index + 1).padStart(2, '0')} · `);
  const badge = document.createElement('span');
  badge.className = open ? '' : 'badge';
  badge.textContent = STR[lang][open ? 'status.open' : 'status.comingSoon'];
  meta.append(badge);

  const title = titleOf(room);
  const h3 = document.createElement('h3');
  h3.lang = title.lang;
  if (open) {
    const a = document.createElement('a');
    a.href = room.route;
    a.textContent = title.text;
    h3.append(a);
  } else {
    h3.textContent = title.text;
  }

  card.append(meta, h3);
  li.append(card);
  return li;
}

// Cards are rebuilt only when the room list or language changes. Route changes keep the same
// DOM nodes, so focus and element references survive a round trip into a room and back.
let cardsRooms = null;
let cardsLang = null;
function renderCards() {
  if (cardsRooms !== rooms || cardsLang !== lang) {
    listEl.replaceChildren(...rooms.map((room, i) => cardFor(room, i)));
    cardsRooms = rooms;
    cardsLang = lang;
  }
  listEl.hidden = rooms.length === 0;
  emptyEl.hidden = rooms.length > 0;
}

function fillRoom(room) {
  const title = titleOf(room);
  roomTitleEl.lang = title.lang;
  roomTitleEl.textContent = title.text;
  roomSummaryEl.textContent = String(room.summary_ko ?? '');
  roomSwatchEl.style.setProperty('--accent', accentOf(room));
}

// Idempotent: derives the view from the current hash, rooms, language and theme.
function render() {
  root.lang = lang;
  applyTheme();
  applyStrings();
  renderCards();

  const active = activeRoom();
  const next = active ? active.id : 'lobby';
  lobbyEl.hidden = Boolean(active);
  roomEl.hidden = !active;
  if (active) fillRoom(active);

  if (next !== route) {
    if (active) {
      if (route === 'lobby') lobbyScrollY = window.scrollY;
      window.scrollTo(0, 0);
      roomTitleEl.focus({ preventScroll: true });
    } else {
      window.scrollTo(0, lobbyScrollY);
    }
  }
  route = next;
}

langBtn.addEventListener('click', () => {
  lang = lang === 'ko' ? 'en' : 'ko';
  try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* ignore */ }
  render();
});

themeBtn.addEventListener('click', () => {
  themeChoice = effectiveTheme() === 'dark' ? 'light' : 'dark';
  render();
});

systemDark.addEventListener?.('change', () => {
  if (themeChoice === null) render();
});

window.addEventListener('hashchange', render);

render();

window.__bench = {
  version: 1,
  ready: (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => undefined),
  setSeed() {
    rooms = readRooms();
    render();
  },
  seek(tMs) {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = Number(tMs) || 0;
    }
  },
  resume() {
    for (const a of document.getAnimations()) a.play();
  },
  async renderFrame() {
    render();
    if (document.fonts) await document.fonts.ready;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 100);
    });
  },
  state() {
    const active = activeRoom();
    return { route: active ? active.id : 'lobby', lang, theme: root.dataset.theme };
  },
  stats() {
    return { drawCalls: 0, triangles: 0 };
  },
};
