/**
 * Room adapter for `restoration` ("The Broken Orrery Room").
 *
 * Leak-prevention guarantee:
 * This file is copied into contestant containers under `bench/rooms/restoration.mjs`.
 * It MUST NOT contain planted bug identities, hidden seeds, reference patch colors,
 * or root-cause mappings. All grading secrets are loaded dynamically from
 * `hidden/restoration/` (and unsanitized `rooms/restoration/spec.json`) when present,
 * and skipped gracefully when `hidden/` is absent (as in contestant `selfcheck`).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreMetric } from "../score.mjs";
import { checkScope } from "../gates.mjs";
import { evaluateRootCauseAccuracy } from "../report.mjs";

export const room = "restoration";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANET_COUNT = 7;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(seed, label) {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function loadHiddenGradeJson(repoRoot) {
  if (!repoRoot) return null;
  const p = path.join(repoRoot, "hidden", "restoration", "grade.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Deterministically generate room parameters (orbit phases & camera drift path) for a capture seed.
 */
export function generate(seed, { hidden = false, repoRoot = null } = {}) {
  const numSeed = Number(seed) || 1;
  const gen = mulberry32(hashLabel(numSeed, "orrery_params"));

  const orbitPhasesDeg = [];
  for (let idx = 0; idx < PLANET_COUNT; idx++) {
    orbitPhasesDeg.push(Number(((gen() * 280 + idx * 42) % 360).toFixed(4)));
  }

  const cameraPath = {
    basePosition: [0.25, 3.55, 7.35],
    baseTarget: [-0.45, 1.45, -0.45],
    driftAmp: [0.025, 0.012, 0.02],
    driftPhase: Number((gen() * Math.PI * 2).toFixed(4)),
    driftFreqHz: 0.08
  };

  const resolvedRoot = repoRoot || path.resolve(__dirname, "..", "..", "..");
  const hiddenGrade = loadHiddenGradeJson(resolvedRoot);
  const chartPatchesRef = Array.isArray(hiddenGrade?.chart_patches_ref_srgb)
    ? hiddenGrade.chart_patches_ref_srgb.map((rgb) => ({ srgb: rgb }))
    : undefined;

  return {
    seed: numSeed,
    hidden: Boolean(hidden),
    orbitPhasesDeg,
    cameraPath,
    ...(chartPatchesRef ? { chartPatchesRef } : {})
  };
}

function enrichManifestObjectWithHiddenAssets(manifest, repoRoot) {
  if (!manifest || typeof manifest !== "object") return false;
  const hiddenDir = path.join(repoRoot, "hidden", "restoration");
  if (!fs.existsSync(hiddenDir)) return false;

  const hiddenGrade = loadHiddenGradeJson(repoRoot);
  const refsDir = path.join(hiddenDir, "refs");
  const masksDir = path.join(hiddenDir, "masks");
  let changed = false;

  if (Array.isArray(hiddenGrade?.chart_patches_ref_srgb)) {
    const refPatches = hiddenGrade.chart_patches_ref_srgb.map((rgb) => ({ srgb: rgb }));
    manifest.params = manifest.params || {};
    for (const s of manifest.samples || []) {
      const sk = String(s.seed ?? 1);
      manifest.params[sk] = manifest.params[sk] || {};
      if (!manifest.params[sk].chartPatchesRef) {
        manifest.params[sk].chartPatchesRef = refPatches;
        changed = true;
      }
      if (!s.chart_patches_ref) {
        s.chart_patches_ref = refPatches;
        changed = true;
      }
    }
  }

  if (fs.existsSync(refsDir)) {
    manifest.refs = manifest.refs || {};
    for (const s of manifest.samples || []) {
      const candidateExact = path.join(refsDir, `${s.key}.png`);
      const fallbackNormalKey = `s${s.seed}_t${s.t}_${s.viewport}_${s.scheme || "light"}_normal`;
      const candidateNormal = path.join(refsDir, `${fallbackNormalKey}.png`);
      const chosen = fs.existsSync(candidateExact)
        ? candidateExact
        : fs.existsSync(candidateNormal)
          ? candidateNormal
          : null;
      if (chosen && s.ref_file !== chosen) {
        s.ref_file = chosen;
        manifest.refs[s.key] = chosen;
        changed = true;
      }
    }
  }

  if (fs.existsSync(masksDir)) {
    const ringsMask = path.join(masksDir, "rings.png");
    const decalMask = path.join(masksDir, "floor_decal.png");
    if (fs.existsSync(ringsMask)) {
      for (const s of manifest.samples || []) {
        if ((s.t === 1000 || s.t === 4000) && s.variant === "normal" && !s.mask) {
          s.mask = ringsMask;
          changed = true;
        }
      }
    }
    if (fs.existsSync(decalMask)) {
      for (const seq of manifest.sequences || []) {
        if (seq.variant === "camera_drift" && !seq.mask) {
          seq.mask = decalMask;
          changed = true;
        }
      }
    }
  }

  return changed;
}

function enrichManifestWithHiddenAssets(manifestPath, repoRoot) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const changed = enrichManifestObjectWithHiddenAssets(manifest, repoRoot);
  if (changed) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  return changed;
}

async function runBrowserLifecycleAndClockProbes(page, seeds = [1]) {
  const probeOut = {};
  const seed = seeds[0] ?? 1;

  // 1. 30-cycle lifecycle + single_step probe
  try {
    const lifeRes = await page.evaluate(async (s) => {
      window.__bench.setSeed(s);
      window.__bench.seek(1000);
      await window.__bench.renderFrame();
      const container = document.getElementById("orrery-stage") || document.body;

      // Cycle 1 baseline
      await window.__bench.unmount();
      const detachedOnUnmount = container.querySelector("canvas") === null;
      await window.__bench.mount(container);
      const firstStats = window.__bench.stats();
      const firstHostListeners =
        typeof window.__benchHostControl?.getListenerCount === "function"
          ? window.__benchHostControl.getListenerCount()
          : (firstStats.listeners ?? 0);
      const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;

      for (let i = 1; i < 30; i++) {
        await window.__bench.unmount();
        await window.__bench.mount(container);
      }
      const finalStats = window.__bench.stats();
      const finalHostListeners =
        typeof window.__benchHostControl?.getListenerCount === "function"
          ? window.__benchHostControl.getListenerCount()
          : (finalStats.listeners ?? 0);
      const heap30 = performance.memory ? performance.memory.usedJSHeapSize : 0;

      const beforeFocus = window.__bench.state().focusedIndex;
      const btn = document.querySelector('[data-bench="next-planet"]');
      if (btn) btn.click();
      const afterFocus = window.__bench.state().focusedIndex;
      const focusDelta = ((afterFocus - beforeFocus) % 7 + 7) % 7;

      const resourceBaseline =
        detachedOnUnmount &&
        finalStats.geometries === firstStats.geometries &&
        finalStats.textures === firstStats.textures &&
        (finalStats.programs ?? 0) === (firstStats.programs ?? 0);

      const listenerBaseline =
        detachedOnUnmount &&
        finalHostListeners === firstHostListeners &&
        (finalStats.listeners ?? 0) === (firstStats.listeners ?? 0);
      const rawHeapMb = Math.max(0, (heap30 - heap1) / (1024 * 1024));
      const leakedGeoms = Math.max(0, (finalStats.geometries ?? 0) - (firstStats.geometries ?? 0));
      const heapGrowthMb = !resourceBaseline ? Math.max(rawHeapMb, leakedGeoms * 0.065, 35) : Math.min(rawHeapMb, 0.5);
      const singleStep = detachedOnUnmount && focusDelta === 1;

      return {
        resourceBaseline,
        listenerBaseline,
        heapGrowthMb,
        singleStep
      };
    }, seed);

    probeOut[`lifecycle_30_s${seed}`] = {
      metrics: {
        "mem.resource_baseline": lifeRes.resourceBaseline,
        "mem.heap_growth_mb": lifeRes.heapGrowthMb,
        "mem.listener_baseline": lifeRes.listenerBaseline,
        "interact.single_step": lifeRes.singleStep
      }
    };
  } catch {
    // ignore if page is already closed
  }

  // 2. anim.clock_independence (30 Hz vs 144 Hz over 5000 ms clock)
  try {
    const clockDiff = await page.evaluate(async (s) => {
      async function measureLiveAngleAtHz(hz) {
        const totalMs = 5000;
        const steps = Math.round((totalMs / 1000) * hz);
        const dt = totalMs / steps;
        const callbacks = [];
        const origRaf = window.requestAnimationFrame;
        const origCaf = window.cancelAnimationFrame;
        const canvas = document.querySelector("canvas");
        const gl = canvas ? (canvas.getContext("webgl2") || canvas.getContext("webgl")) : null;
        const origDrawElements = gl ? gl.drawElements : null;
        const origDrawArrays = gl ? gl.drawArrays : null;
        window.requestAnimationFrame = (cb) => {
          callbacks.push(cb);
          return callbacks.length;
        };
        window.cancelAnimationFrame = () => {};
        try {
          window.__bench.setSeed(s);
          window.__bench.seek(0);
          window.__bench.resume();
          if (callbacks.length === 0) {
            const container = document.getElementById("orrery-stage") || document.body;
            await window.__bench.unmount();
            await window.__bench.mount(container);
            window.__bench.setSeed(s);
            window.__bench.seek(0);
            window.__bench.resume();
          }
          if (gl) {
            gl.drawElements = () => {};
            gl.drawArrays = () => {};
          }
          for (let i = 1; i <= steps; i++) {
            const tNow = i * dt;
            if (typeof window.__benchHostControl?.setVirtualClock === "function") {
              window.__benchHostControl.setVirtualClock(tNow);
            }
            if (typeof window.__benchHost?.clock?._set === "function") {
              window.__benchHost.clock._set(tNow);
            }
            const batch = callbacks.splice(0, callbacks.length);
            for (const fn of batch) {
              fn(tNow);
            }
          }
          const angle = window.__bench.state().orbitAngleDeg ?? 0;
          return angle;
        } finally {
          if (gl && origDrawElements) gl.drawElements = origDrawElements;
          if (gl && origDrawArrays) gl.drawArrays = origDrawArrays;
          window.requestAnimationFrame = origRaf;
          window.cancelAnimationFrame = origCaf;
        }
      }

      const a30 = await measureLiveAngleAtHz(30);
      const a144 = await measureLiveAngleAtHz(144);
      if (typeof window.__benchHostControl?.freeze === "function") {
        window.__benchHostControl.freeze(1000);
      }
      await window.__bench.seek(1000);
      await window.__bench.renderFrame();
      const rawDiff = Math.abs(a30 - a144) % 360;
      return Math.min(rawDiff, 360 - rawDiff);
    }, seed);

    probeOut[`raf_clock_s${seed}`] = {
      metrics: {
        "anim.clock_independence": clockDiff
      }
    };
  } catch {
    // ignore
  }

  return probeOut;
}

export async function extraCapture(ctx) {
  if (!ctx) return;
  const repoRoot = ctx.repoRoot || path.resolve(__dirname, "..", "..", "..");

  let ownedHandle = null;
  let page = ctx.page || null;
  try {
    if (!page && (typeof ctx.openPage === "function" || ctx.browserSession)) {
      const seed0 = ctx.spec?.capture?.public_seeds?.[0] ?? 1;
      const params0 =
        typeof ctx.getParams === "function"
          ? ctx.getParams(seed0, "normal")
          : generate(seed0, { hidden: ctx.hidden, repoRoot });
      if (typeof ctx.openPage === "function") {
        ownedHandle = await ctx.openPage({
          viewport: "1440x900",
          dpr: 1,
          colorScheme: "light",
          seed: seed0,
          params: params0
        });
      } else {
        ownedHandle = await ctx.browserSession.newPage({
          origin: ctx.origin,
          url: ctx.url,
          localResolver: ctx.localResolver || null,
          viewport: "1440x900",
          dpr: 1,
          colorScheme: "light",
          seed: seed0,
          params: params0
        });
      }
      page = ownedHandle.page;
    }

    if (page && ctx.manifest && Array.isArray(ctx.manifest.samples)) {
      // 1. Populate sample.state (chartPatches, focusedCenter, focusedMaskColor) for existing samples
      for (const s of ctx.manifest.samples) {
        if (!s.state && s.viewport === "1440x900" && (s.dpr ?? 1) === 1) {
          const st = await page.evaluate(
            async ({ seedVal, tVal }) => {
              if (typeof window.__benchHostControl?.freeze === "function") {
                window.__benchHostControl.freeze(tVal);
              }
              window.__bench.setSeed(seedVal);
              window.__bench.seek(tVal);
              await window.__bench.renderFrame();
              return window.__bench.state();
            },
            { seedVal: s.seed ?? 1, tVal: s.t ?? 1000 }
          );
          s.state = st;
        }
      }

      // 2. Capture resize_seq frame (1440x900 -> 768x1024 -> 1200x700) for shape.circularity if not yet captured
      const hasResizeSample = ctx.manifest.samples.some((s) => s.variant === "resize_seq" || s.step === "resize_seq");
      if (!hasResizeSample && ctx.workDir) {
        const seed0 = ctx.spec?.capture?.public_seeds?.[0] ?? 1;
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await page.setViewportSize({ width: 768, height: 1024 });
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await page.setViewportSize({ width: 1200, height: 700 });
        const resizeState = await page.evaluate(async (sVal) => {
          if (typeof window.__benchHostControl?.freeze === "function") {
            window.__benchHostControl.freeze(1000);
          }
          window.__bench.setSeed(sVal);
          window.dispatchEvent(new Event("resize"));
          window.__bench.seek(1000);
          await window.__bench.renderFrame();
          return window.__bench.state();
        }, seed0);
        const relFile = `frames/resize_seq_s${seed0}_1200x700.png`;
        const absFile = path.join(ctx.workDir, relFile);
        await page.screenshot({ path: absFile });
        ctx.manifest.samples.push({
          key: `resize_seq_s${seed0}_1200x700`,
          seed: seed0,
          t: 1000,
          viewport: "1200x700",
          scheme: "light",
          variant: "resize_seq",
          step: "resize_seq",
          dpr: 1,
          file: relFile,
          state: resizeState
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      }
    }

    if (page) {
      const hasLifecycle =
        ctx.probes &&
        Object.values(ctx.probes).some(
          (p) => p?.metrics?.["mem.resource_baseline"] !== undefined || p?.["mem.resource_baseline"] !== undefined
        );
      if (!hasLifecycle) {
        const extraProbes = await runBrowserLifecycleAndClockProbes(page, ctx.seeds || [1]);
        if (ctx.probes && typeof ctx.probes === "object") {
          Object.assign(ctx.probes, extraProbes);
        }
      }
    }
  } finally {
    if (ownedHandle) {
      if (typeof ctx.collectLogs === "function") {
        ctx.collectLogs(ownedHandle);
      }
      await ownedHandle.close();
    }
  }

  if (ctx.manifest) {
    enrichManifestObjectWithHiddenAssets(ctx.manifest, repoRoot);
  }
  if (ctx.manifestPath) {
    enrichManifestWithHiddenAssets(ctx.manifestPath, repoRoot);
  }
}

function buildFlatBugMap(bugPool) {
  const map = new Map();
  if (!bugPool || typeof bugPool !== "object") return map;
  for (const [category, list] of Object.entries(bugPool)) {
    for (const bug of list || []) {
      map.set(bug.id, { ...bug, category });
    }
  }
  return map;
}

function detectVariantSeedAndBugs(submissionDir, spec, hiddenGrade) {
  const bugMap = buildFlatBugMap(spec?.bug_pool);
  if (bugMap.size === 0 || !hiddenGrade?.variants) {
    return { variantSeed: null, plantedBugs: null };
  }

  // 1. Check .run.json if present
  const runJsonPath = path.join(submissionDir, ".run.json");
  if (fs.existsSync(runJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      if (Number.isInteger(meta.seed)) {
        const idx = (((meta.seed - 1) % 16) + 16) % 16 + 1;
        const ids = hiddenGrade.variants[String(idx)];
        if (Array.isArray(ids)) {
          return {
            variantSeed: meta.seed,
            plantedBugs: ids.map((id) => bugMap.get(id)).filter(Boolean)
          };
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Match PROMPT.md visitor reports if present
  const promptPath = path.join(submissionDir, "PROMPT.md");
  if (fs.existsSync(promptPath)) {
    const text = fs.readFileSync(promptPath, "utf8");
    const matches = [...text.matchAll(/Report\s+`(B\d+)`/g)].map((m) => m[1]);
    if (matches.length === 4) {
      for (const [seedStr, ids] of Object.entries(hiddenGrade.variants)) {
        if (Array.isArray(ids) && ids.length === 4 && ids.every((id, i) => id === matches[i])) {
          return {
            variantSeed: Number(seedStr),
            plantedBugs: ids.map((id) => bugMap.get(id)).filter(Boolean)
          };
        }
      }
    }
  }

  // 3. Default to seed 1 (used by seed/, anchors/a5, anchors/a8, attacks/*)
  const defaultIds = hiddenGrade.variants["1"] || [];
  return {
    variantSeed: 1,
    plantedBugs: defaultIds.map((id) => bugMap.get(id)).filter(Boolean)
  };
}

function safeMkdirSync(dirPath) {
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved)) return;
  const toCreate = [];
  let cur = resolved;
  while (cur && !fs.existsSync(cur)) {
    toCreate.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (let i = toCreate.length - 1; i >= 0; i--) {
    fs.mkdirSync(toCreate[i]);
  }
}

function copyDirSafe(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  safeMkdirSync(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirSafe(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

async function ensureCachedSeedVariant(variantSeed, repoRoot) {
  const seedDir = path.join(repoRoot, "rooms", "restoration", "seed");
  if (variantSeed === 1 && fs.existsSync(path.join(seedDir, "room", "src", "orrery.js"))) {
    return seedDir;
  }
  const cacheDir = path.join(repoRoot, "work", "mol_restoration_variants", `seed_${variantSeed}`);
  if (fs.existsSync(path.join(cacheDir, "room", "src", "orrery.js"))) {
    return cacheDir;
  }
  const builderPath = path.join(repoRoot, "rooms", "restoration", "build-variant.mjs");
  if (!fs.existsSync(builderPath)) {
    return fs.existsSync(seedDir) ? seedDir : null;
  }
  const { buildVariant } = await import(pathToFileURL(builderPath).href);
  safeMkdirSync(cacheDir);
  buildVariant({ seed: variantSeed, outDir: cacheDir, repoRoot });
  return cacheDir;
}

const IGNORED_TOP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "bench",
  "metrics",
  "schemas",
  "contract",
  "work",
  "preview",
  "public-tests"
]);

const IGNORED_TOP_FILES = new Set([
  ".bench-room",
  ".run.json",
  "package.json",
  "PROMPT.md",
  "selfcheck.json"
]);

function walkRelativeFiles(baseDir, relDir = "") {
  const out = [];
  const curDir = relDir ? path.join(baseDir, relDir) : baseDir;
  if (!fs.existsSync(curDir)) return out;
  for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (!relDir) {
      if (entry.isDirectory() && IGNORED_TOP_DIRS.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_TOP_FILES.has(entry.name)) continue;
    }
    if (entry.name === ".gitkeep" || entry.name === ".keep") continue;
    if (entry.isDirectory()) {
      out.push(...walkRelativeFiles(baseDir, relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Compute Myers/LCS line diff count (added + removed lines) between two strings.
 */
function countChangedLines(oldText, newText) {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const stride = m + 1;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * stride + j];
        const left = dp[i * stride + (j - 1)];
        dp[i * stride + j] = up >= left ? up : left;
      }
    }
  }
  const lcs = dp[n * stride + m];
  return (n - lcs) + (m - lcs);
}

function computeDiffMetrics(submissionDir, seedVariantDir, plantedBugs, spec) {
  const subFiles = walkRelativeFiles(submissionDir);
  const seedFiles = new Set(walkRelativeFiles(seedVariantDir));
  const changedFiles = [];

  for (const rel of subFiles) {
    const subPath = path.join(submissionDir, rel);
    const seedPath = path.join(seedVariantDir, rel);
    if (!fs.existsSync(seedPath)) {
      changedFiles.push(rel);
    } else {
      const b1 = fs.readFileSync(subPath);
      const b2 = fs.readFileSync(seedPath);
      if (!b1.equals(b2)) {
        changedFiles.push(rel);
      }
    }
  }
  for (const rel of seedFiles) {
    if (!fs.existsSync(path.join(submissionDir, rel))) {
      changedFiles.push(rel);
    }
  }

  const scopeCheck = checkScope(changedFiles, spec.scope || []);

  const srcFiles = new Set(
    [...subFiles, ...seedFiles].filter((f) => f.startsWith("room/src/"))
  );
  let totalChangedLines = 0;
  for (const rel of srcFiles) {
    const subPath = path.join(submissionDir, rel);
    const seedPath = path.join(seedVariantDir, rel);
    const oldText = fs.existsSync(seedPath) ? fs.readFileSync(seedPath, "utf8") : "";
    const newText = fs.existsSync(subPath) ? fs.readFileSync(subPath, "utf8") : "";
    if (oldText !== newText) {
      totalChangedLines += countChangedLines(oldText, newText);
    }
  }

  const denom = (plantedBugs || []).reduce((acc, b) => acc + (Number(b.ref_fix_lines) || 1), 0) || 16;
  const changeRatio = totalChangedLines === 0 ? 100 : totalChangedLines / denom;

  return {
    outOfScopeCount: scopeCheck.outOfScopeCount,
    changeRatio,
    totalChangedLines,
    denom
  };
}

function evaluateRedGreenTests(submissionDir, seedVariantDir, plantedBugs, report, repoRoot) {
  if (!Array.isArray(plantedBugs) || plantedBugs.length === 0) return null;
  const reportedBugs = report?.room?.bugs || [];
  let passedCount = 0;

  for (let idx = 0; idx < plantedBugs.length; idx++) {
    const bug = plantedBugs[idx];
    const altId = `R${idx + 1}`;
    const entry = reportedBugs.find((r) => r.report_id === bug.id || r.report_id === altId);
    if (!entry || typeof entry.test !== "string" || !entry.test.trim()) continue;

    const relTestPath = entry.test.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relTestPath.startsWith("tests/regression/")) continue;

    const subTestFile = path.join(submissionDir, relTestPath);
    if (!fs.existsSync(subTestFile) || !fs.statSync(subTestFile).isFile()) continue;

    const testContent = fs.readFileSync(subTestFile, "utf8");
    const matchId = testContent.includes(bug.id) ? bug.id : testContent.includes(altId) ? altId : null;
    if (!matchId) continue;

    // 1. Run on submissionDir -> MUST PASS (Green)
    const greenRun = spawnSync(
      process.execPath,
      ["--test", `--test-name-pattern=${matchId}`, subTestFile],
      {
        cwd: submissionDir,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, MOL_TARGET_DIR: submissionDir }
      }
    );
    if (greenRun.status !== 0) continue;

    // 2. Apply only agent's test files onto a temporary copy of seedVariantDir -> MUST FAIL (Red)
    const workTmpRoot = path.join(repoRoot, "work");
    safeMkdirSync(workTmpRoot);
    const tmpSeedDir = fs.mkdtempSync(path.join(workTmpRoot, "mol-rg-"));
    try {
      copyDirSafe(path.join(seedVariantDir, "room", "src"), path.join(tmpSeedDir, "room", "src"));
      copyDirSafe(path.join(submissionDir, "tests", "regression"), path.join(tmpSeedDir, "tests", "regression"));
      const seedTestFile = path.join(tmpSeedDir, relTestPath);
      const redRun = spawnSync(
        process.execPath,
        ["--test", `--test-name-pattern=${matchId}`, seedTestFile],
        {
          cwd: tmpSeedDir,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, MOL_TARGET_DIR: tmpSeedDir }
        }
      );
      if (redRun.status !== 0 && redRun.status !== null) {
        passedCount += 1;
      }
    } finally {
      fs.rmSync(tmpSeedDir, { recursive: true, force: true });
    }
  }

  return {
    passed: passedCount,
    total: plantedBugs.length
  };
}

function findPythonExecutable(repoRoot) {
  const winVenv = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winVenv)) return winVenv;
  const unixVenv = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(unixVenv)) return unixVenv;
  return "python";
}

function rerunPythonMetricsIfNeeded(manifestPath, specPath, workDir, repoRoot, rawMetrics) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return;
  const enriched = enrichManifestWithHiddenAssets(manifestPath, repoRoot);
  const neededIds = ["ref.flip", "ref.lum_delta", "color.patch_delta", "time.flicker_region", "render.stripe_energy", "shape.circularity"];
  const missingAny = neededIds.some((id) => !(id in rawMetrics));
  if (!enriched && !missingAny) return;

  const py = findPythonExecutable(repoRoot);
  const metricsPkgDir = path.join(repoRoot, "metrics");
  const pythonPath = [metricsPkgDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const outPath = path.join(workDir, "metrics_restoration.json");
  try {
    execFileSync(py, ["-m", "molmetrics", "compute", "--manifest", manifestPath, "--spec", specPath, "--out", outPath], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (fs.existsSync(outPath)) {
      const pyMetrics = JSON.parse(fs.readFileSync(outPath, "utf8"));
      Object.assign(rawMetrics, pyMetrics);
    }
  } catch {
    // degrade gracefully if python metrics cannot re-run
  }
}

export async function diffDenominator(ctx = {}) {
  const repoRoot = ctx.repoRoot || path.resolve(__dirname, "..", "..", "..");
  const hiddenGrade = loadHiddenGradeJson(repoRoot);
  if (!hiddenGrade) return null;

  const specPath = path.join(repoRoot, "rooms", "restoration", "spec.json");
  let fullSpec = ctx.spec || null;
  if ((!fullSpec || !fullSpec.bug_pool) && fs.existsSync(specPath)) {
    try {
      fullSpec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    } catch {
      // ignore
    }
  }

  let { plantedBugs } = detectVariantSeedAndBugs(ctx.submissionDir || "", fullSpec, hiddenGrade);
  if ((!plantedBugs || plantedBugs.length === 0) && ctx.startDir) {
    ({ plantedBugs } = detectVariantSeedAndBugs(ctx.startDir, fullSpec, hiddenGrade));
  }
  if (!plantedBugs || plantedBugs.length === 0) return null;

  const refLinesMap = hiddenGrade.ref_fix_lines || {};
  return plantedBugs.reduce(
    (sum, b) => sum + (Number(refLinesMap[b.id] ?? b.ref_fix_lines) || 1),
    0
  );
}

export async function extraMetrics(ctx, rawMetrics) {
  if (!ctx || !rawMetrics) return;
  const submissionDir = ctx.submissionDir;
  const repoRoot = ctx.repoRoot || path.resolve(__dirname, "..", "..", "..");
  const spec = ctx.spec;
  const staticRes = ctx.staticRes;
  const captureRes = ctx.captureRes;
  const noPython = ctx.noPython;
  const workDir = ctx.workDir;
  const manifestPath = ctx.manifestPath || captureRes?.manifestPath;

  // 1. If capture produced a manifest, ensure hidden refs/masks/chartPatchesRef are linked
  if (!noPython && manifestPath) {
    rerunPythonMetricsIfNeeded(manifestPath, spec._specPath, workDir, repoRoot, rawMetrics);
  }

  // 2. Load hidden grading data if present (absent inside contestant selfcheck containers)
  const hiddenGrade = loadHiddenGradeJson(repoRoot);
  let fullSpec = spec;
  if ((!fullSpec || !fullSpec.bug_pool) && fs.existsSync(path.join(repoRoot, "rooms", "restoration", "spec.json"))) {
    try {
      fullSpec = JSON.parse(fs.readFileSync(path.join(repoRoot, "rooms", "restoration", "spec.json"), "utf8"));
    } catch {
      // ignore
    }
  }
  if (!hiddenGrade || !fullSpec?.bug_pool) {
    return;
  }

  const { variantSeed, plantedBugs } = detectVariantSeedAndBugs(submissionDir, fullSpec, hiddenGrade);
  if (!plantedBugs || plantedBugs.length === 0) {
    return;
  }

  const seedVariantDir = await ensureCachedSeedVariant(variantSeed, repoRoot);

  // 3. diff.out_of_scope_files and diff.change_ratio (compute against seedVariantDir if not already computed via --start)
  if (seedVariantDir && fs.existsSync(seedVariantDir)) {
    if (rawMetrics._diffError || !("diff.change_ratio" in rawMetrics)) {
      const diffRes = computeDiffMetrics(submissionDir, seedVariantDir, plantedBugs, fullSpec);
      rawMetrics["diff.out_of_scope_files"] = diffRes.outOfScopeCount;
      rawMetrics["diff.change_ratio"] = diffRes.changeRatio;
      delete rawMetrics._diffError;
    }
  }

  // 4. rootcause.accuracy
  let report = staticRes?.report || null;
  if (!report && submissionDir && fs.existsSync(path.join(submissionDir, "report.json"))) {
    try {
      report = JSON.parse(fs.readFileSync(path.join(submissionDir, "report.json"), "utf8"));
    } catch {
      report = null;
    }
  }
  const rcAcc = evaluateRootCauseAccuracy(report, plantedBugs);
  if (rcAcc !== null) {
    const matches = Math.round(rcAcc * plantedBugs.length);
    rawMetrics["rootcause.accuracy"] = { passed: matches, total: plantedBugs.length };
  }

  // 5. tests.redgreen
  if (seedVariantDir && fs.existsSync(seedVariantDir)) {
    const rgRes = evaluateRedGreenTests(submissionDir, seedVariantDir, plantedBugs, report, repoRoot);
    if (rgRes) {
      rawMetrics["tests.redgreen"] = rgRes;
    }
  }

  // 6. bugs.fixed (mean over the 4 planted bugs of each bug's weighted metric score from bug_pool)
  const bugScores = [];
  for (const bug of plantedBugs) {
    let wSum = 0;
    let wsSum = 0;
    for (const bm of bug.metrics || []) {
      if (!(bm.id in rawMetrics) || rawMetrics[bm.id] === null || rawMetrics[bm.id] === undefined) {
        continue;
      }
      const scored = scoreMetric(bm, rawMetrics[bm.id]);
      if (scored.score !== null && scored.score !== undefined) {
        wSum += bm.weight;
        wsSum += bm.weight * scored.score;
      }
    }
    if (wSum > 0) {
      bugScores.push(wsSum / wSum);
    }
  }

  if (bugScores.length > 0) {
    const meanBugScore = bugScores.reduce((a, b) => a + b, 0) / bugScores.length;
    rawMetrics["bugs.fixed"] = meanBugScore;
  }
}
