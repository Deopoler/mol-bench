import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getMetricDef, isValidVariant, registerVariants } from "./registry.mjs";
import { isV2Spec } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "spec.schema.json");

let _validateSpec = null;
function getSpecValidator() {
  if (!_validateSpec) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    _validateSpec = ajv.compile(schema);
  }
  return _validateSpec;
}

export class SpecError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SpecError";
    Object.assign(this, details);
  }
}

/**
 * Normalize a CLI or metadata benchmark version to integer 1 or 2.
 */
export function parseVersion(version) {
  if (version === undefined || version === null || version === "") return 1;
  if (version === 1 || version === "1") return 1;
  if (version === 2 || version === "2") return 2;
  const s = String(version).trim();
  if (/^v?0\.1(?:\.|$)/.test(s)) return 1;
  if (/^v?0\.2(?:\.|$)/.test(s)) return 2;
  throw new SpecError(`Unsupported benchmark version: "${version}" (expected 1 or 2)`);
}

/**
 * Resolve version-specific directories for side-by-side v0.1 and v0.2 coexistence.
 */
export function resolveVersionPaths(version = 1, repoRoot = process.cwd()) {
  const v = parseVersion(version);
  const root = path.resolve(repoRoot);
  if (v === 2) {
    return {
      version: 2,
      benchVersion: "0.2.0",
      roomsDir: path.join(root, "rooms-v2"),
      hiddenDir: path.join(root, "hidden-v2"),
      resultsDir: path.join(root, "results-v2"),
      adaptersDir: path.join(root, "harness", "src", "rooms-v2")
    };
  }
  return {
    version: 1,
    benchVersion: "0.1.0",
    roomsDir: path.join(root, "rooms"),
    hiddenDir: path.join(root, "hidden"),
    resultsDir: path.join(root, "results"),
    adaptersDir: path.join(root, "harness", "src", "rooms")
  };
}

/**
 * Split an `at` string on commas, ignoring commas inside [...] brackets.
 */
function splitAtTokens(atStr) {
  const tokens = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < atStr.length; i++) {
    const ch = atStr[i];
    if (ch === "[") depth++;
    else if (ch === "]" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) tokens.push(trimmed);
  return tokens;
}

const CUSTOM_AT_TOKENS = new Map();

/**
 * Register a custom `at` grammar token parser (M1 Extension Protocol).
 * @param {string} name Unique name for the token parser
 * @param {(token: string, result: object) => boolean} matcher Returns true if it consumed the token
 */
export function registerAtToken(name, matcher) {
  if (typeof name !== "string" || !name) throw new Error("registerAtToken requires a non-empty name");
  if (typeof matcher !== "function") throw new Error("registerAtToken requires a matcher function");
  if (CUSTOM_AT_TOKENS.has(name)) throw new Error(`at token parser "${name}" is already registered`);
  CUSTOM_AT_TOKENS.set(name, matcher);
}

export function unregisterAtToken(name) {
  CUSTOM_AT_TOKENS.delete(name);
}

/**
 * Parse `at` grammar per docs/ARCHITECTURE.md.
 * Grammar tokens:
 * - viewports: `WxH` | `all viewports` | `A and B` (where A, B are WxH)
 * - time: `t=N` | `t in [a, b, ...]` | `all timestamps` | `t0=N`
 * - schemes: `both schemes`
 * - variants: `variants=a|b|...`
 * - masks: `mask=<name>`
 * - steps: `after resize sequence` | `after resize A -> B -> C` | `turntable` | `12 hidden views` | `front, side, top`
 */
export function parseAt(atString, opts = {}) {
  const { lenient = false, context = "" } = opts;
  const result = {
    raw: atString ?? null,
    viewports: null,
    timestamps: null,
    t0: null,
    schemes: ["light"],
    variants: ["normal"],
    mask: null,
    steps: [],
    warnings: []
  };

  if (atString === undefined || atString === null || atString === "") {
    return result;
  }
  if (typeof atString !== "string") {
    throw new SpecError(`Invalid 'at' value (expected string)${context ? ` in ${context}` : ""}`);
  }

  const tokens = splitAtTokens(atString);
  const orthoViews = [];

  for (const token of tokens) {
    let matched = true;

    if (token === "all viewports") {
      result.viewports = "all";
    } else if (/^\d+x\d+(?:@zoom\d+)?$/.test(token)) {
      result.viewports = [...(Array.isArray(result.viewports) ? result.viewports : []), token];
    } else if (/^\d+x\d+(?:@zoom\d+)?(?:\s+and\s+\d+x\d+(?:@zoom\d+)?)+$/.test(token)) {
      const parts = token.split(/\s+and\s+/);
      result.viewports = [...(Array.isArray(result.viewports) ? result.viewports : []), ...parts];
    } else if (/^t=(\d+(?:\.\d+)?)$/.test(token)) {
      const m = token.match(/^t=(\d+(?:\.\d+)?)$/);
      result.timestamps = [...(Array.isArray(result.timestamps) ? result.timestamps : []), Number(m[1])];
    } else if (/^t\s+in\s+\[([^\]]+)\]$/.test(token)) {
      const m = token.match(/^t\s+in\s+\[([^\]]+)\]$/);
      const items = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      const nums = items.map(Number);
      if (items.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0)) {
        matched = false;
      } else {
        result.timestamps = [...(Array.isArray(result.timestamps) ? result.timestamps : []), ...nums];
      }
    } else if (token === "all timestamps") {
      result.timestamps = "all";
    } else if (/^t0=(\d+(?:\.\d+)?)$/.test(token)) {
      const m = token.match(/^t0=(\d+(?:\.\d+)?)$/);
      result.t0 = Number(m[1]);
    } else if (token === "both schemes") {
      result.schemes = ["light", "dark"];
    } else if (token === "all schemes") {
      result.schemes = ["light", "dark", "high_contrast"];
    } else if (/^schemes=((?:light|dark|high_contrast)(?:\|(?:light|dark|high_contrast))*)$/.test(token)) {
      const m = token.match(/^schemes=(.+)$/);
      result.schemes = m[1].split("|");
    } else if (/^dpr=(\d+(?:\.\d+)?)$/.test(token)) {
      const m = token.match(/^dpr=(\d+(?:\.\d+)?)$/);
      result.dpr = Number(m[1]);
    } else if (/^variants=([a-z0-9_]+(?:\|[a-z0-9_]+)*)$/.test(token)) {
      const m = token.match(/^variants=([a-z0-9_]+(?:\|[a-z0-9_]+)*)$/);
      const list = m[1].split("|");
      const bad = list.filter((v) => !isValidVariant(v));
      if (bad.length > 0) {
        if (!lenient) {
          throw new SpecError(
            `Unknown variant(s) "${bad.join(", ")}" in at="${atString}"${context ? ` (${context})` : ""}`,
            { token, badVariants: bad }
          );
        }
        result.warnings.push(`Unknown variant(s) "${bad.join(", ")}" in at="${atString}" (${context}); using defaults`);
      } else {
        result.variants = list;
      }
    } else if (/^mask=([A-Za-z0-9_.-]+)$/.test(token)) {
      const m = token.match(/^mask=([A-Za-z0-9_.-]+)$/);
      result.mask = m[1];
    } else if (token === "after resize sequence") {
      result.steps.push({ kind: "resize_sequence", viewports: null });
    } else if (/^after\s+resize\s+(\d+x\d+(?:\s*->\s*\d+x\d+)+)$/.test(token)) {
      const m = token.match(/^after\s+resize\s+(.+)$/);
      const viewports = m[1].split(/\s*->\s*/);
      result.steps.push({ kind: "resize_sequence", viewports });
    } else if (token === "turntable") {
      result.steps.push({ kind: "turntable" });
    } else if (token === "12 hidden views") {
      result.steps.push({ kind: "hidden_views", count: 12 });
    } else if (token === "front" || token === "side" || token === "top" || token === "section_a") {
      orthoViews.push(token);
    } else {
      matched = false;
      for (const matcher of CUSTOM_AT_TOKENS.values()) {
        if (matcher(token, result) === true) {
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      if (!lenient) {
        throw new SpecError(
          `Unknown 'at' token "${token}" in "${atString}"${context ? ` (${context})` : ""}`,
          { token, at: atString, context }
        );
      }
      result.warnings.push(`Unknown 'at' token "${token}" in "${atString}" (${context}); falling back to defaults`);
      const leadingVp = token.match(/^(\d+x\d+)\b/);
      if (leadingVp && !result.viewports) {
        result.viewports = [leadingVp[1]];
      }
    }
  }

  if (orthoViews.length > 0) {
    result.steps.push({ kind: "ortho_views", views: orthoViews });
  }

  return result;
}

export function validateSpec(spec) {
  const validate = getSpecValidator();
  const valid = validate(spec);
  if (!valid) {
    const msgs = (validate.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new SpecError(`Spec schema validation failed: ${msgs}`, { errors: validate.errors });
  }
  return true;
}

function expandMetricList(metrics, fileLabel, prefix, lenient, warnings) {
  return (metrics || []).map((m) => {
    const def = getMetricDef(m.id);
    const context = `${fileLabel} -> ${prefix}${m.id}`;
    const parsedAt = parseAt(m.at, { lenient, context });
    for (const w of parsedAt.warnings) warnings.push(w);
    return {
      ...m,
      agg: m.agg ?? "median",
      calibrate: Boolean(m.calibrate),
      source: def.source,
      parsedAt
    };
  });
}

export function resolveSpecPath(roomOrPath, { renovation = null, version = 1, repoRoot = process.cwd() } = {}) {
  if (roomOrPath.endsWith(".json") && fs.existsSync(roomOrPath)) {
    return path.resolve(roomOrPath);
  }
  const relCandidate = path.resolve(repoRoot, roomOrPath);
  if (roomOrPath.endsWith(".json") && fs.existsSync(relCandidate)) {
    return relCandidate;
  }
  const v = parseVersion(version);
  const { roomsDir } = resolveVersionPaths(v, repoRoot);
  if (renovation) {
    const primary = path.join(roomsDir, roomOrPath, "renovation", `${renovation}.json`);
    if (fs.existsSync(primary)) return primary;
    if (v === 2) {
      const chainCandidate = path.join(roomsDir, roomOrPath, "renovation", "chain", `${renovation}.json`);
      if (fs.existsSync(chainCandidate)) return chainCandidate;
    }
    const benchSpec = path.resolve(repoRoot, "bench", "_spec", roomOrPath, "renovation", `${renovation}.json`);
    if (fs.existsSync(benchSpec)) return benchSpec;
    return primary;
  }
  const primary = path.join(roomsDir, roomOrPath, "spec.json");
  if (fs.existsSync(primary)) return primary;
  const benchSpec = path.resolve(repoRoot, "bench", "_spec", roomOrPath, "spec.json");
  if (fs.existsSync(benchSpec)) return benchSpec;
  return primary;
}

export function loadSpec(roomOrPath, opts = {}) {
  const { renovation = null, lenient = false, version = null, repoRoot = process.cwd() } = opts;
  const requestedVersion = version !== null && version !== undefined ? parseVersion(version) : 1;
  const specPath = resolveSpecPath(roomOrPath, { renovation, version: requestedVersion, repoRoot });
  if (!fs.existsSync(specPath)) {
    throw new SpecError(`Spec file not found: ${specPath}`);
  }

  const rawSpec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  validateSpec(rawSpec);
  if (Array.isArray(rawSpec.extra_variants) && rawSpec.extra_variants.length > 0) {
    registerVariants(rawSpec.extra_variants);
  }

  const resolvedVersion =
    version !== null && version !== undefined
      ? parseVersion(version)
      : (isV2Spec(rawSpec) ? 2 : 1);
  const { roomsDir } = resolveVersionPaths(resolvedVersion, repoRoot);

  const fileLabel = path.relative(repoRoot, specPath).replace(/\\/g, "/") || specPath;
  const warnings = [];

  // Inherit capture/limits from base room spec when loading a renovation spec.
  let baseSpec = null;
  if (rawSpec.track === "renovation") {
    const primaryBase = path.join(roomsDir, rawSpec.room, "spec.json");
    const fallbackBase = path.resolve(repoRoot, "bench", "_spec", rawSpec.room, "spec.json");
    const basePath = fs.existsSync(primaryBase) ? primaryBase : fallbackBase;
    if (fs.existsSync(basePath)) {
      baseSpec = JSON.parse(fs.readFileSync(basePath, "utf8"));
    }
  }

  const expandedRequests = (rawSpec.requests || []).map((req) => ({
    ...req,
    metrics: expandMetricList(req.metrics, fileLabel, `request.${req.id}.`, lenient, warnings)
  }));
  const requestMap = new Map(expandedRequests.map((r) => [`request.${r.id}`, r]));

  const expandedMetrics = expandMetricList(rawSpec.metrics, fileLabel, "", lenient, warnings).map((m) => {
    const req = requestMap.get(m.id);
    return req ? { ...m, request: req, subMetrics: req.metrics } : m;
  });

  let expandedBugPool = null;
  if (rawSpec.bug_pool) {
    expandedBugPool = {};
    for (const [cat, bugs] of Object.entries(rawSpec.bug_pool)) {
      expandedBugPool[cat] = bugs.map((bug) => ({
        ...bug,
        metrics: expandMetricList(bug.metrics, fileLabel, `bug_pool.${cat}.${bug.id}.`, lenient, warnings)
      }));
    }
  }

  const mergedCapture = {
    ...(baseSpec?.capture || {}),
    ...(rawSpec.capture || {})
  };
  if (!mergedCapture.public_timestamps_ms && mergedCapture.timestamps_ms) {
    mergedCapture.public_timestamps_ms = mergedCapture.timestamps_ms;
  }

  return {
    ...rawSpec,
    _specPath: specPath,
    _baseSpec: baseSpec,
    _version: resolvedVersion,
    load_timeout_ms: rawSpec.load_timeout_ms ?? baseSpec?.load_timeout_ms ?? 15000,
    max_raster_asset_kb: rawSpec.max_raster_asset_kb ?? baseSpec?.max_raster_asset_kb ?? 256,
    max_raster_total_kb: rawSpec.max_raster_total_kb ?? baseSpec?.max_raster_total_kb ?? 1024,
    capture: mergedCapture,
    metrics: expandedMetrics,
    requests: rawSpec.requests ? expandedRequests : undefined,
    bug_pool: expandedBugPool ?? undefined,
    warnings
  };
}

function dedupeByKey(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, item);
  }
  return [...map.values()];
}

export function buildPlan(spec, opts = {}) {
  const hidden = Boolean(opts.hidden);
  const renovation = opts.renovation ?? spec.renovation ?? null;
  const seeds = opts.seeds ?? spec.capture?.public_seeds ?? [1];
  const timestamps = opts.timestamps ?? spec.capture?.public_timestamps_ms ?? spec.capture?.timestamps_ms ?? [0];
  const viewports = spec.capture?.viewports ?? spec.protected?.compare_at ?? ["1440x900"];
  const defaultViewport = viewports[0] ?? "1440x900";
  const defaultTimestamp = timestamps.includes(1000) ? 1000 : (timestamps[0] ?? 0);

  const ctx = {
    spec,
    seeds,
    timestamps,
    viewports,
    defaultViewport,
    defaultTimestamp,
    hidden,
    renovation,
    version: opts.version ?? spec._version ?? (isV2Spec(spec) ? 2 : 1)
  };

  const allMetrics = [...(spec.metrics || [])];
  for (const req of spec.requests || []) {
    for (const sm of req.metrics || []) allMetrics.push(sm);
  }
  if (spec.bug_pool) {
    for (const bugs of Object.values(spec.bug_pool)) {
      for (const bug of bugs) {
        for (const bm of bug.metrics || []) allMetrics.push(bm);
      }
    }
  }

  const frames = [];
  const sequences = [];
  const probes = [];
  const steps = [];
  const tests = [];
  const perf = { enabled: false, viewport: defaultViewport };
  const lighthouse = { enabled: false };

  for (const m of allMetrics) {
    const def = getMetricDef(m.id);
    const reqs = def.needs(m, ctx) || [];
    for (const r of reqs) {
      if (r.kind === "frame") {
        const { kind: _k, ...rest } = r;
        frames.push(rest);
      } else if (r.kind === "sequence") {
        const { kind: _k, ...rest } = r;
        sequences.push(rest);
      } else if (r.kind === "probe") {
        const { kind: _k, ...rest } = r;
        probes.push(rest);
      } else if (r.kind === "step") {
        const { kind: _k, ...rest } = r;
        steps.push(rest);
      } else if (r.kind === "test") {
        tests.push(r.path);
      } else if (r.kind === "perf") {
        perf.enabled = true;
        if (r.viewport) perf.viewport = r.viewport;
      } else if (r.kind === "lighthouse") {
        lighthouse.enabled = true;
      }
    }
  }

  return {
    room: spec.room,
    renovation,
    mode: spec.capture?.renderer || "swiftshader",
    frames: dedupeByKey(frames, (f) => f.key),
    sequences: dedupeByKey(sequences, (s) => s.key),
    probes: dedupeByKey(probes, (p) => p.key),
    steps: dedupeByKey(steps, (s) => s.key),
    tests: [...new Set(tests)],
    perf,
    lighthouse
  };
}
