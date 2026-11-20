# Implementation architecture (v0.1)

This is the contract between the parts of the harness so they can be built in parallel. `docs/SCORING.md`,
`docs/METRICS.md`, `contract/*` and `rooms/*/spec.json` are the source of truth for *what* is measured; this file
fixes *where code lives and how parts talk*.

## Repository layout

```
package.json                 # npm workspace root (deps pre-installed; PLAYWRIGHT_BROWSERS_PATH=0)
harness/
  src/cli.mjs                # `bench` CLI: grade | selfcheck | preview | blender-run | calibrate
  src/spec.mjs               # load + validate spec.json / renovation json, expand metric sample sets
  src/score.mjs              # score functions (range/lower/higher/pass/ratio/relative), agg, axes, composite — pure
  src/gates.mjs              # standard gates
  src/report.mjs             # report.json / decisions.json schema validation, honesty, autonomy
  src/capture/server.mjs     # static file server for a submission directory (random free port, local only)
  src/capture/host.js        # in-page __benchHost implementation (clock, rng, params) — injected before page scripts
  src/capture/browser.mjs    # Playwright session: launch (swiftshader / gpu), setViewport, emulate media,
                             #   setSeed/seek/renderFrame/screenshot, virtual time, rAF scheduler override
  src/capture/probes/*.js    # in-page DOM probes (layout/text/type/space/align/a11y helpers)
  src/capture/plan.mjs       # turns a spec into a capture plan (list of samples) and executes it
  src/rooms/<room>.mjs       # room adapter: generator(seed) → params, room-specific capture steps,
                             #   room-specific metric glue (owned by the room's implementer)
  test/                      # node:test unit tests for score/spec/report/gates
metrics/                     # Python package `molmetrics` (image + time-series metrics)
  molmetrics/__main__.py     # python -m molmetrics compute --manifest work/.../manifest.json --metric <id> [...]
  molmetrics/{io,color,lum,time_,render,scene,ref,shape,visual,mask}.py
  tests/                     # pytest on synthetic images with known answers
metrics3d/                   # Python run INSIDE Blender (bpy): 3D metrics for Blender rooms
hidden/<room>/               # NEVER mounted into contestant containers
  grade.json                 # hidden seeds / timestamps / variants
  tests/*.mjs                # hidden functional tests (see "Hidden tests")
  refs/, masks/              # reference renders, masks
rooms/<room>/
  spec.json, prompt.md, seed/, anchors/{a5,a8}/, attacks/<name>/, renovation/
runner/                      # contestant isolation: Docker images + run orchestration
  docker/agent-base.Dockerfile, docker/grader.Dockerfile
  agents/<name>.yaml         # how to launch an agent CLI in its container
  run.mjs                    # bench-run: one container per (agent, model, room, run#)
work/                        # scratch output of captures (gitignored)
results/                     # graded results JSON (gitignored until published)
```

## Data flow of `bench grade <room> <submissionDir> [--renovation r1] [--hidden] [--out results/...]`

1. `spec.mjs` loads the spec and builds a **capture plan**: the union of samples every metric needs.
2. `gates.mjs` runs gates that need no capture (report schema, static scans), then capture-time gates.
3. `capture/plan.mjs` serves the submission, opens Chromium with `host.js` injected, and for each sample writes
   `work/<runId>/<room>/frames/<sampleKey>.png` and appends to `work/<runId>/<room>/manifest.json`.
   DOM probe results go to `probes.json`, perf results to `perf.json`.
4. Python metrics: `python -m molmetrics compute --manifest <manifest> --spec <spec> --out metrics.json`
   computes every image/time metric id it implements and writes raw values per sample.
   Room adapters may add values (e.g. state() checks, bug metrics) into the same `metrics.json`.
5. `score.mjs` maps raw values → scores → axes → composite. Output: `results/<runId>/<room>.json`:

```json
{ "room": "aurora", "track": "build", "spec_version": "0.1.0-draft", "bench_version": "0.1.0",
  "submission": "...", "seeds": "public|hidden",
  "gates": { "G-load": { "pass": true, "detail": "..." } },
  "metrics": { "color.palette_fidelity": { "raw": 0.91, "samples": [...], "score": 10, "axis": "craft", "weight": 3 } },
  "axes": { "craft": 8.4, "visual_quality": 7.1, "reliability": 10 },
  "composite": 8.1, "taste": null, "efficiency": { "wall_min": null } }
```

## manifest.json (capture → metrics)

```json
{ "room": "aurora", "viewport_default": "1440x900",
  "samples": [ { "key": "s1_t1000_1440x900_light", "seed": 1, "t": 1000, "viewport": "1440x900",
                 "scheme": "light", "variant": "normal|reduced_motion|pointer_left|resize_seq|dpr2|...",
                 "file": "frames/s1_t1000_1440x900_light.png" } ],
  "sequences": [ { "key": "flicker_s1", "seed": 1, "t0": 2500, "dt": 16.667, "count": 120,
                   "dir": "frames/flicker_s1/" } ],
  "params": { "1": { "palette": [[0.78,0.17,160], ...] } } }
```

Metric implementations select the samples they need by `variant` and viewport, following the metric's `at`.

## Hidden tests

`hidden/<room>/tests/*.mjs` export an array of tests:

```js
export default [
  { id: "palette-state", title: "state().palette equals params.palette",
    async run(ctx) { /* ctx.page (Playwright), ctx.bench (helpers: setSeed, seek, renderFrame, state, stats,
                       screenshot, resize, emulate, rafRate, virtualTime), ctx.params(seed), ctx.spec */
                     return { pass: true, detail: "" } } }
]
```

`tests.hidden` = passed / total. The same runner executes `rooms/<room>/seed/public-tests/*.mjs` for selfcheck.

## Room adapter (`harness/src/rooms/<room>.mjs`)

```js
export const room = "aurora";
export function generate(seed, { hidden }) { return params; }          // deterministic, no Math.random
export async function extraCapture(ctx) {}                              // optional room-specific captures
export async function extraMetrics(ctx, metrics) {}                     // optional raw values into metrics.json
```

## Agent-facing tools (inside the contestant container)

- `bench selfcheck` — gates + public tests + all public-seed metrics, prints a table and writes
  `selfcheck.json`. Never touches `hidden/`.
- `bench preview` — writes PNG contact sheets of public samples to `preview/` for agents that can view images.
- `bench blender-run` (Blender rooms) — runs build.py in the pinned Blender.

## Determinism rules for harness code

- No wall clock in scoring paths. Seeds/rng: `mulberry32` in host.js; Python uses numpy `default_rng(seed)`.
- Chromium flags for capture: `--use-angle=swiftshader --enable-unsafe-swiftshader --disable-gpu-vsync
  --force-color-profile=srgb --font-render-hinting=none --disable-lcd-text`, fixed fonts in the grader image.
- All tool versions pinned in `package.json` / `metrics/requirements.txt` / Dockerfiles.

## Capture plan (spec.mjs → capture/plan.mjs) — the interface between scoring and capture

`spec.mjs` exports `buildPlan(spec, { seeds, timestamps, hidden, renovation })`. It interprets each metric's `at`
string with a fixed grammar (below) and a **metric registry** (`harness/src/registry.mjs`: metric id →
`{ source: "python" | "probe" | "room" | "harness" | "test", needs(metric, ctx) → requests[] }`).

```json
{ "room": "aurora", "mode": "swiftshader",
  "frames":    [ { "key": "s1_t1000_1440x900_light_normal", "seed": 1, "t": 1000, "viewport": "1440x900",
                   "scheme": "light", "variant": "normal", "dpr": 1, "pointer": null } ],
  "sequences": [ { "key": "seq_flicker_s1", "seed": 1, "t0": 2500, "dt": 16.667, "count": 120,
                   "viewport": "1440x900", "variant": "normal" } ],
  "probes":    [ { "key": "p_layout_360x780_dark", "probe": "layout", "viewport": "360x780", "scheme": "dark",
                   "variant": "normal", "seed": 1, "args": {} } ],
  "steps":     [ { "key": "resize_seq_s1", "kind": "resize_sequence", "seed": 1, "viewports": ["1440x900","768x1024","1440x900"], "then": "frame", "dpr": 2 } ],
  "tests":     [ "hidden/aurora/tests" ],
  "perf":      { "enabled": false, "viewport": "1440x900" },
  "lighthouse":{ "enabled": false } }
```

Variants (closed list, extend only by editing this file): `normal`, `reduced_motion`, `pointer_left`,
`pointer_right`, `dpr2`, `resize_seq`, `lifecycle_30`, `raf30`, `raf144`, `empty_rooms`, `long_title`,
`lang_en`, `lang_ko`, `camera_drift`.

`at` grammar (comma-separated tokens; unknown tokens are a spec error, never silently ignored):
- viewports: `WxH` | `all viewports`  (and `A and B`)
- time: `t=N` | `t in [a, b, ...]` | `all timestamps` | `t0=N`
- schemes: `both schemes` (default: light only)
- variants: `variants=a|b|...` (sample each listed variant; default `normal`)
- masks: `mask=<name>` (restrict pixels to a named mask: a harness material/ID pass such as `metal`, or a mask file declared in the metric)
- steps: `after resize sequence` | `after resize A -> B -> C` | `turntable` | `12 hidden views` | `front, side, top`
- free notes in a metric go in `notes`, never in `at`.

`capture/plan.mjs` exports:

```js
export async function executePlan(plan, { submissionDir, workDir, spec, adapter, hidden }) {
  // returns:
  return { manifestPath, probes /* {key: result} */, gates /* {"G-load": {pass, detail}, ...} */,
           tests /* [{id, title, pass, detail, file}] */, perf /* {p95_norm_ms, runs:[...]} | null */,
           lighthouse /* {lcp_ms, cls} | null */, console /* [{type, text}] */, network /* [{url, allowed}] */ };
}
```

Capture-time gates (`G-load`, `G-console`, `G-contract`, `G-determinism`, `G-live`, `G-offline`, `G-raster`,
`G-fonts-local`) are evaluated inside `executePlan`; static gates (`G-report`, `G-decisions`, scope checks) in
`gates.mjs`.
