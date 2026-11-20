# Blender room contract, v1

3D rooms are graded on what a **script** produces, not on a hand-delivered binary. This makes every asset
reproducible and lets the grader verify provenance.

## Deliverable

`build.py` at repo root. The harness runs it in the pinned Blender (see `docker/blender.Dockerfile`):

```
blender -b --factory-startup --python build.py -- --blueprint blueprint/ --out out/
```

It must write:

| File | Requirement |
|---|---|
| `out/<asset>.glb` | glTF 2.0 binary, Y-up as exported by Blender's glTF exporter, meters |
| `out/<asset>.blend` | The scene the .glb was exported from (used for rig/animation and topology checks) |

The agent also commits its own `out/` files; gate `G-reproducible` re-runs `build.py` and compares.

## Rules

- Allowed imports: `bpy`, `bmesh`, `mathutils`, Python standard library. No network, no add-ons beyond those
  enabled in factory startup, no pip packages.
- Only files inside `blueprint/` and `assets/` (if the room provides any) may be read. Importing external mesh
  files is forbidden; geometry must be created by the script (`bpy.ops.import_*` calls on any path outside
  `blueprint/` or `assets/` fail gate `G-provenance`).
- Deterministic: no `time`, unseeded `random`, or dict-order-dependent geometry. `random.Random(seed)` is fine.
- Must finish in ≤ 120 s on the reference CPU, ≤ 4 GB RAM.
- Must not set up the presentation scene (lights, world, camera) in the .glb. The harness renders every
  submission in its own fixed studio scene, so presentation is identical for all agents.

## Self-check tools available to the agent

- `bench blender-run` — runs the command above inside the pinned Blender.
- `bench preview` — renders the harness studio turntable (8 views), orthographic silhouettes and overlays them
  on the blueprint, and prints the **public** metrics (`shape.iou_front/side/top`, dims, budgets, validator).
  Hidden oblique views are never shown.
