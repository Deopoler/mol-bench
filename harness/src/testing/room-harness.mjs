/**
 * Black-box room test harness for MoL-Bench v0.2 regression tests (e.g. Restoration).
 *
 * Supports two execution modes:
 * 1. Direct mode (local dev / parent harness): serves `targetDir` over local HTTP and drives
 *    it via Playwright Chromium (SwiftShader) with external network blocked (or connects via
 *    `process.env.MOL_PLAYWRIGHT_WS` when supplied).
 * 2. Runtime-isolated mode (`runSandboxedTest`): runs submission tests in a child Node process
 *    under Node's permission model (`--permission` / `--experimental-permission`) with fs-read
 *    restricted strictly to the test directory, harness testing dir, and node_modules (zero fs
 *    write, zero child_process, zero read access to submission `room/` source). Inside the child,
 *    `openRoom()` transparently proxies all calls over Node IPC to the parent-owned browser.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---- IPC proxy client (used inside --permission sandboxed test child) ----
let _ipcNextId = 1;
const _ipcPending = new Map();
let _ipcListenerInstalled = false;

function ensureIpcListener() {
  if (_ipcListenerInstalled) return;
  _ipcListenerInstalled = true;
  process.on("message", (msg) => {
    if (!msg || typeof msg !== "object" || msg.__molRoomRpc !== "res") return;
    const entry = _ipcPending.get(msg.id);
    if (!entry) return;
    _ipcPending.delete(msg.id);
    if (_ipcPending.size === 0) {
      process.channel?.unref?.();
    }
    if (msg.error) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  });
  process.channel?.unref?.();
}

function ipcCall(cmd, handleId, args = []) {
  ensureIpcListener();
  const id = _ipcNextId++;
  process.channel?.ref?.();
  return new Promise((resolve, reject) => {
    _ipcPending.set(id, { resolve, reject });
    process.send({ __molRoomRpc: "req", id, cmd, handleId, args });
  });
}

async function openRoomViaIpc(opts = {}) {
  // Never pass caller-provided targetDir over IPC; parent pins targetDir authoritatively.
  const { targetDir: _ignored, ...safeOpts } = opts;
  const { handleId } = await ipcCall("openRoom", null, [safeOpts]);
  let closed = false;
  let lastConsoleErrors = [];

  function assertOpen() {
    if (closed) throw new Error("RoomHandle is already closed");
  }

  return {
    targetDir: "<sandboxed>",
    async setSeed(newSeed, newParams) {
      assertOpen();
      await ipcCall("setSeed", handleId, [newSeed, newParams]);
    },
    async seek(tMs) {
      assertOpen();
      await ipcCall("seek", handleId, [tMs]);
    },
    async resume() {
      assertOpen();
      await ipcCall("resume", handleId, []);
    },
    async renderFrame(timeoutMs = 15_000) {
      assertOpen();
      await ipcCall("renderFrame", handleId, [timeoutMs]);
    },
    async screenshot(_outPath = null, options = {}) {
      assertOpen();
      const b64 = await ipcCall("screenshot", handleId, [null, options]);
      return Buffer.from(b64, "base64");
    },
    async resize(viewportOrWidth, height) {
      assertOpen();
      return ipcCall("resize", handleId, [viewportOrWidth, height]);
    },
    async setViewport(viewportOrWidth, height) {
      return this.resize(viewportOrWidth, height);
    },
    async mount(containerSelector = null) {
      assertOpen();
      return ipcCall("mount", handleId, [containerSelector]);
    },
    async unmount() {
      assertOpen();
      return ipcCall("unmount", handleId, []);
    },
    async state() {
      assertOpen();
      return ipcCall("state", handleId, []);
    },
    async stats() {
      assertOpen();
      return ipcCall("stats", handleId, []);
    },
    async rafSweep(sweepOpts = {}) {
      assertOpen();
      return ipcCall("rafSweep", handleId, [sweepOpts]);
    },
    async emulate(emulateOpts = {}) {
      assertOpen();
      await ipcCall("emulate", handleId, [emulateOpts]);
    },
    async movePointer(x, y) {
      assertOpen();
      await ipcCall("movePointer", handleId, [x, y]);
    },
    async movePointerNormalized(nx, ny) {
      assertOpen();
      await ipcCall("movePointerNormalized", handleId, [nx, ny]);
    },
    async getConsoleErrors() {
      assertOpen();
      lastConsoleErrors = await ipcCall("consoleErrors", handleId, []);
      return lastConsoleErrors;
    },
    consoleErrors() {
      return [...lastConsoleErrors];
    },
    async close() {
      if (closed) return;
      closed = true;
      await ipcCall("close", handleId, []);
    }
  };
}

/**
 * Open a room submission in a black-box Playwright browser session.
 * When running inside `runSandboxedTest` (`MOL_ROOM_IPC=1`), proxies transparently
 * over IPC to the parent-owned browser so the test process needs zero fs/network/spawn rights.
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
  if (process.env.MOL_ROOM_IPC === "1" && typeof process.send === "function") {
    return openRoomViaIpc({
      viewport,
      dpr,
      colorScheme,
      reducedMotion,
      locale,
      seed,
      params,
      entryPath,
      loadTimeoutMs,
      mode
    });
  }

  // Lazy-import capture modules so sandboxed child processes never need fs-read on capture/*.mjs
  const [{ startServer }, { launchBrowser, parseViewport }] = await Promise.all([
    import("../capture/server.mjs"),
    import("../capture/browser.mjs")
  ]);

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

    if (process.env.MOL_PLAYWRIGHT_WS) {
      const { chromium } = await import("playwright");
      const connectedBrowser = await chromium.connect(process.env.MOL_PLAYWRIGHT_WS);
      const vp = parseViewport(viewport);
      const context = await connectedBrowser.newContext({
        viewport: vp,
        deviceScaleFactor: Number(dpr) || 1,
        colorScheme: colorScheme === "dark" ? "dark" : "light",
        reducedMotion: reducedMotion === "reduce" ? "reduce" : "no-preference",
        ...(locale ? { locale } : {})
      });
      const page = await context.newPage();
      const hostScript = fs.readFileSync(path.resolve(__dirname, "../capture/host.js"), "utf8");
      await page.addInitScript((cfg) => { window.__BENCH_HOST_INIT__ = cfg; }, { seed, params: params || {}, locale });
      await page.addInitScript({ content: hostScript });
      await page.goto(entryUrl, { waitUntil: "load", timeout: loadTimeoutMs });
      await page.waitForFunction(() => Boolean(window.__bench && window.__bench.ready), null, { timeout: loadTimeoutMs });
      await page.evaluate(() => Promise.resolve(window.__bench.ready));
      browserSession = { close: () => connectedBrowser.close() };
      const consoleLogs = [];
      page.on("console", (m) => consoleLogs.push({ type: m.type(), text: m.text() }));
      page.on("pageerror", (e) => consoleLogs.push({ type: "pageerror", text: String(e?.message || e) }));
      pageHandle = {
        page,
        consoleLogs,
        loadResult: { pass: true, detail: "connected via MOL_PLAYWRIGHT_WS" },
        setSeed: (s, p) => page.evaluate(([sv, pv]) => { window.__benchHostControl.setSeed(sv, pv); window.__bench.setSeed(sv); }, [s, p]),
        seek: (t) => page.evaluate((tv) => { window.__benchHostControl.freeze(tv); window.__bench.seek(tv); }, Number(t)),
        resume: () => page.evaluate(() => { window.__benchHostControl.resume(); window.__bench.resume(); }),
        renderFrame: () => page.evaluate(() => Promise.resolve(window.__bench.renderFrame())),
        screenshot: async (outPath, options) => {
          const buf = await page.screenshot({ type: "png", fullPage: false, animations: "allow", ...options });
          if (outPath) fs.writeFileSync(outPath, buf);
          return buf;
        },
        setViewport: async (vpSpec) => { const sz = parseViewport(vpSpec); await page.setViewportSize(sz); return sz; },
        state: () => page.evaluate(() => window.__bench.state()),
        stats: () => page.evaluate(() => window.__bench.stats()),
        installRafOverride: () => page.evaluate(() => window.__benchHostControl.installRafOverride()),
        uninstallRafOverride: () => page.evaluate(() => window.__benchHostControl.uninstallRafOverride()),
        stepRafVirtual: (d, h, st) => page.evaluate(([dur, rate, start]) => window.__benchHostControl.stepRafVirtual(dur, rate, start), [Number(d), Number(h), st]),
        emulate: async ({ reducedMotion: rm, colorScheme: cs } = {}) => {
          const opts = {};
          if (rm !== undefined) opts.reducedMotion = rm === "reduce" || rm === true ? "reduce" : "no-preference";
          if (cs !== undefined) opts.colorScheme = cs === "dark" ? "dark" : "light";
          if (Object.keys(opts).length > 0) await page.emulateMedia(opts);
        },
        movePointer: (x, y) => page.mouse.move(x, y),
        movePointerNormalized: (nx, ny) => {
          const sz = page.viewportSize() || { width: 1440, height: 900 };
          return page.mouse.move(sz.width * nx, sz.height * ny);
        },
        close: () => context.close()
      };
    } else {
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

function getPermissionFlag() {
  const major = Number(String(process.versions.node || "22").split(".")[0]);
  return major >= 24 ? "--permission" : "--experimental-permission";
}

/**
 * Run a submission regression test file inside a runtime-isolated Node child process
 * using Node's permission model:
 * - fs-read limited strictly to `testDir`, the harness testing module dir, and `node_modules`
 * - NO fs-write, NO child_process, NO worker_threads, NO fs-read on `targetDir` / `room/`
 * - Browser and static server live in the parent process and communicate over IPC.
 */
export async function runSandboxedTest({
  testFile,
  targetDir,
  testDir = null,
  testNamePattern = null,
  timeoutMs = 30_000,
  extraReadPaths = []
} = {}) {
  const absTestFile = path.resolve(testFile);
  const absTargetDir = path.resolve(targetDir);
  const absTestDir = path.resolve(testDir || path.dirname(absTestFile));

  const readPaths = new Set([absTestDir, __dirname]);
  // Allow reading repo package.json (needed for ESM `"type":"module"` resolution of room-harness.mjs)
  const repoRootCandidate = path.resolve(__dirname, "..", "..", "..");
  const pkgJson = path.join(repoRootCandidate, "package.json");
  if (fs.existsSync(pkgJson)) readPaths.add(pkgJson);
  const nodeModules = path.join(repoRootCandidate, "node_modules");
  if (fs.existsSync(nodeModules)) readPaths.add(nodeModules);
  for (const p of extraReadPaths || []) {
    if (p) readPaths.add(path.resolve(p));
  }

  const nodeArgs = [
    getPermissionFlag(),
    ...[...readPaths].map((p) => `--allow-fs-read=${p}`),
    ...(testNamePattern ? [`--test-name-pattern=${testNamePattern}`] : []),
    absTestFile
  ];

  // Sanitized environment: do NOT expose targetDir path to the sandboxed child
  const childEnv = {
    MOL_ROOM_IPC: "1",
    NODE_ENV: process.env.NODE_ENV || "test",
    PATH: process.env.PATH || "",
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {})
  };

  const openHandles = new Map();
  let nextHandleId = 1;

  const child = spawn(process.execPath, nodeArgs, {
    cwd: absTestDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });

  const reply = (id, payload) => {
    if (child.connected) {
      child.send({ __molRoomRpc: "res", id, ...payload });
    }
  };

  child.on("message", async (msg) => {
    if (!msg || typeof msg !== "object" || msg.__molRoomRpc !== "req") return;
    const { id, cmd, handleId, args = [] } = msg;
    try {
      if (cmd === "openRoom") {
        const roomOpts = { ...(args[0] || {}), targetDir: absTargetDir };
        const handle = await openRoom(roomOpts);
        const hid = nextHandleId++;
        openHandles.set(hid, handle);
        reply(id, { result: { handleId: hid } });
        return;
      }
      const handle = openHandles.get(handleId);
      if (!handle) {
        reply(id, { error: `Unknown RoomHandle id: ${handleId}` });
        return;
      }
      if (cmd === "screenshot") {
        // Never allow sandboxed child to specify an output file path in parent
        const buf = await handle.screenshot(null, args[1] || {});
        reply(id, { result: buf.toString("base64") });
        return;
      }
      if (cmd === "consoleErrors") {
        reply(id, { result: handle.consoleErrors() });
        return;
      }
      if (cmd === "close") {
        openHandles.delete(handleId);
        await handle.close();
        reply(id, { result: true });
        return;
      }
      const allowedMethods = new Set([
        "setSeed",
        "seek",
        "resume",
        "renderFrame",
        "resize",
        "setViewport",
        "mount",
        "unmount",
        "state",
        "stats",
        "rafSweep",
        "emulate",
        "movePointer",
        "movePointerNormalized"
      ]);
      if (!allowedMethods.has(cmd) || typeof handle[cmd] !== "function") {
        reply(id, { error: `Disallowed RoomHandle RPC command: ${cmd}` });
        return;
      }
      const res = await handle[cmd](...args);
      reply(id, { result: res });
    } catch (err) {
      reply(id, { error: String(err?.message || err) });
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* ignore */ }
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });
  clearTimeout(timer);

  for (const handle of openHandles.values()) {
    try { await handle.close(); } catch { /* ignore */ }
  }
  openHandles.clear();

  return {
    pass: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    stdout,
    stderr
  };
}
