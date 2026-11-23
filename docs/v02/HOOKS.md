# MoL-Bench v0.2 — Frozen Extension & Hook Contract (Milestone M1)

> **Status:** Frozen at Milestone M1 (`WP-0a`).  
> **Scope:** Authoritative interface contract for `WP-0b`, `WP-1`, and `WP-2`–`WP-7`. Parallel workers build rooms, probes, Python metrics, capture interceptors, and runner tooling strictly against these hooks without editing any WP-0a-owned file.

---

## 1. Version Coexistence & Path Resolution

v0.1 (`--version 1`, default) and v0.2 (`--version 2`) coexist side by side. v0.1 grading behavior and output numbers remain byte-identical.

### CLI & Metadata Resolution
- `bench grade <room> <dir> [--version 1|2]` (default: `1`, unless overridden by `.bench-room` or `.run.json` when `--version` is omitted on `selfcheck`, or inferred from `spec_version >= 0.2.0` when grading a direct `.json` spec path).
- `bench selfcheck [--dir <dir>] [--version 1|2]` reads `.bench-room` (JSON `{"room":"aurora","version":2}` or plain text) and `.run.json` (`bench_version: "0.2.0"` or `version: 2`).
- `bench calibrate <room> [--version 1|2] [--renovation <r>] [--hidden]` resolves anchors/seed/attacks from the versioned rooms directory (`rooms-v2/` for v2).

### Exported Helpers (`harness/src/spec.mjs` & `harness/src/score.mjs`)
```js
import { parseVersion, resolveVersionPaths, resolveSpecPath, loadSpec, buildPlan } from "./spec.mjs";
import { parseSemver, isV2Spec } from "./score.mjs";

parseVersion(v) // 1 | "1" | "0.1.0" -> 1; 2 | "2" | "0.2.0" -> 2; null/undefined -> 1
isV2Spec(spec)  // true when spec.spec_version >= 0.2.0 (major > 0 || minor >= 2)

resolveVersionPaths(version, repoRoot)
// Returns:
// v1: { version: 1, benchVersion: "0.1.0", roomsDir: "<root>/rooms",    hiddenDir: "<root>/hidden",    resultsDir: "<root>/results",    adaptersDir: "<root>/harness/src/rooms" }
// v2: { version: 2, benchVersion: "0.2.0", roomsDir: "<root>/rooms-v2", hiddenDir: "<root>/hidden-v2", resultsDir: "<root>/results-v2", adaptersDir: "<root>/harness/src/rooms-v2" }
```

- `resolveSpecPath(roomOrPath, { renovation, version, repoRoot })` resolves:
  - Build: `<roomsDir>/<room>/spec.json`
  - Renovation: `<roomsDir>/<room>/renovation/<renovation>.json`, with fallback to `<roomsDir>/<room>/renovation/chain/<renovation>.json` for v2 chained renovations, then `<repoRoot>/bench/_spec/...`.
- `loadSpec(roomOrPath, { renovation, lenient, version, repoRoot })` attaches `_version` (`1` or `2`) to the returned spec object.
- `buildPlan(spec, { seeds, timestamps, hidden, renovation, version })` passes `version` in `ctx` so metric `needs(m, ctx)` resolves `hidden-v2/<room>/tests` and `rooms-v2/<room>/seed/public-tests` for v2.

---

## 2. Fail-Closed Scoring & Informational Metrics (`harness/src/score.mjs`)

### Activation Rule
- `failClosed` is enabled when:
  1. `spec.fail_closed === true`, **or**
  2. `spec.fail_closed !== false` **and** `isV2Spec(spec)` (`spec_version >= 0.2.0`),
  **and** `opts.partialEval !== true`.
- `opts.partialEval` is an **internal harness-only option** set exclusively by `cli.mjs` when `--no-capture` or `--no-python` is passed on the CLI. It is **never** readable from `spec.json`, `report.json`, `.bench-room`, or any submission artifact (`spec.schema.json` enforces `additionalProperties: false`).
- For v0.1 specs (`spec_version: "0.1.x"` without `fail_closed: true`), `scoreSubmission` behavior is 100% unchanged.

### Required vs. Informational Metrics
- A metric is **informational** iff `m.informational === true || m.weight === 0 || m.score?.type === "informational"`.
  - Allowed in `spec.schema.json`: `weight` allows `0` (`minimum: 0`), `informational: true`, and `score: { "type": "informational" }` (or any standard score spec with `weight: 0` + `informational: true`).
  - Informational metrics are computed and stored in `result.metrics[id]` with `"informational": true` and never enter axis `wSum` or emit `missing_required_metric`.
- A metric is **required** iff `!isInformational && m.weight > 0`.
  - When `failClosed === true`, any required metric (top-level `spec.metrics` or `spec.requests[].metrics`) whose score is `null` or `undefined` is assigned `score: 0`, `missing: true`, retains `m.weight` in `wSum`, and appends `"missing_required_metric: <id>"` (or `"missing_required_metric: request.<reqId>.<subId>"`) to `result.warnings`.

```js
scoreSubmission(spec, rawMetrics = {}, opts = {})
// opts: { gates?: object, ctx?: object, failClosed?: boolean, partialEval?: boolean }
```

---

## 3. Room Adapter & Metric Registry Extension Protocol

### Metric Registry (`harness/src/registry.mjs`)
```js
import {
  registerMetrics,
  unregisterMetrics,
  registerVariants,
  isValidVariant,
  hasMetric,
  getMetricDef,
  listMetricIds,
  emitFrames,
  emitProbes,
  emitSequence,
  emitResizeSteps
} from "./registry.mjs";

// Register custom v2 metric descriptors (never mutates v0.1 built-ins):
registerMetrics(
  {
    "color.palette_band_sep": {
      source: "python", // "python" | "probe" | "room" | "harness" | "test"
      needs: (metric, ctx) => emitFrames(metric, ctx)
    }
  },
  { replace: false } // pass replace: true to overwrite an existing plugin registration
);

unregisterMetrics(["color.palette_band_sep"]);
registerVariants(["custom_variant"]);
```

Built-in `VALID_VARIANTS` includes all v0.1 variants plus v0.2 standard variants:
`lang_ja`, `high_contrast`, `zoom200`, `many_48`, `one_room`, `empty_state`, `prefers_contrast_more`.

`parseAt()` additionally supports v0.2 tokens:
- Zoom viewports: `1440x900@zoom200`
- Schemes: `all schemes` (`["light", "dark", "high_contrast"]`), `schemes=light|dark|high_contrast`
- Ortho cross-section: `section_a` alongside `front`, `side`, `top`
- Explicit DPR: `dpr=2`

### Room Adapter Exports (`harness/src/rooms-v2/<room>.mjs`)
`cli.mjs` loads the adapter **before** `loadSpec()` and calls `registerMetrics(adapter.registerMetrics(), { replace: true })` if `adapter.registerMetrics` is exported.

```js
export const room = "aurora";

/**
 * Optional (required if spec uses metrics not in built-in registry.mjs).
 * Returns a map of { [metricId]: { source, needs } } registered into registry.mjs.
 */
export function registerMetrics() {
  return {
    "scene.reflection_coherence": {
      source: "python",
      needs: (m, ctx) => emitFrames(m, ctx)
    }
  };
}

/**
 * Deterministically generate seed parameters (never use Math.random()).
 * @param {number} seed
 * @param {{ hidden?: boolean, variant?: string, repoRoot?: string }} opts
 */
export function generate(seed, opts = {}) { return { seed }; }

/** Optional extra browser captures executed by capture/plan.mjs. */
export async function extraCapture(ctx) {}

/**
 * Optional room-specific raw metric calculation merged into rawMetrics before scoring.
 * @param {object} ctx { room, version, submissionDir, workDir, repoRoot, spec, plan, seeds, timestamps, hidden, noCapture, noPython, staticRes, captureRes, manifestPath }
 * @param {Record<string, unknown>} rawMetrics
 */
export async function extraMetrics(ctx, rawMetrics) {}

/** Optional Blender capture pipeline for 3D rooms (contract includes "blender"). */
export async function captureBlender(ctx) { return { gates: {}, rawMetrics: {} }; }

/** Optional minimal-diff line denominator for build tracks using diff.change_ratio. */
export async function diffDenominator(ctx) { return 10; }
```

- Testing override: `gradeSubmission({ ..., adapterDir })` or env `MOL_ADAPTER_DIRS` (path-delimiter-separated directories) allows loading test/mock adapters without modifying `harness/src/rooms-v2/`.

---

## 4. Browser Probe Auto-Discovery (`harness/src/capture/probes/index.js`)

`index.js` keeps all v0.1 built-in probe names unchanged and auto-discovers plugin files in `harness/src/capture/probes/*.js` (and any directories listed in `MOL_PROBE_DIRS`, separated by `path.delimiter`).

### Probe Plugin Contract
Any `*.js` or `*.mjs` file in `harness/src/capture/probes/` (excluding `index.js`, `shared.js`, and v0.1 helper modules without `probeName`) exporting:
```js
export const probeName = "overlap";          // Required: primary probe name
export const aliases = ["layout.overlap_count"]; // Optional: additional names / metric IDs

/**
 * @param {{ page: import('playwright').Page, cdp: any, ... }} pageHandle
 * @param {Record<string, unknown>} args
 * @param {string} invokedName The exact name passed to runProbe()
 * @returns {Promise<Record<string, unknown>>}
 *   Return either `{ [metricId]: value, details?: object }`
 *   or `{ metrics: { [metricId]: value }, details?: object }`.
 */
export async function runProbe(pageHandle, args = {}, invokedName = probeName) {
  return {
    "layout.overlap_count": 0,
    details: {}
  };
}
```

### Exported Orchestration Functions (`harness/src/capture/probes/index.js`)
```js
export async function discoverProbes({ extraDirs = [], forceReload = false } = {});
export async function listProbes({ extraDirs = [] } = {}); // returns sorted array of built-in + plugin probe names
export async function runProbe(probeName, pageHandle, args = {});
```
- Resolution order: built-in v0.1 `switch` cases first (preserving v0.1 byte-identical behavior), then discovered plugin `probeName` / `aliases`.

---

## 5. Python Metric Auto-Discovery (`metrics/molmetrics/cli.py`)

`cli.py` keeps `molmetrics.IMPLEMENTED_METRICS` (29 v0.1 metrics) untouched and auto-discovers every `*.py` plugin in `metrics/molmetrics/` (excluding `__init__.py`, `__main__.py`, `cli.py`, and `_*.py`) plus any extra directories from `--plugin-dir <dir>` (repeatable CLI flag) or `MOLMETRICS_PLUGIN_DIRS` (`os.pathsep`-separated env var).

### Python Metric Plugin Contract
```python
from typing import Any

def compute_my_metric(ctx: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]] | None:
    """Compute a v0.2 metric.

    `ctx` keys:
      - metric_id: str
      - metric_cfg: dict[str, Any]
      - manifest: dict[str, Any]
      - spec: dict[str, Any]
      - start_manifest: dict[str, Any] | None
      - at_filter: AtFilter
      - agg: str ("median" | "mean" | "worst")
      - score_spec: dict[str, Any] | None
      - base_dirs: tuple[Path | None, ...]
      - start_dirs: tuple[Path | None, ...]
      - load_image: Callable[[dict | str | Path], np.ndarray]        # cached uint8/float RGB loader
      - load_start_image: Callable[[dict | str | Path], np.ndarray]
      - resolve_mask: Callable[[str | Path, tuple[int, int]], np.ndarray]
      - select_samples: Callable[..., list[dict[str, Any]]]
      - select_sequences: Callable[..., list[dict[str, Any]]]
      - aggregate_values: Callable[..., float | bool]
      - get_params: Callable[[Any], dict[str, Any]]

    Return one of:
      1. None -> metric inputs absent (added to `_skipped`)
      2. list[{"key": str, "value": float | int | bool, ...}] -> cli.py aggregates `raw` and wraps as `{"raw", "samples", "detail"}`
      3. {"raw": ..., "samples": [...], "detail": {...}} -> stored verbatim
    """
    samples = ctx["select_samples"](
        ctx["manifest"].get("samples", []),
        ctx["at_filter"],
        default_variant="normal",
        viewport_default=ctx["manifest"].get("viewport_default"),
    )
    if not samples:
        return None
    return [{"key": s["key"], "value": 1.0} for s in samples]


def register(METRICS: dict[str, Any]) -> None:
    METRICS["custom.my_metric"] = compute_my_metric
```

### v0.2 Manifest Variants & Hidden Asset Directory in `cli.py`
- For `spec_version >= 0.2.0` (or specs located under `rooms-v2/`), `cli.py`:
  - Resolves `hidden-v2/<room>` in `base_dirs` / `start_dirs` (falling back to `hidden/<room>`).
  - Validates manifest `variant` fields against `VALID_VARIANTS | V2_EXTRA_VARIANTS` (`lang_ja`, `high_contrast`, `zoom200`, `many_48`, `one_room`, `empty_state`, `prefers_contrast_more`).
- For v0.1 specs, `cli.py` preserves exact v0.1 `validate_manifest_variants` and `hidden/<room>` resolution.

---

## 6. Black-Box Room Test Harness & `G-test-sandbox` Gate

### `harness/src/testing/room-harness.mjs` (Workspace path: `bench/testing/room-harness.mjs`)
Black-box Playwright wrapper for Restoration v0.2 regression tests (`tests/regression/**`):

```js
import { openRoom } from "../../bench/testing/room-harness.mjs";

const room = await openRoom({
  targetDir,       // defaults to process.env.MOL_TARGET_DIR || process.cwd()
  viewport,        // default "1440x900"
  dpr,             // default 1
  colorScheme,     // default "light"
  reducedMotion,   // default "no-preference"
  locale,          // default null
  seed,            // default 1
  params,          // default {}
  entryPath,       // optional relative HTML path (auto-detects index.html or room/index.html)
  loadTimeoutMs,   // default 15000
  mode             // default "swiftshader"
});

// RoomHandle methods:
await room.setSeed(seed, params?);
await room.seek(tMs);
await room.resume();
await room.renderFrame(timeoutMs?);
const pngBuf = await room.screenshot(outPath?, options?); // Buffer
await room.resize(viewportOrWidth, height?);              // "1280x720" | { width, height } | (1280, 720)
await room.mount(containerSelector?);                     // calls window.__bench.mount(el)
await room.unmount();                                     // calls window.__bench.unmount()
const st = await room.state();
const stats = await room.stats();
const sweep = await room.rafSweep({ durationMs: 5000, hz: 60, startClockMs: 0 });
// sweep => { frames, durationMs, hz, state, stats }
await room.emulate({ reducedMotion?, colorScheme?, locale? });
await room.movePointer(x, y);
await room.movePointerNormalized(nx, ny);
room.consoleErrors(); // string[] of console errors and pageerrors
await room.close();   // idempotently closes page, browser, and local HTTP server
```

### Static Gate `G-test-sandbox` (`harness/src/gates.mjs`)
```js
import { evaluateTestSandboxGate } from "./gates.mjs";

const gate = evaluateTestSandboxGate(submissionDir, { testDir: "tests/regression" });
// => { pass: boolean, detail: string, violations: Array<{ file, line, rule, snippet }>, filesScanned: number }
```
- Evaluated automatically in `evaluateStaticGates()` whenever `spec.gates` includes `"G-test-sandbox"`.
- Scans all `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` files under `testDir` (comments stripped preserving line numbers) and fails if any file contains:
  1. Static/dynamic imports or `require()` targeting `room/` or `room/src/`
  2. Imports or `require()` of `fs`, `node:fs`, `fs/promises`, `node:fs/promises`, `child_process`, `node:child_process`, `vm`, `node:vm`, `module`, `node:module`, `worker_threads`, `node:worker_threads`
  3. Relative parent imports escaping `tests/` (except imports resolving to `.../testing/room-harness.mjs`)
  4. `eval(`, `new Function(`, `createRequire(`, `process.binding(`, `process.mainModule`
  5. `file://` URL access (`fetch("file://...")`, `new URL("file://...")`)

---

## 7. Result JSON v0.2 Additions & Diffmetrics Exclusions

### Result JSON Additions (v2 only; v0.1 result shape unchanged)
When grading with `--version 2` or `isV2Spec(spec)`:
- `bench_version`: `"0.2.0"`
- `spec_version`: from `spec.spec_version` (e.g. `"0.2.0"`)
- `toolchain`:
  ```json
  {
    "chromium_version": "playwright-core@1.56.1 (chromium rev ...)",
    "swiftshader_renderer": "Google SwiftShader (ANGLE)",
    "blender_version": null,
    "node_version": "v22.x.x",
    "python_version": "3.x.x",
    "os_platform": "win32-x64"
  }
  ```
  If `captureRes.toolchain` is provided by WP-0b (e.g., live `WEBGL_debug_renderer_info` string or exact Chromium version from `browser.version()`), its non-null fields override the offline defaults.
- `metrics[id].informational`: `true` on informational (`weight: 0`) metrics.
- `metrics[id].missing`: `true` on required metrics that failed closed to `0` (with corresponding `missing_required_metric: <id>` in `warnings`).

### Diffmetrics v0.2 Workspace Artifact Exclusions (`harness/src/diffmetrics.mjs`)
- `compareAllFiles(startDir, submissionDir, { excludeWorkspaceArtifacts: false })` and `compareSourceTrees(startDir, submissionDir, { excludeWorkspaceArtifacts: false })` default to `false` so v0.1 grading is byte-identical.
- For v0.2 specs (`isV2Spec(spec)`), `cli.mjs` passes `{ excludeWorkspaceArtifacts: true }`, excluding `.run.json`, `selfcheck.json`, `.bench-room`, `preview/`, `work/`, `.venv/`, `__pycache__/`, `bench/`, `metrics/`.

---

## 8. Vendored Fonts Contract (`harness/fonts/`)

`harness/fonts/` provides:
- `manifest.json` — pinned list of OFL-1.1 fonts (`Pretendard`, `Noto Sans JP`, `Inter`, `Noto Serif`), filenames, weights, license paths, and `sha256` fields (`null` in placeholder state until binaries are vendored).
- `fonts.css` — local `@font-face` declarations pointing to `./<filename>` with deterministic fallback stacks.
- `loader.mjs` — exports `FONTS_DIR`, `FONT_MANIFEST_PATH`, `getFontManifest()`, `verifyVendoredFonts()`, `copyFontsTo(destDir)`.

---

## 9. Ambiguity Resolutions (Design Decisions)
1. **Synchronous `loadSpec()` vs. async adapter `registerMetrics()`:** `loadSpec()` stays synchronous for v0.1 backward compatibility; `cli.mjs` loads the room adapter and calls `registerMetrics()` before calling `loadSpec()`. Callers outside `cli.mjs` can call `loadRoomAdapter()` + `registerMetrics()` before `loadSpec()`.
2. **Probe resolution precedence:** Built-in v0.1 switch cases take precedence over auto-discovered plugins so v0.1 probes cannot be accidentally shadowed; new v0.2 probes register unique `probeName` / `aliases`.
3. **Python `IMPLEMENTED_METRICS` invariance:** Existing `metrics/tests/test_cli_and_at.py` asserts `len(IMPLEMENTED_METRICS) == 29`. `cli.py` therefore keeps `IMPLEMENTED_METRICS` untouched and merges discovered plugin handlers from `register(METRICS)` dynamically at compute time.
4. **v0.2 `G-test-sandbox` on empty `tests/regression/`:** An absent or empty `tests/regression/` directory passes `G-test-sandbox` (no forbidden imports present); `tests.redgreen_verified` handles missing tests by scoring `0`.
5. **v0.1 isolation:** New `diffmetrics.mjs` workspace exclusions, fail-closed scoring, `toolchain` stamp, and `bench_version: "0.2.0"` apply only for v0.2 (`--version 2` / `spec_version >= 0.2.0`), leaving v0.1 grades byte-identical.
