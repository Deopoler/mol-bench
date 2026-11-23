/**
 * Black-box room test harness for MoL-Bench v0.2 regression tests (e.g. Restoration).
 *
 * Serves `targetDir` (default: `process.env.MOL_TARGET_DIR || process.cwd()`) over a
 * local-only HTTP server and drives it strictly through the BenchRoom v1 browser API
 * inside headless Playwright Chromium (SwiftShader) with external network blocked.
 */

import fs from "node:fs";
import path from "node:path";
import { startServer } from "../capture/server.mjs";
import { launchBrowser, parseViewport } from "../capture/browser.mjs";

function resolveEntryUrl(targetDir, origin, entryPath = null) {
  if (entryPath) {
    const clean = String(entryPath).replace(/\\/g, "/").replace(/^\/+/, "");
    return `${origin}/${clean}`;
  }
  if (fs.existsSync(path.join(targetDir, "index.html"))) {
    return `${origin}/`;
  }
  if (fs.existsSync(path.join(targetDir, "room", "index.html"))) {
    return `${origin}/room/index.html`;
  }
  if (fs.existsSync(path.join(targetDir, "lobby", "index.html"))) {
    return `${origin}/lobby/index.html`;
  }
  return `${origin}/`;
}

/**
 * Open a room submission in a sandboxed black-box Playwright browser session.
 *
 * @param {object} opts
 * @param {string} [opts.targetDir] Directory to serve (defaults to MOL_TARGET_DIR or cwd)
 * @param {string|{width:number,height:number}} [opts.viewport="1440x900"]
 * @param {number} [opts.dpr=1]
 * @param {"light"|"dark"} [opts.colorScheme="light"]
 * @param {"no-preference"|"reduce"} [opts.reducedMotion="no-preference"]
 * @param {string|null} [opts.locale=null]
 * @param {number} [opts.seed=1]
 * @param {object} [opts.params={}]
 * @param {string|null} [opts.entryPath=null]
 * @param {number} [opts.loadTimeoutMs=15000]
 * @param {"swiftshader"|"gpu"} [opts.mode="swiftshader"]
 */
export async function openRoom({
  targetDir = null,
  viewport = "1440x900",
  dpr = 1,
  colorScheme = "light",
  reducedMotion = "no-preference",
  locale = null,
  seed = 1,
  params = {},
  entryPath = null,
  loadTimeoutMs = 15_000,
  mode = "swiftshader"
} = {}) {
  const absTargetDir = path.resolve(targetDir || process.env.MOL_TARGET_DIR || process.cwd());
  if (!fs.existsSync(absTargetDir) || !fs.statSync(absTargetDir).isDirectory()) {
    throw new Error(`Room target directory does not exist: ${absTargetDir}`);
  }

  let server = null;
  let browserSession = null;
  let pageHandle = null;
  let closed = false;

  async function cleanup() {
    if (closed) return;
    closed = true;
    try {
      if (pageHandle) await pageHandle.close();
    } catch {
      // ignore
    }
    try {
      if (browserSession) await browserSession.close();
    } catch {
      // ignore
    }
    try {
      if (server) await server.close();
    } catch {
      // ignore
    }
  }

  try {
    server = await startServer(absTargetDir);
    const localResolver = server.loopbackReachable ? null : server.resolveFile;
    const entryUrl = resolveEntryUrl(absTargetDir, server.origin, entryPath);
    browserSession = await launchBrowser({ mode });
    pageHandle = await browserSession.newPage({
      origin: server.origin,
      url: entryUrl,
      localResolver,
      viewport,
      dpr,
      colorScheme,
      reducedMotion,
      locale,
      seed,
      params,
      blockExternal: true,
      waitForReady: true,
      loadTimeoutMs
    });

    if (!pageHandle.loadResult.pass) {
      throw new Error(`Failed to load room at ${entryUrl}: ${pageHandle.loadResult.detail}`);
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  function assertOpen() {
    if (closed) throw new Error("RoomHandle is already closed");
  }

  return {
    targetDir: absTargetDir,

    async setSeed(newSeed, newParams) {
      assertOpen();
      await pageHandle.setSeed(newSeed, newParams);
    },

    async seek(tMs) {
      assertOpen();
      await pageHandle.seek(tMs);
    },

    async resume() {
      assertOpen();
      await pageHandle.resume();
    },

    async renderFrame(timeoutMs = 15_000) {
      assertOpen();
      await pageHandle.renderFrame(timeoutMs);
    },

    async screenshot(outPath = null, options = {}) {
      assertOpen();
      return pageHandle.screenshot(outPath, options);
    },

    async resize(viewportOrWidth, height) {
      assertOpen();
      const vp =
        typeof viewportOrWidth === "number" && typeof height === "number"
          ? { width: viewportOrWidth, height }
          : parseViewport(viewportOrWidth);
      const size = await pageHandle.setViewport(vp);
      await pageHandle.page.evaluate(() => {
        window.dispatchEvent(new Event("resize"));
      });
      return size;
    },

    async setViewport(viewportOrWidth, height) {
      return this.resize(viewportOrWidth, height);
    },

    async mount(containerSelector = null) {
      assertOpen();
      return pageHandle.page.evaluate(async (sel) => {
        const b = window.__bench;
        if (!b || typeof b.mount !== "function") {
          throw new Error("window.__bench.mount() is not implemented by this room");
        }
        const el = sel
          ? document.querySelector(sel)
          : (document.getElementById("orrery-stage") || document.getElementById("stage") || document.body);
        if (!el) {
          throw new Error(`mount container not found: ${sel}`);
        }
        return b.mount(el);
      }, containerSelector);
    },

    async unmount() {
      assertOpen();
      return pageHandle.page.evaluate(async () => {
        const b = window.__bench;
        if (!b || typeof b.unmount !== "function") {
          throw new Error("window.__bench.unmount() is not implemented by this room");
        }
        return b.unmount();
      });
    },

    async state() {
      assertOpen();
      return pageHandle.state();
    },

    async stats() {
      assertOpen();
      return pageHandle.stats();
    },

    async rafSweep({ durationMs = 1000, hz = 60, startClockMs = 0 } = {}) {
      assertOpen();
      await pageHandle.installRafOverride();
      try {
        await pageHandle.resume();
        const stepRes = await pageHandle.stepRafVirtual(durationMs, hz, startClockMs);
        const [st, stats] = await Promise.all([pageHandle.state(), pageHandle.stats()]);
        return {
          frames: typeof stepRes === "number" ? stepRes : (stepRes?.frames ?? Math.round((durationMs / 1000) * hz)),
          durationMs,
          hz,
          state: st,
          stats
        };
      } finally {
        await pageHandle.uninstallRafOverride().catch(() => {});
      }
    },

    async emulate(opts = {}) {
      assertOpen();
      await pageHandle.emulate(opts);
    },

    async movePointer(x, y) {
      assertOpen();
      await pageHandle.movePointer(x, y);
    },

    async movePointerNormalized(nx, ny) {
      assertOpen();
      await pageHandle.movePointerNormalized(nx, ny);
    },

    consoleErrors() {
      return (pageHandle?.consoleLogs || [])
        .filter((e) => e.type === "error" || e.type === "pageerror")
        .map((e) => e.text);
    },

    async close() {
      await cleanup();
    }
  };
}
