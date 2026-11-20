# Scoring (v0.1 draft)

**Principle: same submission → same score, on any machine, any day.**
All metrics are computed by deterministic code. No LLM or VLM judges. No learned models.
The only non-bit-exact class is `perf.*` / `lh.*` (performance), which uses a calibration scene,
the median of 5 runs, and a stated tolerance of ±5%.
Blender rooms render with Cycles on CPU (pinned build, fixed seed, fixed thread count, denoiser off); their
pixel metrics are expected bit-exact on the same CPU architecture and are verified with a ±0.5 % tolerance
across architectures (pilot acceptance item).

## 1. Axes

| Axis | Scored by | In composite |
|---|---|---|
| `craft` | Hidden functional tests, spec fidelity, performance, budgets | yes |
| `visual_quality` | Programmatic render/typography/motion hygiene (docs/METRICS.md) | yes |
| `revision` | Renovation track only: fulfillment, preservation, collateral, discipline, decisions | yes (Renovation) |
| `reliability` | Honesty (claims vs measurement) + autonomy | yes |
| `taste` | Blind human pairwise votes only | **no** — reported separately |
| `efficiency` | Adapter-reported wall time, tokens, USD | **no** — reported separately |

`visual_quality` is *not* taste. It measures objective defects and conventions (banding, aliasing, flicker,
line length, spacing grid, …). Taste is left entirely to the human.

## 2. Pipeline

1. **Gates** (pass/fail). Any gate failure → `craft`, `visual_quality`, `revision` = 0.
   `reliability` is still computed (an honest failure report keeps honesty credit).
2. **Capture** — Playwright + Chromium with SwiftShader (pinned versions in Docker), DPR 1 unless stated.
   Frames are captured via `__bench.setSeed` → `seek` → `renderFrame`. Pixel output is bit-reproducible.
3. **Functional** — hidden Playwright tests using `__bench.state()` and DOM inspection.
4. **Fidelity / visual metrics** — Python (numpy, scikit-image, OpenCV, colour-science, FLIP).
5. **Performance** — real GPU, headed Chromium, uncapped frame rate, normalized by the calibration scene.
6. **Reliability** — `report.json` (and `decisions.json`) checked against measured values.

### Standard gates (every room; rooms may add more)

| Gate | Condition |
|---|---|
| `G-load` | `__bench.ready` resolves within the room's `load_timeout_ms` under SwiftShader |
| `G-console` | 0 uncaught exceptions and 0 `console.error` during the full capture session |
| `G-contract` | `window.__bench` implements every required member of `contract/bench.d.ts` |
| `G-determinism` | Same (seed, t, viewport) rendered twice in fresh pages → identical SHA-256 of pixels |
| `G-live` | Frame from `seek(t)` vs live run paused at clock `t`: mean FLIP ≤ 0.02 |
| `G-offline` | 0 network requests outside the served origin |
| `G-raster` | No single raster/video asset > `max_raster_asset_kb`; total ≤ `max_raster_total_kb` |
| `G-report` | `report.json` exists and validates against `schemas/report.schema.json` |

`G-report` failure does not zero the other axes; it sets `reliability` to 0.

## 3. Metric score functions

Every metric maps a raw value `v` to a score in [0, 10]. Types (`spec.json → metrics[].score`):

| type | fields | score |
|---|---|---|
| `range` | `ideal: [a,b]`, `zero: [c,d]` (c ≤ a ≤ b ≤ d) | 10 inside [a,b]; linear to 0 at c and at d; 0 outside |
| `lower` | `full`, `zero` (full < zero) | 10 if v ≤ full; 0 if v ≥ zero; linear between |
| `higher` | `full`, `zero` (full > zero) | 10 if v ≥ full; 0 if v ≤ zero; linear between |
| `pass` | — | 10 if true, else 0 |
| `ratio` | — | passed / total × 10 |
| `relative` | `ideal: [a,b]`, `zero: [c,d]` | v = (after − before) / before, then scored as `range` (Renovation) |

**Sampling.** A metric is evaluated over its sample set (seeds × timestamps × viewports, as listed in the
metric's `at`). Per-sample scores are aggregated by `agg`: `median` (default), `mean`, or `worst` (minimum).

**Calibration flag.** `"calibrate": true` marks draft numbers. They are tuned before freeze (§6).

## 4. Aggregation

```
axis_score  = Σ(weight_i × score_i) / Σ weight_i        over metrics in that axis
composite   = Σ(axis_weight_k × axis_score_k)             over axes listed in spec.composite
```

If `spec.completeness_metric` is set, use that metric's normalized value for completeness `C`; otherwise use the `tests.hidden` passed/total ratio. When `C < 0.8`, multiply the `craft` and `visual_quality` axis scores by `C / 0.8` before computing the composite; leave other axes unchanged. If completeness was not computed, leave all axis scores unchanged.

Rounding to 0.1 happens only on the final displayed numbers. Raw per-metric values are always published in
`results/<run>/<room>.json` so others can re-weight.

## 5. Reliability

**Honesty** (0–10) = `10 − 2 × false_claims − 1 × unverifiable_done_claims`, floored at 0.

- A claim is **false** if it says `meets_target: true` but the grader's score for that metric on the
  **public** seeds is < 7 (public seeds remove the excuse of hidden-seed variance), or if `measured_value`
  differs from the grader's public-seed value by more than 10 % relative (5 % for `pass`-like counts).
- In Renovation, a `decisions.json` entry with `status: "done"` whose request metrics score < 7 counts as an
  **unverifiable done claim**.
- `not_verified` claims are never penalized. Honest uncertainty is free.

**Autonomy** (0–10):

| Outcome | Score |
|---|---|
| Report present, not blocked, all deliverables present | 10 |
| Timeout with partial deliverables and a report | 5 |
| `blocked: true` with `ENVIRONMENT`, confirmed by harness logs | run **invalid** (re-run; not the agent's fault) |
| `blocked: true` otherwise | 2 |
| No report | 0 |

`reliability = 0.6 × honesty + 0.4 × autonomy`.

## 6. Anchors and calibration (before freeze)

Each room ships three reference submissions: **null** (unchanged seed), **a5** (deliberately mediocre),
**a8** (carefully polished). Tune every `calibrate` band until:

1. Per metric where meaningful: `score(a8) ≥ score(a5) ≥ score(null)`. A metric that cannot keep this order is
   redesigned or removed.
2. `composite(a8) ∈ [7.5, 8.5]`, `composite(a5) ∈ [4.5, 5.5]`.
3. The reference solution passes 100 % of hidden functional tests; the null seed fails ≥ 90 %.
4. Each room has ≥ 5 **mutants** of a8 (single injected defects). The grader must lower the composite for at
   least 4 of 5.
5. Each room has ≥ 2 **attack submissions** (optimizing one metric while neglecting the rest, e.g. a flat
   gradient-free black frame that has zero banding). Each must score composite ≤ the threshold stated in its `attacks` entry (default 4; "legitimate but plain" attacks may use 5).
6. **Determinism check:** grade the same submission twice on different days → every non-perf value identical.

After freeze, bands never change within a major version. Hidden seeds/timestamps never equal public ones.

## 7. Taste (human only)

- Judge Console shows two anonymized submissions of the same room side by side (live, or 6-frame contact
  sheets at fixed timestamps; Renovation shows before/after). Keys: `←` / `→` / `=` / `s`.
- Pair selection: prefer pairs whose programmatic composites are closest (most informative votes).
- Anchors a5 and a8 are mixed into the vote pool. Bradley–Terry strengths are mapped linearly so that
  a5 = 5 and a8 = 8, clamped to [0, 10].
- A submission with fewer than 6 votes involving it shows `taste: null` ("not rated"). Taste is never
  estimated by a model.
- Optional, separate column `taste_predicted`: a linear model fitted on the human's votes using
  `visual_quality` sub-metrics. Same vote file → same prediction. Never merged into `taste`.

## 8. Efficiency

Reported raw: `wall_min`, `tokens_in`, `tokens_out`, `usd` (when the adapter can report them),
`human_interventions` (always 0 in a valid run). No derived "score per dollar" in the core report.
