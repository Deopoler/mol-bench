"""
Starter build.py for MoL-Bench room `atelier`.
Creates an unoptimized placeholder structure so the pipeline executes; replace this
with your full procedural museum lantern implementation matching `blueprint/`.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--blueprint", default="blueprint")
    parser.add_argument("--out", default="out")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh, do_unlink=True)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0

    mat_bright = bpy.data.materials.new("default_stripe_bright")
    bsdf_b = mat_bright.node_tree.nodes["Principled BSDF"]
    bsdf_b.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1.0)
    bsdf_b.inputs["Roughness"].default_value = 0.9

    mat_dark = bpy.data.materials.new("default_stripe_dark")
    bsdf_d = mat_dark.node_tree.nodes["Principled BSDF"]
    bsdf_d.inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1.0)
    bsdf_d.inputs["Roughness"].default_value = 0.9

    # 14 unoptimized faceted placeholder bars (~56k total triangles, >12 draw calls, non-manifold open end)
    for idx in range(14):
        bm = bmesh.new()
        bmesh.ops.create_cone(
            bm,
            cap_ends=False,
            cap_tris=False,
            segments=10,
            radius1=0.018,
            radius2=0.014,
            depth=0.14,
        )
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=13, use_grid_fill=True)
        ang = 2.0 * math.pi * idx / 14.0
        ox = 0.035 * math.cos(ang)
        oy = 0.035 * math.sin(ang)
        oz = 0.09 + (idx % 3) * 0.025
        for v in bm.verts:
            v.co += Vector((ox, oy, oz))

        mesh = bpy.data.meshes.new(f"Placeholder_{idx:02d}")
        bm.to_mesh(mesh)
        bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = False
        mesh.materials.append(mat_bright if idx % 2 == 0 else mat_dark)

        obj = bpy.data.objects.new(f"Placeholder_{idx:02d}", mesh)
        obj.scale = Vector((1.1, 1.1, 1.1))
        bpy.context.collection.objects.link(obj)

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / "lantern.glb"),
        export_format="GLB",
        export_yup=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
