# MoL-Bench — Museum of Light (working title)

A one-shot, auto-graded benchmark for coding agents that build **visually rich, real-time web experiences**.

- Each task ("room") is given to an agent as **exactly one prompt**. No follow-up messages, no human help.
- Every criterion except **Taste** is scored by **deterministic programs**: same submission → same score
  (performance metrics are the only exception and carry a stated tolerance).
- **Taste** is scored only by blind human pairwise votes (Judge Console). No LLM/VLM judges anywhere.
- Two tracks: **Build** (from a seed) and **Renovation** (modify an existing work under change requests).

## Results

- **[Leaderboard](https://deopoler.github.io/mol-bench/leaderboard/)** — scores by model, room and axis
  ([markdown version](results/leaderboard.md))
- **[Gallery](https://deopoler.github.io/mol-bench/gallery/)** — what each model actually built, running live
- Raw per-run results: [`results/`](results/) (`<run-id>.json`, submissions and diffs under `results/submissions/`)

Status: **v0.1 pilot.** Rooms are calibrated against anchors (see `docs/SCORING.md`); top models already score
above 9 on several rooms, so v0.2 will raise difficulty.

## Pilot scope (v0.1)

| Room | Track | What it measures |
|---|---|---|
| `aurora` | Build | Fragment shader craft: palette fidelity, luminance, motion, banding, flicker, performance |
| `restoration` | Build | Unknown-cause visual bugs: diagnosis, minimal fixes, red-green tests, root-cause accuracy |
| `lobby` | Build | UI/typography/layout/a11y/navigation for a DOM page with Korean + Latin text |
| `lobby` | Renovation `r1` | Precise, localized changes; collateral damage; conflicting request handling |
| `aurora` | Renovation `r1` | Vague aesthetic feedback measured as directional metric change; preservation |
| `atelier` | Build | Blender, by script: model a lantern from a blueprint (hidden-view silhouette IoU, dims, topology, hinge rig, PBR, bevels) |
| `atelier` | Renovation `r1` | Local resize, LOD to 8k tris, "make it antique", a conflicting 180° door request |

## Layout

```
contract/bench.d.ts          # window.__bench determinism contract every web submission implements
contract/blender.md          # build.py contract for Blender rooms (scripted, reproducible assets)
schemas/report.schema.json   # report.json every agent must write (claims are verified)
schemas/decisions.schema.json# decisions.json for Renovation requests
docs/SCORING.md              # axes, score functions, aggregation, gates, calibration, reliability
docs/METRICS.md              # exact algorithm for every metric id
rooms/<room>/spec.json       # Build spec: generator, gates, metrics, weights, bands
rooms/<room>/renovation/*.json # Renovation specs: requests, masks, preservation, discipline
```

Planned (not yet written): `rooms/*/prompt.md`, `rooms/*/seed/`, anchors `a5`/`a8`, `hidden/`, `harness/`,
`site/judge/`, `agents/*.yaml`, `docker/`.

## License

Code: Apache-2.0. Assets and reference renders: CC-BY-4.0. (To be added before first public release.)

## Runner

Run contestants locally in isolated per-run directories (outside the repo so `hidden/` is never reachable), collect diffs and graded results, and build the leaderboard:

1. **Prepare an isolated run folder** (default root `~/molbench-runs`, overridable via `MOLBENCH_RUNS` or `--root`):

   ```bash
   node runner/prepare.mjs aurora --run-id aurora-codex-01 --seed 1
   # Renovation track:
   node runner/prepare.mjs aurora --run-id aurora-r1-codex-01 --renovation r1
   ```

   `prepare.mjs` copies only the room start state (or `rooms/restoration/build-variant.mjs <seed>` output for `restoration`, or `rooms/<room>/anchors/a5` without `report.json` for renovations), `PROMPT.md`, `bench/` (copy of `harness/src` without `hidden/`), `metrics/`, `contract/`, `schemas/`, `node_modules/`, `.venv/` (via `robocopy /E /MT:16` on Windows), and `.run.json`, initializes a git repo with a neutral start commit, and prints the run directory path.

2. **Launch an agent** using the templates in `runner/agents/agy.yaml` or `runner/agents/codex.yaml` (set `PLAYWRIGHT_BROWSERS_PATH=0` so Playwright uses the run directory's bundled Chromium):

   ```bash
   # Codex CLI (non-interactive one-shot):
   codex exec -s workspace-write -C <run_dir> -m "<model>" "$(cat <run_dir>/PROMPT.md)"

   # Antigravity CLI (non-interactive print mode):
   agy --mode auto --add-dir <run_dir> --model "<model>" -p "$(cat <run_dir>/PROMPT.md)"
   ```

3. **Collect and grade the submission**:

   ```bash
   node runner/collect.mjs aurora-codex-01 --model "<label>"
   ```

   `collect.mjs` records `ended_at` in `.run.json`, computes `efficiency.wall_min` and `efficiency.active_min` (sum of consecutive activity timestamp gaps from session logs or file mtimes, capped at 5 min each), writes `results/submissions/<id>.diff` (including untracked files), copies the submission (excluding `node_modules`, `.venv`, `bench`, `metrics`, `.git`) to `results/submissions/<id>/`, scans for possible `hidden/` or repo-path leakage, runs `bench grade <room> <copy> --hidden`, writes `results/<id>.json` (or marks `"status": "no-submission"` / `"collect-error"` with `composite: null` when no files changed or grading fails), and removes `node_modules` and `.venv` from the run folder.

4. **Unattended autopilot (`runner/hc/autopilot.sh`)**:

   Tracks per-run awake seconds in `.orchestra/awake.tsv` (capping sleep gaps `> 2*INTERVAL+60` to `INTERVAL`), uses awake time for `OVER` limits and `STUCK_HOURS`, marks collected runs terminal in `.orchestra/runs.tsv` so they are never re-collected, and commits only when `results/*.json` or `results/submissions/` change.

5. **Generate the leaderboard**:

   ```bash
   node harness/src/leaderboard.mjs
   ```

   Reads `results/*.json` and writes `results/leaderboard.md`, `site/leaderboard/data.json`, and `site/leaderboard/index.html` (offline, dark/light, responsive, deterministic output showing `Active (min)` with `wall_min` fallback, failed/unranked runs, and preview contact sheet links when present).
