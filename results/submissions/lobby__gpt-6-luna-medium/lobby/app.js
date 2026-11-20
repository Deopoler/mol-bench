const root = document.querySelector('#rooms');
const html = document.documentElement;
const host = window.__benchHost;

const copy = {
  ko: {
    eyebrow: 'A quiet place to look closer',
    titleEn: 'A museum for the light we carry.',
    titleKo: '마음에 담아 온 빛을 만나는 곳',
    intro: '서로 다른 감각과 기억을 따라, 천천히 머물 수 있는 작은 디지털 전시관입니다. 문을 열고 오늘의 방을 둘러보세요.',
    roomsTitle: '전시 공간', roomsNote: '서두르지 말고, 마음이 머무는 곳에서.',
    aboutLabel: 'ABOUT THE MUSEUM',
    aboutCopy: '빛의 박물관은 이야기와 감각을 담은 작은 방들의 모임입니다. 각 공간은 저마다 다른 속도와 색으로 여러분을 맞이합니다. 잠시 머물러도 좋고, 다시 찾아와도 좋습니다.',
    empty: '아직 문을 연 전시실이 없습니다.\n새로운 방이 준비되면 이곳에서 만날 수 있어요.',
    footer: '서울에서, 천천히 빛을 모읍니다 · Seoul', open: '둘러보기', soon: '준비 중', settings: '화면 설정',
  },
  en: {
    eyebrow: 'A quiet place to look closer',
    titleEn: 'A museum for the light we carry.',
    titleKo: 'A place to meet the light we hold',
    intro: 'A small digital museum shaped by different senses and memories. Open a door and spend a little time in a room that speaks to you.',
    roomsTitle: 'The rooms', roomsNote: 'Take your time. Stay where your attention rests.',
    aboutLabel: 'ABOUT THE MUSEUM',
    aboutCopy: 'Museum of Light is a gathering of small rooms for stories and senses. Each welcomes you with its own pace and color. Stay for a moment, or come back another day.',
    empty: 'No exhibition rooms are open yet.\nNew rooms will be waiting here when they are ready.',
    footer: 'Gathering light, slowly · Seoul', open: 'ENTER ROOM', soon: 'COMING SOON', settings: 'Display settings',
  },
};

let lang = 'ko';
let explicitTheme = false;
const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

function rooms() {
  return Array.isArray(host?.params?.rooms) ? host.params.rooms : [];
}

function updateTheme(theme) {
  html.dataset.theme = theme;
  document.querySelector('[data-bench="theme-toggle"]').textContent = theme === 'dark' ? 'Light' : 'Dark';
  document.querySelector('[data-bench="theme-toggle"]').setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  if (root.childElementCount) renderRooms();
}

function setLanguage(next) {
  lang = next === 'en' ? 'en' : 'ko';
  html.lang = lang;
  const labels = copy[lang];
  const values = {
    eyebrow: labels.eyebrow, 'title-en': labels.titleEn, 'title-ko': labels.titleKo,
    intro: labels.intro, 'rooms-title': labels.roomsTitle, 'rooms-note': labels.roomsNote,
    'about-label': labels.aboutLabel, 'about-copy': labels.aboutCopy, empty: labels.empty,
    footer: labels.footer,
  };
  for (const [key, value] of Object.entries(values)) {
    const node = document.querySelector(`[data-copy="${key}"]`);
    if (node) node.textContent = value;
  }
  document.querySelector('[data-bench="lang-toggle"]').textContent = lang === 'ko' ? 'EN' : '한';
  document.querySelector('[data-bench="lang-toggle"]').setAttribute('aria-label', lang === 'ko' ? 'Switch to English' : '한국어로 전환');
  localStorage.setItem('mol-lang', lang);
  renderRooms();
}

function renderRooms() {
  if (!root) return;
  const items = rooms();
  root.replaceChildren();
  items.forEach((room, index) => {
    const coming = room.status === 'coming_soon';
    const card = document.createElement(coming ? 'article' : 'a');
    card.className = `room-card${coming ? ' is-coming' : ''}`;
    card.dataset.bench = 'room-card';
    card.dataset.status = coming ? 'coming_soon' : 'open';
    if (!coming) card.href = room.route;
    const accent = Array.isArray(room.accent_oklch) ? room.accent_oklch : [0.62, 0.1, 145];
    const [sourceL, sourceC, h] = accent.map(Number);
    const l = html.dataset.theme === 'dark' ? Math.max(sourceL, 0.76) : Math.min(sourceL, 0.42);
    const c = Math.min(sourceC, 0.1);
    card.style.setProperty('--room-accent', `oklch(${l} ${c} ${h})`);
    card.style.setProperty('--room-wash', `color-mix(in srgb, oklch(${sourceL} ${Math.min(sourceC, 0.12)} ${h}) 16%, var(--paper-raised))`);

    const top = document.createElement('div');
    top.className = 'card-top';
    const number = document.createElement('span');
    number.className = 'room-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const symbol = document.createElement('span');
    symbol.className = 'room-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = coming ? '…' : '↗';
    top.append(number, symbol);

    const title = document.createElement('h3');
    title.textContent = lang === 'en' ? (room.title_en || room.title_ko || '') : (room.title_ko || room.title_en || '');
    const summary = document.createElement('p');
    summary.className = 'room-summary';
    summary.textContent = lang === 'en' ? 'A room for a slower kind of looking.' : (room.summary_ko || '천천히 바라보고 오래 머물 수 있는 전시 공간입니다.');
    const status = document.createElement('span');
    status.className = 'card-status';
    status.textContent = coming ? labelsFor(lang).soon : labelsFor(lang).open;
    card.append(top, title, summary, status);
    if (coming) card.setAttribute('aria-label', `${title.textContent} — ${labelsFor(lang).soon}`);
    else card.setAttribute('aria-label', `${title.textContent} — ${labelsFor(lang).open}`);
    root.append(card);
  });
  const empty = document.querySelector('[data-bench="empty-state"]');
  empty.hidden = items.length !== 0;
}

function labelsFor(language) { return copy[language]; }

document.querySelector('[data-bench="lang-toggle"]').addEventListener('click', () => setLanguage(lang === 'ko' ? 'en' : 'ko'));
document.querySelector('[data-bench="theme-toggle"]').addEventListener('click', () => {
  explicitTheme = true;
  updateTheme(html.dataset.theme === 'dark' ? 'light' : 'dark');
  localStorage.setItem('mol-theme', html.dataset.theme);
});
mediaDark.addEventListener?.('change', (event) => { if (!explicitTheme) updateTheme(event.matches ? 'dark' : 'light'); });
root.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-bench="room-card"]');
  if (link) document.body.classList.add('is-navigating');
});

const savedLang = localStorage.getItem('mol-lang');
setLanguage(savedLang === 'en' ? 'en' : 'ko');
const savedTheme = localStorage.getItem('mol-theme');
updateTheme(savedTheme || (mediaDark.matches ? 'dark' : 'light'));
explicitTheme = savedTheme !== null;

function currentRoute() {
  const match = location.hash.match(/^#\/room\/([^/?#]+)/);
  if (!match) return 'lobby';
  return rooms().some((room) => room.id === match[1] && room.status === 'open') ? match[1] : 'lobby';
}

window.__bench = {
  version: 1,
  ready: Promise.resolve().then(() => document.fonts?.ready),
  setSeed(seed) {
    window.__benchHostControl?.setSeed(seed);
    renderRooms();
  },
  seek(tMs) { window.__benchHostControl?.freeze(Number(tMs) || 0); },
  resume() { window.__benchHostControl?.resume(); },
  async renderFrame() {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(fallback); resolve(); } };
      const fallback = setTimeout(finish, 50);
      requestAnimationFrame(finish);
    });
  },
  state() { return { route: currentRoute(), lang, theme: html.dataset.theme }; },
  stats() { return { drawCalls: 0, triangles: 0, listeners: 4 }; },
};
