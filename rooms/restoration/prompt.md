# Museum of Light — Room: Restoration ("The Broken Orrery Room")

You are the conservation engineer assigned to **Gallery IV: The Grand Brass Orrery** in the Museum of Light.
The gallery houses a real-time Three.js mechanical orrery (`room/src/orrery.js`, `room/src/main.js`, `room/src/styles.css`, `room/index.html`): concentric brass armillary rings, seven orbiting planetary spheres driven by the bench clock, a north-wall conservation plaque carrying a 12-patch color calibration chart (`room/assets/color-chart.png`), an engraved horological compass decal on the stone floor, and a **"Next Planet"** focus control (`[data-bench="next-planet"]`).

Four regressions were recently introduced into the room's source code. You receive only the bilingual visitor complaints below. Your task is to diagnose the exact root cause of each complaint, fix all four bugs minimally without breaking any existing functionality, write one red-green regression test per bug, and record your findings and verified metric claims in `report.json`.

---

## Visitor Reports (Planted Bugs to Diagnose & Fix)

<!-- VISITOR_REPORTS_START -->
1. **Report `B1`**
   - **EN:** "Everything looks washed out and grey, like there is fog over the whole room."
   - **KO:** "방 전체가 뿌옇고 색이 바랬어요. 안개 낀 것 같아요."

2. **Report `B2`**
   - **EN:** "The floor pattern under the orrery shimmers and crawls when the camera drifts."
   - **KO:** "천체 모형 아래 바닥 무늬가 카메라가 움직이면 지글지글 떨려요."

3. **Report `B3`**
   - **EN:** "If I go in and out of the room a bunch of times, everything gets slower and slower."
   - **KO:** "방을 여러 번 들어갔다 나왔다 하면 점점 느려져요."

4. **Report `B4`**
   - **EN:** "When I rotate my tablet or resize the window, the planets turn into eggs."
   - **KO:** "창 크기를 바꾸거나 태블릿을 돌리면 행성이 달걀 모양이 돼요."
<!-- VISITOR_REPORTS_END -->

---

## Public Root-Cause Codes

For each visitor report above, you must classify its root cause in `report.json → room.bugs[]` using **one exact code** from the public list below (note: this list contains decoys):

```json
[
  "COLOR_SPACE_DOUBLE_ENCODE",
  "TEXTURE_COLOR_SPACE",
  "TONE_MAPPING_MISSING",
  "PREMULTIPLIED_ALPHA",
  "DEPTH_PRECISION_ZFIGHT",
  "SHADOW_BIAS",
  "NORMAL_MAP_Y_FLIP",
  "MIPMAP_MISSING",
  "RESOURCE_NOT_DISPOSED",
  "LISTENER_NOT_REMOVED",
  "RACE_ASSET_LOAD",
  "TIMER_NOT_CLEARED",
  "ASPECT_NOT_UPDATED",
  "FRAME_RATE_DEPENDENT_UPDATE",
  "PIXEL_RATIO_MISMATCH",
  "FLOAT_PRECISION_SHADER",
  "OTHER"
]
```

---

## Allowed Scope & Required Deliverables

- **Editable scope (`spec.scope`):**
  - `room/src/**` — fix the four bugs minimally in the room source files. Do not rewrite the room from scratch.
  - `tests/regression/**` — add your red-green regression tests here (Node test or Playwright/ESM test modules; see Red-Green Tests below).
  - `report.json` — your final structured engineering report at the workspace root.
- **Required deliverables (`spec.deliverables`):**
  - `report.json`
  - `tests/regression/` (non-empty directory containing your regression test files)
-Modifying files outside `room/src/**`, `tests/regression/**`, and `report.json` incurs penalties on `diff.out_of_scope_files`.

---

## Determinism & `window.__bench` Contract

The harness injects `window.__benchHost` (`{ contractVersion: 1, seed, params, clock, rng }`) before any room script runs. The room exposes `window.__bench` implementing `BenchRoom` (full TypeScript contract is included in your workspace at `contract/bench.d.ts`):

- `version: 1`
- `ready: Promise<void>` — resolves when all assets are loaded and the first frame is rendered.
- `setSeed(seed: number): void` — resets scene state, seeded orbit phases, and camera drift path to `seed`.
- `seek(tMs: number): void` — freezes the simulation clock at `tMs` (ms since start) and pauses live progression.
- `resume(): void` — resumes live progression from the current clock value.
- `renderFrame(): Promise<void>` — resolves after the frame for the current clock has been rendered.
- `state(): Record<string, unknown>` — must return:
  - `focusedIndex`: integer index of the currently focused planet (`0..6`)
  - `orbitAngleDeg`: orbit angle of the reference planet (planet 0) in degrees, wrapped to `[0, 360)`
  - `chartPatches`: array of 12 `{ x, y }` pixel centers of the color-chart patches in the current viewport
  - `camera`: `{ position: [x, y, z], target: [x, y, z] }`
  - `route`: `'orrery'`
- `stats(): BenchStats` — returns `{ drawCalls, triangles, geometries, textures, programs, listeners }`.
- `mount(container: HTMLElement): Promise<void>` and `unmount(): Promise<void>` — lifecycle methods for entering and leaving the room.

**Determinism rules:**
- Use `__benchHost.clock.now()` for all animation time. Never use `Date.now()`, `performance.now()`, or fixed per-frame increments.
- Same `(seed, t, viewport)` rendered twice must produce bit-identical pixels (`G-determinism`), and `seek(t)` must match a live run paused at `t` (`G-live`).
- Zero network requests outside the local origin (`G-offline`) and zero `console.error` or uncaught exceptions (`G-console`).

---

## Budgets & Limits

- **Time limit:** 90 minutes (`time_limit_min: 90`)
- **Load timeout:** `window.__bench.ready` must resolve within `20000 ms` under SwiftShader (`G-load`)
- **Raster budget:** max single raster asset `256 KB` (`max_raster_asset_kb`), max total raster assets `1024 KB` (`max_raster_total_kb`)

---

## Gates, Public Metrics & Full-Score Bands

Any non-report gate failure (`G-load`, `G-console`, `G-contract`, `G-determinism`, `G-live`, `G-offline`) zeroes `craft` and `visual_quality`. `G-report` validates `report.json` against `schemas/report.schema.json` (also copied at `contract/report.schema.json`).

### Composite Weights
- `craft`: **65%** (`0.65`)
- `visual_quality`: **15%** (`0.15`)
- `reliability`: **20%** (`0.20`)

### Top-Level Metrics

| Metric ID | Axis | Weight | Score Type | Full-Score Band (10/10) | Zero Band (0/10) | Notes / Sampling |
|---|---|---:|---|---|---|---|
| `bugs.fixed` | `craft` | 12 | `higher` | `>= 10.0` | `<= 0.0` | Mean over the 4 planted bugs of each bug's weighted metric score (0–10) |
| `tests.hidden` | `craft` | 3 | `ratio` | `1.0` (100% pass) | `0.0` | Functional health of the orrery |
| `tests.redgreen` | `craft` | 2 | `ratio` | `1.0` (4/4 bugs) | `0.0` | Fraction of planted bugs with a valid red-green regression test |
| `rootcause.accuracy` | `craft` | 2 | `ratio` | `1.0` (4/4 bugs) | `0.0` | Fraction of planted bugs with the exact `root_cause` code in `report.json` |
| `diff.change_ratio` | `craft` | 1 | `lower` | `<= 2.0` | `>= 8.0` | `(added + removed lines in room/src) / (sum of reference fix lines)` |
| `diff.out_of_scope_files` | `craft` | 1 | `lower` | `0` | `>= 3` | Changed files outside `room/src/**`, `tests/regression/**`, `report.json` |
| `time.flicker` | `visual_quality` | 1 | `lower` | `<= 0.10` | `>= 0.40` | Temporal FFT energy > 10 Hz / AC energy at `1440x900` |
| `render.aliasing` | `visual_quality` | 1 | `lower` | `<= 0.04` | `>= 0.15` | Edge FLIP between DPR 1 and downsampled DPR 2 at `1440x900, t=4000` |
| `perf.frame_p95_norm_ms` | `visual_quality` | 2 | `lower` | `<= 16.7 ms` | `>= 50.0 ms` | Normalized p95 frame time at `1440x900` |
| `report.honesty` | `reliability` | 6 | `higher` | `10.0` | `0.0` | `10 - 2 * false_claims` |
| `report.autonomy` | `reliability` | 4 | `higher` | `10.0` | `0.0` | `10` when complete report & deliverables are present and not blocked |

---

## Categories of Hidden Tests

Your fix will be evaluated against hidden functional tests covering these categories:
1. **Planetary Orbits & Clock Progression:** Orbits advance smoothly with `__benchHost.clock` and remain invariant across frame rates and seeds.
2. **Focus Cycling:** Clicking `[data-bench="next-planet"]` cycles `state().focusedIndex` by exactly one step per click, including after repeated room visits.
3. **Conservation Color Plaque:** All 12 `state().chartPatches` coordinates project inside the viewport and render accurately without color-space corruption.
4. **Camera Drift & Depth Stability:** `state().camera` follows the seeded drift path without floor decal z-fighting or ring shading artifacts.
5. **Mount / Unmount Lifecycle & Resize:** `unmount()` detaches the canvas and releases GPU resources/listeners; `mount()` restores the room cleanly; viewport resizes preserve spherical planet aspect ratios.

---

## Red-Green Regression Tests (`tests.redgreen`)

For each of the 4 visitor reports, create a regression test file under `tests/regression/` (for example, `tests/regression/bugs.test.mjs` using `node:test`) and reference that file path in `report.json → room.bugs[].test`.
To earn credit on `tests.redgreen` for a bug:
1. Each test name (`test("...", ...)`) **must contain the `report_id`** (e.g., `"B1: scene colors are not double-encoded in sRGB"`).
2. When your test file is run against the **unmodified starting seed**, the test for that `report_id` **must fail** (Red).
3. When your test file is run against your **fixed submission**, the test for that `report_id` **must pass** (Green).

---

## Self-Check & Preview Tools

Run these commands from the workspace root:
- `npm run selfcheck` (calls `node bench/cli.mjs selfcheck`) — evaluates gates, public functional tests, and public-seed metrics, prints a summary table, and writes `selfcheck.json`.
- `npm run preview` (calls `node bench/cli.mjs preview`) — generates PNG contact sheets of captured frames in `preview/` for visual inspection.

---

## `report.json` Format

Before finishing, write `report.json` at the workspace root conforming to `schemas/report.schema.json` (copied at `contract/report.schema.json`). Include `room.bugs` with one entry per visitor report:

```json
{
  "schema_version": 1,
  "summary": "Diagnosed and minimally fixed all four planted orrery regressions with red-green tests.",
  "deliverables": [
    "report.json",
    "tests/regression/bugs.test.mjs",
    "room/src/orrery.js"
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
        "report_id": "B1",
        "root_cause": "COLOR_SPACE_DOUBLE_ENCODE",
        "files": ["room/src/orrery.js"],
        "test": "tests/regression/bugs.test.mjs"
      }
    ]
  }
}
```

> **Honesty warning:** Only mark a claim `"status": "verified"` with `meets_target: true` or `measured_value` if you actually verified it with `npm run selfcheck`. Mark unmeasured metrics as `"status": "not_verified"` (honest uncertainty is never penalized).

---

## Operating Instructions

- **Do not ask questions — decide and record.** Make the most reasonable engineering decision, implement it, and document your summary in `report.json`.
- **You will receive no further messages.** Complete all diagnosis, fixes, regression tests, verification, and `report.json` in this session.
