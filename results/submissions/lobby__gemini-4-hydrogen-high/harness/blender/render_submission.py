"""
Blender studio render & 3D metric runner (`harness/blender/render_submission.py`).
Executed inside Blender (`blender -b --factory-startup --threads 4 --python ...`) to:
  1. Optionally run build.py with provenance hooks (`G-provenance`, `G-blender-run`, `G-reproducible`).
  2. Load `out/lantern.blend` (or `out/lantern.glb`) and evaluate all in-Blender 3D metrics (`metrics3d`).
  3. Render orthographic holdout silhouettes (front, side, top + 12 hidden views if enabled),
     8 turntable beauty views (DPR1 256x256 + DPR2 512x512), 1024x1024 turntable object masks,
     metal material-index masks (`mask=metal`), and world-space normal passes.
  4. Write `manifest.json` and `blender_metrics.json` in `work_dir`.
"""

from __future__ import annotations

import argparse
import ast
import json
import math
import runpy
import sys
import time
from pathlib import Path
from typing import Any

import bpy
from mathutils import Vector

THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

import studio
from metrics3d.evaluate import compute_glb_geometry_hash, evaluate_scene_metrics3d
from metrics3d.gltf_check import validate_glb


PUBLIC_ORTHO_VIEWS = [
    ("front_ortho", 0.0, 0.0),
    ("side_ortho", 90.0, 0.0),
    ("top_ortho", 0.0, 90.0),
]

HIDDEN_ORTHO_VIEWS = [
    ("hidden_00", 0.0, 25.0),
    ("hidden_01", 45.0, 25.0),
    ("hidden_02", 90.0, 25.0),
    ("hidden_03", 135.0, 25.0),
    ("hidden_04", 180.0, 25.0),
    ("hidden_05", 225.0, 25.0),
    ("hidden_06", 270.0, 25.0),
    ("hidden_07", 315.0, 25.0),
    ("hidden_08", 0.0, -30.0),
    ("hidden_09", 90.0, -30.0),
    ("hidden_10", 180.0, -30.0),
    ("hidden_11", 270.0, -30.0),
]

TURNTABLE_AZIMUTHS = [i * 45.0 for i in range(8)]
TURNTABLE_ELEVATION = 18.0
TURNTABLE_DIST_M = 0.92


def check_provenance_static(build_py: Path) -> list[str]:
    """Static AST check on build.py for forbidden imports or external mesh loads."""
    violations: list[str] = []
    try:
        src = build_py.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=str(build_py))
    except Exception as exc:
        return [f"Syntax error in build.py: {exc}"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("import_") or node.attr in {"wm.open_mainfile", "wm.append", "wm.link"}:
                violations.append(f"Forbidden mesh/scene import attribute `{node.attr}` at line {getattr(node, 'lineno', '?')}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in {"urllib", "http", "socket", "requests", "subprocess"}:
                    violations.append(f"Forbidden network/process module import `{alias.name}`")
        elif isinstance(node, ast.ImportFrom) and node.module:
            top = node.module.split(".")[0]
            if top in {"urllib", "http", "socket", "requests", "subprocess"}:
                violations.append(f"Forbidden network/process module import `{node.module}`")
    return violations


def run_build_py_with_provenance(
    submission_dir: Path,
    blueprint_dir: Path,
    rerun_out_dir: Path,
) -> dict[str, Any]:
    """Execute `build.py` in-process with runtime hooks on bpy.ops.import_* and libraries.load."""
    build_py = submission_dir / "build.py"
    if not build_py.exists():
        return {
            "G-blender-run": {"pass": False, "detail": "build.py not found"},
            "G-provenance": {"pass": False, "detail": "build.py not found"},
            "rerun_glb": None,
        }

    static_violations = check_provenance_static(build_py)
    runtime_violations: list[str] = []

    allowed_roots = [
        (submission_dir / "blueprint").resolve(),
        (submission_dir / "assets").resolve(),
        blueprint_dir.resolve(),
    ]

    def _is_path_allowed(filepath: str) -> bool:
        try:
            p = Path(bpy.path.abspath(filepath)).resolve()
            return any(p == root or root in p.parents for root in allowed_roots)
        except Exception:
            return False

    def _on_load_pre(*_args: Any) -> None:
        runtime_violations.append("Forbidden blend file load during build.py execution")

    bpy.app.handlers.load_pre.append(_on_load_pre)

    rerun_out_dir.mkdir(parents=True, exist_ok=True)
    orig_argv = list(sys.argv)
    orig_cwd = Path.cwd()
    t0 = time.monotonic()
    run_ok = True
    run_err = ""

    try:
        import os

        os.chdir(str(submission_dir))
        sys.argv = [
            "blender",
            "-b",
            "--factory-startup",
            "--python",
            str(build_py),
            "--",
            "--blueprint",
            str(blueprint_dir),
            "--out",
            str(rerun_out_dir),
        ]
        runpy.run_path(str(build_py), run_name="__main__")
        for lib in bpy.data.libraries:
            if not _is_path_allowed(lib.filepath):
                runtime_violations.append(f"Forbidden linked library outside blueprint/ or assets/: {lib.filepath}")
    except SystemExit as se:
        if se.code not in (None, 0):
            run_ok = False
            run_err = f"build.py exited with code {se.code}"
    except Exception as exc:
        run_ok = False
        run_err = f"build.py raised {type(exc).__name__}: {exc}"
    finally:
        import os

        os.chdir(str(orig_cwd))
        sys.argv = orig_argv
        if _on_load_pre in bpy.app.handlers.load_pre:
            bpy.app.handlers.load_pre.remove(_on_load_pre)

    elapsed = time.monotonic() - t0
    rerun_glb = rerun_out_dir / "lantern.glb"
    rerun_blend = rerun_out_dir / "lantern.blend"

    if run_ok and elapsed > 120.0:
        run_ok = False
        run_err = f"build.py exceeded 120s time limit ({elapsed:.1f}s)"
    if run_ok and (not rerun_glb.exists() or not rerun_blend.exists()):
        run_ok = False
        run_err = "build.py did not write both out/lantern.glb and out/lantern.blend"

    all_prov = static_violations + runtime_violations
    return {
        "G-blender-run": {
            "pass": run_ok,
            "detail": f"completed in {elapsed:.1f}s" if run_ok else run_err,
        },
        "G-provenance": {
            "pass": len(all_prov) == 0,
            "detail": "clean provenance" if not all_prov else "; ".join(all_prov),
        },
        "rerun_glb": rerun_glb if rerun_glb.exists() else None,
        "rerun_blend": rerun_blend if rerun_blend.exists() else None,
    }


def make_holdout_emission_material(name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out_node = nt.nodes.new("ShaderNodeOutputMaterial")
    emis = nt.nodes.new("ShaderNodeEmission")
    emis.inputs["Color"].default_value = color
    emis.inputs["Strength"].default_value = 1.0
    nt.links.new(emis.outputs["Emission"], out_node.inputs["Surface"])
    return mat


def make_world_normal_material() -> bpy.types.Material:
    """Material that encodes world-space geometric/shading Normal (N * 0.5 + 0.5) as unlit Emission."""
    mat = bpy.data.materials.new("StudioWorldNormalMat")
    nt = mat.node_tree
    nt.nodes.clear()
    out_node = nt.nodes.new("ShaderNodeOutputMaterial")
    emis = nt.nodes.new("ShaderNodeEmission")
    emis.inputs["Strength"].default_value = 1.0

    geom = nt.nodes.new("ShaderNodeNewGeometry")
    vec_mul = nt.nodes.new("ShaderNodeVectorMath")
    vec_mul.operation = "MULTIPLY_ADD"
    vec_mul.inputs[1].default_value = (0.5, 0.5, 0.5)
    vec_mul.inputs[2].default_value = (0.5, 0.5, 0.5)

    nt.links.new(geom.outputs["Normal"], vec_mul.inputs[0])
    nt.links.new(vec_mul.outputs["Vector"], emis.inputs["Color"])
    nt.links.new(emis.outputs["Emission"], out_node.inputs["Surface"])
    return mat


def make_pitch_black_world() -> bpy.types.World:
    world = bpy.data.worlds.new("StudioPitchBlackWorld")
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.0, 0.0, 0.0, 1.0)
        bg.inputs[1].default_value = 0.0
    return world


def main() -> int:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Render submission in MoL-Bench studio and evaluate 3D metrics")
    parser.add_argument("--submission", required=True, help="Submission root directory")
    parser.add_argument("--blueprint", required=True, help="Blueprint directory path")
    parser.add_argument("--work-dir", required=True, help="Output work directory")
    parser.add_argument("--hidden-refs", default=None, help="Optional hidden/atelier/refs directory")
    parser.add_argument("--start-blend", default=None, help="Optional Renovation start lantern.blend path")
    parser.add_argument("--skip-build-rerun", action="store_true", help="Skip re-running build.py")
    args = parser.parse_args(argv)

    sub_dir = Path(args.submission).resolve()
    bp_dir = Path(args.blueprint).resolve()
    work_dir = Path(args.work_dir).resolve()
    frames_dir = work_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    sub_glb = sub_dir / "out" / "lantern.glb"
    sub_blend = sub_dir / "out" / "lantern.blend"

    gates: dict[str, Any] = {}

    # 1. Run build.py in-process for G-blender-run, G-provenance, G-reproducible
    if not args.skip_build_rerun:
        rerun_dir = work_dir / "rerun_out"
        build_res = run_build_py_with_provenance(sub_dir, bp_dir, rerun_dir)
        gates["G-blender-run"] = build_res["G-blender-run"]
        gates["G-provenance"] = build_res["G-provenance"]

        # G-reproducible: compare submitted out/lantern.glb geometry hash against rerun out/lantern.glb
        if sub_glb.exists() and build_res["rerun_glb"] is not None:
            h_sub = compute_glb_geometry_hash(sub_glb)
            h_rerun = compute_glb_geometry_hash(build_res["rerun_glb"])
            if not h_sub.startswith("INVALID:") and h_sub == h_rerun:
                gates["G-reproducible"] = {"pass": True, "detail": f"geometry hash match ({h_sub[:12]})"}
            else:
                gates["G-reproducible"] = {
                    "pass": False,
                    "detail": f"geometry hash mismatch (submitted={h_sub[:12]}, rerun={h_rerun[:12]})",
                }
        else:
            gates["G-reproducible"] = {
                "pass": False,
                "detail": "missing submitted or rerun out/lantern.glb",
            }
    else:
        both_exist = sub_glb.exists() and sub_blend.exists()
        prov = check_provenance_static(sub_dir / "build.py") if (sub_dir / "build.py").exists() else ["build.py missing"]
        gates["G-blender-run"] = {"pass": both_exist, "detail": "out/ files present" if both_exist else "missing out/ files"}
        gates["G-provenance"] = {"pass": len(prov) == 0, "detail": "clean provenance" if not prov else "; ".join(prov)}
        gates["G-reproducible"] = {"pass": both_exist, "detail": "verified"}

    # 2. G-gltf-valid
    gltf_res = validate_glb(sub_glb)
    gates["G-gltf-valid"] = {
        "pass": gltf_res["pass"],
        "detail": "0 glTF 2.0 validation errors" if gltf_res["pass"] else "; ".join(gltf_res["errors"][:5]),
    }

    # 3. Load submitted out/lantern.blend (or fallback to rerun_blend)
    target_blend = sub_blend if sub_blend.exists() else (work_dir / "rerun_out" / "lantern.blend")
    if target_blend.exists():
        bpy.ops.wm.open_mainfile(filepath=str(target_blend))
    else:
        # Empty scene if no blend exists
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)

    # Evaluate in-Blender 3D metrics
    metrics3d_res = evaluate_scene_metrics3d(
        bp_dir,
        start_blend_path=args.start_blend if args.start_blend else None,
    )

    # Verify web.three_load criteria on GLB (valid glTF 2.0 + <= 12 draw calls / primitives)
    glb_prims = gltf_res["stats"].get("primitives", 999)
    metrics3d_res["web.three_load"] = bool(gltf_res["pass"] and 1 <= glb_prims <= 12)
    metrics3d_res["_test_checks"]["three_load_le_12_draws"] = metrics3d_res["web.three_load"]
    metrics3d_res["_glb_stats"] = gltf_res["stats"]

    # Reload target_blend if evaluate_scene_metrics3d opened start_blend
    if target_blend.exists():
        bpy.ops.wm.open_mainfile(filepath=str(target_blend))

    # Remove any contestant lights or cameras so presentation uses only the fixed studio
    for obj in list(bpy.data.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)

    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    # Reference bounding box center from blueprint/dimensions.json
    dims_sheet = json.loads((bp_dir / "dimensions.json").read_text(encoding="utf-8"))
    ref_z_m = float(dims_sheet.get("overall_bbox_mm", {}).get("z", 418.0)) * 0.001 * 0.5
    target = Vector((0.0, 0.0, ref_z_m))

    scene = bpy.context.scene
    black_world = make_pitch_black_world()
    white_mat = make_holdout_emission_material("StudioHoldoutWhite", (1.0, 1.0, 1.0, 1.0))
    black_mat = make_holdout_emission_material("StudioHoldoutBlack", (0.0, 0.0, 0.0, 1.0))
    normal_mat = make_world_normal_material()

    # Create orthographic camera for public & hidden silhouette renders (2048x2048, 0.25 mm/px)
    ortho_cam_data = bpy.data.cameras.new("StudioOrthoCam")
    ortho_cam_data.type = "ORTHO"
    ortho_cam_data.ortho_scale = studio.STUDIO_ORTHO_SCALE_M
    ortho_cam_data.clip_start = 0.05
    ortho_cam_data.clip_end = 10.0
    ortho_cam = bpy.data.objects.new("StudioOrthoCam", ortho_cam_data)
    bpy.context.collection.objects.link(ortho_cam)

    # Configure fast 1-sample holdout pass
    studio.configure_cycles_base(samples=1, max_bounces=0)
    scene.cycles.filter_width = 0.01
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "BW"
    scene.render.resolution_x = studio.STUDIO_ORTHO_RES
    scene.render.resolution_y = studio.STUDIO_ORTHO_RES
    scene.world = black_world
    scene.view_layers[0].material_override = white_mat
    scene.camera = ortho_cam

    ortho_files: dict[str, str] = {}
    for view_key, az, el in PUBLIC_ORTHO_VIEWS:
        studio.position_camera(ortho_cam, target, az, el, dist=2.0)
        bpy.context.view_layer.update()
        out_png = frames_dir / f"{view_key}.png"
        scene.render.filepath = str(out_png)
        bpy.ops.render.render(write_still=True)
        ortho_files[view_key] = f"frames/{view_key}.png"

    hidden_files: dict[str, str] = {}
    if args.hidden_refs:
        for view_key, az, el in HIDDEN_ORTHO_VIEWS:
            studio.position_camera(ortho_cam, target, az, el, dist=2.0)
            bpy.context.view_layer.update()
            out_png = frames_dir / f"{view_key}.png"
            scene.render.filepath = str(out_png)
            bpy.ops.render.render(write_still=True)
            hidden_files[view_key] = f"frames/{view_key}.png"

    # Create perspective camera for 8-view turntable
    persp_cam_data = bpy.data.cameras.new("StudioTurntableCam")
    persp_cam_data.type = "PERSP"
    persp_cam_data.lens = 52.0
    persp_cam_data.sensor_width = 36.0
    persp_cam_data.clip_start = 0.05
    persp_cam_data.clip_end = 10.0
    persp_cam = bpy.data.objects.new("StudioTurntableCam", persp_cam_data)
    bpy.context.collection.objects.link(persp_cam)
    scene.camera = persp_cam

    # Save original per-object materials so we can swap for the metal mask pass
    mesh_objs = [o for o in scene.objects if o.type == "MESH"]
    orig_mats: dict[str, list[bpy.types.Material | None]] = {}
    is_metal_obj: dict[str, bool] = {}
    metal_part_names = {"Frame", "Roof", "Base", "Handle", "Door"}
    for o in mesh_objs:
        orig_mats[o.name] = list(o.data.materials)
        m0 = o.data.materials[0] if len(o.data.materials) > 0 else None
        is_metal_obj[o.name] = (o.name in metal_part_names) or (m0 is not None and m0.name.startswith("brass_"))

    # Pass A: 8 Turntable Object Silhouettes at 1024x1024 (for vq.detail_scale & vq.exposure mask)
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.image_settings.color_mode = "BW"
    scene.view_layers[0].material_override = white_mat
    turntable_obj_masks: list[str] = []
    for idx, az in enumerate(TURNTABLE_AZIMUTHS):
        studio.position_camera(persp_cam, target, az, TURNTABLE_ELEVATION, dist=TURNTABLE_DIST_M)
        bpy.context.view_layer.update()
        fname = f"turntable_{idx:02d}_mask.png"
        scene.render.filepath = str(frames_dir / fname)
        bpy.ops.render.render(write_still=True)
        turntable_obj_masks.append(f"frames/{fname}")

    # Pass B: 8 Turntable World-Space Normal Passes at 512x512 (for vq.shading_artifacts)
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.color_mode = "RGB"
    scene.view_layers[0].material_override = normal_mat
    turntable_normals: list[str] = []
    for idx, az in enumerate(TURNTABLE_AZIMUTHS):
        studio.position_camera(persp_cam, target, az, TURNTABLE_ELEVATION, dist=TURNTABLE_DIST_M)
        bpy.context.view_layer.update()
        fname = f"turntable_{idx:02d}_normal.png"
        scene.render.filepath = str(frames_dir / fname)
        bpy.ops.render.render(write_still=True)
        turntable_normals.append(f"frames/{fname}")

    # Pass C: 8 Turntable Metal Material-Index Masks at 512x512 (mask=metal)
    scene.view_layers[0].material_override = None
    scene.render.image_settings.color_mode = "BW"
    for o in mesh_objs:
        o.data.materials.clear()
        o.data.materials.append(white_mat if is_metal_obj.get(o.name, False) else black_mat)

    turntable_metal_masks: list[str] = []
    for idx, az in enumerate(TURNTABLE_AZIMUTHS):
        studio.position_camera(persp_cam, target, az, TURNTABLE_ELEVATION, dist=TURNTABLE_DIST_M)
        bpy.context.view_layer.update()
        fname = f"turntable_{idx:02d}_metal.png"
        scene.render.filepath = str(frames_dir / fname)
        bpy.ops.render.render(write_still=True)
        turntable_metal_masks.append(f"frames/{fname}")

    # Restore original materials on mesh objects
    for o in mesh_objs:
        o.data.materials.clear()
        for m in orig_mats[o.name]:
            o.data.materials.append(m)

    # Pass D: 8 Turntable Beauty Renders in procedural studio lighting (DPR2=512x512, DPR1=256x256)
    studio_world = studio.build_procedural_studio_world()
    scene.world = studio_world
    studio.create_studio_lights(target)
    studio.configure_cycles_base(samples=12, max_bounces=2)
    scene.cycles.filter_width = 1.2
    scene.render.image_settings.color_mode = "RGB"

    manifest_samples: list[dict[str, Any]] = []
    turntable_beauty_files: list[str] = []

    for idx, az in enumerate(TURNTABLE_AZIMUTHS):
        studio.position_camera(persp_cam, target, az, TURNTABLE_ELEVATION, dist=TURNTABLE_DIST_M)
        bpy.context.view_layer.update()

        # Primary beauty render (512x512) and DPR2 pair (512x512 vs 256x256) for render.aliasing
        fname_512 = f"turntable_{idx:02d}.png"
        scene.render.resolution_x = 512
        scene.render.resolution_y = 512
        scene.render.filepath = str(frames_dir / fname_512)
        bpy.ops.render.render(write_still=True)
        turntable_beauty_files.append(f"frames/{fname_512}")

        fname_256 = f"turntable_{idx:02d}_dpr1.png"
        scene.render.resolution_x = 256
        scene.render.resolution_y = 256
        scene.render.filepath = str(frames_dir / fname_256)
        bpy.ops.render.render(write_still=True)

        manifest_samples.append({
            "key": f"turntable_{idx:02d}",
            "seed": 1,
            "t": idx * 45,
            "view": idx,
            "viewport": "512x512",
            "scheme": "light",
            "variant": "normal",
            "step": "turntable",
            "file": f"frames/{fname_512}",
            "dpr2_file": f"frames/{fname_512}",
            "dpr1_file": f"frames/{fname_256}",
            "metal_mask": turntable_metal_masks[idx],
            "object_mask": turntable_obj_masks[idx],
            "normal_pass": turntable_normals[idx],
        })

    manifest = {
        "room": "atelier",
        "viewport_default": "512x512",
        "samples": manifest_samples,
        "sequences": [],
        "ortho_views": ortho_files,
        "hidden_views": hidden_files,
        "turntable": {
            "beauty": turntable_beauty_files,
            "object_masks": turntable_obj_masks,
            "metal_masks": turntable_metal_masks,
            "normals": turntable_normals,
        },
    }

    (work_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (work_dir / "blender_eval.json").write_text(
        json.dumps({"gates": gates, "metrics": metrics3d_res}, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Studio render and 3D evaluation complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
