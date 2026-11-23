# MoL-Bench v0.2 — Python Metrics & Browser Probes (`WP-1`)

> **Status:** Implemented against frozen WP-0a extension hooks (`docs/v02/HOOKS.md`).  
> **Scope:** Authoritative algorithm notes and WP-0b/WP-2/WP-3/WP-4 interceptor input schemas for all WP-1 Python metrics (`metrics/molmetrics/{spatial,reflection,budget_glsl,redgreen}.py`) and browser probes (`harness/src/capture/probes/{overlap,contrast_apca,flow,perf_dom,theme_tri}.js`).

---

## 1. Python Metric Plugins (`metrics/molmetrics/`)

All four modules export `register(METRICS)` and are auto-discovered by `molmetrics.cli.discover_plugins()` when `spec_version >= 0.2.0` (or `rooms-v2/`).

### 1.1 `spatial.py` — `color.palette_band_sep`
- **Track & Band:** `aurora` v0.2 — `higher`, `full: 0.75`, `zero: 0.25`, `at: 1440x900, all timestamps`, `agg: median`.
- **Algorithm:**
  1. If `horizonY` (normalized `[0, 1]` or row px) is present on the sample or `manifest.params[seed]`, restrict evaluation to sky rows `y < horizonY * H`.
  2. Identify chromatic pixels (`C > 0.04` and `L > 0.25` in OKLab) and assign each to its nearest palette color in OKLab.
  3. Require minimum palette share `min_share >= 0.06` (`share_score = clip(min_share / 0.08, 0, 1)`) AND vertical centroid standard deviation `std(y_0, ..., y_{K-1}) >= 0.045` (`strat_score = clip(y_std / 0.06, 0, 1)`).
  4. Return `min(share_score, strat_score)` in `[0, 1]`. Both thresholds map exactly to `0.75`.

### 1.2 `reflection.py` — `scene.reflection_coherence`, `scene.water_ripple`, `scene.terrain_lighting`
- **Horizon & Shoreline Detection:** Uses `horizonY` hint when provided to locate the dark mountain ridge interior (`L < 0.07`), the ridge crest `h_ridge(x)` (handling both bright rim-over-dark-sky and stepped rim-over-bright-sky profiles), and the lake shoreline `y_shore`.
- **`scene.reflection_coherence`** (`higher`, `full: 0.62`, `zero: 0.20`):
  - Gaussian-blurred (`σ = 6`) OKLab `(L, a, b)` normalized cross-correlation (NCC) between vertically mirrored sky strip above the horizon/shoreline and lake strip below, multiplied by `fresnel_ok = 1.0 if mean(L_lake) < 0.85 * mean(L_sky) else 0.0`.
- **`scene.water_ripple`** (`range`, `ideal: [0.015, 0.12]`, `zero: [0.0, 0.30]`):
  - Computes lake vertical-vs-horizontal luminance gradient anisotropy `(mean(|∂L/∂y|) - mean(|∂L/∂x|)) / (mean(|∂L/∂y|) + mean(|∂L/∂x|))` (clamped to `[0, 1]`), multiplied by mean LDR-FLIP between the lake strip and a luminance-matched mirrored sky strip. Rejects unrippled mirror copies (`FLIP ≈ 0`), isotropic static noise (`anisotropy ≈ 0`), and solid black lakes.
- **`scene.terrain_lighting`** (`higher`, `full: 0.55`, `zero: 0.10`):
  - 32-column-bin Pearson correlation `r` between overhead aurora luminance (`~25–50 px` above `h_ridge(x)`) and ridge-crest rim luminance (`6 px` below `h_ridge(x)`), requiring dark ridge interior (`mean L < 0.07`) and measurable rim brightness above the interior (`mean(rim) - mean(interior) > 0.005`).

### 1.3 `budget_glsl.py` — `budget.gpu_work_profile`, `budget.shader_ops`, `budget.render_passes`, `budget.draw_calls`, `budget.render_work`
- **GLSL Static Analyzer (`count_shader_ops`, `count_program_ops`):**
  - Strips `/*...*/` and `//...` comments, expands constant integer `#define` macros, extracts user-defined functions (inlining call-site costs with cycle protection), expands constant-bound `for` loops exactly, and treats dynamic/uniform-bound loops (`for` without constant upper bound or `while`) as `32` iterations.
  - Op weights: `1` ALU op/builtin, `2` branch (`if`, `?`, `discard`), `4` transcendental (`sin/cos/tan/asin/acos/atan/exp/pow/log/sqrt/...`), `16` texture fetch (`texture*`, `texelFetch*`).
- **Expected `manifest.json` Input Shape from WP-0b `host.js`:**
  Can be placed per sample (`manifest.samples[i].webgl`) or once at manifest root (`manifest.webgl`), with optional `manifest.bundle_gz_kb`:
  ```json
  {
    "webgl": {
      "programs": [
        {
          "vertex": "#version 300 es ...",
          "fragment": "#version 300 es ...",
          "draw_calls": 1,
          "vertices_drawn": 3
        }
      ],
      "draw_calls_per_frame": 1,
      "fbo_switches": 1,
      "pixel_fill_ratio": 1.0,
      "vertices_drawn_per_frame": 3,
      "triangles_per_frame": 1,
      "tex_upload_kb": 0.0,
      "gl_calls_per_frame": 12,
      "bundle_gz_kb": 4.5,
      "reference": {
        "draw_calls": 10,
        "triangles": 4000,
        "render_passes": 2.0
      }
    }
  }
  ```
  - `budget.gpu_work_profile` computes the **minimum** across 4 linear-ramp channels (default `aurora` v0.2 thresholds, overrideable via `spec.budget_thresholds.gpu_work_profile` or `metric.thresholds`):
    1. `shader_ops`: full `<= 650`, zero `>= 2200`
    2. `vertices_drawn_per_frame`: full `<= 12`, zero `>= 2000`
    3. `tex_upload_kb`: full `<= 16`, zero `>= 128`
    4. `min(gl_calls_per_frame [<= 35 / >= 150], bundle_gz_kb [<= 24 / >= 96])`
  - `budget.render_passes` returns `fbo_switches + pixel_fill_ratio` (or direct `render_passes` if supplied).
  - `budget.draw_calls` returns `draw_calls_per_frame` (returns `None` when `webgl` interceptor data is absent so `cli.mjs` `captureRes.drawCalls` is preserved).
  - `budget.render_work` (`restoration` v0.2) scores `min` across `draw_calls <= ref + 2`, `triangles <= ref * 1.15`, `render_passes <= ref + 1`.

### 1.4 `redgreen.py` — `tests.redgreen_verified`
- **Expected `manifest.json` Input Shape:**
  ```json
  {
    "redgreen": {
      "planted_bugs": ["B1", "B2", "B3", "B4", "B5", "B6"],
      "report_bugs": [
        { "report_id": "B1", "root_cause": "...", "test": "tests/regression/b1.test.mjs" }
      ],
      "submission_dir": "/abs/path/to/submission",
      "reference_dir": "/abs/path/to/reference",
      "mutants_dir": "/abs/path/to/hidden-v2/restoration/mutants",
      "sandboxed": true,
      "runs": {
        "B1": {
          "submission": true,
          "reference": true,
          "self_mutant": false,
          "other_mutants": { "B2": true, "B3": true, "B4": true, "B5": true, "B6": true }
        }
      }
    }
  }
  ```
  - When `runs` is omitted and `submission_dir`, `reference_dir`, `mutants_dir` are provided, `redgreen.py` executes each regression test matching `report_id` under `harness/src/testing/room-harness.mjs` `runSandboxedTest()` (`--permission` isolation) against submission, reference, self mutant `b_i`, and every other active mutant `b_j`.
  - A bug `b_i` earns credit iff: `submission == true` AND `reference == true` AND `self_mutant == false` AND `others_passed >= 4/5` (generally `N_other - 1` for `N_other >= 4`).

---

## 2. Browser Probe Plugins (`harness/src/capture/probes/`)

All five plugins export `probeName`, `aliases`, and `runProbe(pageHandle, args, invokedName)` and are auto-discovered by `probes/index.js`.

| File | `probeName` | Aliases / Metric IDs | Key Inputs / Notes |
|---|---|---|---|
| `overlap.js` | `overlap` | `layout.overlap_count` | Pairwise AABB intersection `> 2 px²` across visible sibling block/interactive elements + cross-parent `[data-bench]`/interactive overflow, excluding hidden/closed overlays (`detail-drawer`, `dialog:not([open])`, `[hidden]`, `[aria-hidden="true"]`). Supports `args.zoom200: true`. |
| `contrast_apca.js` | `contrast_apca` | `a11y.apca_contrast` | Captures PNG screenshot, masks foreground-like pixels dilated by a 2 px anti-aliased glyph halo, takes 3×3 median background RGB per visible text node, computes APCA `|Lc|` (`>= 60` body, `>= 75` high-contrast, `>= 45` large headings). Supports `args.highContrast` / `args.scheme === "high_contrast"`. |
| `flow.js` | `flow` | `interact.scripted_flow` | Executes the 10-checkpoint `lobby` v0.2 flow: search -> category chip -> sort by duration -> Tab to 3rd card -> Enter opens drawer -> Tab trap -> Esc restores focus -> Enter Room navigates -> Back restores filter/sort/scroll -> Reload preserves state. |
| `perf_dom.js` | `perf_dom` | `budget.dom_work_profile`, `perf.cls` | Consumes WP-0b `window.__benchHostControl.getDomBudgetStats()` / `window.__benchDomBudget` (when `.ready === true`) or `args.domStats`, or self-instruments `MutationObserver`, forced-layout read wrappers, and `PerformanceObserver('layout-shift', buffered: true)` over filter/sort steps. |
| `theme_tri.js` | `theme_tri` | `theme.tri_valid` | Evaluates `light`, `dark`, and `prefers-contrast: more` via CDP `Emulation.setEmulatedMedia`; passes iff all 3 pixel SHA-256 hashes differ AND both axe `color-contrast` and APCA `a11y.apca_contrast` have 0 failures in all 3 modes. |

### 2.1 WP-0b DOM Interceptor Input Shape (`perf_dom.js`)
If `window.__benchHostControl.getDomBudgetStats()` (or `window.__benchDomBudget`) returns an object with `ready: true`:
```json
{
  "ready": true,
  "steps": 12,
  "dom_mutations": 144,
  "layout_reads": 12,
  "dom_nodes": 480,
  "cls": 0.002
}
```
(`dom_mutations_per_step` and `layout_reads_per_step` may also be supplied directly; otherwise `total / max(1, steps)` is used.)

---

## 3. WP-0b Coordination Note
- `harness/src/capture/plan.mjs` (WP-0b) handles `stepKind === 'nav_transition'` (emitted by `registry.mjs` for `nav.transition_ms` and `a11y.reduced_motion_transition_ms`), `200%` root zoom (`@zoom200`), and `prefers-contrast: more` (`high_contrast`) in capture plans; `probes/nav.js` already implements `probeNavTransitionMs` using CDP `Animation.setPlaybackRate(0)` and `stepRafVirtual`.
