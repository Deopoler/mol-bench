const root = document.querySelector("#room-list");
const html = document.documentElement;
const langToggle = document.querySelector('[data-bench="lang-toggle"]');
const themeToggle = document.querySelector('[data-bench="theme-toggle"]');
const colorPreference = window.matchMedia("(prefers-color-scheme: dark)");

const copy = {
  ko: {
    kicker: "디지털 전시관 · 서울",
    hero: "빛이 머무는 방으로<br>초대합니다.",
    intro: "천천히 둘러보세요. 이곳의 각 방은 저마다 다른 감각과 생각을 위한 작은 전시입니다. 문을 열고, 빛이 들려주는 이야기에 잠시 머물러 보세요.",
    explore: "전시 공간 둘러보기",
    collectionKicker: "둘러보기",
    collectionTitle: "전시 공간",
    collectionNote: "마음이 머무는 곳부터<br>자유롭게 시작해 보세요.",
    empty: "아직 문을 연 전시 공간이 없습니다. 새로운 공간을 준비하고 있으니, 조금 뒤에 다시 들러 주세요.",
    closing: "빛은 머무는 곳마다 다른 이야기를 만듭니다.<br>당신만의 속도로 천천히 감상해 주세요.",
    footerPlace: "서울에서, 빛과 함께",
    open: "관람하기",
    soon: "준비 중",
    summaryFallback: "빛과 감각을 따라 천천히 둘러보는 작은 전시입니다.",
    themeLight: "밝게 보기",
    themeDark: "어둡게 보기",
    languageLabel: "EN",
    languageAction: "Switch language to English",
  },
  en: {
    kicker: "DIGITAL EXHIBITIONS · SEOUL",
    hero: "A room for light,<br>open to you.",
    intro: "Take your time. Each room holds a small exhibition shaped by a different way of seeing and thinking. Step inside, and stay awhile with the stories light has to tell.",
    explore: "Explore the rooms",
    collectionKicker: "THE COLLECTION",
    collectionTitle: "Exhibition rooms",
    collectionNote: "Begin wherever your<br>curiosity takes you.",
    empty: "No exhibition rooms are open just yet. We are preparing new spaces; please come by again soon.",
    closing: "Light finds a different story in every place.<br>Take it in at your own pace.",
    footerPlace: "With light, in Seoul",
    open: "OPEN",
    soon: "COMING SOON",
    summaryFallback: "A small exhibition to explore slowly, guided by light and feeling.",
    themeLight: "Use light theme",
    themeDark: "Use dark theme",
    languageLabel: "한",
    languageAction: "한국어로 바꾸기",
  },
};

let language = readLanguage();
let selectedTheme = null;
let frozenAt = null;

function readLanguage() {
  try {
    return localStorage.getItem("mol-lang") === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

function getRooms() {
  const rooms = window.__benchHost?.params?.rooms;
  return Array.isArray(rooms) ? rooms : [];
}

function activeTheme() {
  return selectedTheme || (colorPreference.matches ? "dark" : "light");
}

function applyTheme() {
  const theme = activeTheme();
  html.dataset.theme = theme;
  themeToggle.setAttribute("aria-label", theme === "dark" ? copy[language].themeLight : copy[language].themeDark);
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  themeToggle.textContent = theme === "dark" ? (language === "ko" ? "밝게" : "Light") : (language === "ko" ? "어둡게" : "Dark");
  themeToggle.dataset.symbol = theme === "dark" ? "☼" : "◐";
}

function setLanguage(next) {
  language = next === "en" ? "en" : "ko";
  html.lang = language;
  for (const el of document.querySelectorAll("[data-copy]")) {
    const value = copy[language][el.dataset.copy];
    if (value !== undefined) el.innerHTML = value;
  }
  langToggle.textContent = copy[language].languageLabel;
  langToggle.setAttribute("aria-label", copy[language].languageAction);
  try { localStorage.setItem("mol-lang", language); } catch { /* Storage can be disabled in private contexts. */ }
  renderRooms();
  applyTheme();
}

function safeAccent(accent) {
  if (!Array.isArray(accent) || accent.length < 3) return null;
  const [l, c, h] = accent.map(Number);
  if (![l, c, h].every(Number.isFinite) || l < 0 || l > 1 || c < 0 || c > 0.4 || h < 0 || h > 360) return null;
  return `oklch(${l} ${c} ${h})`;
}

function makeCard(room, index) {
  const isOpen = room.status === "open";
  const card = document.createElement("article");
  card.className = `room-card${isOpen ? "" : " room-card-soon"}`;
  card.dataset.bench = "room-card";
  card.dataset.status = isOpen ? "open" : "coming_soon";
  const accent = safeAccent(room.accent_oklch);
  if (accent) card.style.setProperty("--room-accent", accent);

  const content = document.createElement(isOpen ? "a" : "div");
  content.className = isOpen ? "room-link" : "room-coming";
  if (isOpen && typeof room.route === "string") content.setAttribute("href", room.route);

  const top = document.createElement("span");
  top.className = "room-topline";
  const number = document.createElement("span");
  number.className = "room-number";
  number.textContent = String(index + 1).padStart(2, "0");
  const status = document.createElement("span");
  status.className = "room-status";
  status.textContent = isOpen ? copy[language].open : copy[language].soon;
  top.append(number, status);

  const title = document.createElement("h3");
  title.className = "room-title";
  title.textContent = language === "en" && room.title_en ? room.title_en : (room.title_ko || room.title_en || "Untitled room");
  const secondary = document.createElement("span");
  secondary.className = "room-secondary";
  secondary.textContent = language === "en" ? (room.title_ko || "") : (room.title_en || "");

  content.append(top, title, secondary);
  if (room.summary_ko) {
    const summary = document.createElement("p");
    summary.className = "room-summary";
    summary.textContent = language === "ko" ? room.summary_ko : copy.en.summaryFallback;
    content.append(summary);
  }
  card.append(content);
  return card;
}

function renderRooms() {
  const rooms = getRooms();
  const cards = rooms.map(makeCard);
  root.replaceChildren(...cards);
  document.querySelector('[data-bench="empty-state"]').hidden = rooms.length > 0;
}

function currentRoute() {
  const match = location.hash.match(/^#\/room\/([^/?#]+)/);
  if (!match) return "lobby";
  const room = getRooms().find((item) => item.id === decodeURIComponent(match[1]) && item.status === "open");
  return room ? room.id : "lobby";
}

langToggle.addEventListener("click", () => setLanguage(language === "ko" ? "en" : "ko"));
themeToggle.addEventListener("click", () => {
  selectedTheme = activeTheme() === "dark" ? "light" : "dark";
  applyTheme();
});
colorPreference.addEventListener?.("change", () => { if (!selectedTheme) applyTheme(); });
window.addEventListener("hashchange", () => {
  document.body.classList.remove("is-navigating");
  void document.body.offsetWidth;
  document.body.classList.add("is-navigating");
});

setLanguage(language);
applyTheme();
renderRooms();

const ready = Promise.resolve(document.fonts?.ready).then(() => undefined);

window.__bench = {
  version: 1,
  ready,
  setSeed(seed) {
    // This room contains no generated visual randomness. Re-render from the host's seeded data.
    void seed;
    renderRooms();
  },
  seek(tMs) {
    frozenAt = Math.max(0, Number(tMs) || 0);
    window.__benchHostControl?.freeze?.(frozenAt);
  },
  resume() {
    frozenAt = null;
    window.__benchHostControl?.resume?.();
  },
  async renderFrame() {
    await ready;
    const overrideActive = window.__benchHostControl?.isRafOverrideActive?.();
    if (overrideActive) await new Promise((resolve) => setTimeout(resolve, 0));
    else await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  },
  state() {
    return { route: currentRoute(), lang: language, theme: activeTheme() };
  },
  stats() {
    return { drawCalls: 0, triangles: 0, listeners: 4 };
  },
};
