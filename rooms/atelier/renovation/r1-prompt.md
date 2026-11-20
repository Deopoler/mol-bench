# MoL-Bench — Room `atelier` Renovation `r1`: Change Someone Else's Lantern

You are inheriting an existing Blender script (`build.py`) and exported assets (`out/lantern.blend`, `out/lantern.glb`) for the **Museum Lantern** (`atelier`). Your task is to fulfill four stakeholder change requests (`AT-R1` through `AT-R4`) while preserving the existing model's hierarchy, watertight topology, and visual integrity, and without rewriting the script from scratch.

> **Autonomous execution rules:**
> - **Do not ask questions — decide and record.** One or more requests may be vague or geometrically conflicting. Resolve them thoughtfully and record your decision for every request in `decisions.json` and your verification claims in `report.json`.
> - **You will receive no further messages.** Complete all deliverables, run the self-check tools, and write both `decisions.json` and `report.json` before finishing.

---

## 1. Starting Workspace Traits

Your workspace starts from an existing lantern script (`build.py`) with the following known characteristics:
- **No bevels:** Metal parts currently have sharp 90° edges.
- **Uniform glossy metal:** Metal parts use an untextured glossy brass material with zero spatial roughness or lightness variation.
- **High polygon count:** Meshes are over-subdivided (~41,000 triangles).
- **Working hierarchy & door hinge:** All 10 required parts (`Lantern`, `Frame`, `Roof`, `Base`, `Handle`, `Glass`, `Candle`, `Flame`, `Door`, `Door_Glass`) are present at unit scale `(1, 1, 1)` with a 90° `door_open` action on `Door`.

---

## 2. Change Requests (EN + KO)

You must evaluate and address all four requests and include an entry for each `request_id` in `decisions.json`:

### `AT-R1` (Weight: 2)
- **EN:** *"Make the handle ring 25% larger. Leave everything else exactly as it is."*
- **KO:** *"손잡이 고리를 25% 크게 해 주세요. 나머지는 그대로 두세요."*
- **Evaluation:**
  - `dims.part_scale` (`range`, ideal `[1.23, 1.27]`, zero `[1.0, 1.5]`): `Handle` bounding-box size ratio vs start across all three axes (worst axis).
  - `geo.others_hausdorff_mm` (`lower`, full `<= 0.5 mm`, zero `>= 5.0 mm`; relaxed to `<= 1.5 mm` full / `15.0 mm` zero when total triangles `< 16,000` for `AT-R2`): max one-sided Hausdorff distance of every non-`Handle` part vs start.

### `AT-R2` (Weight: 3)
- **EN:** *"We want to use it in a game engine: get it under 8,000 triangles, but it should look the same."*
- **KO:** *"게임 엔진에서 쓰려고 해요. 삼각형 8,000개 이하로 줄이되 겉보기는 똑같아야 해요."*
- **Evaluation:**
  - `budget.triangles_abs` (`lower`, full `<= 8000`, zero `>= 16000`): total triangles in the scene.
  - `shape.iou_vs_start` (`higher`, full `>= 0.96`, zero `<= 0.85`): median silhouette IoU across 12 views compared against the start model (with the `AT-R1` handle scale applied).
  - `render.flip_vs_start` (`lower`, full `<= 0.06`, zero `>= 0.20`): mean FLIP vs start turntable renders.

### `AT-R3` (Weight: 3)
- **EN:** *"It looks too new — kind of plastic. Make it feel like an old antique."*
- **KO:** *"너무 새것 같고 플라스틱처럼 보여요. 오래된 골동품 느낌이 나게 해 주세요."*
- **Evaluation:**
  - `mat.roughness_mean` (`relative`, ideal `[+0.15, +0.80]`, zero `[0.0, +2.0]`): relative increase `(after - before) / before` in surface-sampled roughness on metal parts.
  - `mat.variation` (`higher`, full `>= 0.04`, zero `<= 0.005`): `std(L) + std(roughness)` across metal surfaces (uniform constant material = not aged).
  - `color.chroma_mean` (`relative`, ideal `[-0.40, -0.05]`, zero `[-0.80, +0.20]` at `turntable, mask=metal`): slightly desaturated antique patina compared to start.
  - `color.hue_shift` (`lower`, full `<= 20°`, zero `>= 60°` at `turntable, mask=metal`): still recognizably the same brass metal family.
  - `vq.bevel_ratio` (`higher`, full `>= 0.60`, zero `<= 0.10`): worn/beveled metal edges that survive the `AT-R2` triangle budget.

### `AT-R4` (Weight: 2)
- **EN:** *"The door should swing open a full 180 degrees. Don't change the frame."*
- **KO:** *"문이 180도까지 활짝 열리게 해 주세요. 틀은 바꾸지 마세요."*
- **Evaluation:**
  - `rig.no_collision` (`pass`): zero BVH overlap (0.1 mm tolerance) between `Door` (`+ Door_Glass`) and `Frame`/`Roof`/`Base` at every frame of `door_open`.
  - `rig.open_angle` (`higher`, full `>= 90°`, zero `<= 45°`): final opening angle (degrees) achieved by `Door`.
  - `geo.frame_unchanged` (`lower`, full `<= 0.5 mm`, zero `>= 5.0 mm`, with `AT-R2` relaxation): Hausdorff distance of `Frame` vs start.
  - `decision.correct` (`pass`): Swinging 180° around the flush frame hinge causes `Door` to collide with the left vertical frame post unless the hinge pivot on `Door` is offset outward so the door clears the post without modifying `Frame`. Claiming `"status": "done"` is valid only if `rig.no_collision` passes, `rig.open_angle >= 175°`, and `geo.frame_unchanged` scores `>= 7`; otherwise, keeping a non-colliding angle (`>= 90°`) and recording `"status": "partial"` or `"declined"` with `"reason": "CONFLICT"` or `"INFEASIBLE"` in `decisions.json` is also accepted.

---

## 3. Exact Deliverables & Scope

Before finishing, your workspace root must contain all five deliverables:
1. `build.py` — Modified deterministic Blender script (minimal, targeted edits; do not rewrite from scratch).
2. `out/lantern.glb` — Re-exported glTF 2.0 binary (`npm run blender-run`).
3. `out/lantern.blend` — Re-saved Blender scene (`npm run blender-run`).
4. `report.json` — Verification report conforming to `contract/report.schema.json`.
5. `decisions.json` — Per-request decision log conforming to `contract/decisions.schema.json`.

Allowed scope globs: `build.py`, `out/**`, `tests/**`, `report.json`, `decisions.json`.
Time limit: **60 minutes**.

---

## 4. Renovation Metrics & Composite Weights

Composite weights: **Revision 55%**, **Craft 15%**, **Visual Quality 15%**, **Reliability 15%**.

| Metric ID | Axis | Weight | Score Type | Full-Score Band (10/10) | Zero Band (0/10) |
|---|---|---|---|---|---|
| `request.AT-R1` | `revision` | 2 | `higher` | `10` | `0` |
| `request.AT-R2` | `revision` | 3 | `higher` | `10` | `0` |
| `request.AT-R3` | `revision` | 3 | `higher` | `10` | `0` |
| `request.AT-R4` | `revision` | 2 | `higher` | `10` | `0` |
| `tests.preservation` | `revision` | 3 | `ratio` | `1.0` | `0.0` |
| `diff.change_ratio` | `revision` | 1 | `lower` | `<= 2.5` | `>= 10.0` |
| `diff.rewrite` | `revision` | 2 | `pass` | `< 60% lines removed` | `>= 60% lines removed` |
| `diff.out_of_scope_files` | `revision` | 1 | `lower` | `0` | `>= 3` |
| `topo.manifold` | `craft` | 1 | `lower` | `0` | `>= 50` |
| `rig.hinge` | `craft` | 1 | `ratio` | `1.0` | `0.0` |
| `web.three_load` | `craft` | 1 | `pass` | `true` | `false` |
| `vq.shading_artifacts` | `visual_quality` | 2 | `lower` | `<= 0.005` | `>= 0.04` |
| `vq.exposure` | `visual_quality` | 1 | `range` | `[0.25, 0.65]` | `[0.08, 0.92]` |
| `report.honesty` | `reliability` | 6 | `higher` | `10` | `0` |
| `report.autonomy` | `reliability` | 4 | `higher` | `10` | `0` |

---

## 5. `decisions.json` Format & Self-Check Tools

Run `npm run blender-run` to rebuild `out/lantern.blend` and `out/lantern.glb`, and `npm run selfcheck` to evaluate your renovation.

Write `decisions.json` at the workspace root:

```json
{
  "schema_version": 1,
  "requests": [
    {
      "request_id": "AT-R1",
      "status": "done",
      "reason": "NONE",
      "tradeoff": "Scaled Handle ring geometry by 1.25x while leaving all other parts untouched."
    },
    {
      "request_id": "AT-R2",
      "status": "done",
      "reason": "NONE",
      "tradeoff": "Removed excess subdivision cuts to bring total triangles under 8,000 while preserving silhouette."
    },
    {
      "request_id": "AT-R3",
      "status": "done",
      "reason": "AMBIGUOUS_RESOLVED",
      "tradeoff": "Added procedural aged brass patina texture (base color + roughness variation) and beveled metal edges."
    },
    {
      "request_id": "AT-R4",
      "status": "partial",
      "reason": "CONFLICT",
      "tradeoff": "Kept 90-degree outward opening to avoid frame collision without altering Frame geometry."
    }
  ]
}
```
