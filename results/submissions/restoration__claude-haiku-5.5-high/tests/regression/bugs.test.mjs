/**
 * Red-green regression tests for the four visitor-reported orrery regressions.
 *
 * Each test drives the real room in headless Chromium (SwiftShader WebGL) through
 * window.__bench, with a controllable host clock injected before the room scripts run.
 *
 *   B1  washed-out colors         -> COLOR_SPACE_DOUBLE_ENCODE
 *   B2  shimmering floor decal    -> DEPTH_PRECISION_ZFIGHT
 *   B5  speed depends on monitor  -> FRAME_RATE_DEPENDENT_UPDATE
 *   B7  focus jumps several steps -> LISTENER_NOT_REMOVED
 *
 * Run with: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

let server;
let origin;
let browser;

before(async () => {
  // Same browser location the bench harness uses (bundled Chromium under node_modules).
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  }
  const { chromium } = await import("playwright");
  server = http.createServer(async (req, res) => {
    try {
      const reqPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
      const file = path.resolve(ROOT, reqPath);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(403).end();
        return;
      }
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": MIME_TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
});

/** Opens the room with a controllable host clock (window.__testClockMs, in ms). */
async function openRoom() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__testClockMs = 0;
    window.__benchHost = {
      contractVersion: 1,
      seed: 1,
      params: {},
      clock: { now: () => window.__testClockMs },
      rng: null
    };
  });
  await page.goto(`${origin}/room/index.html`);
  await page.waitForFunction(() => window.__bench !== undefined);
  await page.evaluate(() => window.__bench.ready);
  return { context, page };
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test("B1: scene colors are not double-encoded in sRGB (background and chart patch 0 match sRGB)", async () => {
  const { context, page } = await openRoom();
  try {
    const sample = await page.evaluate(async () => {
      window.__bench.seek(1000);
      await window.__bench.renderFrame();
      const st = window.__bench.state();
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const w = canvas.width;
      const h = canvas.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const at = (x, y) => {
        const i = ((h - 1 - y) * w + x) * 4;
        return [px[i], px[i + 1], px[i + 2]];
      };
      const p0 = st.chartPatches[0];
      return { background: at(20, 20), patch0: at(p0.x, p0.y) };
    });
    // Background is sRGB 0x141822 = (20, 24, 34); patch 0 reference is (194, 150, 130).
    const bgErr = colorDistance(sample.background, [20, 24, 34]);
    const patchErr = colorDistance(sample.patch0, [194, 150, 130]);
    assert.ok(bgErr <= 18, `background ${sample.background} is not sRGB (20,24,34), error=${bgErr.toFixed(1)}`);
    assert.ok(patchErr <= 18, `chart patch 0 ${sample.patch0} is not sRGB (194,150,130), error=${patchErr.toFixed(1)}`);
  } finally {
    await context.close();
  }
});

test("B2: floor decal does not shimmer or z-fight while the camera drifts", async () => {
  const { context, page } = await openRoom();
  try {
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const rw = 200;
      const rh = 80;
      const rx = 760;
      const ry = 160;
      const frames = [];
      for (let k = 0; k < 4; k++) {
        window.__bench.seek(2500 + k * 16.667);
        await window.__bench.renderFrame();
        const buf = new Uint8Array(rw * rh * 4);
        gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        frames.push(buf);
      }
      let jumpingPixels = 0;
      for (let i = 0; i < rw * rh * 4; i += 4) {
        const d01 = Math.abs(frames[1][i] - frames[0][i]);
        const d12 = Math.abs(frames[2][i] - frames[1][i]);
        if (d01 > 75 && d12 > 75) jumpingPixels++;
      }
      return { jumpingPixels };
    });
    assert.ok(
      result.jumpingPixels < 50,
      `floor decal flickers between adjacent frames: ${result.jumpingPixels} jumping pixels`
    );
  } finally {
    await context.close();
  }
});

test("B5: planet orbits follow the host clock, not the number of rendered frames", async () => {
  const { context, page } = await openRoom();
  try {
    // Hold the host clock at 2000 ms and let the live loop run for 20 frames.
    await page.evaluate(() => {
      window.__testClockMs = 2000;
    });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let frames = 0;
          const step = () => {
            frames += 1;
            if (frames >= 20) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })
    );
    const live = await page.evaluate(() => window.__bench.state().orbitAngleDeg);
    const seeked = await page.evaluate(async () => {
      window.__bench.seek(2000);
      await window.__bench.renderFrame();
      return window.__bench.state().orbitAngleDeg;
    });
    assert.ok(
      Math.abs(live - seeked) < 1e-6,
      `live orbit angle ${live} after 20 frames at host clock 2000ms != angle at 2000ms ${seeked}`
    );
  } finally {
    await context.close();
  }
});

test("B7: one next-planet click advances focus by exactly one step after lifecycle remounts", async () => {
  const { context, page } = await openRoom();
  try {
    const result = await page.evaluate(async () => {
      const container = document.getElementById("orrery-stage");
      for (let i = 0; i < 3; i++) {
        await window.__bench.unmount();
        await window.__bench.mount(container);
      }
      const before = window.__bench.state().focusedIndex;
      document.querySelector('[data-bench="next-planet"]').click();
      const after = window.__bench.state().focusedIndex;
      return { step: (after - before + 7) % 7, listeners: window.__bench.stats().listeners };
    });
    assert.equal(result.step, 1, `one click advanced focus by ${result.step} steps`);
    assert.equal(result.listeners, 2, `room holds ${result.listeners} listeners after remounts (expected 2)`);
  } finally {
    await context.close();
  }
});
