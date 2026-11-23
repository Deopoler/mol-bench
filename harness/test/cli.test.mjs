import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { gradeSubmission, generatePreviewContactSheets } from "../src/cli.mjs";
import { unregisterMetrics } from "../src/registry.mjs";
import { openRoom } from "../src/testing/room-harness.mjs";
import { discoverProbes, listProbes } from "../src/capture/probes/index.js";
import { getFontManifest, verifyVendoredFonts, copyFontsTo } from "../fonts/loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "harness", "src", "cli.mjs");
const MOCK_AURORA = path.join(__dirname, "data", "mock-aurora");

test("CLI grade aurora rooms/aurora --no-capture --no-python --lenient prints valid JSON", () => {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, "grade", "aurora", "rooms/aurora", "--no-capture", "--no-python", "--lenient"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const res = JSON.parse(stdout);
  assert.equal(res.room, "aurora");
  assert.equal(res.track, "build");
  assert.equal(res.seeds, "public");
  assert.equal(res.gates["G-report"].pass, false);
  assert.equal(res.gates["G-load"].pass, null);
  assert.equal(res.axes.craft, null);
  assert.equal(res.axes.visual_quality, null);
  assert.equal(res.axes.reliability, 0);
  assert.equal(res.composite, null);
});

test("gradeSubmission on mock-aurora with valid report.json computes reliability = 10", async () => {
  const res = await gradeSubmission({
    room: "aurora",
    submissionDir: MOCK_AURORA,
    noCapture: true,
    noPython: true,
    repoRoot: REPO_ROOT
  });
  assert.equal(res.gates["G-report"].pass, true);
  assert.equal(res.axes.reliability, 10);
});

test("CLI selfcheck reads .bench-room and writes selfcheck.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-selfcheck-"));
  try {
    fs.cpSync(MOCK_AURORA, tmpDir, { recursive: true });
    const stdout = execFileSync(
      process.execPath,
      [CLI_PATH, "selfcheck", "--dir", tmpDir, "--no-capture", "--no-python"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.match(stdout, /MoL-Bench selfcheck: aurora/);
    const outFile = path.join(tmpDir, "selfcheck.json");
    assert.equal(fs.existsSync(outFile), true);
    const saved = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(saved.seeds, "public");
    assert.equal(saved.axes.reliability, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generatePreviewContactSheets builds contact sheet PNG from manifest", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-preview-"));
  try {
    const framesDir = path.join(tmpDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const png = new PNG({ width: 16, height: 16 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 40;
      png.data[i + 1] = 200;
      png.data[i + 2] = 140;
      png.data[i + 3] = 255;
    }
    fs.writeFileSync(path.join(framesDir, "s1.png"), PNG.sync.write(png));
    fs.writeFileSync(path.join(framesDir, "s2.png"), PNG.sync.write(png));
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        room: "aurora",
        samples: [
          { key: "s1", file: "frames/s1.png" },
          { key: "s2", file: "frames/s2.png" }
        ]
      })
    );

    const sheets = generatePreviewContactSheets(manifestPath, path.join(tmpDir, "preview"));
    assert.equal(sheets.length, 1);
    assert.equal(fs.existsSync(sheets[0]), true);
    const outPng = PNG.sync.read(fs.readFileSync(sheets[0]));
    assert.ok(outPng.width > 0 && outPng.height > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const CAPTURE_PRESENT = fs.existsSync(new URL("../src/capture/plan.mjs", import.meta.url));
test("gradeSubmission fails clearly when capture/plan.mjs is missing and --no-capture is omitted", { skip: CAPTURE_PRESENT && "capture layer present" }, async () => {
  await assert.rejects(
    () =>
      gradeSubmission({
        room: "aurora",
        submissionDir: MOCK_AURORA,
        noCapture: false,
        noPython: true,
        repoRoot: REPO_ROOT
      }),
    /Capture layer missing/
  );
});

test("gradeSubmission captures web renovation start version for relative, mask.element_ssim, and layout.shift_px", { timeout: 90_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-reno-cap-"));
  try {
    const startDir = path.join(tmpDir, "start");
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(startDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    const makeHtml = ({ bg, shiftPx }) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${bg}; color: #fff; font: 16px sans-serif; }
  .wrap { padding-top: ${shiftPx}px; }
  [data-bench="card"] { margin: 20px; width: 140px; height: 60px; background: #225588; display: flex; align-items: center; justify-content: center; }
  [data-bench="footer"] { margin-top: 200px; height: 40px; background: #334455; display: flex; align-items: center; padding: 0 12px; }
</style></head>
<body><div class="wrap"><div data-bench="card">Card</div><footer data-bench="footer">Footer</footer></div>
<script>
  window.__bench = {
    version: 1,
    ready: Promise.resolve(),
    setSeed() {},
    seek() {},
    resume() {},
    async renderFrame() { await new Promise((r) => requestAnimationFrame(r)); },
    state() { return {}; },
    stats() { return { drawCalls: 0, triangles: 0 }; }
  };
</script></body></html>`;

    fs.writeFileSync(path.join(startDir, "index.html"), makeHtml({ bg: "#101820", shiftPx: 0 }));
    fs.writeFileSync(path.join(subDir, "index.html"), makeHtml({ bg: "#304860", shiftPx: 12 }));
    fs.writeFileSync(
      path.join(subDir, "report.json"),
      JSON.stringify({ schema_version: 1, summary: "reno test", deliverables: ["index.html", "report.json", "decisions.json"], claims: [], blocked: false })
    );
    fs.writeFileSync(
      path.join(subDir, "decisions.json"),
      JSON.stringify({ schema_version: 1, requests: [{ request_id: "T-R1", status: "done", reason: "NONE" }] })
    );

    const specPath = path.join(tmpDir, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        room: "lobby",
        renovation: "r1",
        spec_version: "0.1.0-draft",
        track: "renovation",
        title: "Test Web Renovation",
        time_limit_min: 30,
        scope: ["index.html", "report.json", "decisions.json"],
        deliverables: ["index.html", "report.json", "decisions.json"],
        gates: ["G-load", "G-console", "G-contract", "G-determinism", "G-report", "G-decisions"],
        capture: { renderer: "swiftshader", dpr: 1, viewports: ["320x240"], public_seeds: [1], timestamps_ms: [0] },
        protected: { elements: ['[data-bench="card"]', '[data-bench="footer"]'], compare_at: ["320x240"], color_schemes: ["light"] },
        requests: [
          {
            id: "T-R1",
            kind: "concrete",
            text: { en: "Brighten background", ko: "배경을 밝게" },
            weight: 1,
            metrics: [
              { id: "lum.mean", weight: 1, score: { type: "relative", ideal: [0.1, 2.0], zero: [-0.2, 5.0] } }
            ]
          }
        ],
        composite: { revision: 0.85, reliability: 0.15 },
        metrics: [
          { id: "request.T-R1", axis: "revision", weight: 2, score: { type: "higher", full: 10, zero: 0 } },
          { id: "mask.element_ssim", axis: "revision", weight: 2, score: { type: "higher", full: 0.985, zero: 0.9 } },
          { id: "layout.shift_px", axis: "revision", weight: 1, score: { type: "lower", full: 0, zero: 64 }, at: "320x240" },
          { id: "diff.out_of_scope_files", axis: "revision", weight: 1, score: { type: "lower", full: 0, zero: 3 } },
          { id: "report.honesty", axis: "reliability", weight: 6, score: { type: "higher", full: 10, zero: 0 } },
          { id: "report.autonomy", axis: "reliability", weight: 4, score: { type: "higher", full: 10, zero: 0 } }
        ]
      })
    );

    const res = await gradeSubmission({
      room: specPath,
      submissionDir: subDir,
      start: startDir,
      workDir: path.join(tmpDir, "work"),
      repoRoot: REPO_ROOT
    });

    assert.equal(res.gates["G-load"].pass, true);
    assert.equal(res.gates["G-decisions"].pass, true);
    assert.ok(res.metrics["mask.element_ssim"].raw > 0.99, `expected element_ssim > 0.99, got ${res.metrics["mask.element_ssim"].raw}`);
    assert.ok(Math.abs(res.metrics["layout.shift_px"].raw - 12) < 1.0, `expected shift_px ~12, got ${res.metrics["layout.shift_px"].raw}`);
    assert.ok(res.requests["T-R1"].score >= 9.9, `expected relative request score ~10, got ${res.requests["T-R1"].score}`);
    assert.ok(res.composite > 8, `expected composite > 8, got ${res.composite}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("harness/fonts placeholder manifest and loader API work offline", () => {
  const manifest = getFontManifest();
  assert.equal(manifest.license, "OFL-1.1");
  assert.ok(Array.isArray(manifest.fonts) && manifest.fonts.length >= 4);
  const status = verifyVendoredFonts();
  assert.equal(typeof status.complete, "boolean");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mol-fonts-"));
  try {
    const copied = copyFontsTo(tmpDir);
    assert.ok(copied.includes("fonts.css"));
    assert.ok(copied.includes("manifest.json"));
    assert.equal(fs.existsSync(path.join(tmpDir, "fonts.css")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("room-harness openRoom provides black-box BenchRoom lifecycle, resize, screenshot, and rafSweep", { timeout: 60_000 }, async () => {
  const subDir = path.join(__dirname, "fixtures", "v2", "submission");
  const room = await openRoom({ targetDir: subDir, viewport: "320x240", seed: 7 });
  try {
    await room.setSeed(11);
    await room.seek(250);
    await room.renderFrame();
    const st1 = await room.state();
    assert.equal(st1.seed, 11);
    assert.equal(st1.t, 250);
    assert.equal(st1.mounted, true);

    const stats = await room.stats();
    assert.equal(stats.drawCalls, 1);

    const shot = await room.screenshot();
    assert.ok(Buffer.isBuffer(shot) && shot.length > 100);

    const sz = await room.resize("400x300");
    assert.deepEqual(sz, { width: 400, height: 300 });
    const stResize = await room.state();
    assert.equal(stResize.width, 400);
    assert.equal(stResize.height, 300);

    await room.unmount();
    assert.equal((await room.state()).mounted, false);
    await room.mount("#stage");
    assert.equal((await room.state()).mounted, true);

    const sweep = await room.rafSweep({ durationMs: 200, hz: 30, startClockMs: 0 });
    assert.ok(sweep.frames >= 5);
    assert.ok(sweep.state.rafTicks >= 5);
    assert.deepEqual(room.consoleErrors(), []);
  } finally {
    await room.close();
  }
});

test("M1 smoke test: mock v2 adapter + mock probe + mock python metric grade end-to-end without editing WP-0a files", { timeout: 90_000 }, async () => {
  const v2Root = path.join(__dirname, "fixtures", "v2");
  const probeDir = path.join(v2Root, "probes");
  const pyDir = path.join(v2Root, "pymetrics");
  const adapterDir = path.join(v2Root, "adapters");
  const specPath = path.join(v2Root, "rooms-v2", "mockroom", "spec.json");
  const subDir = path.join(v2Root, "submission");
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), "mol-m1-smoke-"));

  const prevProbeEnv = process.env.MOL_PROBE_DIRS;
  const prevPyEnv = process.env.MOLMETRICS_PLUGIN_DIRS;
  process.env.MOL_PROBE_DIRS = probeDir;
  process.env.MOLMETRICS_PLUGIN_DIRS = pyDir;

  try {
    // Verify probe auto-discovery picks up mock_probe without editing probes/index.js
    const discovered = await discoverProbes({ forceReload: true });
    assert.equal(discovered.has("mock_probe"), true);
    assert.equal(discovered.has("mock.probe_elements"), true);
    const probeNames = await listProbes();
    assert.ok(probeNames.includes("mock_probe"));

    // End-to-end grade using mock v2 adapter + mock probe + mock python metric
    const res = await gradeSubmission({
      room: specPath,
      submissionDir: subDir,
      version: 2,
      adapterDir,
      workDir: tmpWork,
      repoRoot: REPO_ROOT
    });

    assert.equal(res.room, "mockroom");
    assert.equal(res.spec_version, "0.2.0");
    assert.equal(res.bench_version, "0.2.0");
    assert.equal(res.gates["G-load"].pass, true);
    assert.equal(res.gates["G-contract"].pass, true);
    assert.equal(res.gates["G-determinism"].pass, true);
    assert.equal(res.gates["G-report"].pass, true);

    assert.equal(res.metrics["mock.probe_elements"].raw, 2);
    assert.equal(res.metrics["mock.probe_elements"].score, 10);
    assert.equal(res.metrics["mock.adapter_bonus"].raw, true);
    assert.equal(res.metrics["mock.adapter_bonus"].score, 10);
    assert.ok(res.metrics["mock.py_mean_blue"].raw > 0.7, `expected blue mean > 0.7, got ${res.metrics["mock.py_mean_blue"].raw}`);
    assert.equal(res.metrics["mock.py_mean_blue"].score, 10);
    assert.equal(res.metrics["mock.info_diag"].informational, true);
    assert.equal(res.metrics["mock.info_diag"].score, null);
    assert.equal(res.axes.craft, 10);
    assert.equal(res.axes.visual_quality, 10);
    assert.equal(res.axes.reliability, 10);
    assert.equal(res.composite, 10);
    assert.ok(!res.warnings || !res.warnings.some((w) => w.includes("missing_required_metric")));

    // Toolchain provenance stamp recorded on v2 results
    assert.ok(res.toolchain && typeof res.toolchain === "object");
    assert.equal(res.toolchain.node_version, process.version);
    assert.ok(typeof res.toolchain.python_version === "string" && res.toolchain.python_version.length > 0);
    assert.ok(typeof res.toolchain.chromium_version === "string" && res.toolchain.chromium_version.includes("playwright-core"));
    assert.equal(res.toolchain.os_platform, `${process.platform}-${process.arch}`);

    // Fail-closed end-to-end check: removing python plugin drops mock.py_mean_blue -> fails closed to 0
    delete process.env.MOLMETRICS_PLUGIN_DIRS;
    const tmpWork2 = fs.mkdtempSync(path.join(os.tmpdir(), "mol-m1-failclosed-"));
    try {
      const fcRes = await gradeSubmission({
        room: specPath,
        submissionDir: subDir,
        version: 2,
        adapterDir,
        workDir: tmpWork2,
        repoRoot: REPO_ROOT
      });
      assert.equal(fcRes.metrics["mock.py_mean_blue"].score, 0);
      assert.equal(fcRes.metrics["mock.py_mean_blue"].missing, true);
      assert.equal(fcRes.axes.visual_quality, 0);
      assert.equal(fcRes.composite, 6.5);
      assert.ok(fcRes.warnings.includes("missing_required_metric: mock.py_mean_blue"));
    } finally {
      fs.rmSync(tmpWork2, { recursive: true, force: true });
    }

    // v0.1 invariance check: v0.1 result keeps bench_version 0.1.0, omits toolchain, preserves null-drop
    const v1Res = await gradeSubmission({
      room: "aurora",
      submissionDir: MOCK_AURORA,
      noCapture: true,
      noPython: true,
      repoRoot: REPO_ROOT
    });
    assert.equal(v1Res.bench_version, "0.1.0");
    assert.equal("toolchain" in v1Res, false);
    assert.equal(v1Res.axes.reliability, 10);
  } finally {
    if (prevProbeEnv === undefined) delete process.env.MOL_PROBE_DIRS;
    else process.env.MOL_PROBE_DIRS = prevProbeEnv;
    if (prevPyEnv === undefined) delete process.env.MOLMETRICS_PLUGIN_DIRS;
    else process.env.MOLMETRICS_PLUGIN_DIRS = prevPyEnv;
    await discoverProbes({ forceReload: true });
    unregisterMetrics(["mock.probe_elements", "mock.py_mean_blue", "mock.adapter_bonus", "mock.info_diag"]);
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
});
