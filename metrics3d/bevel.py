"""
Bevel ratio evaluation (`vq.bevel_ratio`) for 3D Blender rooms (`metrics3d/bevel.py`).
Per docs/METRICS.md:
  On metal parts: among edges with dihedral angle > 45 deg in the unbeveled sense
  (detected on the evaluated mesh as chains of faces whose normals turn > 45 deg
  within a width <= 3% of the part's smallest bbox dimension), fraction whose turn
  is spread over >= 2 face strips or uses split/custom normals with a weighted transition.
"""

from __future__ import annotations

import math
import bmesh
import bpy
from mathutils import Vector


def face_strip_width(face: bmesh.types.BMFace) -> float:
    """Estimate the narrow cross-width of a face as Area / max_edge_length."""
    max_len = 0.0
    for e in face.edges:
        length = e.calc_length()
        if length > max_len:
            max_len = length
    if max_len <= 1e-8:
        return 0.0
    return face.calc_area() / max_len


def compute_part_bevel_counts(obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph) -> tuple[float, float]:
    """Return (beveled_length, total_sharp_turn_length) in meters for a single metal mesh object."""
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.transform(obj.matrix_world)
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        if not bm.verts or not bm.faces:
            bm.free()
            return (0.0, 0.0)

        xs = [v.co.x for v in bm.verts]
        ys = [v.co.y for v in bm.verts]
        zs = [v.co.z for v in bm.verts]
        dims = [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)]
        non_zero_dims = [d for d in dims if d > 1e-5]
        min_dim = min(non_zero_dims) if non_zero_dims else 0.01

        # Threshold width for narrow bevel/chamfer face strips: 3% of smallest bbox dimension (min 2.2 mm)
        strip_thresh = max(0.0022, 0.03 * min_dim)

        # Classify faces into narrow bevel strips vs primary structural faces
        is_strip = {}
        for f in bm.faces:
            w = face_strip_width(f)
            # A bevel strip is narrow and its individual edges turn moderately (12..52 deg),
            # never containing an unbeveled >55 deg sharp corner edge.
            max_turn = 0.0
            min_non_zero_turn = 999.0
            for e in f.edges:
                for nb in e.link_faces:
                    if nb is not f:
                        ang_d = math.degrees(f.normal.angle(nb.normal, 0.0))
                        if ang_d > max_turn:
                            max_turn = ang_d
                        if ang_d > 5.0 and ang_d < min_non_zero_turn:
                            min_non_zero_turn = ang_d
            is_strip[f.index] = (w <= strip_thresh) and (10.0 <= max_turn <= 54.0)

        has_custom_normals = bool(mesh.has_custom_normals)

        unbeveled_len = 0.0
        beveled_len = 0.0

        # 1. Direct edges between two non-strip structural faces with dihedral angle > 45 deg -> unbeveled
        for e in bm.edges:
            if len(e.link_faces) != 2:
                continue
            f0, f1 = e.link_faces[0], e.link_faces[1]
            s0 = is_strip.get(f0.index, False)
            s1 = is_strip.get(f1.index, False)
            ang_deg = math.degrees(f0.normal.angle(f1.normal, 0.0))

            if not s0 and not s1:
                if ang_deg > 45.0:
                    length = e.calc_length()
                    if has_custom_normals and not e.smooth:
                        unbeveled_len += length
                    elif has_custom_normals and e.smooth:
                        beveled_len += length
                    else:
                        unbeveled_len += length

        # 2. Connected chains/components of strip faces bordering structural faces with total turn > 45 deg -> beveled
        visited_strips: set[int] = set()
        for f in bm.faces:
            if not is_strip.get(f.index, False) or f.index in visited_strips:
                continue
            # Flood-fill strip faces that form a bevel strip or multi-segment bevel chain
            comp: list[bmesh.types.BMFace] = []
            queue = [f]
            visited_strips.add(f.index)
            while queue:
                cur = queue.pop()
                comp.append(cur)
                for e in cur.edges:
                    for nb in e.link_faces:
                        if is_strip.get(nb.index, False) and nb.index not in visited_strips:
                            visited_strips.add(nb.index)
                            queue.append(nb)

            # Collect bordering structural faces and boundary edge length
            border_normals: list[Vector] = []
            boundary_len = 0.0
            for sf in comp:
                for e in sf.edges:
                    for nb in e.link_faces:
                        if not is_strip.get(nb.index, False):
                            border_normals.append(nb.normal.copy())
                            boundary_len += e.calc_length()

            if len(border_normals) >= 2:
                # Check if any pair of bordering structural normals turns > 45 deg
                max_turn_deg = 0.0
                for i in range(min(12, len(border_normals))):
                    for j in range(i + 1, min(12, len(border_normals))):
                        ang_d = math.degrees(border_normals[i].angle(border_normals[j], 0.0))
                        if ang_d > max_turn_deg:
                            max_turn_deg = ang_d
                if max_turn_deg > 45.0:
                    # Each bevel has 2 structural boundaries (one on each side of the strip)
                    beveled_len += 0.5 * boundary_len

        bm.free()
        return (beveled_len, beveled_len + unbeveled_len)
    finally:
        eval_obj.to_mesh_clear()


def compute_bevel_ratio(metal_objects: list[bpy.types.Object]) -> float:
    """Compute vq.bevel_ratio across all metal mesh objects in the scene."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total_beveled = 0.0
    total_sharp = 0.0
    for obj in metal_objects:
        if obj is None or obj.type != "MESH":
            continue
        b_len, t_len = compute_part_bevel_counts(obj, depsgraph)
        total_beveled += b_len
        total_sharp += t_len

    if total_sharp <= 1e-6:
        return 0.0
    return float(min(1.0, max(0.0, total_beveled / total_sharp)))
