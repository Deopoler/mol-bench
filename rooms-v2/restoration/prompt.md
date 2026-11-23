# Museum of Light — Room: Restoration v0.2 ("The Fractured Planetarium")

You are the senior conservation systems engineer assigned to **Gallery IV: The Grand Planetarium** in the Museum of Light.
The gallery runs a modular real-time Three.js planetarium (`room/src/planetarium.js`, `room/src/main.js`, `room/src/styles.css`, `room/index.html`, and six subsystem modules under `room/src/modules/`): concentric brass armillary rings above a central pedestal, seven orbiting planetary spheres driven by the bench clock, an engraved brass astrolabe floor dial and central-north relief medallion, a north-west conservation color calibration plaque (`room/assets/color-chart.png`), a north-east celestial meridian clock dial beneath a glass dome vault, and a **"Next Planet"** focus control (`[data-bench="next-planet"]`).

Six interacting regressions were recently introduced across the planetarium's subsystem modules. You receive only the **four synthesized curator & visitor complaints** below — note that some complaints conceal **interacting or masking bug pairs** where fixing the primary visual symptom unmasks a second underlying defect. Your task is to diagnose all **six** underlying bugs, fix them minimally in `room/src/**` without breaking existing functionality or coupled constraints, write one **black-box behavioral regression test** per bug in `tests/regression/**` using `bench/testing/room-harness.mjs`, and classify all six root causes in `report.json`.

- **Spec Time Limit:** **75 minutes** (`time_limit_min: 75`).

---

## Synthesized Curator & Visitor Complaints (6 Planted Bugs Across 4 Notes)

<!-- VISITOR_REPORTS_START -->
1. **Curator Note I — Chamber Haze & Surface Relief (Covers Reports `B1`, `B2`)**
   - **Report `B1` (Primary Symptom):**
     - **EN:** "The entire planetarium chamber looks washed out under a pale grey glare, draining contrast from the walls, color chart, and central apparatus."
     - **KO:** "천체관 전체가 창백한 회색빛 안개에 덮인 것처럼 바래 보여서 벽면과 색상표, 중앙 장치의 대비가 모두 사라졌어요."
   - **Report `B2` (Unmasked After Clearing Chamber Haze):**
     - **EN:** "Once the chamber haze is cleared, the engraved astrolabe ridges and wall medallion look inside-out, catching lamp light on their underside instead of their upper crests."
     - **KO:** "전시실의 뿌연 현상을 걷어내고 나니, 아스트롤라베와 벽면 메달리온의 양각 능선이 위아래가 뒤집힌 것처럼 빛을 반대로 받고 있어요."

2. **Curator Note II — Armillary Ring Striping & Pedestal Contact Shadow (Covers Report `B5`)**
   - **Report `B5`:**
     - **EN:** "Rippling dark bands cover the brass armillary rings while the shadow at the base of the central pedestal and the glass dome depth layering look detached or inverted."
     - **KO:** "황동 혼천의 고리에 이상한 줄무늬가 생기고 중앙 받침대 아래 그림자와 유리 돔의 깊이감이 어긋나 보여요."

3. **Curator Note III — Repeated Gallery Entry & Focus Control (Covers Report `B6`)**
   - **Report `B6`:**
     - **EN:** "Leaving and re-entering the gallery repeatedly causes memory and interaction handlers to pile up, yet naively wiping all geometry objects leaves the planets and rings missing on re-entry."
     - **KO:** "전시실을 여러 번 나갔다 들어오면 메모리와 버튼 반응이 누적되고, 그렇다고 모든 도형을 일괄 폐기하면 재입장 시 행성과 고리가 사라져 버려요."

4. **Curator Note IV — Preset Switching, Refresh Rates & Display Scaling (Covers Reports `B7`, `B8`)**
   - **Report `B7`:**
     - **EN:** "Switching rapidly between exhibition presets sometimes leaves an earlier preset's planetary alignment and camera path on screen after the switch finishes."
     - **KO:** "전시 프리셋을 빠르게 연속으로 전환하면 나중에 선택한 배치가 아니라 이전에 눌렀던 행성 정렬 상태로 되돌아가곤 해요."
   - **Report `B8`:**
     - **EN:** "Rotating a tablet from portrait back to landscape or resizing across high-density displays leaves the planets stretched into wide ovals."
     - **KO:** "태블릿을 세로에서 가로로 다시 돌리거나 고해상도 화면 크기를 조절하면 행성이 옆으로 넓적한 타원형으로 찌그러져요."
<!-- VISITOR_REPORTS_END -->

---

## Public Root-Cause Taxonomy (20 Codes: 10 Active + 10 Decoys)

For each of the **6** report IDs above, you must classify its root cause in `report.json → room.bugs[]` using **one exact code** from the 20-code public taxonomy below:

```json
[
  "POSTFX_DOUBLE_TONEMAP",
  "NORMAL_MAP_GREEN_INVERTED",
  "PREMULT_ALPHA_DOME_FOG",
  "DATA_TEXTURE_SRGB_DECODE",
  "SHADOW_BIAS_ACNE_VS_DETACH",
  "SHARED_RESOURCE_DISPOSE_TRAP",
  "ASYNC_SEED_RACE",
  "DPR_FBO_RESIZE_DESYNC",
  "FIXED_STEP_SUBSTEP_DRIFT",
  "SHADER_MEDIUMP_TIME_OVERFLOW",
  "COLOR_SPACE_MISSING_GAMMA",
  "TANGENT_BITANGENT_HANDEDNESS",
  "MIPMAP_ANISOTROPY_BLEED",
  "DEPTH_BUFFER_LOGARITHMIC_ZFIGHT",
  "SHADOW_FRUSTUM_NEAR_CLIP",
  "WEBGL_CONTEXT_LOST_LEAK",
  "RAF_DUPLICATE_LOOP_SPAWN",
  "UNIFORM_BUFFER_ALIGNMENT_PAD",
  "CAMERA_FOV_RADIANS_MISMATCH",
  "STENCIL_MASK_DOME_OVERFLOW"
]
```

---

## Allowed Scope & Required Deliverables

- **Editable scope (`spec.scope`):**
  - `room/src/**` — fix the six bugs minimally in the room source files (`room/src/modules/*.js`). Do not rewrite the room from scratch.
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
   - Tests in `tests/regression/**` **MUST NOT** import any file from `room/src/**`, **MUST NOT** import `fs`, `node:fs`, `child_process`, `vm`, or `module`, **MUST NOT** use `eval` or `Function`, and **MUST NOT** traverse outside the workspace root. Any violation fails `G-test-sandbox` and zeroes `craft` and `visual_quality`.
   - Instead, interact with the running room strictly through `openRoom()` imported from `../../bench/testing/room-harness.mjs`:
     ```js
     import test from "node:test";
     import assert from "node:assert/strict";
     import { openRoom } from "../../bench/testing/room-harness.mjs";
     ```
   - `openRoom({ viewport, dpr, seed, params })` serves `process.env.MOL_TARGET_DIR` in headless Chromium (SwiftShader) and returns `{ setSeed, seek, resume, renderFrame, screenshot, resize, mount, unmount, state, stats, rafSweep, emulate, movePointer, movePointerNormalized, consoleErrors, close }`.
2. **Mutant-Verified Red-Green Protocol (`tests.redgreen_verified`):**
   - Each test name (`test("...", ...)`) **must start with the exact `report_id` followed by a colon** (e.g. `test("Bx: <behavioral description>", async () => { ... })`), matched by anchored pattern `^B<n>[: ]`.
   - Your test for bug `b_i` earns credit if and only if:
     1. It **PASSES** against your fixed submission (`MOL_TARGET_DIR=<submission>`).
     2. It **PASSES** against the clean reference implementation (`MOL_TARGET_DIR=<reference>`).
     3. It **FAILS** against single-bug mutant `b_i` (`MOL_TARGET_DIR=<mutants/b_i>`).
     4. It **PASSES** on **≥ 4 of the 5** other active single-bug mutants `b_j (j ≠ i)` (proving your test checks the specific behavioral failure of `b_i` rather than asserting everything at once).

---

## Determinism & `window.__bench` Contract

The harness injects `window.__benchHost` (`{ contractVersion: 1, seed, params, clock, rng }`) before any room script runs. The room exposes `window.__bench` implementing `BenchRoom` (`contract/bench.d.ts`):

- `version: 1`
- `ready: Promise<void>` — resolves when all assets are loaded and the first frame is rendered.
- `setSeed(seed: number): void` — transitions scene state, seeded orbit phases, and camera drift path to `seed`.
- `seek(tMs: number): void` — freezes the simulation clock at `tMs` (ms since start) and pauses live progression.
- `resume(): void` — resumes live progression from the current clock value.
- `renderFrame(): Promise<void>` — awaits any pending seed transition and resolves after the frame for the current clock has been rendered.
- `state(): Record<string, unknown>` — returns `{ activeSeed, focusedIndex, orbitAngleDeg, chartPatches, focusedCenter, focusedMaskColor, probes, camera, route }`, where `state().probes` provides `{ bgSrgb, domeCenterSrgb, topBevelSrgb, botBevelSrgb, satinSectorSrgb, mirrorSectorSrgb, focusedAspect, focusedPixelCount, meridianSampleSrgb, contactShadowSrgb, canvasSize, postTargetSize }`.
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
| `bugs.fixed` | `craft` | 12 | `higher` | `>= 10.0` | `<= 0.0` | Mean over the 6 planted bugs of each bug's weighted metric score (0–10) |
| `tests.hidden` | `craft` | 3 | `ratio` | `1.0` (100% pass) | `0.0` | Functional health of the planetarium across hidden seeds/timestamps/remounts |
| `tests.redgreen_verified` | `craft` | 3 | `ratio` | `1.0` (6/6 bugs) | `0.0` | Black-box mutant-verified regression tests |
| `rootcause.accuracy` | `craft` | 2 | `ratio` | `1.0` (6/6 bugs) | `0.0` | Exact `root_cause` match from the 20-code taxonomy |
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

Before finishing, write `report.json` at the workspace root conforming to `contract/report.schema.json`. Include `room.bugs` with one entry for each of the **6** planted report IDs:

```json
{
  "schema_version": 1,
  "summary": "Diagnosed and minimally fixed the planted planetarium regressions with black-box regression tests.",
  "deliverables": [
    "report.json",
    "tests/regression/bugs.test.mjs",
    "room/src/modules/<module>.js"
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
        "report_id": "Bx",
        "root_cause": "<CODE>",
        "files": ["room/src/modules/<module>.js"],
        "test": "tests/regression/bugs.test.mjs"
      }
    ]
  }
}
```
