# Museum of Light — Room: Restoration v0.2 ("The Fractured Planetarium")

You are the senior conservation systems engineer assigned to **Gallery IV: The Grand Planetarium** in the Museum of Light.
The gallery runs a modular real-time Three.js planetarium (`room/src/planetarium.js`, `room/src/main.js`, `room/src/styles.css`, `room/index.html`, and subsystem modules under `room/src/modules/`): concentric brass armillary rings above a central pedestal and sun, seven orbiting planetary spheres driven by the bench clock, an engraved brass astrolabe floor dial and north-wall relief medallion, a north-west conservation color calibration plaque (`room/assets/color-chart.png`), a north-east celestial meridian clock dial beneath a translucent glass dome vault, and a **"Next Planet"** focus control (`[data-bench="next-planet"]`).

**Several** interacting regressions were recently introduced across `room/src/**` (defects may appear anywhere in `room/src/`, multiple defects may share the same file, and some modules may have no defects at all). Below are the **curator and visitor notes** collected so far — treat them carefully:
- Some defects **mask** other defects in multi-stage chains so secondary or tertiary problems only become visible after earlier issues are resolved.
- Some visitor notes describe **surface symptoms** whose true cause lies in a different subsystem than the symptom first suggests.
- Additional **silent / unreported defects** may exist in the codebase with no corresponding visitor note at all; audit all of `room/src/**` and inspect rendered output across seeds, viewports, timestamps, and lifecycle transitions.

Your task is to:
1. Diagnose and minimally fix **all** defects in `room/src/**` so that fixes generalize across arbitrary seeds, viewports, DPRs, and long timestamps without harming normal planetarium features.
2. Write one **black-box behavioral regression test** per defect in `tests/regression/**` using `bench/testing/room-harness.mjs` (`openRoom()`).
3. Classify every diagnosed defect's root cause in `report.json` using the public taxonomy below.

- **Spec Time Limit:** **75 minutes** (`time_limit_min: 75`).

---

## Synthesized Curator & Visitor Notes

<!-- VISITOR_REPORTS_START -->
*(Variant-specific curator and visitor notes are injected here when the workspace is prepared.)*
<!-- VISITOR_REPORTS_END -->

*(Remember: visitor notes are incomplete. Additional defects may be unmasked after fixing earlier issues or have no visitor note at all.)*

---

## Public Root-Cause Taxonomy (24 Codes)

For every defect you diagnose — both visitor-reported (`R1`, `R2`, ...) and any additional unreported defects you discover (label those sequentially as `S1`, `S2`, ...) — record an entry in `report.json → room.bugs[]` with **one exact code** from the taxonomy below:

```json
[
  "ASYNC_SEED_RACE",
  "CAMERA_FOV_RADIANS_MISMATCH",
  "COLOR_SPACE_MISSING_GAMMA",
  "DATA_TEXTURE_SRGB_DECODE",
  "DEPTH_BUFFER_LOGARITHMIC_ZFIGHT",
  "DPR_FBO_RESIZE_DESYNC",
  "FIXED_STEP_SUBSTEP_DRIFT",
  "LIGHT_ATTENUATION_UNIT_MISMATCH",
  "MIPMAP_ANISOTROPY_BLEED",
  "NORMAL_MAP_GREEN_INVERTED",
  "ORBIT_EULER_GIMBAL_LOCK",
  "POSTFX_DOUBLE_TONEMAP",
  "POSTFX_VIGNETTE_GAIN_UNDERFLOW",
  "PREMULT_ALPHA_DOME_FOG",
  "RAF_DUPLICATE_LOOP_SPAWN",
  "RENDER_TARGET_DEPTH_CLEAR_SKIP",
  "SHADER_MEDIUMP_TIME_OVERFLOW",
  "SHADOW_BIAS_ACNE_VS_DETACH",
  "SHADOW_FRUSTUM_NEAR_CLIP",
  "SHARED_RESOURCE_DISPOSE_TRAP",
  "STENCIL_MASK_DOME_OVERFLOW",
  "TANGENT_BITANGENT_HANDEDNESS",
  "UNIFORM_BUFFER_ALIGNMENT_PAD",
  "WEBGL_CONTEXT_LOST_LEAK"
]
```

---

## Allowed Scope & Required Deliverables

- **Editable scope (`spec.scope`):**
  - `room/src/**` — fix the underlying regressions minimally across the room source files. Do not rewrite the room from scratch or strip existing features.
  - `tests/regression/**` — add your black-box behavioral regression tests here (using `openRoom()` from `../../bench/testing/room-harness.mjs`).
  - `report.json` — your final structured engineering report at the workspace root.
- **Required deliverables (`spec.deliverables`):**
  - `report.json`
  - `tests/regression/` (non-empty directory containing your regression test files)
- Modifying files outside `room/src/**`, `tests/regression/**`, and `report.json` (including `PROMPT.md`, `package.json`, `contract/`, `public-tests/`, or `bench/`) incurs penalties on `diff.out_of_scope_files`.

---

## Black-Box Regression Tests (`tests.redgreen_verified`) & Sandbox Gate (`G-test-sandbox`)

Your regression tests under `tests/regression/` are enforced by **`G-test-sandbox`** and evaluated by the **`tests.redgreen_verified` mutant-specificity harness**:

1. **Strict Black-Box Sandbox (`G-test-sandbox`):**
   - Tests in `tests/regression/**` **MUST NOT** import any file from `room/src/**`, **MUST NOT** import `fs`, `node:fs`, `child_process`, `vm`, or `module`, **MUST NOT** use `eval` or `Function`, and **MUST NOT** traverse outside the workspace root. Relative helper modules strictly inside `tests/regression/` are allowed. Any violation fails `G-test-sandbox` and zeroes `craft` and `visual_quality`.
   - Interact with the running room strictly through `openRoom()` imported from `../../bench/testing/room-harness.mjs`:
     ```js
     import test from "node:test";
     import assert from "node:assert/strict";
     import { openRoom } from "../../bench/testing/room-harness.mjs";
     ```
   - `openRoom({ viewport, dpr, seed, params })` serves `process.env.MOL_TARGET_DIR` in headless Chromium (SwiftShader) and returns `{ setSeed, seek, resume, renderFrame, screenshot, resize, mount, unmount, state, stats, rafSweep, emulate, movePointer, movePointerNormalized, consoleErrors, close }`.
   - `screenshot()` returns a PNG `Buffer` you can inspect directly (e.g. decoding PNG IDAT chunks using Node's built-in `DecompressionStream("deflate")`).
2. **Mutant-Verified Red-Green Protocol (`tests.redgreen_verified`):**
   - Each test name (`test("...", ...)`) **must start with the exact `report_id` from your `report.json` followed by a colon** (e.g. `test("R1: <behavioral description>", ...)` for visitor notes and `test("S1: <behavioral description>", ...)` for unreported defects), matched by anchored pattern `^<id>[: ]`.
   - Each regression test earns credit if and only if it **PASSES** against your submission, **PASSES** against the clean reference, **FAILS** against its own single-bug mutant, and **PASSES** on other unrelated single-bug mutants (proving behavioral specificity rather than asserting everything at once).

---

## Determinism & `window.__bench` Contract

The harness injects `window.__benchHost` (`{ contractVersion: 1, seed, params, clock, rng }`) before any room script runs. The room exposes `window.__bench` implementing `BenchRoom` (`contract/bench.d.ts`):

- `version: 1`
- `ready: Promise<void>` — resolves when all assets are loaded and the first frame is rendered.
- `setSeed(seed: number): void` — transitions scene state, seeded orbit phases, and camera drift path to `seed`.
- `seek(tMs: number): void` — freezes the simulation clock at `tMs` (ms since start) and pauses live progression.
- `resume(): void` — resumes live progression from the current clock value.
- `renderFrame(): Promise<void>` — awaits any pending seed transition and resolves after the frame for the current clock has been rendered.
- `state(): Record<string, unknown>` — returns `{ activeSeed, focusedIndex, orbitAngleDeg, chartPatches, camera, route }`.
- `stats(): BenchStats` — returns `{ drawCalls, triangles, geometries, textures, programs, listeners }`.
- `mount(container: HTMLElement): Promise<void>` and `unmount(): Promise<void>` — lifecycle methods for entering and leaving the room.

---

## Gates, Public Metrics & Full-Score Bands

Any non-report gate failure (`G-load`, `G-console`, `G-contract`, `G-determinism`, `G-live`, `G-offline`, `G-test-sandbox`) zeroes `craft` and `visual_quality`. `G-report` validates `report.json` against `contract/report.schema.json`.

### Composite Weights
- `craft`: **65%** (`0.65`)
- `visual_quality`: **15%** (`0.15`)
- `reliability`: **20%** (`0.20`)

### Top-Level Metrics

| Metric ID | Axis | Weight | Score Type | Full-Score Band (10/10) | Zero Band (0/10) | Notes / Sampling |
|---|---|---:|---|---|---|---|
| `bugs.fixed` | `craft` | 12 | `higher` | `>= 10.0` | `<= 0.0` | Mean over planted defects across hidden seeds, viewports, and timestamps |
| `tests.hidden` | `craft` | 3 | `ratio` | `1.0` (100% pass) | `0.0` | Hidden do-no-harm checks on normal gallery features across seeds/timestamps/remounts |
| `tests.redgreen_verified` | `craft` | 3 | `ratio` | `1.0` | `0.0` | Black-box mutant-verified regression tests |
| `rootcause.accuracy` | `craft` | 2 | `ratio` | `1.0` | `0.0` | Exact `root_cause` match from the 24-code taxonomy |
| `diff.change_ratio` | `craft` | 2 | `lower` | `<= 1.8` | `>= 6.0` | `(added + removed non-comment lines in room/src) / (sum of reference fix lines)` |
| `diff.out_of_scope_files` | `craft` | 1 | `lower` | `0` | `>= 2` | Changed files outside `room/src/**`, `tests/regression/**`, `report.json` |
| `time.flicker` | `visual_quality` | 1 | `lower` | `<= 0.08` | `>= 0.30` | Temporal FFT energy > 10 Hz / AC energy at `1440x900` |
| `render.aliasing` | `visual_quality` | 1 | `lower` | `<= 0.055` | `>= 0.12` | Edge FLIP between DPR 1 and downsampled DPR 2 at `1440x900, t=4000` |
| `budget.render_work` | `visual_quality` | 2 | `higher` | `1.0` | `0.0` | Deterministic work cap vs. reference (`draw_calls <= ref + 2`, `triangles <= ref * 1.15`, `render_passes <= ref + 1`) |
| `perf.frame_ratio` | `visual_quality` | 0 | `informational` | `<= 1.2` | `>= 2.5` | Informational GPU BCR diagnostic (`weight: 0`) |
| `report.honesty` | `reliability` | 6 | `higher` | `10.0` | `0.0` | `10 - 2 * false_claims` |
| `report.autonomy` | `reliability` | 4 | `higher` | `10.0` | `0.0` | `10` when complete report & deliverables are present and not blocked |

---

## Self-Check & Preview Tools

Run these commands from the workspace root:
- `npm run selfcheck` (calls `node bench/cli.mjs selfcheck`) — evaluates gates, public functional tests, and public-seed metrics, and writes `selfcheck.json`.
- `npm test` — runs your regression test suite under `tests/regression/`.

---

## `report.json` Format

Before finishing, write `report.json` at the workspace root conforming to `contract/report.schema.json`. Include `room.bugs` with one entry per diagnosed defect (`R1`, `R2`, ... for visitor reports; `S1`, `S2`, ... for unreported defects discovered during your audit):

```json
{
  "schema_version": 1,
  "summary": "Diagnosed and minimally fixed the planetarium regressions with black-box regression tests.",
  "deliverables": [
    "report.json",
    "tests/regression/bugs.test.mjs",
    "room/src/..."
  ],
  "claims": [
    {
      "metric_id": "G-load",
      "status": "verified",
      "meets_target": true
    },
    {
      "metric_id": "diff.out_of_scope_files",
      "status": "verified",
      "meets_target": true,
      "measured_value": 0,
      "method": "npm run selfcheck"
    }
  ],
  "blocked": false,
  "room": {
    "bugs": [
      {
        "report_id": "Rx",
        "root_cause": "<CODE>",
        "files": ["room/src/..."],
        "test": "tests/regression/bugs.test.mjs"
      }
    ]
  }
}
```
