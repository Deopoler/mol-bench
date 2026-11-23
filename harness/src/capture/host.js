/**
 * In-page MoL-Bench host script injected via page.addInitScript BEFORE any room script runs.
 * Implements window.__benchHost (contract/bench.d.ts), EventTarget listener counting,
 * optional navigator.language override, and deterministic rAF scheduler override.
 */
(function initBenchHostScript() {
  if (window.__benchHostControl) return;

  const initConfig = window.__BENCH_HOST_INIT__ || {};
  try {
    delete window.__BENCH_HOST_INIT__;
  } catch {
    window.__BENCH_HOST_INIT__ = undefined;
  }

  const controlSecret =
    typeof initConfig.controlSecret === 'string' && initConfig.controlSecret.length > 0
      ? initConfig.controlSecret
      : null;

  const tamperEvents = [];
  function recordTamper(method, reason = 'unauthorized_call') {
    if (tamperEvents.length < 100) {
      tamperEvents.push({
        method: String(method || 'unknown'),
        reason: String(reason || 'unauthorized_call'),
        t: Date.now(),
      });
    }
  }
  function verifySecret(provided, method) {
    if (controlSecret === null) return true;
    if (provided === controlSecret) return true;
    recordTamper(method, 'unauthorized_mutator_call');
    return false;
  }

  // ---- Stub navigator.gpu & track unhooked rendering channels ----
  const unhookedState = {
    workerCount: 0,
    offscreenTransfers: 0,
    canvas2dCount: 0,
    bitmapRendererCount: 0,
    webgpuAttempts: 0,
    reasons: new Set(),
  };
  const hookedCanvases = new WeakSet();

  function addUnhookedReason(reason) {
    if (reason) unhookedState.reasons.add(reason);
  }

  if (initConfig.disableWebGpu !== false) {
    try {
      if (typeof Navigator !== 'undefined') {
        Object.defineProperty(Navigator.prototype, 'gpu', {
          get() { return undefined; },
          configurable: false,
        });
      }
    } catch {
      try {
        Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: false });
      } catch {
        // ignore if already non-configurable
      }
    }
    try {
      if (typeof WorkerNavigator !== 'undefined') {
        Object.defineProperty(WorkerNavigator.prototype, 'gpu', {
          get() { return undefined; },
          configurable: false,
        });
      }
    } catch {
      // ignore
    }
  }

  if (typeof window.Worker === 'function') {
    const OrigWorker = window.Worker;
    window.Worker = function PatchedWorker(...args) {
      unhookedState.workerCount += 1;
      addUnhookedReason('worker_created');
      return new OrigWorker(...args);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }
  if (typeof window.SharedWorker === 'function') {
    const OrigSharedWorker = window.SharedWorker;
    window.SharedWorker = function PatchedSharedWorker(...args) {
      unhookedState.workerCount += 1;
      addUnhookedReason('worker_created');
      return new OrigSharedWorker(...args);
    };
    window.SharedWorker.prototype = OrigSharedWorker.prototype;
  }
  if (typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function') {
    const origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function patchedTransferControlToOffscreen(...args) {
      unhookedState.offscreenTransfers += 1;
      addUnhookedReason('offscreen_canvas_transferred');
      hookedCanvases.add(this);
      return origTransfer.apply(this, args);
    };
  }

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

  // ---- WebGL2 / WebGL1 Interceptors ----
  const glState = {
    drawCalls: 0,
    verticesDrawn: 0,
    trianglesDrawn: 0,
    glCalls: 0,
    fboSwitches: 0,
    bindFramebufferCalls: 0,
    drawPasses: 0,
    pixelFillRatio: 0,
    totalUploadBytes: 0,
    frameUploadBytes: 0,
    boundFbo: null,
    lastDrawnFbo: undefined,
    hasDrawnInFrame: false,
    currentProgram: null,
    usedProgramIds: new Set(),
    renderers: [],
  };
  const shaderInfo = new WeakMap();
  const programInfo = new WeakMap();
  const textureSizes = new WeakMap();
  const renderbufferSizes = new WeakMap();
  const fboAttachments = new WeakMap();
  const linkedPrograms = [];
  let nextProgramId = 1;
  let lastViewport = null;

  function computeTriangles(gl, mode, vertCountPerInstance, instances = 1) {
    const v = Math.max(0, Number(vertCountPerInstance) || 0);
    const inst = Math.max(1, Number(instances) || 1);
    const tri = gl?.TRIANGLES ?? 4;
    const strip = gl?.TRIANGLE_STRIP ?? 5;
    const fan = gl?.TRIANGLE_FAN ?? 6;
    if (mode === tri) return Math.floor(v / 3) * inst;
    if (mode === strip || mode === fan) return (v >= 3 ? v - 2 : 0) * inst;
    return 0;
  }

  function getBoundFbo(gl) {
    return glState.boundFbo;
  }

  function getFboTargetSize(gl, fbo) {
    if (fbo) {
      const att = fboAttachments.get(fbo);
      if (att && att.width > 0 && att.height > 0) {
        return { width: att.width, height: att.height };
      }
    }
    if (lastViewport && lastViewport.width > 0 && lastViewport.height > 0) {
      return { width: lastViewport.width, height: lastViewport.height };
    }
    return {
      width: Math.max(1, gl.drawingBufferWidth || gl.canvas?.width || 1),
      height: Math.max(1, gl.drawingBufferHeight || gl.canvas?.height || 1),
    };
  }

  function recordDrawCall(gl, mode, vertCountPerInstance, instances = 1) {
    const verts = Math.max(0, Number(vertCountPerInstance) || 0) * Math.max(1, Number(instances) || 1);
    const tris = computeTriangles(gl, mode, vertCountPerInstance, instances);
    glState.drawCalls += 1;
    glState.verticesDrawn += verts;
    glState.trianglesDrawn += tris;
    if (glState.currentProgram) {
      const pInfo = programInfo.get(glState.currentProgram);
      if (pInfo) {
        glState.usedProgramIds.add(pInfo.programId);
        pInfo.usedInFrame = true;
        pInfo.frameDrawCalls += 1;
        pInfo.frameVerticesDrawn += verts;
        pInfo.frameTrianglesDrawn += tris;
      }
    }
    const fbo = getBoundFbo(gl);
    if (!glState.hasDrawnInFrame || fbo !== glState.lastDrawnFbo) {
      glState.hasDrawnInFrame = true;
      glState.lastDrawnFbo = fbo;
      glState.drawPasses += 1;
      const vpW = Math.max(1, gl.drawingBufferWidth || gl.canvas?.width || 1);
      const vpH = Math.max(1, gl.drawingBufferHeight || gl.canvas?.height || 1);
      const targetSize = getFboTargetSize(gl, fbo);
      glState.pixelFillRatio += (targetSize.width * targetSize.height) / (vpW * vpH);
    }
  }

  function estimateSourceUploadBytes(source) {
    if (!source) return 0;
    if (typeof source.byteLength === 'number') return source.byteLength;
    if (source.data && typeof source.data.byteLength === 'number') return source.data.byteLength;
    const w = source.width || source.videoWidth || source.naturalWidth || 0;
    const h = source.height || source.videoHeight || source.naturalHeight || 0;
    return w > 0 && h > 0 ? w * h * 4 : 0;
  }

  function computeBufferUploadBytes(srcData, srcOffset, length) {
    if (typeof srcData === 'number') return Math.max(0, srcData);
    if (!srcData) return 0;
    if (ArrayBuffer.isView(srcData)) {
      if (typeof length === 'number' && length >= 0) {
        return length * (srcData.BYTES_PER_ELEMENT || 1);
      }
      if (typeof srcOffset === 'number' && srcOffset > 0) {
        return Math.max(0, srcData.byteLength - srcOffset * (srcData.BYTES_PER_ELEMENT || 1));
      }
      return srcData.byteLength;
    }
    if (srcData instanceof ArrayBuffer) return srcData.byteLength;
    return 0;
  }

  function computeTexUploadBytes(gl, args, isSub) {
    // 6-arg (texImage2D) or 7-arg (texSubImage2D): last arg is TexImageSource
    if ((!isSub && args.length === 6) || (isSub && args.length === 7)) {
      return estimateSourceUploadBytes(args[args.length - 1]);
    }
    // 9-arg or 10-arg: (..., width, height, [border,] format, type, pixelsOrOffset, [srcOffset])
    const width = Number(args[3]) || 0;
    const height = Number(args[4]) || 0;
    const pixels = args[isSub ? 8 : 8];
    const srcOffset = args[9];
    if (pixels === null || pixels === undefined || typeof pixels === 'number') {
      // null allocation for FBO backing or PBO offset -> 0 CPU byte upload
      return 0;
    }
    if (ArrayBuffer.isView(pixels)) {
      const bpe = pixels.BYTES_PER_ELEMENT || 1;
      if (typeof srcOffset === 'number' && srcOffset > 0) {
        return Math.max(0, pixels.byteLength - srcOffset * bpe);
      }
      return pixels.byteLength;
    }
    if (pixels instanceof ArrayBuffer) {
      return pixels.byteLength;
    }
    return estimateSourceUploadBytes(pixels) || Math.max(0, width * height * 4);
  }

  function patchWebGLPrototype(proto) {
    if (!proto) return;
    const boundTexture2D = new WeakMap();
    const boundRenderbuffer = new WeakMap();

    const keys = Object.getOwnPropertyNames(proto);
    for (const key of keys) {
      if (key === 'constructor') continue;
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(proto, key);
      } catch {
        continue;
      }
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) continue;
      const orig = desc.value;

      proto[key] = function patchedGLMethod(...args) {
        glState.glCalls += 1;
        try {
          if (key === 'drawArrays') {
            recordDrawCall(this, args[0], args[2], 1);
          } else if (key === 'drawElements') {
            recordDrawCall(this, args[0], args[1], 1);
          } else if (key === 'drawArraysInstanced') {
            recordDrawCall(this, args[0], args[2], args[3]);
          } else if (key === 'drawElementsInstanced') {
            recordDrawCall(this, args[0], args[1], args[4]);
          } else if (key === 'drawRangeElements') {
            recordDrawCall(this, args[0], args[3], 1);
          } else if (key === 'bindFramebuffer') {
            const target = args[0];
            const fb = args[1] || null;
            glState.bindFramebufferCalls += 1;
            if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) {
              if (fb !== glState.boundFbo) {
                glState.fboSwitches += 1;
                glState.boundFbo = fb;
              }
            }
          } else if (key === 'viewport') {
            lastViewport = { width: Number(args[2]) || 0, height: Number(args[3]) || 0 };
          } else if (key === 'bindTexture') {
            if (args[0] === this.TEXTURE_2D) {
              boundTexture2D.set(this, args[1] || null);
            }
          } else if (key === 'bindRenderbuffer') {
            if (args[0] === this.RENDERBUFFER) {
              boundRenderbuffer.set(this, args[1] || null);
            }
          } else if (key === 'texImage2D') {
            const bytes = computeTexUploadBytes(this, args, false);
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
            const tex = boundTexture2D.get(this);
            if (tex && args.length >= 6) {
              const w = args.length === 6 ? (args[5]?.width || 0) : (Number(args[3]) || 0);
              const h = args.length === 6 ? (args[5]?.height || 0) : (Number(args[4]) || 0);
              if (w > 0 && h > 0) textureSizes.set(tex, { width: w, height: h });
            }
          } else if (key === 'texSubImage2D') {
            const bytes = computeTexUploadBytes(this, args, true);
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'texStorage2D') {
            const tex = boundTexture2D.get(this);
            const w = Number(args[3]) || 0;
            const h = Number(args[4]) || 0;
            if (tex && w > 0 && h > 0) textureSizes.set(tex, { width: w, height: h });
          } else if (key === 'renderbufferStorage' || key === 'renderbufferStorageMultisample') {
            const rb = boundRenderbuffer.get(this);
            const w = key === 'renderbufferStorage' ? Number(args[2]) : Number(args[3]);
            const h = key === 'renderbufferStorage' ? Number(args[3]) : Number(args[4]);
            if (rb && w > 0 && h > 0) renderbufferSizes.set(rb, { width: w, height: h });
          } else if (key === 'framebufferTexture2D') {
            const fbo = glState.boundFbo;
            const tex = args[3];
            if (fbo && tex) {
              const sz = textureSizes.get(tex);
              if (sz) fboAttachments.set(fbo, sz);
            }
          } else if (key === 'framebufferRenderbuffer') {
            const fbo = glState.boundFbo;
            const rb = args[3];
            if (fbo && rb) {
              const sz = renderbufferSizes.get(rb);
              if (sz) fboAttachments.set(fbo, sz);
            }
          } else if (key === 'bufferData') {
            const bytes = computeBufferUploadBytes(args[1], args[3], args[4]);
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'bufferSubData') {
            const bytes = computeBufferUploadBytes(args[2], args[3], args[4]);
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'copyBufferSubData') {
            const bytes = Math.max(0, Number(args[4]) || 0);
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'texImage3D') {
            // (target, level, internalformat, width, height, depth, border, format, type, srcData[, srcOffset])
            const srcData = args[9];
            const srcOffset = args[10];
            let bytes = 0;
            if (ArrayBuffer.isView(srcData)) {
              const bpe = srcData.BYTES_PER_ELEMENT || 1;
              bytes = typeof srcOffset === 'number' && srcOffset > 0
                ? Math.max(0, srcData.byteLength - srcOffset * bpe)
                : srcData.byteLength;
            } else if (srcData instanceof ArrayBuffer) {
              bytes = srcData.byteLength;
            } else if (srcData !== null && srcData !== undefined && typeof srcData !== 'number') {
              bytes = estimateSourceUploadBytes(srcData);
            }
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'texSubImage3D') {
            // (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, srcData[, srcOffset])
            const srcData = args[10];
            const srcOffset = args[11];
            let bytes = 0;
            if (ArrayBuffer.isView(srcData)) {
              const bpe = srcData.BYTES_PER_ELEMENT || 1;
              bytes = typeof srcOffset === 'number' && srcOffset > 0
                ? Math.max(0, srcData.byteLength - srcOffset * bpe)
                : srcData.byteLength;
            } else if (srcData instanceof ArrayBuffer) {
              bytes = srcData.byteLength;
            } else if (srcData !== null && srcData !== undefined && typeof srcData !== 'number') {
              bytes = estimateSourceUploadBytes(srcData);
            }
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'compressedTexImage2D' || key === 'compressedTexSubImage2D') {
            // 7 args: (..., srcData) or 8/9 args WebGL2: (..., srcData, srcOffset, srcLengthOverride) or (..., imageSize, offset)
            let bytes = 0;
            const lastOrView = [args[6], args[7], args[8]].find((a) => ArrayBuffer.isView(a) || a instanceof ArrayBuffer);
            if (ArrayBuffer.isView(lastOrView)) {
              const bpe = lastOrView.BYTES_PER_ELEMENT || 1;
              const srcOffset = typeof args[7] === 'number' ? args[7] : 0;
              const srcLen = typeof args[8] === 'number' && args[8] > 0 ? args[8] * bpe : null;
              bytes = srcLen !== null
                ? Math.min(lastOrView.byteLength, srcLen)
                : Math.max(0, lastOrView.byteLength - srcOffset * bpe);
            } else if (lastOrView instanceof ArrayBuffer) {
              bytes = lastOrView.byteLength;
            }
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'compressedTexImage3D' || key === 'compressedTexSubImage3D') {
            let bytes = 0;
            const viewArg = [args[7], args[8], args[9]].find((a) => ArrayBuffer.isView(a) || a instanceof ArrayBuffer);
            if (ArrayBuffer.isView(viewArg)) {
              const bpe = viewArg.BYTES_PER_ELEMENT || 1;
              const srcOffset = typeof args[8] === 'number' ? args[8] : (typeof args[9] === 'number' ? args[9] : 0);
              const srcLen = typeof args[9] === 'number' && viewArg === args[8] && args[9] > 0 ? args[9] * bpe : null;
              bytes = srcLen !== null
                ? Math.min(viewArg.byteLength, srcLen)
                : Math.max(0, viewArg.byteLength - srcOffset * bpe);
            } else if (viewArg instanceof ArrayBuffer) {
              bytes = viewArg.byteLength;
            }
            glState.totalUploadBytes += bytes;
            glState.frameUploadBytes += bytes;
          } else if (key === 'shaderSource') {
            const shader = args[0];
            const src = String(args[1] || '');
            const existing = shaderInfo.get(shader) || { type: null, source: '' };
            existing.source = src;
            shaderInfo.set(shader, existing);
          } else if (key === 'attachShader') {
            const prog = args[0];
            const shader = args[1];
            let p = programInfo.get(prog);
            if (!p) {
              p = {
                programId: nextProgramId++,
                shaders: new Set(),
                linked: false,
                usedInFrame: false,
                frameDrawCalls: 0,
                frameVerticesDrawn: 0,
                frameTrianglesDrawn: 0,
                vertexSource: null,
                fragmentSource: null,
              };
              programInfo.set(prog, p);
            }
            p.shaders.add(shader);
          } else if (key === 'detachShader') {
            const p = programInfo.get(args[0]);
            if (p) p.shaders.delete(args[1]);
          } else if (key === 'useProgram') {
            glState.currentProgram = args[0] || null;
          }
        } catch {
          // Never interfere with underlying GL call
        }

        const ret = orig.apply(this, args);

        try {
          if (key === 'createShader' && ret) {
            shaderInfo.set(ret, { type: args[0], source: '' });
          } else if (key === 'createProgram' && ret) {
            programInfo.set(ret, {
              programId: nextProgramId++,
              shaders: new Set(),
              linked: false,
              usedInFrame: false,
              frameDrawCalls: 0,
              frameVerticesDrawn: 0,
              frameTrianglesDrawn: 0,
              vertexSource: null,
              fragmentSource: null,
            });
          } else if (key === 'linkProgram') {
            const prog = args[0];
            let p = programInfo.get(prog);
            if (!p) {
              p = {
                programId: nextProgramId++,
                shaders: new Set(),
                linked: false,
                usedInFrame: false,
                frameDrawCalls: 0,
                frameVerticesDrawn: 0,
                frameTrianglesDrawn: 0,
                vertexSource: null,
                fragmentSource: null,
              };
              programInfo.set(prog, p);
            }
            p.linked = true;
            let vs = null;
            let fs = null;
            for (const sh of p.shaders) {
              const info = shaderInfo.get(sh);
              if (!info) continue;
              if (info.type === this.VERTEX_SHADER) vs = info.source;
              else if (info.type === this.FRAGMENT_SHADER) fs = info.source;
            }
            p.vertexSource = vs;
            p.fragmentSource = fs;
            const entry = {
              programId: p.programId,
              ref: p,
              linked: true,
              vertexSource: vs,
              fragmentSource: fs,
            };
            const idx = linkedPrograms.findIndex((x) => x.programId === p.programId);
            if (idx >= 0) linkedPrograms[idx] = entry;
            else linkedPrograms.push(entry);
          }
        } catch {
          // ignore
        }

        return ret;
      };
    }
  }

  if (typeof WebGLRenderingContext !== 'undefined') {
    patchWebGLPrototype(WebGLRenderingContext.prototype);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchWebGLPrototype(WebGL2RenderingContext.prototype);
  }

  const capturedContexts = new WeakSet();
  const wrappedExtensionContexts = new WeakSet();

  function patchContextExtensions(ctx) {
    if (!ctx || wrappedExtensionContexts.has(ctx) || typeof ctx.getExtension !== 'function') return;
    wrappedExtensionContexts.add(ctx);
    const origGetExt = ctx.getExtension;
    ctx.getExtension = function patchedGetExtension(name, ...rest) {
      const ext = origGetExt.call(this, name, ...rest);
      if (!ext || ext.__molPatched) return ext;
      const extName = String(name || '');
      if (extName === 'ANGLE_instanced_arrays') {
        if (typeof ext.drawArraysInstancedANGLE === 'function') {
          const orig = ext.drawArraysInstancedANGLE;
          ext.drawArraysInstancedANGLE = function patchedDrawArraysInstancedANGLE(mode, first, count, primcount) {
            glState.glCalls += 1;
            recordDrawCall(ctx, mode, count, primcount);
            return orig.call(this, mode, first, count, primcount);
          };
        }
        if (typeof ext.drawElementsInstancedANGLE === 'function') {
          const orig = ext.drawElementsInstancedANGLE;
          ext.drawElementsInstancedANGLE = function patchedDrawElementsInstancedANGLE(mode, count, type, offset, primcount) {
            glState.glCalls += 1;
            recordDrawCall(ctx, mode, count, primcount);
            return orig.call(this, mode, count, type, offset, primcount);
          };
        }
        try { Object.defineProperty(ext, '__molPatched', { value: true }); } catch { /* ignore */ }
      } else if (extName === 'WEBGL_multi_draw' || extName === 'WEBGL_multi_draw_instanced') {
        const wrapMulti = (fnName, instanced) => {
          if (typeof ext[fnName] !== 'function') return;
          const orig = ext[fnName];
          ext[fnName] = function patchedMultiDraw(mode, firstsOrCounts, fOff, countsOrTypes, cOff, offsetsOrDrawcount, oOff, instCounts, iOff, dcArg) {
            glState.glCalls += 1;
            try {
              const isElements = fnName.includes('Elements');
              const countsList = isElements ? firstsOrCounts : countsOrTypes;
              const countsOffset = isElements ? fOff : cOff;
              const drawcount = isElements
                ? (instanced ? dcArg : oOff)
                : (instanced ? oOff : offsetsOrDrawcount);
              const dc = Math.max(0, Number(drawcount) || 0);
              for (let i = 0; i < dc; i++) {
                const cVal = Number(countsList?.[countsOffset + i] || 0);
                const instVal = instanced ? Math.max(1, Number(offsetsOrDrawcount?.[oOff + i] ?? instCounts?.[iOff + i] ?? 1)) : 1;
                recordDrawCall(ctx, mode, cVal, instVal);
              }
            } catch {
              // ignore
            }
            return orig.apply(this, arguments);
          };
        };
        wrapMulti('multiDrawArraysWEBGL', false);
        wrapMulti('multiDrawElementsWEBGL', false);
        wrapMulti('multiDrawArraysInstancedWEBGL', true);
        wrapMulti('multiDrawElementsInstancedWEBGL', true);
        try { Object.defineProperty(ext, '__molPatched', { value: true }); } catch { /* ignore */ }
      } else if (extName === 'OES_vertex_array_object') {
        for (const m of ['createVertexArrayOES', 'deleteVertexArrayOES', 'isVertexArrayOES', 'bindVertexArrayOES']) {
          if (typeof ext[m] === 'function') {
            const orig = ext[m];
            ext[m] = function patchedVaoMethod(...a) {
              glState.glCalls += 1;
              return orig.apply(this, a);
            };
          }
        }
        try { Object.defineProperty(ext, '__molPatched', { value: true }); } catch { /* ignore */ }
      }
      return ext;
    };
  }

  function wrapGetContext(proto) {
    if (!proto || typeof proto.getContext !== 'function') return;
    const origGetContext = proto.getContext;
    proto.getContext = function patchedGetContext(type, ...rest) {
      const lowerType = String(type || '').toLowerCase();
      if (lowerType === 'webgpu' || lowerType === 'gpupresent') {
        unhookedState.webgpuAttempts += 1;
        addUnhookedReason('webgpu_context');
        hookedCanvases.add(this);
        return null;
      }
      const ctx = origGetContext.call(this, type, ...rest);
      if (ctx) {
        hookedCanvases.add(this);
        if (lowerType === '2d') {
          unhookedState.canvas2dCount += 1;
          addUnhookedReason('canvas_2d');
        } else if (lowerType === 'bitmaprenderer') {
          unhookedState.bitmapRendererCount += 1;
          addUnhookedReason('canvas_bitmaprenderer');
        } else if (
          !capturedContexts.has(ctx) &&
          (lowerType === 'webgl' || lowerType === 'webgl2' || lowerType === 'experimental-webgl')
        ) {
          capturedContexts.add(ctx);
          patchContextExtensions(ctx);
          try {
            const dbg = origGetExtSafe(ctx, 'WEBGL_debug_renderer_info');
            const renderer = dbg
              ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
              : ctx.getParameter(ctx.RENDERER);
            if (renderer && !glState.renderers.includes(String(renderer))) {
              glState.renderers.push(String(renderer));
            }
          } catch {
            // ignore
          }
        }
      }
      return ctx;
    };
  }
  function origGetExtSafe(ctx, name) {
    try { return ctx.getExtension(name); } catch { return null; }
  }
  if (typeof HTMLCanvasElement !== 'undefined') wrapGetContext(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrapGetContext(OffscreenCanvas.prototype);

  function resetWebGLFrameMetrics(secret) {
    if (!verifySecret(secret, 'resetWebGLFrameMetrics')) return;
    glState.drawCalls = 0;
    glState.verticesDrawn = 0;
    glState.trianglesDrawn = 0;
    glState.glCalls = 0;
    glState.fboSwitches = 0;
    glState.bindFramebufferCalls = 0;
    glState.drawPasses = 0;
    glState.pixelFillRatio = 0;
    glState.frameUploadBytes = 0;
    glState.lastDrawnFbo = undefined;
    glState.hasDrawnInFrame = false;
    glState.usedProgramIds.clear();
    for (const lp of linkedPrograms) {
      if (lp.ref) {
        lp.ref.usedInFrame = false;
        lp.ref.frameDrawCalls = 0;
        lp.ref.frameVerticesDrawn = 0;
        lp.ref.frameTrianglesDrawn = 0;
      }
    }
  }

  function serializeProgramEntry(lp) {
    return {
      programId: lp.programId,
      linked: lp.linked,
      vertexSource: lp.vertexSource,
      fragmentSource: lp.fragmentSource,
      drawCalls: lp.ref?.frameDrawCalls ?? 0,
      verticesDrawn: lp.ref?.frameVerticesDrawn ?? 0,
      trianglesDrawn: lp.ref?.frameTrianglesDrawn ?? 0,
    };
  }

  function getWebGLMetrics() {
    const activeShaders = linkedPrograms
      .filter((p) => glState.usedProgramIds.has(p.programId))
      .map(serializeProgramEntry);
    return {
      drawCalls: glState.drawCalls,
      verticesDrawn: glState.verticesDrawn,
      trianglesDrawn: glState.trianglesDrawn,
      glCalls: glState.glCalls,
      fboSwitches: glState.fboSwitches,
      bindFramebufferCalls: glState.bindFramebufferCalls,
      drawPasses: glState.drawPasses,
      pixelFillRatio: Number(glState.pixelFillRatio.toFixed(6)),
      renderPasses: Number((glState.fboSwitches + glState.pixelFillRatio).toFixed(6)),
      totalUploadBytes: glState.totalUploadBytes,
      frameUploadBytes: glState.frameUploadBytes,
      texUploadKb: Number((glState.totalUploadBytes / 1024).toFixed(4)),
      frameUploadKb: Number((glState.frameUploadBytes / 1024).toFixed(4)),
      activeShaders,
      linkedPrograms: linkedPrograms.map(serializeProgramEntry),
      renderers: [...glState.renderers],
    };
  }

  // ---- DOM Interceptors (MutationObserver, Forced Layout Reads, CLS) ----
  let internalDomBypass = false;
  let domSteps = 0;
  let domMutations = 0;
  let domAddedNodes = 0;
  let domRemovedNodes = 0;
  let layoutReads = 0;
  let clsValue = 0;
  let clsTotal = 0;
  let clsEntriesCount = 0;

  let mutationObserver = null;
  const observedDomRoots = typeof WeakSet === 'function' ? new WeakSet() : null;

  function observeDomRoot(root) {
    if (!mutationObserver || !root || (observedDomRoots && observedDomRoots.has(root))) return;
    try {
      mutationObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      if (observedDomRoots) observedDomRoots.add(root);
    } catch {
      // ignore unobservable roots
    }
  }

  function scanShadowRootsInSubtree(rootNode) {
    if (!rootNode || !mutationObserver) return;
    try {
      if (rootNode.shadowRoot && rootNode.shadowRoot.mode !== 'closed') {
        observeDomRoot(rootNode.shadowRoot);
        scanShadowRootsInSubtree(rootNode.shadowRoot);
      }
      if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && (rootNode.nodeType === 1 || rootNode.nodeType === 11)) {
        const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
        let n = walker.nextNode();
        while (n) {
          if (n.shadowRoot && n.shadowRoot.mode !== 'closed') {
            observeDomRoot(n.shadowRoot);
            scanShadowRootsInSubtree(n.shadowRoot);
          }
          n = walker.nextNode();
        }
      }
    } catch {
      // ignore
    }
  }

  function processMutationRecords(records) {
    if (!records || records.length === 0 || internalDomBypass) return;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.type === 'childList') {
        const addedList = rec.addedNodes;
        const added = addedList ? addedList.length : 0;
        const removed = rec.removedNodes ? rec.removedNodes.length : 0;
        domAddedNodes += added;
        domRemovedNodes += removed;
        domMutations += added + removed;
        if (addedList) {
          for (let j = 0; j < addedList.length; j++) {
            const node = addedList[j];
            if (node && node.nodeType === 1) {
              scanShadowRootsInSubtree(node);
            }
          }
        }
      } else if (rec.type === 'attributes' || rec.type === 'characterData') {
        domMutations += 1;
      }
    }
  }

  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    try {
      mutationObserver = new MutationObserver(processMutationRecords);
      observeDomRoot(document);
    } catch {
      mutationObserver = null;
    }
  }

  if (typeof Element !== 'undefined' && typeof Element.prototype.attachShadow === 'function') {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function patchedAttachShadow(init, ...rest) {
      const sr = origAttachShadow.call(this, init, ...rest);
      if (sr && (!init || init.mode !== 'closed')) {
        observeDomRoot(sr);
      }
      return sr;
    };
  }

  function wrapLayoutMethod(target, prop) {
    if (!target || typeof target[prop] !== 'function') return;
    const orig = target[prop];
    target[prop] = function patchedLayoutMethod(...args) {
      if (!internalDomBypass) layoutReads += 1;
      return orig.apply(this, args);
    };
  }

  function wrapLayoutGetter(proto, prop) {
    if (!proto) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && typeof desc.get === 'function' && desc.configurable) {
        const origGet = desc.get;
        Object.defineProperty(proto, prop, {
          ...desc,
          get() {
            if (!internalDomBypass) layoutReads += 1;
            return origGet.call(this);
          },
        });
      }
    } catch {
      // ignore
    }
  }

  if (typeof Element !== 'undefined') {
    wrapLayoutMethod(Element.prototype, 'getBoundingClientRect');
    wrapLayoutMethod(Element.prototype, 'getClientRects');
    for (const p of ['clientWidth', 'clientHeight', 'clientLeft', 'clientTop', 'scrollWidth', 'scrollHeight', 'scrollLeft', 'scrollTop']) {
      wrapLayoutGetter(Element.prototype, p);
    }
  }
  if (typeof HTMLElement !== 'undefined') {
    for (const p of ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop', 'offsetParent', 'innerText']) {
      wrapLayoutGetter(HTMLElement.prototype, p);
    }
  }
  if (typeof Document !== 'undefined') {
    wrapLayoutMethod(Document.prototype, 'elementFromPoint');
  }
  if (typeof ShadowRoot !== 'undefined') {
    wrapLayoutMethod(ShadowRoot.prototype, 'elementFromPoint');
  }
  if (typeof Range !== 'undefined') {
    wrapLayoutMethod(Range.prototype, 'getBoundingClientRect');
    wrapLayoutMethod(Range.prototype, 'getClientRects');
  }
  if (typeof SVGGraphicsElement !== 'undefined') {
    wrapLayoutMethod(SVGGraphicsElement.prototype, 'getBBox');
  }
  wrapLayoutMethod(window, 'getComputedStyle');

  function processClsEntries(entries) {
    if (!entries) return;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const val = Number(entry?.value || 0);
      if (!(val > 0)) continue;
      clsTotal += val;
      clsEntriesCount += 1;
      if (!entry.hadRecentInput) {
        clsValue += val;
      }
    }
  }

  let clsObserver = null;
  if (typeof PerformanceObserver === 'function') {
    try {
      clsObserver = new PerformanceObserver((list) => {
        processClsEntries(list.getEntries());
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch {
      clsObserver = null;
    }
  }

  function resetDomMetrics(opts = {}, secret) {
    if (!verifySecret(secret, 'resetDomMetrics')) return;
    if (mutationObserver) mutationObserver.takeRecords();
    domSteps = typeof opts?.steps === 'number' && opts.steps >= 0 ? opts.steps : 0;
    domMutations = 0;
    domAddedNodes = 0;
    domRemovedNodes = 0;
    layoutReads = 0;
    if (opts && opts.resetCls) {
      if (clsObserver && typeof clsObserver.takeRecords === 'function') {
        clsObserver.takeRecords();
      }
      clsValue = 0;
      clsTotal = 0;
      clsEntriesCount = 0;
    }
  }

  function markDomStep(count = 1, secret) {
    if (!verifySecret(secret, 'markDomStep')) return domSteps;
    domSteps += Math.max(0, Number(count) || 0);
    return domSteps;
  }

  function countDeepDomNodes(rootDoc) {
    if (!rootDoc || !rootDoc.documentElement || typeof document.createTreeWalker !== 'function') {
      return typeof document !== 'undefined' && document.documentElement
        ? document.getElementsByTagName('*').length
        : 0;
    }
    let count = 0;
    const visitRoot = (root) => {
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = root.nodeType === 1 ? root : walker.nextNode();
      while (node) {
        count += 1;
        if (node.shadowRoot && node.shadowRoot.mode !== 'closed') {
          visitRoot(node.shadowRoot);
        }
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            if (node.contentDocument?.documentElement) {
              visitRoot(node.contentDocument.documentElement);
            }
          } catch {
            // cross-origin iframe
          }
        }
        node = walker.nextNode();
      }
    };
    visitRoot(rootDoc.documentElement);
    return count;
  }

  function getDomMetrics() {
    if (mutationObserver) {
      processMutationRecords(mutationObserver.takeRecords());
    }
    if (clsObserver && typeof clsObserver.takeRecords === 'function') {
      processClsEntries(clsObserver.takeRecords());
    }
    const domNodes = typeof document !== 'undefined' ? countDeepDomNodes(document) : 0;
    return {
      domMutations,
      addedNodes: domAddedNodes,
      removedNodes: domRemovedNodes,
      layoutReads,
      domNodes,
      cls: Number(clsValue.toFixed(6)),
      clsTotal: Number(clsTotal.toFixed(6)),
      clsEntriesCount,
    };
  }

  function getDomBudgetStats() {
    const m = getDomMetrics();
    return {
      ready: true,
      steps: domSteps > 0 ? domSteps : 1,
      dom_mutations: m.domMutations,
      layout_reads: m.layoutReads,
      dom_nodes: m.domNodes,
      cls: m.cls,
    };
  }

  function getTamperStatus() {
    return {
      tampered: tamperEvents.length > 0,
      count: tamperEvents.length,
      events: tamperEvents.slice(0, 50),
    };
  }

  function getUnhookedRenderingStatus() {
    const reasons = new Set(unhookedState.reasons);
    let iframeCount = 0;
    let unhookedCanvasCount = 0;
    if (typeof document !== 'undefined') {
      try {
        iframeCount = document.querySelectorAll('iframe, frame').length;
        if (iframeCount > 0) reasons.add('iframe_detected');
        const canvases = document.querySelectorAll('canvas');
        for (let i = 0; i < canvases.length; i++) {
          const c = canvases[i];
          if (!hookedCanvases.has(c) && (c.width > 0 || c.height > 0)) {
            unhookedCanvasCount += 1;
          }
        }
        if (unhookedCanvasCount > 0 && iframeCount > 0) {
          reasons.add('unhooked_canvas');
        }
      } catch {
        // ignore
      }
    }
    const reasonList = Array.from(reasons);
    return {
      detected: reasonList.length > 0,
      reasons: reasonList,
      worker_count: unhookedState.workerCount,
      offscreen_transfers: unhookedState.offscreenTransfers,
      iframe_count: iframeCount,
      canvas_2d_count: unhookedState.canvas2dCount,
      bitmap_renderer_count: unhookedState.bitmapRendererCount,
      unhooked_canvas_count: unhookedCanvasCount,
      webgpu_attempts: unhookedState.webgpuAttempts,
    };
  }

  // ---- Internal harness control API (non-enumerable, mutators secret-gated) ----
  const control = Object.freeze({
    setSeed(seed, params, secret) {
      if (!verifySecret(secret, 'setSeed')) return;
      currentSeed = Number(seed) >>> 0;
      currentRng = createRng(currentSeed);
      if (params !== undefined) {
        currentParams = deepCloneAndFreeze(params || {});
      }
    },
    setParams(params, secret) {
      if (!verifySecret(secret, 'setParams')) return;
      currentParams = deepCloneAndFreeze(params || {});
    },
    freeze(tMs, secret) {
      if (!verifySecret(secret, 'freeze')) return;
      clockMode = 'frozen';
      frozenMs = Number(tMs);
    },
    resume(secret) {
      if (!verifySecret(secret, 'resume')) return;
      const current = clockNow();
      liveBaseMs = current;
      liveStartPerfMs = perfNow();
      clockMode = 'live';
    },
    resetClock(tMs = 0, secret) {
      if (!verifySecret(secret, 'resetClock')) return;
      liveBaseMs = Number(tMs);
      liveStartPerfMs = perfNow();
      frozenMs = Number(tMs);
      virtualMs = Number(tMs);
      clockMode = 'live';
    },
    setVirtualClock(tMs, secret) {
      if (!verifySecret(secret, 'setVirtualClock')) return;
      clockMode = 'virtual';
      virtualMs = Number(tMs);
    },
    advanceVirtualClock(dtMs, secret) {
      if (!verifySecret(secret, 'advanceVirtualClock')) return clockNow();
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
    installRafOverride(secret) {
      if (!verifySecret(secret, 'installRafOverride')) return;
      installRafOverride();
    },
    uninstallRafOverride(secret) {
      if (!verifySecret(secret, 'uninstallRafOverride')) return;
      uninstallRafOverride();
    },
    stepRafVirtual(durationMs, hz, startClockMs, secret) {
      if (!verifySecret(secret, 'stepRafVirtual')) return { steps: 0, invoked: 0, finalClockMs: clockNow() };
      return stepRafVirtual(durationMs, hz, startClockMs);
    },
    isRafOverrideActive() {
      return rafOverrideActive;
    },
    getQueuedRafCount() {
      return rafQueue.size;
    },
    setInternalBypass(flag, secret) {
      if (!verifySecret(secret, 'setInternalBypass')) return;
      internalListenerBypass = Boolean(flag);
      internalDomBypass = Boolean(flag);
    },
    setDomBypass(flag, secret) {
      if (!verifySecret(secret, 'setDomBypass')) return;
      internalDomBypass = Boolean(flag);
    },
    getWebGLMetrics,
    resetWebGLFrameMetrics,
    getDomMetrics,
    getDomBudgetStats,
    resetDomMetrics,
    markDomStep,
    getTamperStatus,
    getUnhookedRenderingStatus,
  });

  Object.defineProperty(window, '__benchHostControl', {
    value: control,
    enumerable: false,
    writable: false,
    configurable: false,
  });
})();
