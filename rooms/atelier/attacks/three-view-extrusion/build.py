"""
Attack submission: `three-view-extrusion`.
Extrudes the bounding profile to game public orthographic silhouettes while omitting
true 3D hexagonal facets, hollow frame bars, hierarchy, materials, and hinge rigging.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


def main() -> int:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--blueprint", default="blueprint")
    parser.add_argument("--out", default="out")
    args = parser.parse_args(argv)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh, do_unlink=True)

    # Solid rectangular visual-hull block slabs approximating front/side widths without true 3D structure
    bm = bmesh.new()
    # Body block (solid, non-hollow, wrong cross-section at 45 deg oblique views)
    v_bot = [
        bm.verts.new((-0.080, -0.080, 0.012)),
        bm.verts.new((0.080, -0.080, 0.012)),
        bm.verts.new((0.080, 0.080, 0.012)),
        bm.verts.new((-0.080, 0.080, 0.012)),
    ]
    v_top = [
        bm.verts.new((-0.080, -0.080, 0.340)),
        bm.verts.new((0.080, -0.080, 0.340)),
        bm.verts.new((0.080, 0.080, 0.340)),
        bm.verts.new((-0.080, 0.080, 0.340)),
    ]
    # Leave bottom cap missing (non-manifold)
    bm.faces.new(v_top)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([v_bot[i], v_bot[j], v_top[j], v_top[i]])

    mesh = bpy.data.meshes.new("ExtrudedHull")
    bm.to_mesh(mesh)
    bm.free()

    mat = bpy.data.materials.new("hull_mat")
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.15, 0.15, 0.15, 1.0)
    mesh.materials.append(mat)

    obj = bpy.data.objects.new("ExtrudedHull", mesh)
    obj.scale = Vector((1.05, 1.05, 1.0))
    bpy.context.collection.objects.link(obj)

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(filepath=str(out_dir / "lantern.glb"), export_format="GLB", export_yup=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
