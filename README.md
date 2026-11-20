# MoL-Bench — Museum of Light (working title)

A one-shot, auto-graded benchmark for coding agents that build **visually rich, real-time web experiences**.

- Each task ("room") is given to an agent as **exactly one prompt**. No follow-up messages, no human help.
- Every criterion except **Taste** is scored by **deterministic programs**: same submission → same score
  (performance metrics are the only exception and carry a stated tolerance).
- **Taste** is scored only by blind human pairwise votes (Judge Console). No LLM/VLM judges anywhere.
- Two tracks: **Build** (from a seed) and **Renovation** (modify an existing work under change requests).

Status: **v0.1 draft — pilot specification only.** Numbers flagged `"calibrate": true` are drafts that must be
tuned against the anchors before the spec is frozen (see `docs/SCORING.md`).

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
