import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TEST_TIMEOUT_MS = 30_000;

async function collectTestFiles(entries) {
  const files = [];
  for (const entry of entries || []) {
    const abs = path.resolve(entry);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const items = await fs.readdir(abs, { withFileTypes: true });
      const mjsFiles = items
        .filter((d) => d.isFile() && (d.name.endsWith('.mjs') || d.name.endsWith('.js')))
        .map((d) => path.join(abs, d.name))
        .sort();
      files.push(...mjsFiles);
    } else if (st.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Test "${label}" timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Execute public or hidden test modules exported as:
 *   export default [{ id, title, async run(ctx) { return { pass, detail }; } }]
 */
export async function runTests(testPaths, {
  browserSession,
  origin,
  url,
  localResolver = null,
  spec = {},
  adapter = null,
  hidden = false,
  workDir = null,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  defaultViewport = '1440x900',
  defaultSeed = 1,
  onLogs = null,
} = {}) {
  const files = await collectTestFiles(testPaths);
  const results = [];

  const getParams = (seed, opts = {}) => {
    if (adapter && typeof adapter.generate === 'function') {
      return adapter.generate(seed, { hidden, ...opts });
    }
    return {};
  };

  for (const file of files) {
    const relFile = path.relative(process.cwd(), file).replace(/\\/g, '/');
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      results.push({
        id: path.basename(file),
        title: `Load test module ${relFile}`,
        pass: false,
        detail: `Failed to import test module: ${String(err?.stack || err?.message || err)}`,
        file: relFile,
      });
      continue;
    }

    const tests = Array.isArray(mod.default) ? mod.default : [];
    for (const t of tests) {
      const id = String(t?.id || 'unnamed-test');
      const title = String(t?.title || id);
      if (typeof t?.run !== 'function') {
        results.push({
          id,
          title,
          pass: false,
          detail: 'Test definition missing run(ctx) function',
          file: relFile,
        });
        continue;
      }

      const initParams = getParams(defaultSeed);
      let handle = null;
      try {
        handle = await browserSession.newPage({
          origin,
          url,
          localResolver,
          viewport: defaultViewport,
          seed: defaultSeed,
          params: initParams,
          loadTimeoutMs: spec?.load_timeout_ms ?? 15000,
        });

        const ctx = {
          page: handle.page,
          spec,
          origin,
          url,
          workDir,
          params(seed, opts) {
            return getParams(seed, opts);
          },
          bench: {
            setSeed: (s, p) => handle.setSeed(s, p !== undefined ? p : getParams(s)),
            seek: (ms) => handle.seek(ms),
            resume: () => handle.resume(),
            resetClock: (ms) => handle.resetClock(ms),
            clockNow: () => handle.clockNow(),
            renderFrame: () => handle.renderFrame(),
            state: () => handle.state(),
            stats: () => handle.stats(),
            screenshot: (outPath, opts) => handle.screenshot(outPath, opts),
            resize: (vp) => handle.setViewport(vp),
            resizeSequence: (vps) => handle.resizeSequence(vps),
            emulate: (opts) => handle.emulate(opts),
            movePointer: (x, y) => handle.movePointer(x, y),
            movePointerNormalized: (nx, ny) => handle.movePointerNormalized(nx, ny),
            rafRate: async (hz, durationMs = 5000, startClockMs = null) => {
              await handle.installRafOverride();
              return handle.stepRafVirtual(durationMs, hz, startClockMs);
            },
            installRafOverride: () => handle.installRafOverride(),
            uninstallRafOverride: () => handle.uninstallRafOverride(),
            stepRafVirtual: (dur, hz, start) => handle.stepRafVirtual(dur, hz, start),
            virtualTime: {
              pause: () => handle.virtualTimePause(),
              advance: (ms) => handle.virtualTimeAdvance(ms),
              resume: () => handle.virtualTimeResume(),
            },
            collectGarbageAndHeap: () => handle.collectGarbageAndHeap(),
            getListenerCount: () => handle.getListenerCount(),
            setRootFontZoom: (pct) => handle.setRootFontZoom(pct),
            setCpuThrottling: (rate) => handle.setCpuThrottling(rate),
            getWebGLMetrics: () => handle.getWebGLMetrics(),
            resetWebGLFrameMetrics: () => handle.resetWebGLFrameMetrics(),
            getDomMetrics: () => handle.getDomMetrics(),
            resetDomMetrics: (opts) => handle.resetDomMetrics(opts),
            getTransferBytes: () => handle.getTransferBytes(),
          },
        };

        const outcome = await withTimeout(Promise.resolve().then(() => t.run(ctx)), timeoutMs, id);
        const pass = Boolean(outcome && outcome.pass === true);
        const detail = outcome && typeof outcome.detail === 'string'
          ? outcome.detail
          : (pass ? '' : 'Test returned non-passing result');
        results.push({ id, title, pass, detail, file: relFile });
      } catch (err) {
        results.push({
          id,
          title,
          pass: false,
          detail: String(err?.stack || err?.message || err),
          file: relFile,
        });
      } finally {
        if (handle) {
          if (typeof onLogs === 'function') {
            onLogs(handle);
          }
          await handle.close();
        }
      }
    }
  }

  return results;
}
