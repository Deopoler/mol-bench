"""
Attack submission: `dense-mesh`.
Over-subdivided high-triangle model (~150k+ triangles, exceeding 4x triangle budget)
and > 12 mesh primitives/draw calls so `budget.triangles` and `web.three_load` fail.
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

    mat = bpy.data.materials.new("dense_mat")
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.2, 0.2, 0.2, 1.0)

    # Create 16 heavily subdivided chunks (~10,000 tris each -> ~160,000 triangles > 120,000 zero band, 16 draw calls > 12)
    for i in range(16):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=80, v_segments=64, radius=0.07)
        for v in bm.verts:
            v.co.z += 0.08 + i * 0.015
        mesh = bpy.data.meshes.new(f"DenseChunk_{i:02d}")
        bm.to_mesh(mesh)
        bm.free()
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(f"DenseChunk_{i:02d}", mesh)
        obj.scale = Vector((1.05, 1.05, 1.05))
        bpy.context.collection.objects.link(obj)

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(filepath=str(out_dir / "lantern.glb"), export_format="GLB", export_yup=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
