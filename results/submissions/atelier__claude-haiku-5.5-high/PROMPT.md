# MoL-Bench — Room `atelier`: Build the Museum Lantern from a Blueprint

You are building the **Museum Lantern** (`lantern`) for the Museum of Light. Your task is to write a deterministic Blender Python script (`build.py`) that constructs a hanging hexagonal museum lantern from its technical blueprint sheets and orthographic silhouettes, rigs its hinged door with a 90° opening animation, and exports both the Blender scene (`out/lantern.blend`) and a production-ready glTF 2.0 binary (`out/lantern.glb`).

> **Autonomous execution rules:**
> - **Do not ask questions — decide and record.** If any detail requires engineering judgment, make the most reasonable choice that honors the blueprint and record your reasoning in `report.json`.
> - **You will receive no further messages.** Complete all deliverables, run the self-check tools, and write `report.json` before finishing.

---

## 1. Brief & Blueprint Files

Your workspace contains a `blueprint/` directory with the engineering specification of the lantern:

| File | Contents |
|---|---|
| `blueprint/front.png` | Orthographic front silhouette (`2048×2048`, `0.25 mm/px`, framed around the lantern bounding box center, with a `100 mm` scale bar at bottom-left) |
| `blueprint/side.png` | Orthographic side silhouette (`2048×2048`, `0.25 mm/px`) |
| `blueprint/top.png` | Orthographic top silhouette (`2048×2048`, `0.25 mm/px`) |
| `blueprint/dimensions.json` | Overall bounding box (mm), polygon sides, base/body/roof heights and radii, handle ring inner & wire diameters, frame bar section, glass pane thickness & count, candle/flame dimensions, door face index, hinge line coordinates, and origin rule |
| `blueprint/materials.json` | Per-role material specifications: required material name prefixes (`brass_`, `glass_`, `wax_`, `flame_`), OKLCH / sRGB base color swatches, metallic & roughness ranges, glass transmission & IOR, and flame emission color & strength |
| `blueprint/parts.json` | Required object names, parent hierarchy, object types, watertight requirements, and assigned material roles |
| `blueprint/budget.json` | Triangle budget (`<= 30,000` triangles), texture budget (`<= 2` textures, each `<= 1024 px`), and draw call budget (`<= 12` draw calls) |

---

## 2. Exact Deliverables & Paths

Before finishing, your workspace root must contain all four deliverables:

1. `build.py` — Your deterministic Blender build script at the repository root.
2. `out/lantern.glb` — The exported glTF 2.0 binary (Y-up as exported by Blender's glTF exporter, in meters).
3. `out/lantern.blend` — The saved Blender scene from which `out/lantern.glb` was exported (evaluated at rest pose frame 1 for topology/dimensions and across the `door_open` action for rigging).
4. `report.json` — Your final verification report conforming to `contract/report.schema.json`.

Allowed scope globs: `build.py`, `out/**`, `tests/**`, `report.json`. Do not modify files outside these paths.

---

## 3. Blender Room Contract (`contract/blender.md`)

The full contract is included at `contract/blender.md`. Essential rules:

- **Invocation:** The grader executes your script in headless factory-startup Blender:
  ```bash
  blender -b --factory-startup --python build.py -- --blueprint blueprint/ --out out/
  ```
- **Allowed imports:** `bpy`, `bmesh`, `mathutils`, and the Python standard library. No network access, no external pip packages, and no third-party add-ons beyond factory startup.
- **Provenance (`G-provenance`):** Geometry must be constructed procedurally by `build.py`. Reading files outside `blueprint/` or `assets/` or calling `bpy.ops.import_*` / `bpy.data.libraries.load` on external mesh/scene files is forbidden and fails `G-provenance`.
- **Reproducibility (`G-reproducible`):** Deterministic execution only (`random.Random(seed)` is allowed; unseeded randomness or wall-clock-dependent geometry is forbidden). Re-running `build.py` must produce an identical quantized geometry hash.
- **No presentation lights/cameras in output:** Do not leave scene lights or cameras in `out/lantern.glb` or `out/lantern.blend`. The grader renders your asset inside its own fixed Cycles studio scene.
- **Resource & time limits:** `build.py` must finish in **≤ 120 seconds** (≤ 4 GB RAM). The overall room time limit is **90 minutes**.

---

## 4. Scene Hierarchy, Origin, Rigging & Craft Requirements

1. **Hierarchy (`scene.hierarchy`):** Names are case-sensitive and must match `blueprint/parts.json` exactly:
   - `Lantern` (root at world origin `(0, 0, 0)`)
     - `Frame` (parent: `Lantern`)
       - `Door` (parent: `Frame`)
         - `Door_Glass` (parent: `Door`)
     - `Roof` (parent: `Lantern`)
     - `Base` (parent: `Lantern`)
     - `Handle` (parent: `Lantern`)
     - `Glass` (parent: `Lantern`)
     - `Candle` (parent: `Lantern`)
     - `Flame` (parent: `Lantern`)
2. **Units & Origin (`scene.units_origin`):**
   - Scene units: metric (`METERS`, `scale_length = 1.0`).
   - All objects must have applied unit scale `(1.0, 1.0, 1.0)`.
   - `Lantern` origin must lie at the bottom center of the lantern (`|x|, |y| <= 1 mm` from bbox center, lowest vertex `z` within `±1 mm` of `0` in Blender Z-up coordinates).
3. **Hinge Action (`rig.hinge`):**
   - Create an Action named `door_open` assigned to `Door`.
   - At the first frame of `door_open`, `Door` is closed (rest pose). At the last frame, `Door` is rotated open by **90° ± 5°** outward around the vertical hinge axis specified in `blueprint/dimensions.json` (parallel to Z within 2°, passing within 2 mm of the hinge line).
   - `Door_Glass` must move rigidly with `Door`, and no other part may move during the action.
4. **Watertight Topology & Visual Craft:**
   - Every mesh part flagged `watertight: true` in `blueprint/parts.json` must be a closed manifold (`0` non-manifold edges, outward-pointing normals with positive signed volume, `0` degenerate faces/edges).
   - Metal parts (`Frame`, `Roof`, `Base`, `Handle`, `Door`) should have beveled edges (`vq.bevel_ratio`) so edges catch studio light naturally without sharp 90° CG corners or shading artifacts.
   - Materials must use the required role prefixes (`brass_`, `glass_`, `wax_`, `flame_`) and match the OKLCH color swatches and PBR ranges in `blueprint/materials.json`. If you use textures (e.g. for aged brass patina), ensure UVs have zero overlap (`uv.overlap`) and uniform texel density (`vq.texel_density_cv`).

---

## 5. Public Metrics & Full-Score Bands

Composite weights: **Craft 55%**, **Visual Quality 30%**, **Reliability 15%**.
Any gate failure (`G-blender-run`, `G-reproducible`, `G-provenance`, `G-gltf-valid`, `G-offline`) sets Craft and Visual Quality to `0`.

| Metric ID | Axis | Weight | Score Type | Full-Score Band (10/10) | Zero Band (0/10) | Notes |
|---|---|---|---|---|---|---|
| `shape.iou_public` | `craft` | 3 | `higher` | `>= 0.97` | `<= 0.80` | Worst IoU across `front`, `side`, `top` silhouettes |
| `shape.iou_hidden` | `craft` | 5 | `higher` | `>= 0.93` | `<= 0.75` | Median IoU across 12 oblique/underneath orthographic views |
| `dims.bbox_error` | `craft` | 2 | `lower` | `<= 0.01` | `>= 0.10` | Max relative bbox size error across X, Y, Z |
| `dims.key_measurements` | `craft` | 2 | `ratio` | `1.0 (4/4)` | `0.0` | Handle ring inner diameter ±2%, frame bar section ±10%, pane count exact, door face & hinge side |
| `scene.hierarchy` | `craft` | 1 | `ratio` | `1.0 (10/10)` | `0.0` | Required `(name, parent)` pairs present |
| `scene.units_origin` | `craft` | 1 | `ratio` | `1.0 (3/3)` | `0.0` | Metric meters scale 1.0, object scales `(1,1,1)`, bottom-center origin at `z=0` |
| `rig.hinge` | `craft` | 3 | `ratio` | `1.0 (4/4)` | `0.0` | `door_open` action on `Door`, 90°±5° rotation, hinge line alignment, other parts stationary |
| `topo.manifold` | `craft` | 2 | `lower` | `0` | `>= 50` | Non-manifold edge count on watertight parts |
| `topo.normals_outward` | `craft` | 1 | `higher` | `1.0` | `<= 0.90` | Fraction of watertight parts with positive volume & outward normals |
| `topo.degenerate` | `craft` | 1 | `lower` | `0` | `>= 100` | Faces `< 1e-4 mm²` + edges `< 1e-3 mm` |
| `budget.triangles` | `craft` | 2 | `lower` | `<= 1.0` | `>= 4.0` | `triangles / 30000` |
| `mat.assignment` | `craft` | 1 | `ratio` | `1.0 (9/9)` | `0.0` | Parts assigned materials with role prefix (`brass_`, `glass_`, `wax_`, `flame_`) |
| `mat.pbr_plausible` | `craft` | 2 | `ratio` | `1.0 (5/5)` | `0.0` | Metal metallic ≥ 0.9, wax L in [0.15, 0.95], glass transmission ≥ 0.9 & IOR in [1.4, 1.6], flame emission & roughness in sheet ranges |
| `mat.color_delta` | `craft` | 1 | `lower` | `<= 0.03` | `>= 0.15` | Mean ΔE_OK between part base colors and `materials.json` swatches |
| `uv.overlap` | `craft` | 1 | `lower` | `0.0` | `>= 0.20` | Overlapping UV area fraction on textured parts |
| `web.three_load` | `craft` | 1 | `pass` | `true` | `false` | `.glb` loads cleanly in Three.js with `<= 12` draw calls |
| `vq.bevel_ratio` | `visual_quality` | 3 | `higher` | `>= 0.80` | `<= 0.10` | Fraction of sharp metal turns spread across bevel strips |
| `vq.shading_artifacts` | `visual_quality` | 3 | `lower` | `<= 0.005` | `>= 0.04` | Normal-pass discontinuity artifacts across turntable views |
| `vq.texel_density_cv` | `visual_quality` | 1 | `lower` | `<= 0.25` | `>= 1.00` | Coefficient of variation of texel density on textured parts |
| `vq.exposure` | `visual_quality` | 1 | `range` | `[0.30, 0.65]` | `[0.08, 0.92]` | Mean OKLab `L` of object pixels in studio turntable renders |
| `vq.highlight_metal` | `visual_quality` | 1 | `range` | `[0.01, 0.08]` | `[0.00, 0.25]` | Fraction of metal pixels with `L > 0.85` |
| `vq.detail_scale` | `visual_quality` | 2 | `range` | `[0.92, 1.38]` | `[0.70, 1.65]` | Turntable silhouette perimeter ratio (`1024 px` vs `128 px`) |
| `render.aliasing` | `visual_quality` | 1 | `lower` | `<= 0.06` | `>= 0.20` | Edge aliasing FLIP between DPR 1 and DPR 2 turntable renders |
| `report.honesty` | `reliability` | 6 | `higher` | `10` | `0` | Claims in `report.json` match grader measurements on public seeds |
| `report.autonomy` | `reliability` | 4 | `higher` | `10` | `0` | All deliverables present, not blocked |

---

## 6. Hidden Test Categories

In addition to the metrics above, the grader runs hidden functional checks covering these categories:
1. **Emissive light source & shadow hygiene:** `Flame` emission properties and ensuring `Flame` does not cast shadow-blocking geometry over the glass panes.
2. **Physical glass geometry:** Glass panes must have true physical thickness (not zero-thickness planes).
3. **Animation hierarchy integrity:** Child parts attached to the door (`Door_Glass`) must track the door's rigid motion throughout `door_open`.
4. **Real-time WebGL compatibility:** Clean glTF 2.0 loading and draw-call efficiency in a Three.js scene.

---

## 7. Self-Check Tools & `report.json` Format

Use the workspace scripts in `package.json`:

- `npm run blender-run` — Runs `build.py` in headless Blender (`--blueprint blueprint/ --out out/`).
- `npm run selfcheck` — Evaluates all gates, public tests, and public metrics, prints a score table, and writes `selfcheck.json`.
- `npm run preview` — Generates PNG contact sheets of your studio turntable renders under `preview/`.

Before finishing, write `report.json` at the workspace root validating against `contract/report.schema.json`:

```json
{
  "schema_version": 1,
  "summary": "Concise summary of your procedural lantern model, materials, rig, and verification.",
  "deliverables": ["build.py", "out/lantern.glb", "out/lantern.blend", "report.json"],
  "claims": [
    {
      "metric_id": "shape.iou_public",
      "status": "verified",
      "meets_target": true,
      "measured_value": 0.99,
      "method": "npm run selfcheck"
    }
  ],
  "blocked": false
}
```

> **Honesty rule:** Only mark a claim `"verified"` with `measured_value` and `meets_target` when you have measured it with `npm run selfcheck`. False claims (`meets_target: true` when public score `< 7`, or `measured_value` off by `> 10%`) are penalized `-2` points each on `report.honesty`. Metrics you did not verify may be listed with `"status": "not_verified"` at zero penalty.
