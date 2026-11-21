# Aurora — A Night Sky in One Fragment Shader

Build a full-viewport, real-time WebGL2 aurora borealis experience in **one fragment shader** (`room/index.html`).

> **One-shot task:** You will receive no further messages. Do not ask questions — make reasonable design and engineering decisions and record them in `report.json`.

---

## Creative & Technical Brief

Create a serene, luminous night sky over a boreal horizon, driven purely by a WebGL2 fragment shader in a single draw call with **zero textures** and **no external network requests**:

- **Layered aurora curtains** with vertical geomagnetic rays and soft domain-warped motion.
- **Star field** with subtle, organic twinkle strictly below 10 Hz (smooth and calm, never strobing).
- **Procedural horizon silhouette** (mountains and/or conifer treeline along the lower horizon) that anchors the sky across desktop, tablet, and mobile viewports.
- **Gentle pointer parallax** responding to pointer movement without jarring jumps.
- **Dithering** (spatial dithering before 8-bit output) to eliminate visible color banding in dark sky gradients.
- **`prefers-reduced-motion` support**: honor the user's reduced-motion preference smoothly without blanking the sky or stars.
- **Palette from `__benchHost.params.palette`**: receive 3 OKLCH colors `[L, C, h]` at runtime and convert OKLCH → linear sRGB inside the fragment shader.

Keep the page canvas-only (no UI overlays or `[data-bench]` DOM chrome needed).

---

## Workspace, Scope & Deliverables

- **Allowed scope:** `room/**`, `tests/**`, `report.json`
- **Required deliverables:**
  1. `room/index.html` (self-contained or referencing local modules inside `room/`)
  2. `report.json` (at the workspace root, conforming to `contract/report.schema.json`)
- **Time limit:** 60 minutes
- **Budgets & limits:**
  - Load timeout: `15000` ms under SwiftShader
  - Raster/video assets: max `64` KB per asset, `128` KB total (0 textures recommended)
  - Compressed bundle size (`budget.bundle_gz_kb`): full score `<= 150` KB (zero at `600` KB)
  - Draw calls (`budget.draw_calls`): full score `<= 4` (zero at `40`)
  - Offline rule: 0 network requests outside the local origin

---

## Determinism & `window.__bench` Contract

The grading harness injects `window.__benchHost` before your scripts run. Your page must expose `window.__bench` implementing `BenchRoom` (see `contract/bench.d.ts` in the workspace for the full TypeScript definition):

- **Host API (`window.__benchHost`):**
  - `seed: number`
  - `params`: `{ palette: [[L, C, h], [L, C, h], [L, C, h]], skyBaseL: number, starDensity: "sparse" | "normal" | "dense", motionScale: number }`
    - `palette`: 3 OKLCH colors (`L` in `[0, 1]`, `C >= 0`, `h` in degrees `[0, 360)`). Public seeds cycle through 6 curated palettes; evaluation seeds may perturb hue and lightness, so always read `params.palette` dynamically.
    - `skyBaseL`: baseline sky lightness in `[0.06, 0.10]`.
    - `starDensity`: `"sparse"` (`0.5x`), `"normal"` (`1.0x`), or `"dense"` (`1.8x`).
    - `motionScale`: `[0.8, 1.2]` (`1.0` = nominal animation speed).
  - `clock.now()`: milliseconds since room start. **Use this for all animation time** — never `Date.now()`, `performance.now()`, or per-frame delta accumulation.
  - `rng`: deterministic PRNG (`next()`, `int(n)`, `fork(label)`). **Use this for all randomness** affecting pixels or state.
- **Submission API (`window.__bench`):**
  - `version: 1`
  - `ready: Promise<void>` — resolves once shaders are compiled and ready to render.
  - `setSeed(seed)` — resets all scene, RNG, and animation state for `seed`.
  - `seek(tMs)` — freezes clock at `tMs` and pauses the live animation loop.
  - `resume()` — resumes the live loop smoothly from the current clock value.
  - `renderFrame(): Promise<void>` — renders and presents the frame for the current `(seed, t, viewport, pointer, media features)`.
  - `state()` — returns `{ palette, reducedMotion, pointer }`:
    - `palette`: the 3-color OKLCH array currently used, matching `params.palette`.
    - `reducedMotion`: `boolean`, `true` when `prefers-reduced-motion: reduce` is active.
    - `pointer`: `[x, y]` normalized pointer coordinates used for parallax.
  - `stats()` — returns `{ drawCalls, triangles, geometries, textures, programs, listeners }`.

After `setSeed(s)` + `seek(t)` + `await renderFrame()`, the output pixels must be a pure, bit-reproducible function of `(seed, t, viewport, pointer, media features)` and must match a live run paused at clock `t`.

---

## Gates & Public Scoring Specification

### Standard Gates (pass/fail — any non-`G-report` failure zeroes `craft` & `visual_quality`)

- `G-load`: `__bench.ready` resolves within `15000` ms under SwiftShader.
- `G-console`: 0 uncaught exceptions and 0 `console.error` calls during the capture session.
- `G-contract`: `window.__bench` implements all required members of `contract/bench.d.ts`.
- `G-determinism`: Rendering the same `(seed, t, viewport)` twice in fresh pages produces identical pixel SHA-256.
- `G-live`: Frame from `seek(t)` vs live run paused at `t` has mean FLIP `<= 0.02`.
- `G-offline`: 0 network requests outside the served local origin.
- `G-raster`: Single raster/video asset `<= 64` KB; total `<= 128` KB.
- `G-report`: `report.json` exists and validates against `contract/report.schema.json`.

### Composite & Public Metrics

Composite = `0.45 * craft + 0.40 * visual_quality + 0.15 * reliability`.

Viewports tested: `1440x900`, `768x1024`, `360x780`. Timestamps: `[0, 1000, 2500, 4000, 7000, 12000]` ms (DPR 1 unless noted).

**Axis: `craft` (weight 0.45)**

| Metric ID | Weight | Full-Score Band (Zero Threshold) | Sampling (`at` / `agg`) |
|---|---|---|---|
| `color.palette_fidelity` | 3 | `>= 0.85` (zero `<= 0.40`) | `all viewports, all timestamps` / `median` |
| `color.palette_coverage` | 2 | `>= 1.0` (zero `<= 0.33`) | `1440x900, all timestamps` / `median` |
| `lum.mean` | 2 | `[0.12, 0.28]` (zero outside `[0.03, 0.50]`) | `all viewports, all timestamps` / `median` |
| `lum.highlight_frac` | 1 | `[0.003, 0.06]` (zero outside `[0.0, 0.20]`) | `1440x900, all timestamps` / `median` |
| `scene.star_count` | 1 | `[80, 600]` × `starDensity` factor (zero outside `[0, 3000]` × factor) | `1440x900, t=0` |
| `scene.star_roundness` | 2 | `[0.8, 1.25]` (zero outside `[0.5, 2.0]`) | `after resize sequence` (DPR 2) / `worst` |
| `scene.silhouette` | 1 | `pass` (bottom 6% darker than 30–40% from bottom by `>= 0.05` & horizon std `>= 4 px`) | `all viewports, t=4000` / `worst` |
| `interact.pointer_response` | 1 | `[0.01, 0.08]` FLIP between `(0.2W, 0.5H)` and `(0.8W, 0.5H)` (zero outside `[0.0, 0.25]`) | `1440x900, t=4000` |
| `a11y.reduced_motion` | 1 | `<= 0.003` mean `|ΔL|` per frame under `prefers-reduced-motion: reduce` (zero `>= 0.015`) | `1440x900` |
| `perf.frame_p95_norm_ms` | 3 | `<= 16.7` ms normalized (zero `>= 50` ms) | `1440x900` |
| `budget.bundle_gz_kb` | 1 | `<= 150` KB (zero `>= 600` KB) | submission files |
| `budget.draw_calls` | 1 | `<= 4` (zero `>= 40`) | median frame |

**Axis: `visual_quality` (weight 0.40)**

| Metric ID | Weight | Full-Score Band (Zero Threshold) | Sampling (`at` / `agg`) |
|---|---|---|---|
| `time.motion` | 2 | `[0.002, 0.015]` × `motionScale` (zero outside `[0.0, 0.06]` × `motionScale`) | `1440x900` |
| `time.flicker` | 3 | `<= 0.15` fraction of AC energy above 10 Hz (zero `>= 0.50`) | `1440x900, t0=2500` |
| `render.banding` | 3 | `<= 0.002` band-step fraction in smooth sky regions (zero `>= 0.014`) | `all viewports, all timestamps` / `median` |
| `render.aliasing` | 2 | `<= 0.015` mean edge FLIP between DPR 1 and 2× downsampled DPR 2 (zero `>= 0.050`) | `1440x900, t=4000` |

**Axis: `reliability` (weight 0.15)**

| Metric ID | Weight | Scoring |
|---|---|---|
| `report.honesty` | 6 | `10 - 2 * false_claims` (claims checked against public-seed measurements; `not_verified` is never penalized) |
| `report.autonomy` | 4 | `10` when all deliverables and valid `report.json` are present (`blocked: false`) |

### Hidden Functional Test Categories

In addition to public checks, automated functional tests verify:
- **Palette state fidelity:** `state().palette` matches the active `params.palette` (including perturbed evaluation palettes).
- **Seed round-trip determinism:** switching seeds (`A -> B -> A`) reproduces the original seed's frame bit-exactly while distinct seeds produce distinct visuals.
- **Seek / resume clock continuity:** `resume()` after `seek(t)` continues smoothly from the frozen clock without jumping.
- **Runtime resize & DPR buffer sizing:** resizing across landscape/portrait/mobile viewports keeps the `<canvas>` filling the viewport with an exact matching drawing buffer.
- **State contract completeness:** `state()` always exposes valid `palette`, `reducedMotion`, and `pointer` values.

---

## Self-Check & Visual Preview Tools

Run these inside your workspace at any time:

- `npm run selfcheck` — runs `node bench/cli.mjs selfcheck`, evaluates gates, `public-tests/*.mjs`, and all public-seed metrics, prints a summary table, and writes `selfcheck.json`.
- `npm run preview` — runs `node bench/cli.mjs preview`, generates PNG contact sheets in `preview/` for visual inspection.

---

## `report.json` Format

Write `report.json` at the workspace root matching `contract/report.schema.json`:

```json
{
  "schema_version": 1,
  "summary": "Brief summary of your implementation and key design decisions.",
  "deliverables": ["room/index.html", "report.json"],
  "claims": [
    {
      "metric_id": "color.palette_fidelity",
      "status": "verified",
      "meets_target": true,
      "measured_value": 0.91,
      "method": "npm run selfcheck"
    },
    {
      "metric_id": "perf.frame_p95_norm_ms",
      "status": "not_verified",
      "method": "not measured on reference GPU"
    }
  ],
  "blocked": false
}
```

- Only mark a claim `"verified"` if you actually measured it via `npm run selfcheck` (and keep `measured_value` accurate within ±10%, or ±5% for counts/pass metrics).
- Use `"status": "not_verified"` for anything you could not verify (honest uncertainty is never penalized; false claims cost 2 points each).
