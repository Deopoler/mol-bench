import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS_PATH = path.join(__dirname, 'host.js');

/**
 * Deterministic Chromium flags for SwiftShader capture mode.
 * Per docs/ARCHITECTURE.md + --use-gl=angle for reliable WebGL2 SwiftShader
 * initialization on Windows, plus --enable-precise-memory-info for heap metrics.
 */
export const SWIFTSHADER_FLAGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-vsync',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--enable-precise-memory-info',
];

/**
 * Chromium flags for headed real-GPU performance measurements.
 */
export const GPU_FLAGS = [
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-precise-memory-info',
];

let cachedHostScript = null;
async function getHostScript() {
  if (!cachedHostScript) {
    cachedHostScript = await fs.readFile(HOST_JS_PATH, 'utf8');
  }
  return cachedHostScript;
}

/**
 * Parse "WxH" string into { width, height }.
 */
export function parseViewport(vp) {
  if (vp && typeof vp === 'object' && typeof vp.width === 'number' && typeof vp.height === 'number') {
    return { width: vp.width, height: vp.height };
  }
  const m = /^(\d+)x(\d+)$/i.exec(String(vp || '1440x900').trim());
  if (!m) {
    throw new Error(`Invalid viewport string: "${vp}"`);
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

function isUrlAllowed(rawUrl, origin) {
  if (!rawUrl) return true;
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('about:')) {
    return true;
  }
  if (!origin) return true;
  try {
    return new URL(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const tp = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, tp]).finally(() => clearTimeout(timer));
}

/**
 * Launch a Playwright Chromium session in 'swiftshader' (headless) or 'gpu' (headed) mode.
 */
export async function launchBrowser({ mode = 'swiftshader', extraArgs = [], launchTimeoutMs = 30_000 } = {}) {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
  }
  const { chromium } = await import('playwright');

  const isGpu = mode === 'gpu';
  const args = [...(isGpu ? GPU_FLAGS : SWIFTSHADER_FLAGS), ...extraArgs];
  const browser = await chromium.launch({
    headless: !isGpu,
    args,
    timeout: launchTimeoutMs,
  });

  const openContexts = new Set();

  /**
   * Open a fresh isolated context + page with host.js pre-injected.
   */
  async function newPage({
    origin = null,
    url = null,
    viewport = '1440x900',
    dpr = 1,
    colorScheme = 'light',
    reducedMotion = 'no-preference',
    locale = null,
    seed = 1,
    params = {},
    blockExternal = true,
    localResolver = null,
    waitForReady = true,
    loadTimeoutMs = 15000,
  } = {}) {
    const vp = parseViewport(viewport);
    const contextOptions = {
      viewport: vp,
      deviceScaleFactor: Number(dpr) || 1,
      colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
      reducedMotion: reducedMotion === 'reduce' ? 'reduce' : 'no-preference',
    };
    if (locale) {
      contextOptions.locale = locale;
    }

    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(loadTimeoutMs);
    openContexts.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(loadTimeoutMs);
    const cdp = await context.newCDPSession(page);

    const consoleLogs = [];
    const networkLogs = [];
    const fontResponses = [];

    page.on('console', (msg) => {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => {
      consoleLogs.push({ type: 'pageerror', text: String(err?.stack || err?.message || err) });
    });

    if (origin && (blockExternal || localResolver)) {
      await page.route('**/*', async (route) => {
        const req = route.request();
        const reqUrl = req.url();
        const allowed = isUrlAllowed(reqUrl, origin);
        if (!allowed && blockExternal) {
          networkLogs.push({
            url: reqUrl,
            method: req.method(),
            resourceType: req.resourceType(),
            allowed: false,
            blocked: true,
          });
          await route.abort('blockedbyclient');
          return;
        }
        if (allowed && localResolver && reqUrl.startsWith(origin)) {
          const resolved = await localResolver(reqUrl);
          await route.fulfill({
            status: resolved.status,
            contentType: resolved.contentType,
            headers: {
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
            body: resolved.body,
          });
          return;
        }
        await route.continue();
      });
    }

    page.on('request', (req) => {
      const reqUrl = req.url();
      const allowed = isUrlAllowed(reqUrl, origin);
      // Avoid double-logging already blocked external requests
      if (!allowed && origin && blockExternal) return;
      networkLogs.push({
        url: reqUrl,
        method: req.method(),
        resourceType: req.resourceType(),
        allowed,
        blocked: false,
      });
    });

    page.on('response', (res) => {
      const req = res.request();
      const resourceType = req.resourceType();
      const resUrl = res.url();
      const contentType = res.headers()['content-type'] || '';
      const isFont = resourceType === 'font' || /^font\//i.test(contentType) || /\.(woff2?|ttf|otf)(\?|$)/i.test(resUrl);
      if (isFont) {
        fontResponses.push({
          url: resUrl,
          status: res.status(),
          allowed: isUrlAllowed(resUrl, origin),
          contentType,
        });
      }
    });

    // Inject initial config + host.js before any page script executes
    const hostScript = await getHostScript();
    const initConfig = { seed, params: params || {}, locale: locale || null };
    await page.addInitScript((cfg) => {
      window.__BENCH_HOST_INIT__ = cfg;
    }, initConfig);
    await page.addInitScript({ content: hostScript });

    let loadResult = { pass: true, detail: '' };

    const handle = {
      browser,
      context,
      page,
      cdp,
      consoleLogs,
      networkLogs,
      fontResponses,
      get loadResult() {
        return loadResult;
      },

      async goto(targetUrl, { waitForBench = waitForReady, timeoutMs = loadTimeoutMs } = {}) {
        try {
          await page.goto(targetUrl, { waitUntil: 'load', timeout: timeoutMs });
          if (waitForBench) {
            await handle.waitForBenchReady(timeoutMs);
          }
          loadResult = { pass: true, detail: 'Loaded and __bench.ready resolved' };
        } catch (err) {
          loadResult = { pass: false, detail: String(err?.message || err) };
        }
        return loadResult;
      },

      async waitForBenchReady(timeoutMs = loadTimeoutMs) {
        const deadline = Date.now() + timeoutMs;
        await page.waitForFunction(() => Boolean(window.__bench && window.__bench.ready), null, {
          timeout: Math.max(100, deadline - Date.now()),
        });
        const remaining = Math.max(100, deadline - Date.now());
        await page.evaluate(async (ms) => {
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`__bench.ready timed out after ${ms} ms`)), ms);
          });
          try {
            await Promise.race([Promise.resolve(window.__bench.ready), timeoutPromise]);
          } finally {
            clearTimeout(timer);
          }
        }, remaining);
      },

      async checkContract() {
        return page.evaluate(() => {
          const b = window.__bench;
          const missing = [];
          if (!b || typeof b !== 'object') {
            return { pass: false, detail: 'window.__bench is not defined' };
          }
          if (b.version !== 1) missing.push(`version (got ${String(b.version)}, expected 1)`);
          if (!b.ready || typeof b.ready.then !== 'function') missing.push('ready (Promise)');
          for (const fn of ['setSeed', 'seek', 'resume', 'renderFrame', 'state', 'stats']) {
            if (typeof b[fn] !== 'function') missing.push(`${fn}()`);
          }
          if (missing.length > 0) {
            return { pass: false, detail: `Missing/invalid BenchRoom members: ${missing.join(', ')}` };
          }
          try {
            const st = b.state();
            if (!st || typeof st !== 'object') {
              return { pass: false, detail: 'state() did not return an object' };
            }
            const stats = b.stats();
            if (!stats || typeof stats !== 'object' || typeof stats.drawCalls !== 'number' || typeof stats.triangles !== 'number') {
              return { pass: false, detail: 'stats() must return { drawCalls: number, triangles: number }' };
            }
          } catch (err) {
            return { pass: false, detail: `state()/stats() threw: ${String(err?.message || err)}` };
          }
          return { pass: true, detail: 'BenchRoom v1 contract satisfied' };
        });
      },

      async setViewport(vpSpec) {
        const size = parseViewport(vpSpec);
        await page.setViewportSize(size);
        await withTimeout(
          page.evaluate(() => new Promise((resolve) => {
            if (window.__benchHostControl?.isRafOverrideActive?.()) {
              setTimeout(resolve, 16);
              return;
            }
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve();
              }
            };
            const t = setTimeout(finish, 250);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              clearTimeout(t);
              finish();
            }));
          })),
          5000,
          'setViewport paint wait',
        );
        return size;
      },

      async emulate({ reducedMotion: rm, colorScheme: cs, locale: loc } = {}) {
        const mediaOpts = {};
        if (rm !== undefined) {
          mediaOpts.reducedMotion = rm === 'reduce' || rm === true ? 'reduce' : 'no-preference';
        }
        if (cs !== undefined) {
          mediaOpts.colorScheme = cs === 'dark' ? 'dark' : 'light';
        }
        if (Object.keys(mediaOpts).length > 0) {
          await page.emulateMedia(mediaOpts);
        }
        if (typeof loc === 'string' && loc.length > 0) {
          await page.evaluate((lang) => {
            const langs = Object.freeze([lang, lang.split('-')[0]].filter((v, i, a) => v && a.indexOf(v) === i));
            try {
              Object.defineProperty(Navigator.prototype, 'language', {
                get() { return lang; },
                configurable: true,
              });
              Object.defineProperty(Navigator.prototype, 'languages', {
                get() { return langs; },
                configurable: true,
              });
            } catch {
              // ignore
            }
            window.dispatchEvent(new Event('languagechange'));
          }, loc);
        }
      },

      async movePointer(x, y) {
        await page.mouse.move(x, y);
      },

      async movePointerNormalized(nx, ny) {
        const size = page.viewportSize() || { width: 1440, height: 900 };
        await page.mouse.move(size.width * nx, size.height * ny);
      },

      async resizeSequence(viewports) {
        for (const vpSpec of viewports) {
          await handle.setViewport(vpSpec);
        }
      },

      async setSeed(newSeed, newParams) {
        await page.evaluate(([s, p]) => {
          window.__benchHostControl.setSeed(s, p);
          window.__bench.setSeed(s);
        }, [newSeed, newParams]);
      },

      async setParams(newParams) {
        await page.evaluate((p) => {
          window.__benchHostControl.setParams(p);
        }, newParams);
      },

      async seek(tMs) {
        await page.evaluate((t) => {
          window.__benchHostControl.freeze(t);
          window.__bench.seek(t);
        }, Number(tMs));
      },

      async resume() {
        await page.evaluate(() => {
          window.__benchHostControl.resume();
          window.__bench.resume();
        });
      },

      async resetClock(tMs = 0) {
        await page.evaluate((t) => {
          window.__benchHostControl.resetClock(t);
        }, Number(tMs));
      },

      async clockNow() {
        return page.evaluate(() => window.__benchHost.clock.now());
      },

      async renderFrame(timeoutMs = 15_000) {
        await withTimeout(
          page.evaluate(async (ms) => {
            let timer;
            const tp = new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`renderFrame timed out after ${ms} ms`)), ms);
            });
            try {
              await Promise.race([Promise.resolve(window.__bench.renderFrame()), tp]);
            } finally {
              clearTimeout(timer);
            }
          }, timeoutMs),
          timeoutMs + 2000,
          'renderFrame',
        );
      },

      async state() {
        return withTimeout(page.evaluate(() => window.__bench.state()), 10_000, 'bench.state');
      },

      async stats() {
        return withTimeout(page.evaluate(() => window.__bench.stats()), 10_000, 'bench.stats');
      },

      async screenshot(outPath = null, options = {}) {
        const buf = await page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'allow',
          timeout: 15_000,
          ...options,
        });
        if (outPath) {
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          await fs.writeFile(outPath, buf);
        }
        return buf;
      },

      async screenshotCdp(outPath = null) {
        const { data } = await withTimeout(
          cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
          10_000,
          'Page.captureScreenshot',
        );
        const buf = Buffer.from(data, 'base64');
        if (outPath) {
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          await fs.writeFile(outPath, buf);
        }
        return buf;
      },

      async installRafOverride() {
        await withTimeout(page.evaluate(() => window.__benchHostControl.installRafOverride()), 10_000, 'installRafOverride');
      },

      async uninstallRafOverride() {
        await withTimeout(page.evaluate(() => window.__benchHostControl.uninstallRafOverride()), 10_000, 'uninstallRafOverride');
      },

      async stepRafVirtual(durationMs, hz, startClockMs = null) {
        return withTimeout(
          page.evaluate(([dur, rate, start]) => {
            return window.__benchHostControl.stepRafVirtual(dur, rate, start);
          }, [Number(durationMs), Number(hz), startClockMs]),
          30_000,
          'stepRafVirtual',
        );
      },

      async virtualTimePause() {
        await withTimeout(cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }), 10_000, 'virtualTimePause');
      },

      async virtualTimeAdvance(budgetMs) {
        const budget = Number(budgetMs);
        let onExpired;
        const done = new Promise((resolve) => {
          onExpired = () => {
            cdp.off('Emulation.virtualTimeBudgetExpired', onExpired);
            resolve();
          };
          cdp.on('Emulation.virtualTimeBudgetExpired', onExpired);
        });
        try {
          await withTimeout(
            (async () => {
              await cdp.send('Emulation.setVirtualTimePolicy', {
                policy: 'pauseIfNetworkFetchesPending',
                budget,
              });
              await done;
            })(),
            Math.max(10_000, budget * 10),
            `virtualTimeAdvance(${budget}ms)`,
          );
        } finally {
          if (onExpired) cdp.off('Emulation.virtualTimeBudgetExpired', onExpired);
        }
      },

      async virtualTimeResume() {
        await withTimeout(cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' }), 10_000, 'virtualTimeResume');
      },

      async collectGarbageAndHeap() {
        try {
          await cdp.send('HeapProfiler.enable');
          await cdp.send('HeapProfiler.collectGarbage');
        } catch {
          // Best effort
        }
        const jsHeap = await page.evaluate(() => {
          if (performance && performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
            return performance.memory.usedJSHeapSize;
          }
          return null;
        });
        if (jsHeap !== null) {
          return { usedJSHeapSize: jsHeap, usedMB: jsHeap / (1024 * 1024) };
        }
        const usage = await cdp.send('Runtime.getHeapUsage');
        const used = Number(usage?.usedSize || 0);
        return { usedJSHeapSize: used, usedMB: used / (1024 * 1024) };
      },

      async getListenerCount() {
        return page.evaluate(() => window.__benchHostControl.getListenerCount());
      },

      async waitForFontsReady(timeoutMs = loadTimeoutMs) {
        return page.evaluate(async (ms) => {
          if (!document.fonts || !document.fonts.ready) {
            return { ok: true, count: 0 };
          }
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`document.fonts.ready timed out after ${ms} ms`)), ms);
          });
          try {
            await Promise.race([document.fonts.ready, timeoutPromise]);
            return { ok: true, count: document.fonts.size };
          } catch (err) {
            return { ok: false, error: String(err?.message || err) };
          } finally {
            clearTimeout(timer);
          }
        }, timeoutMs);
      },

      async close() {
        openContexts.delete(context);
        try {
          await cdp.detach();
        } catch {
          // ignore
        }
        try {
          await context.close();
        } catch {
          // ignore
        }
      },
    };

    if (url) {
      await handle.goto(url, { waitForBench: waitForReady, timeoutMs: loadTimeoutMs });
    }

    return handle;
  }

  return {
    mode,
    browser,
    newPage,
    async close() {
      for (const ctx of Array.from(openContexts)) {
        try {
          await ctx.close();
        } catch {
          // ignore
        }
      }
      openContexts.clear();
      await browser.close();
    },
  };
}
