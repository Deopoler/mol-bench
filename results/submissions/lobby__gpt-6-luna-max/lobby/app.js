const copy = {
  ko: {
    skip: "본문으로 건너뛰기",
    heroKicker: "DIGITAL COLLECTION · SEOUL",
    heroTitle: "빛이 머무는 곳으로\n천천히 들어오세요.",
    heroIntro: "천천히 머물며 빛을 발견하는 디지털 전시 공간입니다. 서로 다른 이야기를 품은 방들을 따라 걷고, 마음에 닿는 장면 앞에서 잠시 쉬어가세요.",
    collectionKicker: "ROOMS TO WANDER",
    collectionTitle: "빛을 만나는 여러 개의 방",
    collectionNote: "각 방에는 저마다 다른 시선과 감각이 기다립니다.",
    empty: "아직 공개된 방이 없습니다. 새로운 전시를 준비하고 있어요.",
    back: "← 모든 방으로 돌아가기",
    roomInvitation: "이곳에 잠시 머물며, 천천히 둘러보세요.",
    stageCaption: "A MOMENT IN LIGHT",
    footerNote: "자신의 속도로 머물다 가세요.",
    top: "처음으로 ↑",
    open: "공개 중",
    coming: "곧 공개",
    enter: "방 둘러보기",
    unavailable: "전시를 준비하고 있습니다",
    noSummary: "이 방의 이야기를 천천히 만나보세요.",
    noSummaryEn: "Take your time with the story held in this room.",
    countOne: "1개의 전시실",
    countMany: (n) => `${n}개의 전시실`,
    countEmpty: "전시실을 둘러보세요",
    toEnglish: "언어를 영어로 바꾸기",
    toKorean: "언어를 한국어로 바꾸기",
    toDark: "어두운 테마로 전환",
    toLight: "밝은 테마로 전환",
    themeDark: "어두운 테마",
    themeLight: "밝은 테마",
    roomKicker: "DIGITAL ROOM · OPEN",
    footerLabel: "사이트 설정",
  },
  en: {
    skip: "Skip to content",
    heroKicker: "DIGITAL COLLECTION · SEOUL",
    heroTitle: "Step gently into\na museum of light.",
    heroIntro: "A quiet place to notice light, gathered into small digital rooms. Follow a story, pause when a scene catches you, and let the visit unfold at your own pace.",
    collectionKicker: "ROOMS TO WANDER",
    collectionTitle: "Many ways to meet the light",
    collectionNote: "Each room holds a different point of view and a feeling of its own.",
    empty: "There are no rooms open just yet. A new exhibition is being prepared.",
    back: "← Return to all rooms",
    roomInvitation: "Stay for a moment and take your time looking around.",
    stageCaption: "A MOMENT IN LIGHT",
    footerNote: "Stay as long as you like.",
    top: "Back to the beginning ↑",
    open: "Open",
    coming: "Coming soon",
    enter: "Explore this room",
    unavailable: "This exhibition is being prepared",
    noSummary: "Take your time with the story held in this room.",
    noSummaryEn: "Take your time with the story held in this room.",
    countOne: "1 room",
    countMany: (n) => `${n} rooms`,
    countEmpty: "Explore the collection",
    toEnglish: "Change language to English",
    toKorean: "Change language to Korean",
    toDark: "Switch to dark theme",
    toLight: "Switch to light theme",
    themeDark: "Dark theme",
    themeLight: "Light theme",
    roomKicker: "DIGITAL ROOM · OPEN",
    footerLabel: "Site settings",
  },
};

const root = document.documentElement;
const roomsList = document.querySelector("#rooms");
const emptyState = document.querySelector('[data-bench="empty-state"]');
const roomCount = document.querySelector("[data-room-count]");
const lobbyView = document.querySelector('[data-view="lobby"]');
const roomView = document.querySelector("#room-view");
const roomTitle = document.querySelector("#room-title");
const roomSummary = document.querySelector("#room-summary");
const roomKicker = document.querySelector("[data-room-kicker]");
const roomStage = document.querySelector(".room-stage");
const languageButton = document.querySelector('[data-bench="lang-toggle"]');
const languageCode = document.querySelector(".language-code");
const languageLabel = document.querySelector("[data-language-label]");
const themeButton = document.querySelector('[data-bench="theme-toggle"]');
const themeSymbol = document.querySelector(".theme-symbol");
const themeLabel = document.querySelector("[data-theme-label]");
const themePreference = window.matchMedia("(prefers-color-scheme: dark)");

let rooms = [];
let language = "ko";
let chosenTheme = "system";
let activeRoom = null;
let lobbyScrollY = 0;
let lobbyScrollPending = false;
let logicalTimeMs = window.__benchHost?.clock?.now?.() ?? 0;
let currentSeed = window.__benchHost?.seed ?? 1;

function tr(key) {
  return copy[language][key];
}

function accentFor(room) {
  const values = Array.isArray(room?.accent_oklch) ? room.accent_oklch.map(Number) : [];
  if (values.length !== 3 || !values.every(Number.isFinite)) return "var(--accent-strong)";
  const lightness = Math.max(0, Math.min(1, values[0]));
  const chroma = Math.max(0, Math.min(0.4, values[1]));
  const hue = ((values[2] % 360) + 360) % 360;
  const color = `oklch(${lightness} ${chroma} ${hue})`;
  return CSS.supports("color", color) ? color : `hsl(${hue} 42% 47%)`;
}

function setLocalizedText() {
  root.lang = language;
  document.querySelectorAll("[data-copy]").forEach((element) => {
    const value = tr(element.dataset.copy);
    if (typeof value === "string") element.textContent = value;
  });

  const english = language === "en";
  languageCode.textContent = english ? "KO" : "EN";
  languageLabel.textContent = english ? "한국어" : "English";
  languageButton.setAttribute("aria-label", english ? tr("toKorean") : tr("toEnglish"));
  languageButton.title = english ? tr("toKorean") : tr("toEnglish");
  roomKicker.textContent = tr("roomKicker");
  themeLabel.textContent = themePreferenceForLabel();
  themeButton.setAttribute("aria-label", themeActionLabel());
  themeButton.title = themeActionLabel();

  if (rooms.length === 0) {
    roomCount.textContent = tr("countEmpty");
  } else if (language === "en") {
    roomCount.textContent = rooms.length === 1 ? tr("countOne") : tr("countMany")(rooms.length);
  } else {
    roomCount.textContent = rooms.length === 1 ? tr("countOne") : tr("countMany")(rooms.length);
  }

  if (activeRoom) renderRoom(activeRoom);
}

function currentTheme() {
  if (chosenTheme !== "system") return chosenTheme;
  return themePreference.matches ? "dark" : "light";
}

function themePreferenceForLabel() {
  return currentTheme() === "dark" ? tr("themeLight") : tr("themeDark");
}

function themeActionLabel() {
  return currentTheme() === "dark" ? tr("toLight") : tr("toDark");
}

function applyTheme() {
  const theme = currentTheme();
  root.dataset.theme = theme;
  themeButton.setAttribute("aria-pressed", String(theme === "dark"));
  themeSymbol.textContent = theme === "dark" ? "☼" : "◐";
  themeLabel.textContent = themePreferenceForLabel();
  themeButton.setAttribute("aria-label", themeActionLabel());
  themeButton.title = themeActionLabel();
}

function selectedTitle(room) {
  if (language === "en") return room.title_en || room.title_ko || "Untitled room";
  return room.title_ko || room.title_en || "이름 없는 방";
}

function selectedSummary(room) {
  if (typeof room.summary_ko === "string" && room.summary_ko.length > 0) {
    return { text: room.summary_ko, lang: "ko" };
  }
  return language === "en"
    ? { text: tr("noSummaryEn"), lang: "en" }
    : { text: tr("noSummary"), lang: "ko" };
}

function makeCardTop(index, statusText) {
  const top = document.createElement("div");
  top.className = "room-card-top";

  const number = document.createElement("span");
  number.className = "room-number";
  number.textContent = `ROOM ${String(index + 1).padStart(2, "0")}`;

  const status = document.createElement("span");
  status.className = "room-status";
  status.textContent = ` · ${statusText}`;
  top.append(number, status);
  return top;
}

function makeRoomCard(room, index) {
  const isOpen = room.status === "open";
  const item = document.createElement("li");
  item.className = "room-item";
  item.dataset.bench = "room-card";
  item.dataset.status = isOpen ? "open" : "coming_soon";
  if (typeof room.id === "string") item.dataset.roomId = room.id;

  const card = document.createElement(isOpen ? "a" : "article");
  card.className = isOpen ? "room-card-link" : "soon-card";
  card.style.setProperty("--room-accent", accentFor(room));
  if (isOpen) card.href = typeof room.route === "string" ? room.route : "#/";
  else card.setAttribute("aria-label", `${selectedTitle(room)} — ${tr("coming")}`);

  card.append(makeCardTop(index, isOpen ? tr("open") : tr("coming")));

  const title = document.createElement("h3");
  title.className = "room-title";
  title.lang = language === "en" && room.title_en ? "en" : "ko";
  title.textContent = selectedTitle(room);
  card.append(title);

  const summaryData = selectedSummary(room);
  const summary = document.createElement("p");
  summary.className = "room-summary";
  summary.lang = summaryData.lang;
  summary.textContent = summaryData.text;
  card.append(summary);

  const bottom = document.createElement("div");
  bottom.className = "room-card-bottom";
  const action = document.createElement("span");
  action.className = "room-card-action";
  action.textContent = isOpen ? tr("enter") : tr("unavailable");
  bottom.append(action);
  card.append(bottom);
  item.append(card);
  return item;
}

function renderRooms() {
  rooms = Array.isArray(window.__benchHost?.params?.rooms)
    ? Array.from(window.__benchHost.params.rooms)
    : [];

  const fragment = document.createDocumentFragment();
  rooms.forEach((room, index) => fragment.append(makeRoomCard(room || {}, index)));
  roomsList.replaceChildren(fragment);
  emptyState.hidden = rooms.length !== 0;
  if (rooms.length === 0) roomCount.textContent = tr("countEmpty");
  else roomCount.textContent = rooms.length === 1 ? tr("countOne") : tr("countMany")(rooms.length);

  if (activeRoom) {
    const stillAvailable = rooms.find((room) => room.status === "open" && room.id === activeRoom.id);
    if (stillAvailable) renderRoom(stillAvailable);
    else navigateToLobby();
  }
}

function renderRoom(room) {
  activeRoom = room;
  const title = selectedTitle(room);
  const summaryData = selectedSummary(room);
  roomTitle.textContent = title;
  roomTitle.lang = language === "en" && room.title_en ? "en" : "ko";
  roomSummary.textContent = summaryData.text;
  roomSummary.lang = summaryData.lang;
  const accent = accentFor(room);
  roomView.style.setProperty("--room-accent", accent);
  roomStage.style.setProperty("--room-accent", accent);
  document.title = `${title} — Museum of Light`;
}

function roomForCurrentHash() {
  return rooms.find((room) => room.status === "open" && room.route === window.location.hash) || null;
}

function playEntrance(view) {
  view.classList.remove("view-enter");
  void view.getBoundingClientRect();
  view.classList.add("view-enter");
}

function navigateToLobby() {
  if (window.location.hash.startsWith("#/room/")) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}#/`);
  }
  syncRoute(false);
}

function syncRoute(animate = true) {
  const nextRoom = roomForCurrentHash();
  if (window.location.hash.startsWith("#/room/") && !nextRoom) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}#/`);
  }

  if (nextRoom === activeRoom) return;

  if (!activeRoom && nextRoom) {
    if (!lobbyScrollPending) lobbyScrollY = window.scrollY;
    lobbyScrollPending = false;
  }
  const previousRoom = activeRoom;
  activeRoom = nextRoom;

  if (nextRoom) {
    renderRoom(nextRoom);
    lobbyView.hidden = true;
    roomView.hidden = false;
    if (animate) playEntrance(roomView);
    roomTitle.focus({ preventScroll: true });
  } else {
    roomView.hidden = true;
    lobbyView.hidden = false;
    document.body.offsetHeight;
    if (previousRoom) {
      const returnScrollY = lobbyScrollY;
      window.scrollTo({ left: 0, top: returnScrollY, behavior: "instant" });
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => {
          window.scrollTo({ left: 0, top: returnScrollY, behavior: "instant" });
        });
      }
    }
    if (animate && previousRoom) playEntrance(lobbyView);
    document.title = "빛의 박물관 — Museum of Light";
  }
}

function setLanguage(nextLanguage, persist = true) {
  language = nextLanguage === "en" ? "en" : "ko";
  setLocalizedText();
  renderRooms();
  if (persist) {
    try {
      localStorage.setItem("mol-lang", language);
    } catch {
      // Language still works when storage is unavailable.
    }
  }
  document.title = activeRoom
    ? `${selectedTitle(activeRoom)} — Museum of Light`
    : "빛의 박물관 — Museum of Light";
}

function readSavedLanguage() {
  try {
    return localStorage.getItem("mol-lang") === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

languageButton.addEventListener("click", () => {
  setLanguage(language === "ko" ? "en" : "ko");
});

themeButton.addEventListener("click", () => {
  chosenTheme = currentTheme() === "dark" ? "light" : "dark";
  applyTheme();
});

themePreference.addEventListener?.("change", () => {
  if (chosenTheme === "system") applyTheme();
});

window.addEventListener("hashchange", () => syncRoute(true));

document.addEventListener("animationend", (event) => {
  if (event.target instanceof HTMLElement) event.target.classList.remove("view-enter");
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const card = event.target.closest('[data-bench="room-card"][data-status="open"]');
  const link = card?.querySelector("a[href]");
  if (link && link.getAttribute("href") !== window.location.hash) {
    lobbyScrollY = window.scrollY;
    lobbyScrollPending = true;
  }
}, true);

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
language = readSavedLanguage();
applyTheme();
setLocalizedText();
renderRooms();
syncRoute(false);

const ready = Promise.resolve(document.fonts?.ready).then(() => undefined);

window.__bench = {
  version: 1,
  ready,
  setSeed(seed) {
    currentSeed = Number(seed) >>> 0;
    logicalTimeMs = 0;
    renderRooms();
    syncRoute(false);
  },
  seek(tMs) {
    const time = Number(tMs);
    logicalTimeMs = Number.isFinite(time) ? Math.max(0, time) : 0;
  },
  resume() {
    logicalTimeMs = window.__benchHost?.clock?.now?.() ?? logicalTimeMs;
  },
  async renderFrame() {
    await ready;
    void document.documentElement.getBoundingClientRect();
    void document.body.getBoundingClientRect();
    logicalTimeMs = window.__benchHost?.clock?.now?.() ?? logicalTimeMs;
    await new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });
    void document.documentElement.getBoundingClientRect();
  },
  state() {
    return {
      route: activeRoom?.id ?? "lobby",
      lang: language,
      theme: root.dataset.theme === "dark" ? "dark" : "light",
    };
  },
  stats() {
    return { drawCalls: 0, triangles: 0, listeners: 6 };
  },
};
