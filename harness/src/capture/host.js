/**
 * In-page MoL-Bench host script injected via page.addInitScript BEFORE any room script runs.
 * Implements window.__benchHost (contract/bench.d.ts), EventTarget listener counting,
 * optional navigator.language override, and deterministic rAF scheduler override.
 */
(function initBenchHostScript() {
  if (window.__benchHostControl) return;

  const initConfig = window.__BENCH_HOST_INIT__ || {};

  // ---- Deterministic PRNG (mulberry32) ----
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
    // Murmur3 fmix32 finalizer for full avalanche
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
      next() {
        return gen();
      },
      int(n) {
        const limit = Math.floor(Number(n));
        if (!(limit > 0)) return 0;
        return Math.floor(gen() * limit);
      },
      fork(label) {
        return createRng(hashSeedLabel(baseSeed, label));
      },
    });
  }

  function deepCloneAndFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const arr = value.map(deepCloneAndFreeze);
      return Object.freeze(arr);
    }
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = deepCloneAndFreeze(value[k]);
    }
    return Object.freeze(out);
  }

  // ---- Locale override (if configured) ----
  if (typeof initConfig.locale === 'string' && initConfig.locale.length > 0) {
    const loc = initConfig.locale;
    const langs = Object.freeze([loc, loc.split('-')[0]].filter((v, i, a) => v && a.indexOf(v) === i));
    try {
      Object.defineProperty(Navigator.prototype, 'language', {
        get() { return loc; },
        configurable: true,
      });
      Object.defineProperty(Navigator.prototype, 'languages', {
        get() { return langs; },
        configurable: true,
      });
    } catch {
      // Ignore if environment forbids redefining Navigator properties
    }
  }

  // ---- EventTarget listener tracking ----
  const origAddEventListener = EventTarget.prototype.addEventListener;
  const origRemoveEventListener = EventTarget.prototype.removeEventListener;
  const listenerStore = new WeakMap();
  let activeListeners = 0;
  let internalListenerBypass = false;

  function normalizeCapture(options) {
    if (typeof options === 'boolean') return options;
    if (options && typeof options === 'object') return Boolean(options.capture);
    return false;
  }

  function getTargetRecords(target) {
    let map = listenerStore.get(target);
    if (!map) {
      map = new Map();
      listenerStore.set(target, map);
    }
    return map;
  }

  EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (internalListenerBypass || !listener || (typeof listener !== 'function' && typeof listener !== 'object')) {
      return origAddEventListener.call(this, type, listener, options);
    }
    const capture = normalizeCapture(options);
    const key = `${String(type)}::${capture ? '1' : '0'}`;
    const map = getTargetRecords(this);
    let entries = map.get(key);
    if (!entries) {
      entries = new Map();
      map.set(key, entries);
    }
    // DOM spec deduplicates identical (target, type, listener, capture)
    if (entries.has(listener)) {
      return origAddEventListener.call(this, type, listener, options);
    }

    const optsObj = options && typeof options === 'object' ? options : null;
    if (optsObj && optsObj.signal && optsObj.signal.aborted) {
      return origAddEventListener.call(this, type, listener, options);
    }

    const once = Boolean(optsObj && optsObj.once);
    const self = this;
    let actualListener = listener;
    let removed = false;

    const cleanup = () => {
      if (removed) return;
      removed = true;
      entries.delete(listener);
      if (entries.size === 0) map.delete(key);
      activeListeners = Math.max(0, activeListeners - 1);
    };

    if (once) {
      actualListener = function onceWrapper(event) {
        cleanup();
        if (typeof listener === 'function') {
          return listener.call(this, event);
        }
        if (listener && typeof listener.handleEvent === 'function') {
          return listener.handleEvent(event);
        }
      };
    }

    entries.set(listener, { actualListener, cleanup });
    activeListeners += 1;

    if (optsObj && optsObj.signal && typeof optsObj.signal.addEventListener === 'function') {
      internalListenerBypass = true;
      try {
        origAddEventListener.call(optsObj.signal, 'abort', cleanup, { once: true });
      } finally {
        internalListenerBypass = false;
      }
    }

    return origAddEventListener.call(self, type, actualListener, options);
  };

  EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(type, listener, options) {
    if (internalListenerBypass || !listener) {
      return origRemoveEventListener.call(this, type, listener, options);
    }
    const capture = normalizeCapture(options);
    const key = `${String(type)}::${capture ? '1' : '0'}`;
    const map = listenerStore.get(this);
    const entries = map && map.get(key);
    const record = entries && entries.get(listener);
    if (record) {
      const actual = record.actualListener;
      record.cleanup();
      return origRemoveEventListener.call(this, type, actual, options);
    }
    return origRemoveEventListener.call(this, type, listener, options);
  };

  // ---- Bench Clock ----
  const perfNow = () => performance.now();
  let clockMode = 'live'; // 'live' | 'frozen' | 'virtual'
  let liveBaseMs = 0;
  let liveStartPerfMs = perfNow();
  let frozenMs = 0;
  let virtualMs = 0;

  function clockNow() {
    if (clockMode === 'frozen') return frozenMs;
    if (clockMode === 'virtual') return virtualMs;
    return liveBaseMs + (perfNow() - liveStartPerfMs);
  }

  const benchClock = Object.freeze({
    now: clockNow,
  });

  // ---- Host State ----
  let currentSeed = (initConfig.seed !== undefined ? Number(initConfig.seed) : 1) >>> 0;
  let currentParams = deepCloneAndFreeze(initConfig.params || {});
  let currentRng = createRng(currentSeed);

  // ---- Deterministic rAF scheduler override ----
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  let rafOverrideActive = false;
  let rafNextId = 1;
  let rafQueue = new Map();

  function installRafOverride() {
    if (rafOverrideActive) return;
    rafOverrideActive = true;
    rafQueue.clear();
    window.requestAnimationFrame = function overriddenRAF(cb) {
      const id = rafNextId++;
      rafQueue.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = function overriddenCAF(id) {
      rafQueue.delete(id);
    };
  }

  function uninstallRafOverride() {
    if (!rafOverrideActive) return;
    rafOverrideActive = false;
    rafQueue.clear();
    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
  }

  function stepRafVirtual(durationMs, hz, startClockMs) {
    if (!rafOverrideActive) {
      installRafOverride();
    }
    const rate = Number(hz) > 0 ? Number(hz) : 60;
    const dt = 1000 / rate;
    const steps = Math.max(1, Math.round(Number(durationMs) / dt));
    const t0 = startClockMs !== undefined && startClockMs !== null ? Number(startClockMs) : clockNow();
    clockMode = 'virtual';
    virtualMs = t0;

    let invoked = 0;
    for (let i = 1; i <= steps; i++) {
      virtualMs = i === steps ? t0 + Number(durationMs) : t0 + i * dt;
      const batch = Array.from(rafQueue.entries());
      rafQueue.clear();
      for (let j = 0; j < batch.length; j++) {
        const [, cb] = batch[j];
        if (typeof cb === 'function') {
          invoked += 1;
          cb(virtualMs);
        }
      }
    }
    return { steps, invoked, finalClockMs: virtualMs };
  }

  // ---- Expose window.__benchHost (contract/bench.d.ts) ----
  const benchHost = {};
  Object.defineProperties(benchHost, {
    contractVersion: { value: 1, enumerable: true, writable: false, configurable: false },
    seed: { get() { return currentSeed; }, enumerable: true, configurable: false },
    params: { get() { return currentParams; }, enumerable: true, configurable: false },
    clock: { value: benchClock, enumerable: true, writable: false, configurable: false },
    rng: { get() { return currentRng; }, enumerable: true, configurable: false },
  });
  Object.freeze(benchHost);

  Object.defineProperty(window, '__benchHost', {
    value: benchHost,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  // ---- Internal harness control API (non-enumerable) ----
  const control = Object.freeze({
    setSeed(seed, params) {
      currentSeed = Number(seed) >>> 0;
      currentRng = createRng(currentSeed);
      if (params !== undefined) {
        currentParams = deepCloneAndFreeze(params || {});
      }
    },
    setParams(params) {
      currentParams = deepCloneAndFreeze(params || {});
    },
    freeze(tMs) {
      clockMode = 'frozen';
      frozenMs = Number(tMs);
    },
    resume() {
      const current = clockNow();
      liveBaseMs = current;
      liveStartPerfMs = perfNow();
      clockMode = 'live';
    },
    resetClock(tMs = 0) {
      liveBaseMs = Number(tMs);
      liveStartPerfMs = perfNow();
      frozenMs = Number(tMs);
      virtualMs = Number(tMs);
      clockMode = 'live';
    },
    setVirtualClock(tMs) {
      clockMode = 'virtual';
      virtualMs = Number(tMs);
    },
    advanceVirtualClock(dtMs) {
      if (clockMode !== 'virtual') {
        virtualMs = clockNow();
        clockMode = 'virtual';
      }
      virtualMs += Number(dtMs);
      return virtualMs;
    },
    getClockMode() {
      return clockMode;
    },
    getListenerCount() {
      return activeListeners;
    },
    installRafOverride,
    uninstallRafOverride,
    stepRafVirtual,
    isRafOverrideActive() {
      return rafOverrideActive;
    },
    getQueuedRafCount() {
      return rafQueue.size;
    },
    setInternalBypass(flag) {
      internalListenerBypass = Boolean(flag);
    },
  });

  Object.defineProperty(window, '__benchHostControl', {
    value: control,
    enumerable: false,
    writable: false,
    configurable: false,
  });
})();
