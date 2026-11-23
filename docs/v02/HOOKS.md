# MoL-Bench v0.2 — Frozen Extension & Hook Contract (Milestone M1)

> **Status:** Frozen at Milestone M1 (`WP-0a`, hardened after independent security & design review).  
> **Scope:** Authoritative interface contract for `WP-0b`, `WP-1`, and `WP-2`–`WP-7`. Parallel workers build rooms, probes, Python metrics, capture interceptors, and runner tooling strictly against these hooks without editing any WP-0a-owned file.

---

## 1. Version Coexistence & Path Resolution

v0.1 (`--version 1`, default) and v0.2 (`--version 2`) coexist side by side. v0.1 grading behavior and output JSON remain byte-identical.

### CLI & Metadata Resolution
- `bench grade <room> <dir> [--version 1|2]` (default: `1`, or inferred from `spec_version >= 0.2.0` when grading a direct `.json` spec path). Throws on disagreement if `--version` contradicts the loaded spec's `spec_version`.
- `bench selfcheck [--dir <dir>] [--version 1|2]` reads `.bench-room` / `.run.json` for **`room` and `renovation` only**. The authoritative version comes strictly from `--version` (default `1`), never from submission-controlled files; if `.bench-room` or `.run.json` declares a disagreeing version, `selfcheck` throws a version-mismatch error.
- `bench calibrate <room> [--version 1|2] [--renovation <r>] [--hidden]` resolves anchors/seed/attacks from the versioned rooms directory (`rooms-v2/` for v2). `parseAttackThreshold` preserves strict `<=` matching (default `4`) for v1 and supports `<=` / `<` (default `3.0`) for v2.

### Exported Helpers (`harness/src/spec.mjs` & `harness/src/score.mjs`)
```js
import { parseVersion, resolveVersionPaths, resolveSpecPath, loadSpec, buildPlan, registerAtToken, unregisterAtToken } from "./spec.mjs";
import { parseSemver, isV2Spec } from "./score.mjs";

parseVersion(v) // 1 | "1" | "0.1.0" -> 1; 2 | "2" | "0.2.0" -> 2; null/undefined -> 1
isV2Spec(spec)  // true when spec.spec_version >= 0.2.0 (major > 0 || minor >= 2)

resolveVersionPaths(version, repoRoot)
// v1: { version: 1, benchVersion: "0.1.0", roomsDir: "<root>/rooms",    hiddenDir: "<root>/hidden",    resultsDir: "<root>/results",    adaptersDir: "<root>/harness/src/rooms" }
// v2: { version: 2, benchVersion: "0.2.0", roomsDir: "<root>/rooms-v2", hiddenDir: "<root>/hidden-v2", resultsDir: "<root>/results-v2", adaptersDir: "<root>/harness/src/rooms-v2" }
```

- `resolveSpecPath(roomOrPath, { renovation, version, repoRoot })` resolves:
  - Build: `<roomsDir>/<room>/spec.json`
  - Renovation: `<roomsDir>/<room>/renovation/<renovation>.json`, with fallback to `<roomsDir>/<room>/renovation/chain/<renovation>.json` for v2 chained renovations, then `<repoRoot>/bench/_spec/...`.
- `loadSpec(roomOrPath, { renovation, lenient, version, repoRoot })` attaches `_version` (`1` or `2`) and registers any `spec.extra_variants` automatically.
- `buildPlan(spec, { seeds, timestamps, hidden, renovation, version })` passes `version` in `ctx` so `tests.hidden` / `tests.preservation` emit `hidden-v2/<room>/tests` and `rooms-v2/<room>/seed/public-tests` for v2.

---

## 2. Fail-Closed Scoring & Informational Metrics (`harness/src/score.mjs`)

### Activation Rule
- `failClosed` is enabled when:
  1. `spec.fail_closed === true`, **or**
  2. `spec.fail_closed !== false` **and** `isV2Spec(spec)` (`spec_version >= 0.2.0`),
  **and** `opts.partialEval !== true`.
- `opts.partialEval` is an **internal harness-only option** set exclusively by `cli.mjs` when `--no-capture` or `--no-python` is passed on the CLI. It is **never** readable from `spec.json`, `report.json`, `.bench-room`, or any submission artifact (`spec.schema.json` enforces `additionalProperties: false`).
- Whenever `partialEval === true` suppresses fail-closed scoring on a v2 spec, `scoreSubmission()` and `gradeSubmission()` stamp **`"partial_eval": true`** into the result JSON so partial runs cannot be mistaken for full grades.
- For v0.1 specs (`spec_version: "0.1.x"` without `fail_closed: true`), `scoreSubmission` behavior and output keys are 100% unchanged.

### Required, Excluded (Calibrate), and Informational Metrics
- **Informational:** `m.informational === true || m.score?.type === "informational"` (or `m.weight === 0` in v2 specs). Stored in `result.metrics[id]` with `"informational": true`; never enters axis `wSum` or triggers `missing_required_metric`.
- **Excluded / Null-band (`calibrate: true`):** If `res.excluded === true` (null score bands), fail-closed conversion is skipped so uncalibrated metrics stay `score: null, excluded: true` instead of being penalized to `0`.
- **Required:** `!informational && !res.excluded && m.weight > 0`. When `failClosed === true`, any `null`/`undefined` score becomes `score: 0, missing: true`, keeps `m.weight` in `wSum`, and emits `"missing_required_metric: <id>"` (or `"missing_required_metric: request.<reqId>.<subId>"`).

```js
scoreSubmission(spec, rawMetrics = {}, opts = {})
// opts: { gates?: object, ctx?: object, failClosed?: boolean, partialEval?: boolean }
```

---

## 3. Room Adapter, Registry & Extensible `at` / Gate Hooks

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
```
- `registerMetrics(defs, { replace = false })`:
  - **Built-ins cannot be shadowed:** colliding with any built-in v0.1 metric in `DEFINITIONS` always throws (even with `replace: true`), and `getMetricDef()` always checks built-ins first.
  - Duplicate plugin IDs throw unless `replace: true`.
- `cli.mjs` registers adapter metrics with `replace: false` via `registerAdapterMetrics(adapter)` and automatically calls `unregisterMetrics(registeredIds)` in `finally` after every `gradeSubmission()` / `runCalibrate()` call so global state never leaks across rooms.

### Extensible `at` Tokens, Variants & Static Gates
- **Variants:** Built-in `VALID_VARIANTS` includes v0.1 + v0.2 standard variants (`lang_ja`, `high_contrast`, `zoom200`, `many_48`, `one_room`, `empty_state`, `prefers_contrast_more`). Specs may also declare `"extra_variants": ["my_variant"]` in `spec.json` (consumed automatically by both `spec.mjs` and `metrics/molmetrics/cli.py`), or register dynamically via `registerVariants(["my_variant"])`.
- **`at` Tokens:** `parseAt()` supports v0.2 tokens (`1440x900@zoom200`, `all schemes`, `schemes=light|dark|high_contrast`, `section_a`, `dpr=2`) plus custom parsers via `registerAtToken(name, (token, result) => boolean)` / `unregisterAtToken(name)`.
- **Static Gates (`harness/src/gates.mjs`):** `registerGate("G-custom", (submissionDir, spec, opts) => ({ pass, detail }))` / `unregisterGate("G-custom")` registers custom static gates evaluated by `evaluateStaticGates()` when listed in `spec.gates` (cannot shadow built-ins `G-report`, `G-decisions`, `G-test-sandbox`).

### Room Adapter Exports (`harness/src/rooms-v2/<room>.mjs`)
```js
export const room = "aurora";
export function registerMetrics() { return { "scene.reflection_coherence": { source: "python", needs: (m, ctx) => emitFrames(m, ctx) } }; }
export function generate(seed, opts = {}) { return { seed }; }
export async function extraCapture(ctx) {}
export async function extraMetrics(ctx, rawMetrics) {}
export async function captureBlender(ctx) { return { gates: {}, rawMetrics: {} }; }
export async function diffDenominator(ctx) { return 10; }
```
Testing override: `gradeSubmission({ ..., adapterDir })` or `MOL_ADAPTER_DIRS` (`path.delimiter`-separated).

---

## 4. Browser Probe Auto-Discovery (`harness/src/capture/probes/index.js`)

Built-in v0.1 handlers live in a single `BUILTIN_HANDLERS` map (which also drives `listProbes()`). Plugin files in `harness/src/capture/probes/*.js` (plus `MOL_PROBE_DIRS`) export:
```js
export const probeName = "overlap";
export const aliases = ["layout.overlap_count"]; // optional
export async function runProbe(pageHandle, args = {}, invokedName = probeName) {
  return { "layout.overlap_count": 0, details: {} };
}
```
- **Collision protection:** Duplicate `probeName` or `aliases` (or shadowing any built-in probe name) throws immediately naming both files.
- **Per-file import isolation:** Each plugin `import()` is wrapped in `try/catch`; one broken plugin does not abort discovery of healthy plugins, and any unresolved `runProbe(name)` fails closed with an error naming the failed plugin file(s) (`getProbeLoadErrors()` also exposes load failures).

---

## 5. Python Metric Auto-Discovery (`metrics/molmetrics/cli.py`)

`molmetrics.IMPLEMENTED_METRICS` (29 v0.1 metrics) stays untouched.
- **v2-only plugin loading:** `compute_metrics()` only calls `discover_plugins()` for v2 specs (`spec_version >= 0.2.0` or under `rooms-v2/`) or when explicit `--plugin-dir` / `MOLMETRICS_PLUGIN_DIRS` is set. v0.1 grading never imports optional v2 plugin modules.
- **Collision protection:** Each module's `register(local_reg)` is validated; shadowing any metric in `IMPLEMENTED_METRICS` or registering a duplicate metric ID raises `ValueError`.
- **Dynamic variants:** v2 manifest validation reads `spec.extra_variants`, `spec.capture.variants`, and `manifest.extra_variants` in addition to `VALID_VARIANTS | V2_EXTRA_VARIANTS`.

Plugin signature:
```python
def compute_my_metric(ctx: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]] | None: ...
def register(METRICS: dict[str, Any]) -> None:
    METRICS["custom.my_metric"] = compute_my_metric
```
`ctx` keys: `metric_id`, `metric_cfg`, `manifest`, `spec`, `start_manifest`, `at_filter`, `agg`, `score_spec`, `base_dirs`, `start_dirs`, `load_image`, `load_start_image`, `resolve_mask`, `select_samples`, `select_sequences`, `aggregate_values`, `get_params`.

---

## 6. Black-Box Room Test Harness & `G-test-sandbox` (Defense in Depth)

### (a) Static Allowlist Gate `G-test-sandbox` (`harness/src/gates.mjs`)
`evaluateTestSandboxGate(submissionDir, { testDir = "tests/regression", requireTests = true, allowedBareSpecifiers = [] })`:
- Fails closed (`pass: false`) if `testDir` is missing or contains 0 test files when `requireTests` is true (default when `G-test-sandbox` is in `spec.gates`; overrideable via `spec.test_sandbox.required: false`).
- Tokenizes JS/TS (skipping comments) and scans all files in `testDir` **plus transitive relative imports**.
- **Strict Allowlist** (plain single/double-quoted string literals ONLY):
  - Bare specifiers: `node:test`, `node:assert`, `node:assert/strict`, `playwright`
  - Room harness: relative path resolving to `bench/testing/room-harness.mjs` or `harness/src/testing/room-harness.mjs`
  - Relative `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` modules strictly inside `testDir` (scanned transitively)
- **Rejects:** all other bare/builtin imports (`fs`, `os`, `net`, `http`, `inspector`, `child_process`, etc.), absolute paths (`/abs`, `C:/...`), `file:`/`data:`/`http:` URLs, non-JS imports (`.json`, `.node`, `.wasm`), relative escapes outside `testDir` (e.g. `../helper.js`), any symlink in `testDir` or resolved targets, non-literal or multi-arg `import(...)`/`require(...)` (concatenation, template strings, import attributes), `import.meta.resolve`, `eval`/`Function`/`createRequire`, and any `process` usage other than `process.env.MOL_*`.

### (b) Runtime Isolation (`harness/src/testing/room-harness.mjs`)
- `openRoom(opts)` provides the black-box RoomHandle (`setSeed`, `seek`, `resume`, `renderFrame`, `screenshot`, `resize`, `mount`, `unmount`, `state`, `stats`, `rafSweep`, `emulate`, `movePointer`, `movePointerNormalized`, `consoleErrors`, `close`). Supports `MOL_PLAYWRIGHT_WS` (`chromium.connect`) and transparent IPC proxy mode (`MOL_ROOM_IPC=1`).
- `runSandboxedTest({ testFile, targetDir, testDir, testNamePattern, timeoutMs, extraReadPaths })`:
  - Spawns `testFile` in a child Node process under `--permission` (Node 24+) / `--experimental-permission` (Node 22/23) with `--allow-fs-read` limited strictly to `testDir`, `harness/src/testing` (or `bench/testing`), `node_modules`, and `package.json` — **zero fs-write, zero child_process, zero worker_threads, zero fs-read on `targetDir`/`room/`**.
  - Parent process owns the local HTTP server and SwiftShader Chromium browser and services `openRoom()` calls over Node IPC (works even in loopback-restricted Windows sandboxes).

---

## 7. Result JSON v0.2 Additions, Root-Only Diffmetrics & Vendored Fonts

- **v0.2 Result JSON additions (omitted on v0.1):**
  - `bench_version`: `"0.2.0"`
  - `toolchain`: `{ chromium_version, swiftshader_renderer, blender_version, node_version, python_version, os_platform }`
  - `partial_eval`: `true` (only when `--no-capture` or `--no-python` was used on v2)
  - `metrics[id].informational`: `true` (on informational metrics), `metrics[id].missing`: `true` (on fail-closed missing metrics)
- **Diffmetrics (`harness/src/diffmetrics.mjs`):** `{ excludeWorkspaceArtifacts: true }` (passed only for v2 specs) excludes `.run.json`, `selfcheck.json`, `.bench-room`, `preview/`, and `work/` **strictly at submission root** (`depth === 0`) — never in nested paths like `src/work/x.js`, and never excluding `bench/`, `metrics/`, `.venv/`, or `__pycache__/` from `compareAllFiles`.
- **Vendored OFL Fonts (`harness/fonts/`):** `manifest.json` (`status: "vendored"`, SHA-256 pinned for `Pretendard`, `Noto Sans JP`, `Inter`, `Noto Serif` + OFL-1.1 license files), `fonts.css`, and `loader.mjs` (`getFontManifest`, `verifyVendoredFonts`, `copyFontsTo`).
