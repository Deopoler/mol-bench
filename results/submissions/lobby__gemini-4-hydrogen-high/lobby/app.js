const I18N = {
  ko: {
    skip: "전시실 목록으로 건너뛰기",
    brandSub: "빛의 미술관",
    langBtn: "EN",
    langAria: "영어로 전환",
    themeBtnDark: "다크 모드",
    themeBtnLight: "라이트 모드",
    themeAria: "색상 테마 전환",
    eyebrow: "PERMANENT DIGITAL COLLECTION · 상설 디지털 전시",
    heroTitle: "빛의 방에 오신 것을 환영합니다",
    heroBody:
      "각각의 방은 빛과 시간, 그리고 고요한 사유를 위해 마련된 작은 디지털 건축입니다. 서두르지 않고 천천히 머물며 서로 다른 색온도와 결을 따라 자신의 속도로 전시를 거닐어 보세요.",
    heroCta: "전시실 둘러보기",
    collectionTitle: "전시실 안내",
    collectionNote: "카드를 선택하면 해당 전시실의 입구로 이동합니다.",
    emptyTitle: "현재 열려 있는 전시실이 없습니다",
    emptyDesc: "새로운 빛의 전시를 준비하고 있습니다. 잠시 후 다시 방문해 주세요.",
    infoTitle: "관람 안내",
    infoNote: "빛의 미술관은 열려 있는 웹 전시 공간입니다.",
    infoCard1Title: "머무는 속도",
    infoCard1Body:
      "모든 전시실은 작은 화면부터 넓은 데스크톱까지 고른 호흡으로 읽히도록 정돈되어 있습니다. 화면의 밝기와 움직임 설정에 맞추어 빛의 농도와 전환 속도가 자연스럽게 조율됩니다.",
    infoCard2Title: "접근과 탐색",
    infoCard2Body:
      "키보드 탭 이동과 스크린 리더 탐색을 통해 모든 전시실과 안내 문구에 막힘없이 닿을 수 있습니다. 개관 준비 중인 방은 목록에서 미리 살펴보되 입장 시점까지 고요히 대기합니다.",
    footerCopy: "Museum of Light · Seoul — 디지털 빛의 아카이브",
    footerRooms: "전시실 목록",
    footerTop: "맨 위로",
    roomBack: "← 로비로 돌아가기",
    statusOpen: "열림",
    statusSoon: "준비 중",
    enterRoom: "전시실 입장하기 →",
    openingSoon: "개관 준비 중",
    roomCount: (openCount, totalCount) => `전시실 ${totalCount}개 · 개관 ${openCount}개`,
    roomViewBadge: "전시실 입구",
    roomViewSummary: "이 공간은 로비에서 이어지는 개별 전시실의 문턱입니다. 조용히 빛의 변화를 감상한 뒤 언제든 로비로 돌아갈 수 있습니다.",
  },
  en: {
    skip: "Skip to exhibition rooms",
    brandSub: "Digital Gallery",
    langBtn: "한국어",
    langAria: "Switch to Korean",
    themeBtnDark: "Dark Mode",
    themeBtnLight: "Light Mode",
    themeAria: "Toggle color theme",
    eyebrow: "PERMANENT DIGITAL COLLECTION · MUSEUM OF LIGHT",
    heroTitle: "Welcome to the Museum of Light",
    heroBody:
      "Each room is a quiet digital architecture shaped around light, time, and attentive observation. Take your time moving across shifting temperatures and calm surfaces at your own pace.",
    heroCta: "Browse Rooms",
    collectionTitle: "Exhibition Rooms",
    collectionNote: "Select an open room card to step into its threshold.",
    emptyTitle: "No exhibition rooms are open yet",
    emptyDesc: "Curators are preparing upcoming studies in light. Please check back shortly.",
    infoTitle: "Visiting Guide",
    infoNote: "An open web entrance designed for calm reading.",
    infoCard1Title: "Measured Pacing",
    infoCard1Body:
      "Every gallery card and curatorial note is composed to read comfortably from phone to desktop. Contrast, spacing, and transitions adapt smoothly to your color scheme and motion preferences.",
    infoCard2Title: "Open Navigation",
    infoCard2Body:
      "All open rooms, controls, and landmarks remain directly reachable by keyboard and assistive technologies. Rooms marked as coming soon remain previews until their doors open.",
    footerCopy: "Museum of Light · Seoul — Digital Light Archive",
    footerRooms: "Exhibition Index",
    footerTop: "Back to top",
    roomBack: "← Back to Lobby",
    statusOpen: "Open",
    statusSoon: "Coming Soon",
    enterRoom: "Enter Room →",
    openingSoon: "Opening Soon",
    roomCount: (openCount, totalCount) => `${totalCount} Rooms · ${openCount} Open`,
    roomViewBadge: "Room Threshold",
    roomViewSummary: "You have arrived at the threshold of this exhibition room. Take a moment with its light study or return to the main lobby whenever you wish.",
  },
};

const EN_SUMMARIES = [
  "Walk slowly through a quiet study where light and memory overlap in gentle layers.",
  "A calm room dedicated to close observation, stillness, and unhurried discovery.",
];

const colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  lang: safeReadLang(),
  themeOverride: null,
  route: "lobby",
  clockMs: 0,
  live: true,
  rafId: 0,
  pointer: { x: 0.5, y: 0.5 },
  beams: [],
  savedLobbyScrollY: 0,
  lastRoute: "lobby",
  activeTransition: null,
};

function safeReadLang() {
  try {
    return localStorage.getItem("mol-lang") === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

function safeWriteLang(lang) {
  try {
    localStorage.setItem("mol-lang", lang);
  } catch {
    // Ignore storage restriction
  }
}

function getEffectiveTheme() {
  if (state.themeOverride === "dark" || state.themeOverride === "light") {
    return state.themeOverride;
  }
  return colorSchemeMedia.matches ? "dark" : "light";
}

function syncThemeAttribute() {
  const theme = getEffectiveTheme();
  if (state.themeOverride) {
    document.documentElement.setAttribute("data-theme", state.themeOverride);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const themeBtn = document.querySelector('[data-bench="theme-toggle"]');
  if (themeBtn) {
    const dict = I18N[state.lang];
    themeBtn.textContent = theme === "dark" ? dict.themeBtnLight : dict.themeBtnDark;
    themeBtn.setAttribute("aria-label", dict.themeAria);
    themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
  }
}

function getRooms() {
  const raw = window.__benchHost?.params?.rooms;
  return Array.isArray(raw) ? raw : [];
}

function getRoomIdFromHash() {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#/room/")) return "lobby";
  const candidate = hash.slice(7).trim();
  if (!candidate) return "lobby";
  const rooms = getRooms();
  const match = rooms.find((r) => r.id === candidate && r.status !== "coming_soon");
  return match ? match.id : "lobby";
}

function oklchString(oklch, alpha = 1) {
  if (!Array.isArray(oklch) || oklch.length < 3) {
    return alpha < 1 ? `rgba(180, 160, 120, ${alpha})` : "rgb(180, 160, 120)";
  }
  const [l, c, h] = oklch;
  return alpha < 1 ? `oklch(${l} ${c} ${h} / ${alpha})` : `oklch(${l} ${c} ${h})`;
}

function initBeamsFromSeed() {
  const rng = window.__benchHost?.rng?.fork?.("lobby-light");
  const nextRand = () => (rng ? rng.next() : 0.5);
  state.beams = [
    {
      bx: 0.45 + nextRand() * 0.16,
      by: 0.42 + nextRand() * 0.16,
      radius: 0.42,
      speed: 0.0003 + nextRand() * 0.0002,
      phase: nextRand() * Math.PI * 2,
      hue: 32 + Math.floor(nextRand() * 190),
    },
  ];
}

function drawLightField(tMs) {
  const canvas = document.getElementById("light-field");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const theme = getEffectiveTheme();
  const reduce = reducedMotionMedia.matches;
  const t = reduce ? 0 : Number(tMs || 0);

  ctx.clearRect(0, 0, w, h);

  const b = state.beams[0] || { bx: 0.52, by: 0.48, radius: 0.42, speed: 0.00035, phase: 0, hue: 40 };
  const pxOffset = (state.pointer.x - 0.5) * 18;
  const pyOffset = (state.pointer.y - 0.5) * 18;
  const cx = w * b.bx + Math.sin(t * b.speed + b.phase) * 14 + pxOffset;
  const cy = h * b.by + Math.cos(t * b.speed * 0.8 + b.phase) * 14 + pyOffset;
  const r = w * b.radius;

  const grad = ctx.createRadialGradient(cx, cy, r * 0.08, cx, cy, r);
  if (theme === "dark") {
    grad.addColorStop(0, `hsla(${b.hue}, 44%, 64%, 0.44)`);
    grad.addColorStop(0.55, `hsla(${b.hue}, 38%, 48%, 0.18)`);
    grad.addColorStop(1, `hsla(${b.hue}, 38%, 35%, 0)`);
  } else {
    grad.addColorStop(0, `hsla(${b.hue}, 58%, 74%, 0.52)`);
    grad.addColorStop(0.55, `hsla(${b.hue}, 48%, 78%, 0.22)`);
    grad.addColorStop(1, `hsla(${b.hue}, 48%, 82%, 0)`);
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Concentric architectural ring inside the circular aperture
  ctx.strokeStyle = theme === "dark" ? "rgba(210, 220, 240, 0.16)" : "rgba(110, 96, 76, 0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.5, w * 0.34, 0, Math.PI * 2);
  ctx.stroke();
}

function getRoomTitle(room) {
  if (state.lang === "en") {
    return room.title_en || room.title_ko || room.id;
  }
  return room.title_ko || room.title_en || room.id;
}

function getRoomSummary(room, idx) {
  if (state.lang === "en") {
    return room.summary_en || EN_SUMMARIES[idx % EN_SUMMARIES.length];
  }
  return room.summary_ko || "";
}

function renderI18nText() {
  const dict = I18N[state.lang];
  document.documentElement.lang = state.lang;

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key && typeof dict[key] === "string") {
      el.textContent = dict[key];
    }
  }

  const heroTitle = document.querySelector('[data-bench="hero-title"]');
  if (heroTitle) {
    heroTitle.textContent = dict.heroTitle;
  }

  const langBtn = document.querySelector('[data-bench="lang-toggle"]');
  if (langBtn) {
    langBtn.setAttribute("aria-label", dict.langAria);
  }

  syncThemeAttribute();
}

function renderRooms() {
  const grid = document.getElementById("rooms-grid");
  const emptyState = document.querySelector('[data-bench="empty-state"]');
  const countPill = document.getElementById("room-count-pill");
  if (!grid || !emptyState) return;

  const rooms = getRooms();
  const dict = I18N[state.lang];
  const openCount = rooms.filter((r) => r.status !== "coming_soon").length;
  if (countPill) {
    countPill.textContent = dict.roomCount(openCount, rooms.length);
  }

  grid.replaceChildren();
  emptyState.hidden = rooms.length > 0;
  grid.hidden = rooms.length === 0;

  rooms.forEach((room, idx) => {
    const isSoon = room.status === "coming_soon";
    const card = document.createElement("article");
    card.className = "room-card";
    card.dataset.bench = "room-card";
    card.dataset.status = isSoon ? "coming_soon" : "open";
    card.dataset.route = room.route || `#/room/${room.id}`;

    const isDark = getEffectiveTheme() === "dark";
    card.style.setProperty("--room-bar", oklchString(room.accent_oklch, isDark ? 0.78 : 0.85));

    const inner = document.createElement("div");
    inner.className = "room-card-inner";

    const aperture = document.createElement("div");
    aperture.className = "room-aperture";

    const body = document.createElement("div");
    body.className = "room-body";

    const meta = document.createElement("p");
    meta.className = "room-meta";
    const idxSpan = document.createElement("span");
    idxSpan.textContent = `${String(idx + 1).padStart(2, "0")} · `;
    const statusSpan = document.createElement("span");
    statusSpan.className = "room-status-text";
    statusSpan.textContent = isSoon ? dict.statusSoon : dict.statusOpen;
    meta.append(idxSpan, statusSpan);

    const title = document.createElement("h3");
    title.className = "room-title";
    title.textContent = getRoomTitle(room);

    const summary = document.createElement("p");
    summary.className = "room-summary";
    summary.textContent = getRoomSummary(room, idx);

    const foot = document.createElement("p");
    foot.className = "room-foot";
    foot.textContent = isSoon ? dict.openingSoon : dict.enterRoom;

    body.append(meta, title, summary, foot);
    inner.append(aperture, body);

    if (isSoon) {
      card.setAttribute("aria-disabled", "true");
      card.append(inner);
    } else {
      const link = document.createElement("a");
      link.className = "room-card-link";
      link.href = room.route || `#/room/${room.id}`;
      link.addEventListener("click", () => {
        state.savedLobbyScrollY = window.scrollY;
      });
      link.append(inner);
      card.append(link);
    }

    grid.append(card);
  });
}

function finishActiveTransition() {
  if (state.activeTransition) {
    try {
      state.activeTransition.cancel();
    } catch {
      // Ignore
    }
    state.activeTransition = null;
  }
}

function renderRoomView({ animate = false } = {}) {
  const view = document.getElementById("room-view");
  const mainShell = document.querySelector(".site-shell");
  if (!view || !mainShell) return;

  const routeId = getRoomIdFromHash();
  const prevRoute = state.route;
  state.route = routeId;

  if (routeId === "lobby") {
    finishActiveTransition();
    view.hidden = true;
    mainShell.removeAttribute("inert");
    if (prevRoute !== "lobby") {
      window.scrollTo({ top: state.savedLobbyScrollY, behavior: "instant" });
    }
    state.lastRoute = "lobby";
    return;
  }

  const rooms = getRooms();
  const room = rooms.find((r) => r.id === routeId);
  if (!room) {
    finishActiveTransition();
    view.hidden = true;
    state.route = "lobby";
    return;
  }

  if (prevRoute === "lobby") {
    state.savedLobbyScrollY = window.scrollY;
  }

  const dict = I18N[state.lang];
  const isDark = getEffectiveTheme() === "dark";
  const swatch = document.getElementById("room-view-swatch");
  const badge = document.getElementById("room-view-badge");
  const eyebrow = document.getElementById("room-view-eyebrow");
  const titleEl = document.getElementById("room-view-title");
  const subtitleEl = document.getElementById("room-view-subtitle");
  const summaryEl = document.getElementById("room-view-summary");

  if (swatch) {
    swatch.style.setProperty("--room-glow", oklchString(room.accent_oklch, isDark ? 0.42 : 0.36));
  }
  if (badge) badge.textContent = dict.roomViewBadge;
  if (eyebrow) eyebrow.textContent = `${room.id.toUpperCase()} · ${room.route}`;
  if (titleEl) titleEl.textContent = getRoomTitle(room);
  if (subtitleEl) subtitleEl.textContent = state.lang === "en" ? (room.title_ko || "") : (room.title_en || "");
  if (summaryEl) {
    const idx = Math.max(0, rooms.indexOf(room));
    summaryEl.textContent = `${getRoomSummary(room, idx)} ${dict.roomViewSummary}`.trim();
  }

  view.hidden = false;
  mainShell.setAttribute("inert", "");
  state.lastRoute = routeId;

  if (animate && prevRoute === "lobby") {
    finishActiveTransition();
    const duration = reducedMotionMedia.matches ? 0 : 280;
    if (duration > 0 && typeof view.animate === "function") {
      state.activeTransition = view.animate(
        [
          { opacity: 0, transform: "translateY(32px)" },
          { opacity: 1, transform: "translateY(0px)" },
        ],
        {
          duration,
          easing: "cubic-bezier(0.35, 0, 0.25, 1)",
          fill: "forwards",
        },
      );
      state.activeTransition.onfinish = () => {
        state.activeTransition = null;
      };
    }
  }
}

function renderAll(tMs = state.clockMs) {
  syncThemeAttribute();
  drawLightField(tMs);
}

function startLiveLoop() {
  if (state.rafId) return;
  const tick = () => {
    if (!state.live) {
      state.rafId = 0;
      return;
    }
    const now = window.__benchHost?.clock?.now?.() ?? 0;
    state.clockMs = now;
    drawLightField(now);
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function stopLiveLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }
}

function setupListeners() {
  const langToggle = document.querySelector('[data-bench="lang-toggle"]');
  if (langToggle) {
    langToggle.addEventListener("click", () => {
      state.lang = state.lang === "ko" ? "en" : "ko";
      safeWriteLang(state.lang);
      renderI18nText();
      renderRooms();
      if (state.route !== "lobby") {
        renderRoomView({ animate: false });
      }
    });
  }

  const themeToggle = document.querySelector('[data-bench="theme-toggle"]');
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = getEffectiveTheme();
      state.themeOverride = current === "dark" ? "light" : "dark";
      syncThemeAttribute();
      renderRooms();
      drawLightField(state.clockMs);
      if (state.route !== "lobby") {
        renderRoomView({ animate: false });
      }
    });
  }

  const backLink = document.getElementById("room-back-link");
  if (backLink) {
    backLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.location.hash.startsWith("#/room/")) {
        history.back();
        setTimeout(() => {
          if (window.location.hash.startsWith("#/room/")) {
            window.location.hash = "";
          }
        }, 50);
      } else {
        renderRoomView({ animate: false });
      }
    });
  }

  window.addEventListener("hashchange", () => {
    renderRoomView({ animate: true });
  });

  window.addEventListener("pointermove", (e) => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    state.pointer.x = Math.max(0, Math.min(1, e.clientX / w));
    state.pointer.y = Math.max(0, Math.min(1, e.clientY / h));
    if (!state.live) {
      drawLightField(state.clockMs);
    }
  });

  colorSchemeMedia.addEventListener("change", () => {
    syncThemeAttribute();
    renderRooms();
    drawLightField(state.clockMs);
  });

  reducedMotionMedia.addEventListener("change", () => {
    drawLightField(state.clockMs);
  });
}

initBeamsFromSeed();
renderI18nText();
renderRooms();
renderRoomView({ animate: false });
drawLightField(0);
setupListeners();
startLiveLoop();

window.__bench = {
  version: 1,
  ready: document.fonts.ready.then(() => {
    drawLightField(state.clockMs);
  }),
  setSeed() {
    state.pointer = { x: 0.5, y: 0.5 };
    state.clockMs = 0;
    finishActiveTransition();
    initBeamsFromSeed();
    renderI18nText();
    renderRooms();
    renderRoomView({ animate: false });
    drawLightField(state.clockMs);
  },
  seek(tMs) {
    state.live = false;
    stopLiveLoop();
    finishActiveTransition();
    state.clockMs = Number(tMs) || 0;
    drawLightField(state.clockMs);
  },
  resume() {
    state.live = true;
    state.clockMs = window.__benchHost?.clock?.now?.() ?? state.clockMs;
    startLiveLoop();
  },
  async renderFrame() {
    if (state.live) {
      state.clockMs = window.__benchHost?.clock?.now?.() ?? state.clockMs;
    }
    renderAll(state.clockMs);
    if (window.__benchHostControl?.isRafOverrideActive?.()) {
      return;
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  },
  state() {
    return {
      route: state.route,
      lang: state.lang,
      theme: getEffectiveTheme(),
    };
  },
  stats() {
    return {
      drawCalls: 1,
      triangles: 2,
    };
  },
};
