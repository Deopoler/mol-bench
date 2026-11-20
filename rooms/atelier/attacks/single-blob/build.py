"""
Attack submission: `single-blob`.
One unnamed merged mesh with rough lantern outline, no hierarchy, no hinge, no materials.
"""

from __future__ import annotations

import argparse
import math
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

    bm = bmesh.new()
    # Single solid hexagonal pillar with open bottom
    sides = 6
    r = 0.062
    v_bot = [
        bm.verts.new((r * math.cos(i * math.pi / 3), r * math.sin(i * math.pi / 3), 0.02))
        for i in range(sides)
    ]
    v_top = [
        bm.verts.new((r * math.cos(i * math.pi / 3), r * math.sin(i * math.pi / 3), 0.26))
        for i in range(sides)
    ]
    bm.faces.new(v_top)
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new([v_bot[i], v_bot[j], v_top[j], v_top[i]])

    mesh = bpy.data.meshes.new("Blob")
    bm.to_mesh(mesh)
    bm.free()

    mat = bpy.data.materials.new("blob_mat")
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.12, 0.12, 0.12, 1.0)
    mesh.materials.append(mat)

    obj = bpy.data.objects.new("Blob", mesh)
    obj.scale = Vector((1.1, 1.1, 1.0))
    bpy.context.collection.objects.link(obj)

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(filepath=str(out_dir / "lantern.glb"), export_format="GLB", export_yup=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
