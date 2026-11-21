/**
 * MoL-Bench Gallery Shim (bench-host.js)
 * Implements window.__benchHost for live static gallery viewers,
 * offline-capable with deterministic Mulberry32 PRNG and performance clock.
 * Also injects a sleek, unobtrusive dismissible gallery bar.
 */
(function initBenchHostShim() {
  const ROOM_PARAMS = {"lobby":{"rooms":[{"id":"room-1","route":"#/room/room-1","title_ko":"기억을 수집하는 방","title_en":"Rooms That Gather Memory","summary_ko":"조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.","accent_oklch":[0.68,0.12,39],"status":"open"},{"id":"room-2","route":"#/room/room-2","title_ko":"작은 파도의 기록","title_en":"Notes from a Small Wave","summary_ko":"빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.","accent_oklch":[0.68,0.12,70],"status":"open"},{"id":"room-3","route":"#/room/room-3","title_ko":"시간의 표면을 걷다","title_en":"Walking the Surface of Time","summary_ko":"조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.","accent_oklch":[0.68,0.12,101],"status":"open"},{"id":"room-4","route":"#/room/room-4","title_ko":"낯선 행성의 식물도감","title_en":"Field Guide to Alien Plants","summary_ko":"빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.","accent_oklch":[0.68,0.12,132],"status":"open"},{"id":"room-5","route":"#/room/room-5","title_ko":"사라진 색을 찾아서","title_en":"In Search of a Vanished Color","summary_ko":"조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.","accent_oklch":[0.68,0.12,163],"status":"open"},{"id":"room-6","route":"#/room/room-6","title_ko":"밤의 건축과 낮의 꿈","title_en":"Night Architecture, Daydreams","summary_ko":"빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.","accent_oklch":[0.68,0.12,194],"status":"open"},{"id":"room-7","route":"#/room/room-7","title_ko":"보이지 않는 선들의 지도","title_en":"Atlas of Invisible Lines","summary_ko":"조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.","accent_oklch":[0.68,0.12,225],"status":"open"},{"id":"room-8","route":"#/room/room-8","title_ko":"마지막 종이배를 띄우며","title_en":"Launch the Last Paper Boat","summary_ko":"빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.","accent_oklch":[0.68,0.12,256],"status":"open"},{"id":"room-9","route":"#/room/room-9","title_ko":"천천히 흐르는 푸른 세계","title_en":"A World in Slow Blue","summary_ko":"조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.","accent_oklch":[0.68,0.12,287],"status":"open"}]},"atelier":{"seed":1,"hidden":false,"token":627073940},"restoration":{"seed":1,"hidden":false,"orbitPhasesDeg":[62.1159,217.4678,285.4541,8.4733,250.7254,57.0207,307.0276],"cameraPath":{"basePosition":[0.25,3.55,7.35],"baseTarget":[-0.45,1.45,-0.45],"driftAmp":[0.025,0.012,0.02],"driftPhase":4.0515,"driftFreqHz":0.08},"chartPatchesRef":[{"srgb":[194,150,130]},{"srgb":[98,122,157]},{"srgb":[87,108,67]},{"srgb":[133,128,177]},{"srgb":[103,189,170]},{"srgb":[214,126,44]},{"srgb":[80,91,166]},{"srgb":[193,90,99]},{"srgb":[94,60,108]},{"srgb":[157,188,64]},{"srgb":[224,163,46]},{"srgb":[200,200,200]}]},"aurora":{"seed":1,"hidden":false,"room":"aurora"}};
  const RUNS_METADATA = {"lobby__gemini-4-neon-high":{"run_id":"lobby__gemini-4-neon-high","model":"Gemini 4 Neon (High)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__gemini-4-hydrogen-high":{"run_id":"lobby__gemini-4-hydrogen-high","model":"Gemini 4 Hydrogen (High)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__claude-haiku-5.5-max":{"run_id":"lobby__claude-haiku-5.5-max","model":"Claude Haiku 5.5 (max)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__gemini-4-hydrogen-xhigh":{"run_id":"lobby__gemini-4-hydrogen-xhigh","model":"Gemini 4 Hydrogen (XHigh)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__gemini-4-neon-xhigh":{"run_id":"lobby__gemini-4-neon-xhigh","model":"Gemini 4 Neon (XHigh)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__claude-sonnet-5.5-max":{"run_id":"lobby__claude-sonnet-5.5-max","model":"Claude Sonnet 5.5 (max)","room":"lobby","renovation":null,"room_key":"lobby","composite":10},"lobby__gpt-6-luna-high":{"run_id":"lobby__gpt-6-luna-high","model":"GPT-6-Luna (high)","room":"lobby","renovation":null,"room_key":"lobby","composite":9.8},"atelier__claude-haiku-5.5-high":{"run_id":"atelier__claude-haiku-5.5-high","model":"Claude Haiku 5.5 (high)","room":"atelier","renovation":null,"room_key":"atelier","composite":9.7},"lobby__gemini-3.8-flash-high":{"run_id":"lobby__gemini-3.8-flash-high","model":"Gemini 3.8 Flash (High)","room":"lobby","renovation":null,"room_key":"lobby","composite":9.5},"lobby__claude-haiku-5.5-high":{"run_id":"lobby__claude-haiku-5.5-high","model":"Claude Haiku 5.5 (high)","room":"lobby","renovation":null,"room_key":"lobby","composite":9.5},"lobby__gemini-3.8-flash-medium":{"run_id":"lobby__gemini-3.8-flash-medium","model":"Gemini 3.8 Flash (Medium)","room":"lobby","renovation":null,"room_key":"lobby","composite":9.5},"lobby__gpt-6-luna-medium":{"run_id":"lobby__gpt-6-luna-medium","model":"GPT-6-Luna (medium)","room":"lobby","renovation":null,"room_key":"lobby","composite":9.4},"lobby__gpt-6-luna-max":{"run_id":"lobby__gpt-6-luna-max","model":"GPT-6-Luna (max)","room":"lobby","renovation":null,"room_key":"lobby","composite":9},"lobby__claude-sonnet-5.5-high":{"run_id":"lobby__claude-sonnet-5.5-high","model":"Claude Sonnet 5.5 (high)","room":"lobby","renovation":null,"room_key":"lobby","composite":8.9},"lobby__claude-sonnet-5.5-medium":{"run_id":"lobby__claude-sonnet-5.5-medium","model":"Claude Sonnet 5.5 (medium)","room":"lobby","renovation":null,"room_key":"lobby","composite":8.6},"lobby__claude-haiku-5.5-medium":{"run_id":"lobby__claude-haiku-5.5-medium","model":"Claude Haiku 5.5 (medium)","room":"lobby","renovation":null,"room_key":"lobby","composite":8.6},"restoration__claude-haiku-5.5-high":{"run_id":"restoration__claude-haiku-5.5-high","model":"Claude Haiku 5.5 (high)","room":"restoration","renovation":null,"room_key":"restoration","composite":8.3},"lobby-r1__claude-haiku-5.5-high":{"run_id":"lobby-r1__claude-haiku-5.5-high","model":"Claude Haiku 5.5 (high)","room":"lobby","renovation":"r1","room_key":"lobby/r1","composite":7.3}};

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeedLabel(seed, label) {
    let h = (2166136261 ^ (seed >>> 0)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    const s = String(label);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function createRng(seed) {
    const baseSeed = seed >>> 0;
    const gen = mulberry32(baseSeed);
    return Object.freeze({
      next() { return gen(); },
      int(n) {
        const limit = Math.floor(Number(n));
        if (!(limit > 0)) return 0;
        return Math.floor(gen() * limit);
      },
      fork(label) {
        return createRng(hashSeedLabel(baseSeed, label));
      }
    });
  }

  function deepCloneAndFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(deepCloneAndFreeze));
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepCloneAndFreeze(value[k]);
    return Object.freeze(out);
  }

  // Detect current run ID & room from URL pathname
  let detectedRunId = "";
  const match = /[\/](?:runs|anchors)[\/]([^\/]+)/i.exec(window.location.href);
  if (match) detectedRunId = decodeURIComponent(match[1]);

  let runInfo = RUNS_METADATA[detectedRunId] || null;
  let roomName = runInfo?.room || "";
  if (!roomName) {
    const p = window.location.pathname.toLowerCase();
    if (p.includes("atelier")) roomName = "atelier";
    else if (p.includes("restoration")) roomName = "restoration";
    else if (p.includes("aurora")) roomName = "aurora";
    else roomName = "lobby";
  }

  const roomParams = ROOM_PARAMS[roomName] || ROOM_PARAMS["lobby"] || {};
  const currentParams = deepCloneAndFreeze(roomParams);
  const startTime = performance.now();

  const benchClock = Object.freeze({
    now: () => performance.now() - startTime
  });

  const benchHost = {};
  Object.defineProperties(benchHost, {
    contractVersion: { value: 1, enumerable: true, writable: false, configurable: false },
    seed: { get: () => 1, enumerable: true, configurable: false },
    params: { get: () => currentParams, enumerable: true, configurable: false },
    clock: { value: benchClock, enumerable: true, writable: false, configurable: false },
    rng: { value: createRng(1), enumerable: true, writable: false, configurable: false },
  });
  Object.freeze(benchHost);

  try {
    Object.defineProperty(window, "__benchHost", {
      value: benchHost,
      enumerable: true,
      writable: false,
      configurable: false
    });
  } catch {
    window.__benchHost = benchHost;
  }

  // Small dismissible overlay bar (only on top frame)
  if (window.self === window.top) {
    function injectOverlay() {
      if (document.getElementById("mol-bench-gallery-bar")) return;
      const hostEl = document.createElement("div");
      hostEl.id = "mol-bench-gallery-bar";

      const shadow = hostEl.attachShadow ? hostEl.attachShadow({ mode: "open" }) : hostEl;
      const modelLabel = runInfo?.model || "MoL-Bench";
      const roomLabel = runInfo?.room_key || roomName;
      const scoreStr = runInfo?.composite !== null && runInfo?.composite !== undefined ? Number(runInfo.composite).toFixed(1) : "Live";

      // Calculate relative back path to site/gallery/index.html
      const curPath = window.location.pathname.replace(/\\/g, "/");
      const runsIdx = curPath.indexOf("/runs/");
      let backUrl = "../../index.html";
      if (runsIdx !== -1) {
        const afterRuns = curPath.slice(runsIdx + 6).split("/").filter(Boolean);
        backUrl = "../".repeat(afterRuns.length) + "index.html";
      }

      shadow.innerHTML = `
        <style>
          :host {
            all: initial;
            position: fixed;
            top: 12px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 2147483647;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.4;
          }
          .bar {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 6px 14px;
            background: rgba(18, 17, 16, 0.88);
            color: #f6f4ef;
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 999px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(10px);
            user-select: none;
            white-space: nowrap;
          }
          .back-link {
            color: #f2b84b;
            text-decoration: none;
            font-weight: 700;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          .back-link:hover { text-decoration: underline; }
          .sep { color: rgba(255, 255, 255, 0.25); }
          .title { font-weight: 600; color: #ffffff; }
          .sub { color: #a39e94; font-size: 12px; }
          .score {
            background: rgba(242, 184, 75, 0.2);
            color: #f2b84b;
            padding: 2px 8px;
            border-radius: 999px;
            font-weight: 700;
            font-family: ui-monospace, Menlo, Consolas, monospace;
          }
          .close-btn {
            background: transparent;
            border: none;
            color: #a39e94;
            cursor: pointer;
            padding: 0 2px;
            font-size: 15px;
            line-height: 1;
            display: flex;
            align-items: center;
          }
          .close-btn:hover { color: #ffffff; }
        </style>
        <div class="bar">
          <a class="back-link" href="${backUrl}">← Gallery</a>
          <span class="sep">|</span>
          <span class="title">${modelLabel}</span>
          <span class="sub">(${roomLabel})</span>
          <span class="score">${scoreStr}</span>
          <button class="close-btn" id="close-btn" title="Dismiss overlay" type="button">✕</button>
        </div>
      `;

      const closeBtn = shadow.getElementById("close-btn");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => hostEl.remove());
      }

      document.body.appendChild(hostEl);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectOverlay);
    } else {
      injectOverlay();
    }
  }
})();
