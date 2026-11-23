#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { round1 } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    }
  }
  return flags;
}

function formatNum(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return Number(val).toFixed(1);
}

/**
 * Injects shimPath as a script tag before the first script tag in html,
 * or before </head> / after <body> if no script tag exists.
 * Idempotent: returns html unchanged if already containing shimPath or bench-host.js.
 */
export function patchHtml(html, shimPath = "../../shim/bench-host.js") {
  if (!html || typeof html !== "string") return html;
  if (html.includes(shimPath) || html.includes("bench-host.js")) {
    return html;
  }

  const scriptTag = `<script src="${shimPath}"></script>\n`;

  const scriptMatch = /<script\b[^>]*>/i.exec(html);
  if (scriptMatch) {
    const idx = scriptMatch.index;
    return html.slice(0, idx) + scriptTag + html.slice(idx);
  }

  const headClose = /<\/head>/i.exec(html);
  if (headClose) {
    const idx = headClose.index;
    return html.slice(0, idx) + scriptTag + html.slice(idx);
  }

  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen) {
    const idx = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, idx) + "\n" + scriptTag + html.slice(idx);
  }

  return scriptTag + html;
}

/**
 * Deterministically generates room parameters for a seed from room adapter.
 */
export async function generateParams(roomName, seed = 1, { hidden = false, repoRoot = null } = {}) {
  const root = repoRoot || DEFAULT_REPO_ROOT;
  const baseRoom = roomName.split("/")[0].split("-")[0];
  const adapterPath = path.join(root, "harness", "src", "rooms", `${baseRoom}.mjs`);
  if (!fs.existsSync(adapterPath)) {
    return { seed, hidden, room: roomName };
  }
  const moduleUrl = pathToFileURL(adapterPath).href;
  const adapter = await import(moduleUrl);
  if (typeof adapter.generate === "function") {
    return adapter.generate(seed, { hidden, repoRoot: root });
  }
  return { seed, hidden, room: roomName };
}

/**
 * Extracts a normalized model family string for filtering.
 */
export function getModelFamily(modelName = "") {
  const m = String(modelName).toLowerCase();
  if (m.includes("claude")) return "Claude";
  if (m.includes("gpt")) return "GPT";
  if (m.includes("gemini")) return "Gemini";
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("llama")) return "Llama";
  if (m.includes("mistral")) return "Mistral";
  return "Other";
}

/**
 * Loads graded results from resultsDir.
 */
export function loadGradedResults(resultsDir) {
  if (!fs.existsSync(resultsDir)) return [];
  const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (entry.name === "data.json" || entry.name === "leaderboard.json") continue;
    const fullPath = path.join(resultsDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.room) continue;
      if (parsed.status === "no-submission" || parsed.status === "collect-error") continue;
      const runId = parsed.run_id || path.basename(entry.name, ".json");
      const roomKey = parsed.renovation ? `${parsed.room}/${parsed.renovation}` : parsed.room;
      results.push({
        file: entry.name,
        run_id: runId,
        room: parsed.room,
        renovation: parsed.renovation || null,
        room_key: roomKey,
        track: parsed.track || (parsed.renovation ? "renovation" : "build"),
        model: parsed.model || "unknown",
        model_family: getModelFamily(parsed.model),
        composite: round1(parsed.composite ?? null),
        composite_raw: parsed.composite ?? null,
        axes: {
          craft: round1(parsed.axes?.craft ?? null),
          visual_quality: round1(parsed.axes?.visual_quality ?? null),
          revision: round1(parsed.axes?.revision ?? null),
          reliability: round1(parsed.axes?.reliability ?? null)
        },
        efficiency: parsed.efficiency || {},
        gates: parsed.gates || {},
        data: parsed
      });
    } catch {
      // Skip invalid JSON
    }
  }

  // Sort: composite desc, reliability desc, wall_min asc, run_id asc
  results.sort((a, b) => {
    const ac = a.composite_raw;
    const bc = b.composite_raw;
    if (ac === null && bc !== null) return 1;
    if (ac !== null && bc === null) return -1;
    if (ac !== null && bc !== null && bc !== ac) return bc - ac;
    const ar = a.axes.reliability ?? -1;
    const br = b.axes.reliability ?? -1;
    if (br !== ar) return br - ar;
    const aw = a.efficiency.wall_min ?? Infinity;
    const bw = b.efficiency.wall_min ?? Infinity;
    if (aw !== bw) return aw - bw;
    return a.run_id.localeCompare(b.run_id);
  });

  return results;
}

/**
 * Builds the standalone shim script: site/gallery/shim/bench-host.js
 */
export function buildShimSource(paramsMap = {}, runsMetadata = {}) {
  const safeParamsJson = JSON.stringify(paramsMap);
  const safeRunsJson = JSON.stringify(runsMetadata);

  return `/**
 * MoL-Bench Gallery Shim (bench-host.js)
 * Implements window.__benchHost for live static gallery viewers,
 * offline-capable with deterministic Mulberry32 PRNG and performance clock.
 * Also injects a sleek, unobtrusive dismissible gallery bar.
 */
(function initBenchHostShim() {
  const ROOM_PARAMS = ${safeParamsJson};
  const RUNS_METADATA = ${safeRunsJson};

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
  const match = /[\\/](?:runs|anchors)[\\/]([^\\/]+)/i.exec(window.location.href);
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
      const curPath = window.location.pathname.replace(/\\\\/g, "/");
      const runsIdx = curPath.indexOf("/runs/");
      let backUrl = "../../index.html";
      if (runsIdx !== -1) {
        const afterRuns = curPath.slice(runsIdx + 6).split("/").filter(Boolean);
        backUrl = "../".repeat(afterRuns.length) + "index.html";
      }

      shadow.innerHTML = \`
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
          <a class="back-link" href="\${backUrl}">← Gallery</a>
          <span class="sep">|</span>
          <span class="title">\${modelLabel}</span>
          <span class="sub">(\${roomLabel})</span>
          <span class="score">\${scoreStr}</span>
          <button class="close-btn" id="close-btn" title="Dismiss overlay" type="button">✕</button>
        </div>
      \`;

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
`;
}

/**
 * Builds the Atelier Three.js GLTF viewer page.
 */
export function buildAtelierViewerHtml(run, glbRelPath, turntablePngs = []) {
  const modelLabel = run.model || "Atelier Run";
  const compositeScore = formatNum(run.composite);

  const turntableScrubberHtml = turntablePngs.length > 0
    ? `
    <div class="turntable-panel">
      <div class="turntable-title">Turntable Renders (360° Inspection)</div>
      <div class="turntable-view">
        <img id="turntable-img" src="${turntablePngs[0]}" alt="Turntable angle 0" />
      </div>
      <div class="turntable-controls">
        <label for="turntable-slider">Angle: <span id="turntable-val">0°</span></label>
        <input id="turntable-slider" type="range" min="0" max="${turntablePngs.length - 1}" value="0" />
      </div>
    </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Atelier 3D View — ${modelLabel}</title>
  <style>
    :root {
      --bg: #121316;
      --surface: #1b1c21;
      --text: #f0ede6;
      --muted: #9a968f;
      --accent: #f2b84b;
      --border: #2a2c34;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      overflow-x: hidden;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header.viewer-header {
      padding: 12px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .left-controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .back-btn {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
      font-size: 0.9rem;
    }
    .back-btn:hover { text-decoration: underline; }
    .title-group h1 {
      margin: 0;
      font-size: 1.15rem;
      font-weight: 700;
    }
    .title-group span {
      font-size: 0.82rem;
      color: var(--muted);
    }
    .score-badge {
      background: rgba(242, 184, 75, 0.18);
      color: var(--accent);
      padding: 4px 12px;
      border-radius: 999px;
      font-weight: 700;
      font-family: monospace;
    }
    .btn-anim {
      background: var(--accent);
      color: #121316;
      border: none;
      padding: 8px 16px;
      border-radius: 999px;
      font-weight: 700;
      cursor: pointer;
      font-size: 0.85rem;
      transition: transform 0.1s ease, filter 0.15s ease;
    }
    .btn-anim:hover { filter: brightness(1.1); }
    .btn-anim:active { transform: scale(0.97); }
    #canvas-container {
      flex: 1;
      width: 100%;
      height: 70vh;
      min-height: 480px;
      position: relative;
      background: radial-gradient(circle at center, #23252d 0%, #0f1013 100%);
    }
    #three-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(18, 19, 22, 0.85);
      color: var(--text);
      font-size: 0.95rem;
      transition: opacity 0.3s ease;
    }
    .turntable-panel {
      padding: 18px 20px 28px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .turntable-title {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .turntable-view img {
      max-width: 320px;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      display: block;
    }
    .turntable-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .turntable-controls input {
      width: 220px;
      cursor: pointer;
    }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "../../vendor/three.module.js",
      "three/addons/": "../../vendor/"
    }
  }
  </script>
</head>
<body>
  <header class="viewer-header">
    <div class="left-controls">
      <a class="back-btn" href="../../index.html">← Gallery</a>
      <div class="title-group">
        <h1>${modelLabel} · Atelier 3D Lantern</h1>
        <span>Room: atelier (build) · Run: ${run.run_id}</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <span class="score-badge">Score: ${compositeScore}</span>
      <button class="btn-anim" id="btn-toggle-anim" type="button">Play 'door_open' Animation</button>
    </div>
  </header>

  <div id="canvas-container">
    <canvas id="three-canvas"></canvas>
    <div id="loading" class="loading-overlay">
      <div>Loading 3D Lantern model…</div>
    </div>
  </div>

  ${turntableScrubberHtml}

  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from '../../vendor/GLTFLoader.js';
    import { OrbitControls } from '../../vendor/OrbitControls.js';

    const container = document.getElementById('canvas-container');
    const canvas = document.getElementById('three-canvas');
    const loadingEl = document.getElementById('loading');
    const btnAnim = document.getElementById('btn-toggle-anim');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15161a);

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(2.5, 1.8, 3.2);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Studio-like lighting setup
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x333340, 1.2);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfffaed, 2.2);
    keyLight.position.set(4, 6, 4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd4e4ff, 1.0);
    fillLight.position.set(-4, 3, -3);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffeedd, 0.8);
    rimLight.position.set(0, -3, -4);
    scene.add(rimLight);

    let mixer = null;
    let doorAction = null;
    let isPlaying = false;

    const loader = new GLTFLoader();
    loader.load(
      '${glbRelPath}',
      (gltf) => {
        const model = gltf.scene;
        scene.add(model);

        // Center and frame camera on object
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.5);

        controls.target.copy(center);
        camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 0.8, center.z + maxDim * 1.7);
        camera.lookAt(center);
        controls.update();

        // Setup door_open animation if available
        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          const clip = gltf.animations.find((c) => c.name === 'door_open') || gltf.animations[0];
          if (clip) {
            doorAction = mixer.clipAction(clip);
            doorAction.setLoop(THREE.LoopOnce);
            doorAction.clampWhenFinished = true;
          }
        }

        if (loadingEl) {
          loadingEl.style.opacity = '0';
          setTimeout(() => loadingEl.remove(), 300);
        }
      },
      undefined,
      (err) => {
        console.error('Failed to load lantern.glb:', err);
        if (loadingEl) loadingEl.textContent = 'Failed to load model file.';
      }
    );

    btnAnim.addEventListener('click', () => {
      if (!doorAction || !mixer) return;
      if (isPlaying) {
        doorAction.paused = true;
        isPlaying = false;
        btnAnim.textContent = "Resume 'door_open'";
      } else {
        if (doorAction.time >= doorAction.getClip().duration - 0.01) {
          doorAction.reset();
        }
        doorAction.paused = false;
        doorAction.play();
        isPlaying = true;
        btnAnim.textContent = "Pause 'door_open'";
      }
    });

    const clock = new THREE.Clock();
    function animate() {
      requestAnimationFrame(animate);
      const delta = clock.getDelta();
      if (mixer) mixer.update(delta);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    });

    // Turntable scrubber logic
    const turntableImg = document.getElementById('turntable-img');
    const turntableSlider = document.getElementById('turntable-slider');
    const turntableVal = document.getElementById('turntable-val');
    const turntablePngs = ${JSON.stringify(turntablePngs)};
    if (turntableSlider && turntableImg && turntablePngs.length > 0) {
      turntableSlider.addEventListener('input', (ev) => {
        const idx = Number(ev.target.value);
        if (turntablePngs[idx]) {
          turntableImg.src = turntablePngs[idx];
          turntableVal.textContent = Math.round((idx / turntablePngs.length) * 360) + '°';
        }
      });
    }
  </script>
</body>
</html>
`;
}

/**
 * Builds the Side-by-Side comparison viewer for renovation runs (e.g. lobby/r1).
 */
export function buildRenovationViewerHtml(run, requestsList = [], startIframeUrl = "", resultIframeUrl = "") {
  const modelLabel = run.model || "Renovation Run";
  const scoreStr = formatNum(run.composite);

  const reqsHtml = requestsList
    .map((r, i) => `
      <div class="req-item">
        <div class="req-head">
          <span class="req-id">${r.id}</span>
          <span class="req-weight">weight: ${r.weight || 1}</span>
        </div>
        <p class="req-text">${r.text_en || r.text || ""}</p>
      </div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Renovation Comparison — ${modelLabel}</title>
  <style>
    :root {
      --bg: #121110;
      --surface: #1c1a17;
      --surface-alt: #24221e;
      --text: #efece6;
      --muted: #a39e94;
      --border: #322f2a;
      --accent: #f2b84b;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header.renov-head {
      padding: 10px 18px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .head-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .back-btn {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
      font-size: 0.88rem;
    }
    .back-btn:hover { text-decoration: underline; }
    .title-group h1 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
    }
    .title-group span {
      font-size: 0.8rem;
      color: var(--muted);
    }
    .head-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .score-badge {
      background: rgba(242, 184, 75, 0.2);
      color: var(--accent);
      padding: 3px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-family: var(--mono);
      font-size: 0.85rem;
    }
    .toggle-btn {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
    }
    .toggle-btn.active {
      background: var(--accent);
      color: #121110;
      border-color: var(--accent);
    }
    .main-split {
      display: flex;
      flex: 1;
      height: calc(100vh - 56px);
      overflow: hidden;
    }
    .spec-drawer {
      width: 320px;
      min-width: 280px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      transition: width 0.2s ease, margin-left 0.2s ease;
    }
    .spec-drawer.collapsed {
      margin-left: -320px;
    }
    .drawer-head {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      font-weight: 700;
      font-size: 0.88rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-body {
      padding: 14px 16px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .req-item {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .req-head {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 0.78rem;
    }
    .req-id {
      font-weight: 700;
      color: var(--accent);
      font-family: var(--mono);
    }
    .req-weight { color: var(--muted); }
    .req-text {
      margin: 0;
      font-size: 0.84rem;
      line-height: 1.45;
    }
    .frames-container {
      flex: 1;
      display: flex;
      gap: 2px;
      background: var(--border);
      overflow: hidden;
    }
    .frame-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      overflow: hidden;
      transition: width 0.2s ease;
    }
    .pane-head {
      padding: 8px 14px;
      background: var(--surface-alt);
      border-bottom: 1px solid var(--border);
      font-size: 0.82rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .pane-tag {
      font-size: 0.74rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted);
    }
    .frame-wrapper {
      flex: 1;
      position: relative;
      display: flex;
      justify-content: center;
      background: #000;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #ffffff;
      display: block;
    }
    .mode-mobile iframe {
      width: 320px;
      height: 640px;
      margin: auto;
      border: 2px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    }
  </style>
</head>
<body>
  <header class="renov-head">
    <div class="head-left">
      <a class="back-btn" href="../../index.html">← Gallery</a>
      <div class="title-group">
        <h1>Renovation r1: Start Anchor vs Model Result</h1>
        <span>${modelLabel} · Score: ${scoreStr}</span>
      </div>
    </div>
    <div class="head-right">
      <button class="toggle-btn" id="btn-toggle-spec" type="button">Toggle Requests</button>
      <button class="toggle-btn" id="btn-desktop" type="button">Desktop</button>
      <button class="toggle-btn active" id="btn-mobile" type="button">Mobile (320px)</button>
      <span class="score-badge">Composite: ${scoreStr}</span>
    </div>
  </header>

  <div class="main-split">
    <aside class="spec-drawer" id="spec-drawer">
      <div class="drawer-head">
        <span>Renovation Requirements</span>
        <span style="font-size:0.75rem;color:var(--muted)">spec requests</span>
      </div>
      <div class="drawer-body">
        ${reqsHtml}
      </div>
    </aside>

    <div class="frames-container mode-mobile" id="frames-container">
      <div class="frame-pane">
        <div class="pane-head">
          <span>Start Version (Anchor a5)</span>
          <span class="pane-tag">Initial State</span>
        </div>
        <div class="frame-wrapper">
          <iframe id="start-iframe" src="${startIframeUrl}" title="Start anchor"></iframe>
        </div>
      </div>
      <div class="frame-pane">
        <div class="pane-head">
          <span>Model Result (${modelLabel})</span>
          <span class="pane-tag">Renovated</span>
        </div>
        <div class="frame-wrapper">
          <iframe id="result-iframe" src="${resultIframeUrl}" title="Model result"></iframe>
        </div>
      </div>
    </div>
  </div>

  <script>
    const container = document.getElementById('frames-container');
    const drawer = document.getElementById('spec-drawer');
    const btnToggleSpec = document.getElementById('btn-toggle-spec');
    const btnDesktop = document.getElementById('btn-desktop');
    const btnMobile = document.getElementById('btn-mobile');

    btnToggleSpec.addEventListener('click', () => {
      drawer.classList.toggle('collapsed');
      btnToggleSpec.classList.toggle('active', !drawer.classList.contains('collapsed'));
    });

    btnDesktop.addEventListener('click', () => {
      container.classList.remove('mode-mobile');
      btnDesktop.classList.add('active');
      btnMobile.classList.remove('active');
    });

    btnMobile.addEventListener('click', () => {
      container.classList.add('mode-mobile');
      btnMobile.classList.add('active');
      btnDesktop.classList.remove('active');
    });
  </script>
</body>
</html>
`;
}

/**
 * Builds the main Gallery index HTML page.
 */
export function buildGalleryIndexHtml(results = []) {
  const families = ["ALL", ...new Set(results.map((r) => r.model_family).filter(Boolean))].sort();
  const rooms = ["ALL", ...new Set(results.map((r) => r.room_key).filter(Boolean))].sort();

  const safeJson = JSON.stringify(results).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MoL-Bench Results Gallery — Museum of Light</title>
  <style>
    :root {
      --bg: #f6f4ef;
      --surface: #ffffff;
      --surface-alt: #f0ece3;
      --text: #161513;
      --muted: #5c574f;
      --border: #dfd8cb;
      --accent: #9a6b16;
      --accent-soft: rgba(154, 107, 22, 0.12);
      --ok: #157347;
      --ok-soft: rgba(21, 115, 71, 0.12);
      --shadow: 0 8px 24px rgba(22, 21, 19, 0.06);
      --radius: 12px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    html[data-theme="dark"] {
      --bg: #0e1014;
      --surface: #151921;
      --surface-alt: #1b212c;
      --text: #f3f1ec;
      --muted: #9da4b2;
      --border: #262e3d;
      --accent: #e5b75c;
      --accent-soft: rgba(229, 183, 92, 0.14);
      --ok: #34d399;
      --ok-soft: rgba(52, 211, 153, 0.14);
      --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: radial-gradient(1200px 420px at 15% -10%, var(--accent-soft), transparent 60%), var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }
    .container {
      max-width: 1240px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    header.hero {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 6px;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.6rem, 3vw, 2.25rem);
      letter-spacing: -0.02em;
      font-weight: 700;
    }
    .subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .btn:hover { border-color: var(--accent); }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 18px;
      box-shadow: var(--shadow);
    }
    .kpi-label {
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .kpi-value {
      font-size: 1.6rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .filter-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 20px;
      margin-bottom: 32px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .filter-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      min-width: 110px;
      font-weight: 700;
    }
    .filter-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .pill {
      border: 1px solid var(--border);
      background: var(--surface-alt);
      color: var(--muted);
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
    }
    .pill.active {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    html[data-theme="dark"] .pill.active { color: #101216; }
    .search-input {
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 0.875rem;
      min-width: 240px;
      flex: 1;
    }
    .group-section {
      margin-bottom: 40px;
    }
    .group-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 18px;
    }
    .group-header h2 {
      margin: 0;
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .group-count {
      color: var(--muted);
      font-size: 0.85rem;
    }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      border-color: var(--accent);
    }
    .card-thumb-wrap {
      width: 100%;
      height: 190px;
      background: var(--surface-alt);
      overflow: hidden;
      position: relative;
    }
    .card-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.25s ease;
    }
    .card:hover .card-thumb { transform: scale(1.02); }
    .card-track-badge {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(18, 17, 16, 0.85);
      color: #fff;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 3px 8px;
      border-radius: 999px;
      backdrop-filter: blur(4px);
    }
    .card-body {
      padding: 16px;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .card-title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .card-model {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
      line-height: 1.3;
    }
    .score-pill {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      font-family: var(--mono);
      font-size: 0.95rem;
      padding: 3px 10px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .card-runid {
      font-family: var(--mono);
      font-size: 0.76rem;
      color: var(--muted);
      margin-bottom: 12px;
      word-break: break-all;
    }
    .axes-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      padding: 10px;
      background: var(--surface-alt);
      border-radius: 8px;
      font-size: 0.76rem;
      margin-bottom: 14px;
      text-align: center;
    }
    .axis-label { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; margin-bottom: 2px; }
    .axis-val { font-weight: 700; font-family: var(--mono); }
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
    .wall-time {
      color: var(--muted);
      font-size: 0.8rem;
    }
    .btn-view {
      background: var(--accent);
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 999px;
      text-decoration: none;
      font-size: 0.84rem;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: filter 0.15s ease;
    }
    html[data-theme="dark"] .btn-view { color: #101216; }
    .btn-view:hover { filter: brightness(1.1); }
    .empty-state {
      padding: 40px;
      text-align: center;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    footer {
      margin-top: 48px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.82rem;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div>
        <div class="eyebrow">Museum of Light · Deterministic Benchmark</div>
        <h1>MoL-Bench Results Gallery</h1>
        <p class="subtitle" id="meta-line">What each agent actually built — live interactive rooms and 3D scenes.</p>
      </div>
      <div class="controls">
        <a class="btn" href="../leaderboard/">← Leaderboard</a>
        <button class="btn" id="theme-toggle" type="button">Toggle Theme</button>
      </div>
    </header>

    <div class="kpis" id="kpis"></div>

    <section class="filter-panel">
      <div class="filter-row">
        <span class="filter-title">Filter Room:</span>
        <div class="filter-pills" id="room-pills"></div>
      </div>
      <div class="filter-row">
        <span class="filter-title">Model Family:</span>
        <div class="filter-pills" id="family-pills"></div>
      </div>
      <div class="filter-row">
        <span class="filter-title">Search:</span>
        <input class="search-input" id="search-input" type="search" placeholder="Filter by model name, run ID, or room…" aria-label="Search runs" />
      </div>
    </section>

    <div id="gallery-content"></div>

    <footer>
      <span>All submissions run live with deterministic PRNG & host clock shims. Relative paths only.</span>
      <span>MoL-Bench Gallery</span>
    </footer>
  </div>

  <script>
    window.__GALLERY_DATA__ = ${safeJson};
  </script>
  <script>
    (function() {
      const root = document.documentElement;
      const savedTheme = localStorage.getItem("mol-gallery-theme");
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", savedTheme || (prefersDark ? "dark" : "light"));

      document.getElementById("theme-toggle").addEventListener("click", () => {
        const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        localStorage.setItem("mol-gallery-theme", next);
      });

      const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const fmt = (v) => v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(1);

      let state = {
        data: window.__GALLERY_DATA__ || [],
        room: "ALL",
        family: "ALL",
        query: ""
      };

      function renderKPIs() {
        const d = state.data;
        const totalRuns = d.length;
        const roomsSet = new Set(d.map(r => r.room_key));
        const modelsSet = new Set(d.map(r => r.model));
        const maxScore = d.reduce((max, r) => r.composite !== null ? Math.max(max, r.composite) : max, 0);

        document.getElementById("kpis").innerHTML = [
          ["Graded Runs", totalRuns],
          ["Rooms & Tracks", roomsSet.size],
          ["Models", modelsSet.size],
          ["Top Score", maxScore ? fmt(maxScore) : "—"]
        ].map(([lbl, val]) => '<div class="kpi"><div class="kpi-label">' + esc(lbl) + '</div><div class="kpi-value">' + esc(val) + '</div></div>').join("");
      }

      function renderFilters() {
        const d = state.data;
        const rooms = ["ALL", ...new Set(d.map(r => r.room_key))].sort();
        const families = ["ALL", ...new Set(d.map(r => r.model_family).filter(Boolean))].sort();

        const roomEl = document.getElementById("room-pills");
        roomEl.innerHTML = rooms.map(rk => {
          const cls = state.room === rk ? "pill active" : "pill";
          const label = rk === "ALL" ? "All Rooms" : rk;
          return '<button type="button" class="' + cls + '" data-val="' + esc(rk) + '">' + esc(label) + '</button>';
        }).join("");
        roomEl.querySelectorAll("button").forEach(b => {
          b.addEventListener("click", () => {
            state.room = b.getAttribute("data-val");
            renderFilters();
            renderGallery();
          });
        });

        const famEl = document.getElementById("family-pills");
        famEl.innerHTML = families.map(f => {
          const cls = state.family === f ? "pill active" : "pill";
          const label = f === "ALL" ? "All Families" : f;
          return '<button type="button" class="' + cls + '" data-val="' + esc(f) + '">' + esc(label) + '</button>';
        }).join("");
        famEl.querySelectorAll("button").forEach(b => {
          b.addEventListener("click", () => {
            state.family = b.getAttribute("data-val");
            renderFilters();
            renderGallery();
          });
        });
      }

      function renderGallery() {
        const wrap = document.getElementById("gallery-content");
        const q = state.query.trim().toLowerCase();

        const filtered = state.data.filter(r => {
          if (state.room !== "ALL" && r.room_key !== state.room) return false;
          if (state.family !== "ALL" && r.model_family !== state.family) return false;
          if (q) {
            const haystack = (r.model + " " + r.run_id + " " + r.room_key).toLowerCase();
            if (!haystack.includes(q)) return false;
          }
          return true;
        });

        if (filtered.length === 0) {
          wrap.innerHTML = '<div class="empty-state">No matching runs found for current filters.</div>';
          return;
        }

        // Group by room_key
        const groups = {};
        for (const r of filtered) {
          if (!groups[r.room_key]) groups[r.room_key] = [];
          groups[r.room_key].push(r);
        }

        let html = "";
        for (const rk of Object.keys(groups).sort()) {
          const list = groups[rk];
          const trackLabel = list[0]?.track === "renovation" ? "Renovation Side-by-Side" : "Build Track";
          html += '<section class="group-section">';
          html += '<div class="group-header"><h2>' + esc(rk) + '</h2><span class="group-count">' + list.length + ' run(s) · ' + esc(trackLabel) + '</span></div>';
          html += '<div class="cards-grid">';

          for (const run of list) {
            const thumbSrc = run.thumbnail || "previews/" + encodeURIComponent(run.run_id) + "/thumbnail.png";
            const wall = run.efficiency?.wall_min ? fmt(run.efficiency.wall_min) + " min" : "—";
            const liveUrl = "runs/" + encodeURIComponent(run.run_id) + "/";
            const viewText = run.room === "atelier" ? "3D Viewer →" : run.renovation ? "Compare Live →" : "View Live →";

            html += \`
              <article class="card">
                <div class="card-thumb-wrap">
                  <img class="card-thumb" src="\${esc(thumbSrc)}" alt="\${esc(run.model)} thumbnail" loading="lazy" onerror="this.src='../leaderboard/previews/\${esc(run.run_id)}/lobby_sheet_1.png'" />
                  <span class="card-track-badge">\${esc(run.track)}</span>
                </div>
                <div class="card-body">
                  <div class="card-title-row">
                    <h3 class="card-model">\${esc(run.model)}</h3>
                    <span class="score-pill">\${fmt(run.composite)}</span>
                  </div>
                  <div class="card-runid">\${esc(run.run_id)}</div>
                  <div class="axes-grid">
                    <div><div class="axis-label">Craft</div><div class="axis-val">\${fmt(run.axes.craft)}</div></div>
                    <div><div class="axis-label">Visual</div><div class="axis-val">\${fmt(run.axes.visual_quality)}</div></div>
                    <div><div class="axis-label">Revision</div><div class="axis-val">\${fmt(run.axes.revision)}</div></div>
                    <div><div class="axis-label">Reliable</div><div class="axis-val">\${fmt(run.axes.reliability)}</div></div>
                  </div>
                  <div class="card-footer">
                    <span class="wall-time">⏱ \${wall}</span>
                    <a class="btn-view" href="\${liveUrl}">\${viewText}</a>
                  </div>
                </div>
              </article>
            \`;
          }
          html += '</div></section>';
        }

        wrap.innerHTML = html;
      }

      document.getElementById("search-input").addEventListener("input", (e) => {
        state.query = e.target.value;
        renderGallery();
      });

      renderKPIs();
      renderFilters();
      renderGallery();
    })();
  </script>
</body>
</html>
`;
}

/**
 * Main Gallery Builder
 */
export async function buildGallery({
  repoRoot = DEFAULT_REPO_ROOT,
  resultsDir = path.join(DEFAULT_REPO_ROOT, "results"),
  siteDir = path.join(DEFAULT_REPO_ROOT, "site", "gallery"),
  publicSeed = 1
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedResultsDir = path.resolve(resultsDir);
  const resolvedSiteDir = path.resolve(siteDir);

  const safeWrite = (filePath, content) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return true;
    } catch {
      return false;
    }
  };

  const safeCopy = (src, dst) => {
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      return true;
    } catch {
      return false;
    }
  };

  // Clean up any temporary scratch files if they exist in site/gallery
  for (const scratch of ["test.txt", "test_subdir", "test_wf.html"]) {
    const p = path.join(resolvedSiteDir, scratch);
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      //
    }
  }

  // 1. Setup Vendor Directory (site/gallery/vendor/)
  const vendorDir = path.join(resolvedSiteDir, "vendor");
  const threeNodeModules = path.join(resolvedRepoRoot, "node_modules", "three");
  if (fs.existsSync(threeNodeModules)) {
    const threeModuleSrc = path.join(threeNodeModules, "build", "three.module.js");
    const threeCoreSrc = path.join(threeNodeModules, "build", "three.core.js");
    const gltfLoaderSrc = path.join(threeNodeModules, "examples", "jsm", "loaders", "GLTFLoader.js");
    const orbitControlsSrc = path.join(threeNodeModules, "examples", "jsm", "controls", "OrbitControls.js");
    const bufferGeoUtilsSrc = path.join(threeNodeModules, "examples", "jsm", "utils", "BufferGeometryUtils.js");

    if (fs.existsSync(threeModuleSrc)) safeCopy(threeModuleSrc, path.join(vendorDir, "three.module.js"));
    if (fs.existsSync(threeCoreSrc)) safeCopy(threeCoreSrc, path.join(vendorDir, "three.core.js"));
    if (fs.existsSync(orbitControlsSrc)) safeCopy(orbitControlsSrc, path.join(vendorDir, "OrbitControls.js"));
    if (fs.existsSync(bufferGeoUtilsSrc)) {
      safeCopy(bufferGeoUtilsSrc, path.join(vendorDir, "BufferGeometryUtils.js"));
      safeCopy(bufferGeoUtilsSrc, path.join(vendorDir, "utils", "BufferGeometryUtils.js"));
    }
    if (fs.existsSync(gltfLoaderSrc)) {
      // GLTFLoader imports '../utils/BufferGeometryUtils.js' (relative to examples/jsm/loaders); flatten it.
      fs.mkdirSync(vendorDir, { recursive: true });
      const src = fs.readFileSync(gltfLoaderSrc, "utf8").split("'../utils/BufferGeometryUtils.js'").join("'./utils/BufferGeometryUtils.js'");
      fs.writeFileSync(path.join(vendorDir, "GLTFLoader.js"), src);
    }
  }

  // 2. Generate params for all rooms for publicSeed
  const paramsDir = path.join(resolvedSiteDir, "params");
  const roomNames = ["lobby", "atelier", "restoration", "aurora"];
  const paramsMap = {};

  for (const rName of roomNames) {
    try {
      const p = await generateParams(rName, publicSeed, { hidden: false, repoRoot: resolvedRepoRoot });
      paramsMap[rName] = p;
      safeWrite(path.join(paramsDir, `${rName}.json`), JSON.stringify(p, null, 2) + "\n");
    } catch {
      paramsMap[rName] = { seed: publicSeed, hidden: false, room: rName };
    }
  }

  // 3. Setup renovation start anchors (site/gallery/anchors/<room>/a5/)
  const anchorsSrcDir = path.join(resolvedRepoRoot, "rooms");
  const anchorsDstDir = path.join(resolvedSiteDir, "anchors");
  if (fs.existsSync(anchorsSrcDir)) {
    for (const rName of ["lobby", "restoration", "atelier"]) {
      const a5Src = path.join(anchorsSrcDir, rName, "anchors", "a5");
      if (fs.existsSync(a5Src)) {
        const a5Dst = path.join(anchorsDstDir, rName, "a5");
        copyDirRecursive(a5Src, a5Dst, {
          skipList: ["tests", "public-tests", "node_modules", "report.json", "decisions.json"],
          patchHtmlFiles: true,
          shimRelativePath: "../../../../shim/bench-host.js"
        });
      }
    }
  }

  // 4. Load graded runs
  const gradedRuns = loadGradedResults(resolvedResultsDir);
  const runsMetadata = {};
  for (const r of gradedRuns) {
    runsMetadata[r.run_id] = {
      run_id: r.run_id,
      model: r.model,
      room: r.room,
      renovation: r.renovation,
      room_key: r.room_key,
      composite: r.composite
    };
  }

  // 5. Generate site/gallery/shim/bench-host.js
  const shimSrc = buildShimSource(paramsMap, runsMetadata);
  safeWrite(path.join(resolvedSiteDir, "shim", "bench-host.js"), shimSrc);

  // 6. Process each run: copy submission, patch HTML, thumbnails, viewers
  const runsDir = path.join(resolvedSiteDir, "runs");
  const previewsDir = path.join(resolvedSiteDir, "previews");

  for (const run of gradedRuns) {
    const runSubDir = path.join(resolvedResultsDir, "submissions", run.run_id);
    const runDstDir = path.join(runsDir, run.run_id);
    const runPreviewDstDir = path.join(previewsDir, run.run_id);

    // Resolve thumbnail
    let chosenThumbRel = null;
    const candidateThumbs = [];

    // Check leaderboard preview
    const lbPreviewDir = path.join(resolvedRepoRoot, "site", "leaderboard", "previews", run.run_id);
    if (fs.existsSync(lbPreviewDir)) {
      for (const f of fs.readdirSync(lbPreviewDir)) {
        if (f.toLowerCase().endsWith(".png")) candidateThumbs.push(path.join(lbPreviewDir, f));
      }
    }
    // Check collect frames
    const collectFramesDir = path.join(resolvedRepoRoot, "work", "collect", run.run_id, run.room, "frames");
    if (fs.existsSync(collectFramesDir)) {
      for (const f of fs.readdirSync(collectFramesDir)) {
        if (f.toLowerCase().endsWith(".png")) candidateThumbs.push(path.join(collectFramesDir, f));
      }
    }

    if (candidateThumbs.length > 0) {
      // Find a crisp frame under 400KB
      let bestThumb = candidateThumbs.find((p) => {
        try {
          const sz = fs.statSync(p).size;
          return sz > 10000 && sz <= 400 * 1024;
        } catch {
          return false;
        }
      }) || candidateThumbs[0];

      if (bestThumb && fs.existsSync(bestThumb)) {
        const thumbName = "thumbnail.png";
        safeCopy(bestThumb, path.join(runPreviewDstDir, thumbName));
        chosenThumbRel = `previews/${run.run_id}/${thumbName}`;
      }
    }
    run.thumbnail = chosenThumbRel || `../leaderboard/previews/${run.run_id}/lobby_sheet_1.png`;

    // Copy and prepare submission
    if (fs.existsSync(runSubDir)) {
      if (run.room === "atelier") {
        // Atelier Blender 3D viewer page
        const glbSrc = path.join(runSubDir, "out", "lantern.glb");
        const glbDst = path.join(runDstDir, "out", "lantern.glb");
        if (fs.existsSync(glbSrc)) safeCopy(glbSrc, glbDst);

        // Copy turntable frames if present
        const turntablePngsRel = [];
        if (fs.existsSync(collectFramesDir)) {
          const ttFiles = fs.readdirSync(collectFramesDir).filter((f) => /^turntable_\d+\.png$/i.test(f)).sort();
          for (const tt of ttFiles) {
            safeCopy(path.join(collectFramesDir, tt), path.join(runDstDir, "turntable", tt));
            turntablePngsRel.push(`turntable/${tt}`);
          }
        }

        const viewerHtml = buildAtelierViewerHtml(run, "out/lantern.glb", turntablePngsRel);
        safeWrite(path.join(runDstDir, "index.html"), viewerHtml);
      } else if (run.renovation) {
        // Renovation run: copy submission files (skip large/unused files)
        copyDirRecursive(runSubDir, runDstDir, {
          skipList: [
            "tests", "public-tests", "report.json", "decisions.json", "contract",
            "schemas", "work", "preview", "preview-final", "node_modules", ".git",
            "harness", "metrics3d", "rooms", ".run.json", ".bench-room"
          ],
          patchHtmlFiles: true,
          shimRelativePath: "../../../shim/bench-host.js"
        });

        // Load renovation requests from spec
        const renovSpecPath = path.join(resolvedRepoRoot, "rooms", run.room, "renovation", `${run.renovation}.json`);
        let requestsList = [];
        if (fs.existsSync(renovSpecPath)) {
          try {
            const specJson = JSON.parse(fs.readFileSync(renovSpecPath, "utf8"));
            if (Array.isArray(specJson.requests)) {
              requestsList = specJson.requests.map((r) => ({
                id: r.id,
                weight: r.weight,
                text_en: r.text?.en || "",
                text_ko: r.text?.ko || ""
              }));
            }
          } catch {
            //
          }
        }

        const startIframeUrl = `../../anchors/${run.room}/a5/lobby/index.html`;
        const resultIframeUrl = `./lobby/index.html`;
        const renovHtml = buildRenovationViewerHtml(run, requestsList, startIframeUrl, resultIframeUrl);
        safeWrite(path.join(runDstDir, "index.html"), renovHtml);
      } else {
        // Standard Web Room (lobby, restoration)
        copyDirRecursive(runSubDir, runDstDir, {
          skipList: [
            "tests", "public-tests", "report.json", "decisions.json", "contract",
            "schemas", "work", "preview", "preview-final", "node_modules", ".git",
            "harness", "metrics3d", "rooms", ".run.json", ".bench-room"
          ],
          patchHtmlFiles: true,
          shimRelativePath: "../../shim/bench-host.js"
        });

        // Deduplicate large vendor files if present (e.g. three.module.js in restoration)
        const vendorCopy = path.join(runDstDir, "room", "vendor", "three.module.js");
        const coreCopy = path.join(runDstDir, "room", "vendor", "three.core.js");
        if (fs.existsSync(vendorCopy)) {
          safeWrite(vendorCopy, 'export * from "../../../../vendor/three.module.js";\n');
          try {
            if (fs.existsSync(coreCopy)) fs.unlinkSync(coreCopy);
          } catch {
            //
          }
        }
      }
    }
  }

  // 7. Write Main Gallery Index
  const indexHtml = buildGalleryIndexHtml(gradedRuns);
  safeWrite(path.join(resolvedSiteDir, "index.html"), indexHtml);

  return {
    runsCount: gradedRuns.length,
    siteDir: resolvedSiteDir,
    resultsDir: resolvedResultsDir,
    runs: gradedRuns
  };
}

/**
 * Helper to recursively copy directories with filtering and HTML shim patching.
 */
function copyDirRecursive(srcDir, dstDir, opts = {}) {
  const skipList = new Set(opts.skipList || []);
  const patchHtmlFiles = Boolean(opts.patchHtmlFiles);

  function walk(currentSrc, currentDst) {
    if (!fs.existsSync(currentSrc)) return;
    const entries = fs.readdirSync(currentSrc, { withFileTypes: true });
    try {
      fs.mkdirSync(currentDst, { recursive: true });
    } catch {
      //
    }

    for (const entry of entries) {
      if (skipList.has(entry.name)) continue;
      if (entry.name.endsWith(".diff") || entry.name.endsWith(".blend") || entry.name.endsWith(".blend1")) continue;

      const srcPath = path.join(currentSrc, entry.name);
      const dstPath = path.join(currentDst, entry.name);

      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (entry.isFile()) {
        try {
          const sz = fs.statSync(srcPath).size;
          if (sz > 5 * 1024 * 1024) continue; // Skip files > 5MB

          if (patchHtmlFiles && entry.name.toLowerCase().endsWith(".html")) {
            const rawHtml = fs.readFileSync(srcPath, "utf8");
            // Determine relative depth to site/gallery/shim/bench-host.js
            const parts = currentDst.split(/[\\/]/);
            const galleryIdx = parts.lastIndexOf("gallery");
            let depth = 2;
            if (galleryIdx !== -1) {
              depth = Math.max(2, parts.length - 1 - galleryIdx);
            }
            const relativeShim = "../".repeat(depth) + "shim/bench-host.js";
            const patched = patchHtml(rawHtml, relativeShim);
            fs.writeFileSync(dstPath, patched, "utf8");
          } else {
            fs.copyFileSync(srcPath, dstPath);
          }
        } catch {
          // Ignore copy failures
        }
      }
    }
  }

  walk(srcDir, dstDir);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log("Usage: node harness/src/gallery.mjs [--results <dir>] [--site-dir <dir>]");
    return;
  }
  buildGallery({
    resultsDir: flags.results || path.join(DEFAULT_REPO_ROOT, "results"),
    siteDir: flags["site-dir"] || path.join(DEFAULT_REPO_ROOT, "site", "gallery")
  })
    .then((res) => {
      console.log(
        JSON.stringify(
          {
            success: true,
            runs: res.runsCount,
            gallery: path.join(res.siteDir, "index.html")
          },
          null,
          2
        )
      );
    })
    .catch((err) => {
      console.error(`Gallery build error: ${err.message}`);
      process.exit(1);
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
