"""
Core 3D metric evaluator (`metrics3d/evaluate.py`) executed inside Blender (bpy)
and over rendered studio passes.
Implements every 3D metric defined in docs/METRICS.md ("3D (Blender rooms)").
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from pathlib import Path
from typing import Any

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from .bevel import compute_bevel_ratio
from .gltf_check import validate_glb


# --- OKLab / OKLCH Color Math (pure Python + math, usable inside Blender's Python) ---

def linear_rgb_to_oklab(r: float, g: float, b: float) -> tuple[float, float, float]:
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_ = math.copysign(abs(l) ** (1.0 / 3.0), l) if l != 0 else 0.0
    m_ = math.copysign(abs(m) ** (1.0 / 3.0), m) if m != 0 else 0.0
    s_ = math.copysign(abs(s) ** (1.0 / 3.0), s) if s != 0 else 0.0
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return (L, A, B)


def srgb_channel_to_linear(c: float) -> float:
    c = min(1.0, max(0.0, c))
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def srgb_to_oklab_tuple(r: float, g: float, b: float) -> tuple[float, float, float]:
    return linear_rgb_to_oklab(
        srgb_channel_to_linear(r),
        srgb_channel_to_linear(g),
        srgb_channel_to_linear(b),
    )


def oklch_to_oklab_tuple(L: float, C: float, h_deg: float) -> tuple[float, float, float]:
    rad = math.radians(h_deg)
    return (L, C * math.cos(rad), C * math.sin(rad))


def oklab_distance(lab1: tuple[float, float, float], lab2: tuple[float, float, float]) -> float:
    return math.sqrt((lab1[0] - lab2[0]) ** 2 + (lab1[1] - lab2[1]) ** 2 + (lab1[2] - lab2[2]) ** 2)


# --- Geometry & BMesh Helpers ---

def get_world_triangles(obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph) -> tuple[list[Vector], list[tuple[int, int, int]]]:
    """Return world-space vertices and triangle index tuples for a mesh object."""
    if obj is None or obj.type != "MESH":
        return ([], [])
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        mesh.calc_loop_triangles()
        mw = obj.matrix_world
        verts = [mw @ v.co for v in mesh.vertices]
        tris = [(lt.vertices[0], lt.vertices[1], lt.vertices[2]) for lt in mesh.loop_triangles]
        return (verts, tris)
    finally:
        eval_obj.to_mesh_clear()


def get_hierarchy_bbox_mm(mesh_objs: list[bpy.types.Object], depsgraph: bpy.types.Depsgraph) -> dict[str, Any]:
    """Compute world-space bounding box (in mm) across all mesh objects in the scene."""
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    total_verts = 0

    for obj in mesh_objs:
        verts, _ = get_world_triangles(obj, depsgraph)
        for v in verts:
            total_verts += 1
            if v.x < min_x:
                min_x = v.x
            if v.y < min_y:
                min_y = v.y
            if v.z < min_z:
                min_z = v.z
            if v.x > max_x:
                max_x = v.x
            if v.y > max_y:
                max_y = v.y
            if v.z > max_z:
                max_z = v.z

    if total_verts == 0:
        return {
            "min_mm": [0.0, 0.0, 0.0],
            "max_mm": [0.0, 0.0, 0.0],
            "size_mm": [0.0, 0.0, 0.0],
            "center_mm": [0.0, 0.0, 0.0],
        }

    min_mm = [min_x * 1000.0, min_y * 1000.0, min_z * 1000.0]
    max_mm = [max_x * 1000.0, max_y * 1000.0, max_z * 1000.0]
    size_mm = [max_mm[0] - min_mm[0], max_mm[1] - min_mm[1], max_mm[2] - min_mm[2]]
    center_mm = [0.5 * (min_mm[0] + max_mm[0]), 0.5 * (min_mm[1] + max_mm[1]), 0.5 * (min_mm[2] + max_mm[2])]
    return {
        "min_mm": min_mm,
        "max_mm": max_mm,
        "size_mm": size_mm,
        "center_mm": center_mm,
    }


def count_mesh_islands(obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph) -> int:
    """Count connected face/vertex islands in a mesh object."""
    if obj is None or obj.type != "MESH":
        return 0
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        visited: set[int] = set()
        islands = 0
        for v in bm.verts:
            if v.index in visited:
                continue
            islands += 1
            stack = [v]
            visited.add(v.index)
            while stack:
                cur = stack.pop()
                for e in cur.link_edges:
                    other = e.other_vert(cur)
                    if other.index not in visited:
                        visited.add(other.index)
                        stack.append(other)
        bm.free()
        return islands
    finally:
        eval_obj.to_mesh_clear()


def measure_handle_ring_inner_diameter_mm(handle_obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph, sheet: dict) -> float:
    """Measure handle ring inner diameter (mm) by ray casting outward from ring center in the ring plane."""
    if handle_obj is None or handle_obj.type != "MESH":
        return 0.0
    verts, tris = get_world_triangles(handle_obj, depsgraph)
    if not verts or not tris:
        return 0.0

    bvh = BVHTree.FromPolygons(verts, tris)
    # Determine ring center from Handle bbox center (so scaled handles also ray-cast from their ring center)
    xs = [v.x for v in verts]
    ys = [v.y for v in verts]
    zs = [v.z for v in verts]
    cx = 0.5 * (min(xs) + max(xs))
    cy = 0.5 * (min(ys) + max(ys))
    cz = 0.5 * (min(zs) + max(zs))
    center = Vector((cx, cy, cz))

    # Determine ring plane: XZ if X span >= Y span, else YZ
    plane = "XZ" if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else "YZ"
    diameters_mm: list[float] = []

    for i in range(18):
        ang = math.pi * i / 18.0
        # Avoid direct vertical ray if there is a bottom stem/collar
        if abs(math.sin(ang)) > 0.96:
            continue
        if plane == "XZ":
            d_dir = Vector((math.cos(ang), 0.0, math.sin(ang))).normalized()
        else:
            d_dir = Vector((0.0, math.cos(ang), math.sin(ang))).normalized()

        hit_pos, _, _, dist_pos = bvh.ray_cast(center, d_dir, 0.5)
        hit_neg, _, _, dist_neg = bvh.ray_cast(center, -d_dir, 0.5)
        if hit_pos is not None and hit_neg is not None:
            diameters_mm.append((dist_pos + dist_neg) * 1000.0)

    if not diameters_mm:
        return 0.0
    diameters_mm.sort()
    return float(diameters_mm[len(diameters_mm) // 2])


def measure_frame_bar_section_mm(frame_obj: bpy.types.Object, depsgraph: bpy.types.Depsgraph, sheet: dict) -> float:
    """Measure frame vertical bar cross-section width (mm) by slicing at mid-body height."""
    if frame_obj is None or frame_obj.type != "MESH":
        return 0.0
    verts, tris = get_world_triangles(frame_obj, depsgraph)
    if not verts or not tris:
        return 0.0

    z_mid = 0.5 * (float(sheet.get("base_top_z_mm", 40.0)) + float(sheet.get("body_top_z_mm", 280.0))) * 0.001
    # Collect vertices or triangle edge intersections near z_mid
    bvh = BVHTree.FromPolygons(verts, tris)
    sides = int(sheet.get("sides", 6))
    r_out = float(sheet.get("r_out_mm", 92.376)) * 0.001

    widths_mm: list[float] = []
    for i in range(sides):
        angle = -math.pi / 2.0 - math.pi / sides + i * (2.0 * math.pi / sides)
        cx = r_out * math.cos(angle)
        cy = r_out * math.sin(angle)
        # Cast axis-aligned X caliper rays across the vertical post at (cx, cy, z_mid)
        p_left = Vector((cx - 0.025, cy, z_mid))
        p_right = Vector((cx + 0.025, cy, z_mid))
        x_dir = Vector((1.0, 0.0, 0.0))
        hit1, _, _, _ = bvh.ray_cast(p_left, x_dir, 0.05)
        hit2, _, _, _ = bvh.ray_cast(p_right, -x_dir, 0.05)
        if hit1 is not None and hit2 is not None:
            w = abs(hit2.x - hit1.x) * 1000.0
            if 1.0 <= w <= 40.0:
                widths_mm.append(w)

    if not widths_mm:
        return 0.0
    widths_mm.sort()
    return float(widths_mm[len(widths_mm) // 2])


def check_door_face_and_hinge(
    door_obj: bpy.types.Object,
    dglass_obj: bpy.types.Object | None,
    depsgraph: bpy.types.Depsgraph,
    sheet: dict,
) -> bool:
    """Verify door is on the specified face (-Y front face) and hinge pivot is on the specified side (left, x < 0)."""
    if door_obj is None or door_obj.type != "MESH":
        return False
    objs = [door_obj] + ([dglass_obj] if dglass_obj and dglass_obj.type == "MESH" else [])
    bbox = get_hierarchy_bbox_mm(objs, depsgraph)
    cx, cy, _ = bbox["center_mm"]
    r_in = float(sheet.get("r_in_mm", 80.0))
    # Door center should be near (0, -r_in) within 25 mm
    on_front_face = (abs(cx) <= 25.0) and (abs(cy - (-r_in)) <= 20.0)
    # Pivot world X should be on the left side (x < -15 mm)
    pivot_world = door_obj.matrix_world.translation * 1000.0
    on_left_hinge = pivot_world.x < -15.0 and abs(pivot_world.y - (-r_in)) <= 20.0
    return bool(on_front_face and on_left_hinge)


# --- Topology Checks ---

def evaluate_topology(
    obj_by_name: dict[str, bpy.types.Object],
    parts_sheet: dict,
    depsgraph: bpy.types.Depsgraph,
) -> dict[str, Any]:
    """Compute topo.manifold, topo.normals_outward, topo.degenerate, budget.triangles_abs."""
    non_manifold_edges = 0
    watertight_total = 0
    outward_passed = 0
    degenerate_count = 0
    total_triangles = 0

    watertight_names = {
        p["name"] for p in parts_sheet.get("parts", []) if p.get("watertight") and p.get("type") == "MESH"
    }

    # Evaluate across all mesh objects in scene
    mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for obj in mesh_objs:
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        try:
            mesh.calc_loop_triangles()
            total_triangles += len(mesh.loop_triangles)

            bm = bmesh.new()
            bm.from_mesh(mesh)
            bm.transform(obj.matrix_world)
            bm.verts.ensure_lookup_table()
            bm.edges.ensure_lookup_table()
            bm.faces.ensure_lookup_table()

            # Degenerate faces (< 1e-4 mm^2 = 1e-10 m^2) and edges (< 1e-3 mm = 1e-6 m)
            for f in bm.faces:
                if f.calc_area() < 1e-10:
                    degenerate_count += 1
            for e in bm.edges:
                if e.calc_length() < 1e-6:
                    degenerate_count += 1

            if obj.name in watertight_names:
                watertight_total += 1
                part_non_manifold = 0
                for e in bm.edges:
                    if len(e.link_faces) != 2:
                        part_non_manifold += 1
                non_manifold_edges += part_non_manifold

                # Signed volume and winding consistency check
                bmesh.ops.triangulate(bm, faces=list(bm.faces))
                signed_vol = 0.0
                for f in bm.faces:
                    if len(f.verts) == 3:
                        v0, v1, v2 = f.verts[0].co, f.verts[1].co, f.verts[2].co
                        signed_vol += v0.dot(v1.cross(v2)) / 6.0

                if part_non_manifold == 0 and signed_vol > 1e-12:
                    outward_passed += 1

            bm.free()
        finally:
            eval_obj.to_mesh_clear()

    # Any missing required watertight object counts as failing outward normal check and adds penalty edges
    missing_wt = len(watertight_names - {o.name for o in mesh_objs})
    non_manifold_edges += missing_wt * 20
    total_wt = max(1, len(watertight_names))

    return {
        "topo.manifold": non_manifold_edges,
        "topo.normals_outward": float(outward_passed / total_wt),
        "topo.degenerate": degenerate_count,
        "budget.triangles_abs": total_triangles,
    }


# --- Rig & Hinge Animation + Collision Checks ---

def evaluate_rig_and_collision(
    obj_by_name: dict[str, bpy.types.Object],
    sheet: dict,
    depsgraph: bpy.types.Depsgraph,
) -> dict[str, Any]:
    """Compute rig.hinge, rig.no_collision, rig.open_angle."""
    door_obj = obj_by_name.get("Door")
    dglass_obj = obj_by_name.get("Door_Glass")
    scene = bpy.context.scene

    act = bpy.data.actions.get("door_open")
    if act is None and door_obj and door_obj.animation_data and door_obj.animation_data.action:
        if door_obj.animation_data.action.name.startswith("door_open"):
            act = door_obj.animation_data.action

    check_action_exists = bool(
        act is not None
        and door_obj is not None
        and door_obj.animation_data is not None
        and door_obj.animation_data.action == act
    )

    if not check_action_exists or door_obj is None:
        return {
            "rig.hinge": {"passed": 0, "total": 4},
            "rig.no_collision": False,
            "rig.open_angle": 0.0,
            "door_glass_tracks_door": False,
        }

    f_start = int(round(act.frame_range[0])) if hasattr(act, "frame_range") else 1
    f_end = int(round(act.frame_range[1])) if hasattr(act, "frame_range") else 30
    if f_end <= f_start:
        f_start, f_end = 1, 30

    # Record rest matrices at f_start
    scene.frame_set(f_start)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    mw_door_start = door_obj.evaluated_get(dg).matrix_world.copy()
    mw_dglass_start = dglass_obj.evaluated_get(dg).matrix_world.copy() if dglass_obj else None
    other_starts = {
        name: obj.evaluated_get(dg).matrix_world.copy()
        for name, obj in obj_by_name.items()
        if name not in {"Door", "Door_Glass"} and obj is not None
    }

    # Evaluate at f_end
    scene.frame_set(f_end)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    mw_door_end = door_obj.evaluated_get(dg).matrix_world.copy()
    mw_dglass_end = dglass_obj.evaluated_get(dg).matrix_world.copy() if dglass_obj else None

    # Relative world transformation M_delta = mw_door_end @ mw_door_start^-1
    m_delta = mw_door_end @ mw_door_start.inverted_safe()
    rot_quat = m_delta.to_quaternion()
    rot_axis, rot_angle_rad = rot_quat.to_axis_angle()
    open_angle_deg = abs(math.degrees(rot_angle_rad))

    # Check 2: Door rotation at last frame is 90 deg +/- 5 deg
    check_angle_90 = abs(open_angle_deg - 90.0) <= 5.0

    # Check 3: Rotation axis parallel to vertical hinge bar (Z axis) within 2 deg and passes within 2 mm of hinge line
    z_axis = Vector((0.0, 0.0, 1.0))
    axis_dot = min(1.0, abs(rot_axis.normalized().dot(z_axis))) if rot_axis.length > 1e-6 else 0.0
    axis_angle_deg = math.degrees(math.acos(axis_dot))

    # Fixed point (pivot XY) of 2D rigid motion in XY plane
    hinge_xy_sheet = sheet.get("door_hinge_line_xy_mm", [-38.0, -80.0])
    hinge_pt_sheet = Vector((float(hinge_xy_sheet[0]) * 0.001, float(hinge_xy_sheet[1]) * 0.001))
    pivot_world = mw_door_start.translation
    pivot_xy = Vector((pivot_world.x, pivot_world.y))
    hinge_dist_mm = (pivot_xy - hinge_pt_sheet).length * 1000.0
    check_axis_line = (open_angle_deg > 10.0) and (axis_angle_deg <= 2.0) and (hinge_dist_mm <= 2.5)

    # Check 4: No other part's world matrix changes during the action (except Door children)
    others_stationary = True
    for name, m0 in other_starts.items():
        obj = obj_by_name.get(name)
        if obj is None:
            continue
        m1 = obj.evaluated_get(dg).matrix_world
        for r in range(4):
            for c in range(4):
                if abs(m0[r][c] - m1[r][c]) > 1e-4:
                    others_stationary = False

    # Verify Door_Glass moves rigidly with Door
    door_glass_tracks = False
    if mw_dglass_start is not None and mw_dglass_end is not None and open_angle_deg > 10.0:
        expected_dglass_end = m_delta @ mw_dglass_start
        diff_sum = sum(abs(expected_dglass_end[r][c] - mw_dglass_end[r][c]) for r in range(4) for c in range(4))
        door_glass_tracks = diff_sum < 1e-3

    # Check BVH collision across frames of door_open (tolerance 0.1 mm = 0.0001 m via shrunken test mesh)
    static_parts = [obj_by_name.get(n) for n in ("Frame", "Roof", "Base") if obj_by_name.get(n) is not None]
    moving_parts = [p for p in (door_obj, dglass_obj) if p is not None and p.type == "MESH"]

    # Build static BVH at rest frame
    scene.frame_set(f_start)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    static_verts: list[Vector] = []
    static_tris: list[tuple[int, int, int]] = []
    for sp in static_parts:
        sv, st = get_world_triangles(sp, dg)
        base_idx = len(static_verts)
        static_verts.extend(sv)
        static_tris.extend([(a + base_idx, b + base_idx, c + base_idx) for (a, b, c) in st])

    static_bvh = BVHTree.FromPolygons(static_verts, static_tris) if static_tris else None

    no_collision = True
    if static_bvh is not None and moving_parts:
        # Sample frames across [f_start, f_end]
        step = max(1, (f_end - f_start) // 15)
        sample_frames = list(range(f_start, f_end + 1, step))
        if sample_frames[-1] != f_end:
            sample_frames.append(f_end)

        for fr in sample_frames:
            scene.frame_set(fr)
            bpy.context.view_layer.update()
            dg = bpy.context.evaluated_depsgraph_get()

            mov_verts: list[Vector] = []
            mov_tris: list[tuple[int, int, int]] = []
            for mp in moving_parts:
                eval_mp = mp.evaluated_get(dg)
                mesh = eval_mp.to_mesh()
                try:
                    mesh.calc_loop_triangles()
                    mw = mp.matrix_world
                    n_mat = mw.to_3x3().inverted_safe().transposed()
                    base_idx = len(mov_verts)
                    # Shrink by 0.1 mm (0.0001 m) along vertex normal for 0.1 mm tolerance
                    for v in mesh.vertices:
                        wn = (n_mat @ v.normal).normalized()
                        mov_verts.append((mw @ v.co) - wn * 0.0001)
                    for lt in mesh.loop_triangles:
                        mov_tris.append((
                            lt.vertices[0] + base_idx,
                            lt.vertices[1] + base_idx,
                            lt.vertices[2] + base_idx,
                        ))
                finally:
                    eval_mp.to_mesh_clear()

            if mov_tris:
                mov_bvh = BVHTree.FromPolygons(mov_verts, mov_tris)
                overlaps = static_bvh.overlap(mov_bvh)
                if overlaps:
                    no_collision = False
                    break

    # Reset frame to rest pose
    scene.frame_set(f_start)
    bpy.context.view_layer.update()

    passed_count = sum([
        1 if check_action_exists else 0,
        1 if check_angle_90 else 0,
        1 if check_axis_line else 0,
        1 if others_stationary else 0,
    ])

    return {
        "rig.hinge": {"passed": passed_count, "total": 4},
        "rig.no_collision": no_collision,
        "rig.open_angle": round(open_angle_deg, 3),
        "door_glass_tracks_door": door_glass_tracks,
    }


# --- Material, Texture & UV Evaluation ---

def extract_material_properties(mat: bpy.types.Material) -> dict[str, Any]:
    """Extract PBR scalar properties and any linked image pixels from a Blender material."""
    info: dict[str, Any] = {
        "name": mat.name if mat else "",
        "base_color_linear": (0.8, 0.8, 0.8),
        "metallic": 0.0,
        "roughness": 0.5,
        "transmission": 0.0,
        "ior": 1.45,
        "emission_strength": 0.0,
        "has_color_texture": False,
        "has_roughness_texture": False,
        "color_image": None,
        "roughness_image": None,
        "roughness_channel": 1,  # Green channel in ORM or grayscale
    }
    if mat is None or not mat.use_nodes or mat.node_tree is None:
        return info

    nt = mat.node_tree
    bsdf = None
    for node in nt.nodes:
        if node.type == "BSDF_PRINCIPLED":
            bsdf = node
            break

    if bsdf is None:
        return info

    def _get_float(sock_name: str, default: float) -> float:
        sock = bsdf.inputs.get(sock_name)
        return float(sock.default_value) if sock is not None else default

    bc = bsdf.inputs.get("Base Color")
    if bc is not None:
        v = bc.default_value
        info["base_color_linear"] = (float(v[0]), float(v[1]), float(v[2]))

    info["metallic"] = _get_float("Metallic", 0.0)
    info["roughness"] = _get_float("Roughness", 0.5)
    info["transmission"] = _get_float("Transmission Weight", _get_float("Transmission", 0.0))
    info["ior"] = _get_float("IOR", 1.45)
    info["emission_strength"] = _get_float("Emission Strength", 0.0)

    # Check texture nodes feeding Base Color or Roughness
    for link in nt.links:
        if link.to_node == bsdf and link.to_socket.name == "Base Color":
            if link.from_node.type == "TEX_IMAGE" and link.from_node.image is not None:
                info["has_color_texture"] = True
                info["color_image"] = link.from_node.image
        elif link.to_node == bsdf and link.to_socket.name == "Roughness":
            src = link.from_node
            if src.type == "TEX_IMAGE" and src.image is not None:
                info["has_roughness_texture"] = True
                info["roughness_image"] = src.image
                info["roughness_channel"] = 0
            elif src.type in {"SEPXYZ", "SEPRGB", " SEPARATE_COLOR", "SEPARATE_COLOR"}:
                for l2 in nt.links:
                    if l2.to_node == src and l2.from_node.type == "TEX_IMAGE" and l2.from_node.image is not None:
                        info["has_roughness_texture"] = True
                        info["roughness_image"] = l2.from_node.image
                        info["roughness_channel"] = 1 if link.from_socket.name in {"Green", "G", "Y"} else 0

    return info


def evaluate_materials_and_uvs(
    obj_by_name: dict[str, bpy.types.Object],
    parts_sheet: dict,
    mat_sheet: dict,
    depsgraph: bpy.types.Depsgraph,
) -> dict[str, Any]:
    """Compute mat.assignment, mat.pbr_plausible, mat.color_delta, mat.roughness_mean,
    mat.variation, uv.overlap, vq.texel_density_cv.
    """
    roles_cfg = mat_sheet.get("roles", {})
    req_mesh_parts = [p for p in parts_sheet.get("parts", []) if p.get("type") == "MESH"]

    assigned_passed = 0
    color_deltas: list[float] = []

    metal_ok = True
    dielectric_ok = True
    glass_ok = True
    flame_ok = True
    roughness_ok = True
    any_part_present = False

    image_cache: dict[str, tuple[int, int, list[float], str]] = {}

    def _get_img_data(img: bpy.types.Image) -> tuple[int, int, list[float], str]:
        if img.name not in image_cache:
            w, h = img.size
            cs = img.colorspace_settings.name if hasattr(img, "colorspace_settings") else "sRGB"
            image_cache[img.name] = (w, h, list(img.pixels), cs)
        return image_cache[img.name]

    for p_entry in req_mesh_parts:
        p_name = p_entry["name"]
        role_name = p_entry.get("material_role")
        role_spec = roles_cfg.get(role_name, {})
        prefix = role_spec.get("prefix", f"{role_name}_")

        obj = obj_by_name.get(p_name)
        if obj is None or obj.type != "MESH" or len(obj.data.materials) == 0 or obj.data.materials[0] is None:
            metal_ok = False
            dielectric_ok = False
            glass_ok = False
            flame_ok = False
            roughness_ok = False
            color_deltas.append(0.5)
            continue

        any_part_present = True
        mat = obj.data.materials[0]
        m_info = extract_material_properties(mat)

        if m_info["name"].startswith(prefix):
            assigned_passed += 1

        # Base color OKLab (mean over texture if textured)
        if m_info["has_color_texture"] and m_info["color_image"] is not None:
            w, h, px, cs = _get_img_data(m_info["color_image"])
            n_px = max(1, w * h)
            step = max(1, n_px // 2048)
            sum_l = sum_a = sum_b = 0.0
            cnt = 0
            for idx_p in range(0, n_px, step):
                r, g, b = px[idx_p * 4], px[idx_p * 4 + 1], px[idx_p * 4 + 2]
                if cs.lower() == "srgb":
                    lab = srgb_to_oklab_tuple(r, g, b)
                else:
                    lab = linear_rgb_to_oklab(r, g, b)
                sum_l += lab[0]
                sum_a += lab[1]
                sum_b += lab[2]
                cnt += 1
            mean_lab = (sum_l / cnt, sum_a / cnt, sum_b / cnt)
        else:
            lr, lg, lb = m_info["base_color_linear"]
            mean_lab = linear_rgb_to_oklab(lr, lg, lb)

        # Compare against swatch
        swatch_oklch = role_spec.get("base_color_oklch", [0.7, 0.1, 80.0])
        swatch_lab = oklch_to_oklab_tuple(float(swatch_oklch[0]), float(swatch_oklch[1]), float(swatch_oklch[2]))
        color_deltas.append(oklab_distance(mean_lab, swatch_lab))

        # Roughness mean for part
        if m_info["has_roughness_texture"] and m_info["roughness_image"] is not None:
            w, h, px, _ = _get_img_data(m_info["roughness_image"])
            ch = m_info["roughness_channel"]
            n_px = max(1, w * h)
            step = max(1, n_px // 2048)
            vals = [px[i * 4 + ch] for i in range(0, n_px, step)]
            part_rough = sum(vals) / len(vals)
        else:
            part_rough = m_info["roughness"]

        r_range = role_spec.get("roughness_range", [0.0, 1.0])
        if not (float(r_range[0]) - 0.02 <= part_rough <= float(r_range[1]) + 0.02):
            roughness_ok = False

        if role_name == "brass":
            if m_info["metallic"] < 0.9:
                metal_ok = False
        elif role_name == "wax":
            if not (0.15 <= mean_lab[0] <= 0.95):
                dielectric_ok = False
        elif role_name == "glass":
            if m_info["transmission"] < 0.9 or not (1.4 <= m_info["ior"] <= 1.6):
                glass_ok = False
        elif role_name == "flame":
            e_range = role_spec.get("emission_strength_range", [3.0, 15.0])
            if not (float(e_range[0]) <= m_info["emission_strength"] <= float(e_range[1])):
                flame_ok = False

    pbr_checks = (
        [metal_ok, dielectric_ok, glass_ok, flame_ok, roughness_ok]
        if any_part_present
        else [False, False, False, False, False]
    )

    # Surface-sampled roughness_mean and variation over metal parts (10k area-weighted samples)
    metal_names = ["Frame", "Roof", "Base", "Handle", "Door"]
    metal_objs = [obj_by_name[n] for n in metal_names if n in obj_by_name and obj_by_name[n].type == "MESH"]

    sample_Ls: list[float] = []
    sample_roughs: list[float] = []
    uv_grid_size = 512  # raster grid for UV overlap check (scaled equivalent to 2048^2)
    uv_total_area = 0.0
    uv_overlap_area = 0.0
    texel_ratios: list[float] = []
    any_textured_part = False

    rng = random.Random(42)
    # Collect triangles with UVs and material info across metal objects
    tri_records: list[tuple[float, Any, tuple[float, float], tuple[float, float], tuple[float, float]]] = []
    total_metal_area = 0.0

    # Also rasterize UV triangles for textured parts to compute uv.overlap and vq.texel_density_cv
    uv_occupancy = bytearray(uv_grid_size * uv_grid_size)

    for obj in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
        mat = obj.data.materials[0] if len(obj.data.materials) > 0 else None
        m_info = extract_material_properties(mat)
        is_textured = m_info["has_color_texture"] or m_info["has_roughness_texture"]
        is_metal = obj.name in metal_names or m_info["name"].startswith("brass_")

        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        try:
            mesh.calc_loop_triangles()
            uv_layer = mesh.uv_layers.active.data if mesh.uv_layers.active else None
            mw = obj.matrix_world

            for lt in mesh.loop_triangles:
                v0 = mw @ mesh.vertices[lt.vertices[0]].co
                v1 = mw @ mesh.vertices[lt.vertices[1]].co
                v2 = mw @ mesh.vertices[lt.vertices[2]].co
                world_area = 0.5 * (v1 - v0).cross(v2 - v0).length
                if world_area <= 1e-12:
                    continue

                if uv_layer is not None:
                    uv0 = (float(uv_layer[lt.loops[0]].uv[0]), float(uv_layer[lt.loops[0]].uv[1]))
                    uv1 = (float(uv_layer[lt.loops[1]].uv[0]), float(uv_layer[lt.loops[1]].uv[1]))
                    uv2 = (float(uv_layer[lt.loops[2]].uv[0]), float(uv_layer[lt.loops[2]].uv[1]))
                else:
                    uv0 = (0.0, 0.0)
                    uv1 = (0.0, 0.0)
                    uv2 = (0.0, 0.0)

                if is_metal:
                    total_metal_area += world_area
                    tri_records.append((total_metal_area, m_info, uv0, uv1, uv2))

                if is_textured and uv_layer is not None:
                    any_textured_part = True
                    uv_area = 0.5 * abs(
                        (uv1[0] - uv0[0]) * (uv2[1] - uv0[1]) - (uv2[0] - uv0[0]) * (uv1[1] - uv0[1])
                    )
                    if uv_area > 1e-12 and world_area > 1e-10:
                        texel_ratios.append(math.sqrt(uv_area / world_area))

                    # Rasterize triangle bounding box in UV grid
                    u_min = max(0, int(min(uv0[0], uv1[0], uv2[0]) * uv_grid_size))
                    u_max = min(uv_grid_size - 1, int(max(uv0[0], uv1[0], uv2[0]) * uv_grid_size))
                    v_min = max(0, int(min(uv0[1], uv1[1], uv2[1]) * uv_grid_size))
                    v_max = min(uv_grid_size - 1, int(max(uv0[1], uv1[1], uv2[1]) * uv_grid_size))

                    denom = (uv1[1] - uv2[1]) * (uv0[0] - uv2[0]) + (uv2[0] - uv1[0]) * (uv0[1] - uv2[1])
                    if abs(denom) > 1e-10:
                        for gy in range(v_min, v_max + 1):
                            py = (gy + 0.5) / uv_grid_size
                            for gx in range(u_min, u_max + 1):
                                px_u = (gx + 0.5) / uv_grid_size
                                w0 = ((uv1[1] - uv2[1]) * (px_u - uv2[0]) + (uv2[0] - uv1[0]) * (py - uv2[1])) / denom
                                w1 = ((uv2[1] - uv0[1]) * (px_u - uv2[0]) + (uv0[0] - uv2[0]) * (py - uv2[1])) / denom
                                w2 = 1.0 - w0 - w1
                                if w0 >= 0.0 and w1 >= 0.0 and w2 >= 0.0:
                                    cell_idx = gy * uv_grid_size + gx
                                    uv_total_area += 1.0
                                    if uv_occupancy[cell_idx] > 0:
                                        uv_overlap_area += 1.0
                                    else:
                                        uv_occupancy[cell_idx] = 1
        finally:
            eval_obj.to_mesh_clear()

    # Sample 10,000 points across metal triangles weighted by area
    if tri_records and total_metal_area > 0:
        import bisect

        cum_areas = [r[0] for r in tri_records]
        n_samples = 10000
        for _ in range(n_samples):
            target_a = rng.random() * total_metal_area
            t_idx = bisect.bisect_left(cum_areas, target_a)
            if t_idx >= len(tri_records):
                t_idx = len(tri_records) - 1
            _, m_info, uv0, uv1, uv2 = tri_records[t_idx]
            r1 = math.sqrt(rng.random())
            r2 = rng.random()
            b0 = 1.0 - r1
            b1 = r1 * (1.0 - r2)
            b2 = r1 * r2
            u = (b0 * uv0[0] + b1 * uv1[0] + b2 * uv2[0]) % 1.0
            v = (b0 * uv0[1] + b1 * uv1[1] + b2 * uv2[1]) % 1.0

            if m_info["has_color_texture"] and m_info["color_image"] is not None:
                w, h, px, cs = _get_img_data(m_info["color_image"])
                ix = min(w - 1, max(0, int(u * w)))
                iy = min(h - 1, max(0, int(v * h)))
                p_idx = (iy * w + ix) * 4
                cr, cg, cb = px[p_idx], px[p_idx + 1], px[p_idx + 2]
                lab = srgb_to_oklab_tuple(cr, cg, cb) if cs.lower() == "srgb" else linear_rgb_to_oklab(cr, cg, cb)
            else:
                lr, lg, lb = m_info["base_color_linear"]
                lab = linear_rgb_to_oklab(lr, lg, lb)
            sample_Ls.append(lab[0])

            if m_info["has_roughness_texture"] and m_info["roughness_image"] is not None:
                w, h, px, _ = _get_img_data(m_info["roughness_image"])
                ix = min(w - 1, max(0, int(u * w)))
                iy = min(h - 1, max(0, int(v * h)))
                p_idx = (iy * w + ix) * 4 + m_info["roughness_channel"]
                sample_roughs.append(float(px[p_idx]))
            else:
                sample_roughs.append(float(m_info["roughness"]))

    if sample_roughs:
        mean_rough = sum(sample_roughs) / len(sample_roughs)
        mean_L = sum(sample_Ls) / len(sample_Ls)
        var_rough = sum((x - mean_rough) ** 2 for x in sample_roughs) / len(sample_roughs)
        var_L = sum((x - mean_L) ** 2 for x in sample_Ls) / len(sample_Ls)
        variation = math.sqrt(var_L) + math.sqrt(var_rough)
    else:
        mean_rough = 0.5
        variation = 0.0

    uv_overlap = float(uv_overlap_area / uv_total_area) if uv_total_area > 0 else 0.0

    if any_textured_part and len(texel_ratios) >= 2:
        tr_mean = sum(texel_ratios) / len(texel_ratios)
        tr_std = math.sqrt(sum((x - tr_mean) ** 2 for x in texel_ratios) / len(texel_ratios))
        texel_cv: float | None = float(tr_std / tr_mean) if tr_mean > 1e-8 else 0.0
    else:
        texel_cv = None

    return {
        "mat.assignment": {"passed": assigned_passed, "total": len(req_mesh_parts)},
        "mat.pbr_plausible": {"passed": sum(1 for c in pbr_checks if c), "total": 5},
        "mat.color_delta": float(sum(color_deltas) / max(1, len(color_deltas))),
        "mat.roughness_mean": float(mean_rough),
        "mat.variation": float(variation),
        "uv.overlap": uv_overlap,
        "vq.texel_density_cv": texel_cv,
    }


# --- Hausdorff Distance & Part Scale vs Start (Renovation r1) ---

def sample_surface_points(
    objs: list[bpy.types.Object],
    depsgraph: bpy.types.Depsgraph,
    n_samples: int = 20000,
    seed: int = 1,
) -> list[Vector]:
    """Sample `n_samples` area-weighted points across `objs` in world space."""
    import bisect

    tris: list[tuple[float, Vector, Vector, Vector]] = []
    cum_area = 0.0
    for obj in objs:
        verts, idx_tris = get_world_triangles(obj, depsgraph)
        for i0, i1, i2 in idx_tris:
            v0, v1, v2 = verts[i0], verts[i1], verts[i2]
            area = 0.5 * (v1 - v0).cross(v2 - v0).length
            if area > 1e-12:
                cum_area += area
                tris.append((cum_area, v0, v1, v2))

    if not tris or cum_area <= 0.0:
        return []

    areas = [t[0] for t in tris]
    rng = random.Random(seed)
    pts: list[Vector] = []
    for _ in range(n_samples):
        a = rng.random() * cum_area
        idx = bisect.bisect_left(areas, a)
        if idx >= len(tris):
            idx = len(tris) - 1
        _, v0, v1, v2 = tris[idx]
        r1 = math.sqrt(rng.random())
        r2 = rng.random()
        b0 = 1.0 - r1
        b1 = r1 * (1.0 - r2)
        b2 = r1 * r2
        pts.append(v0 * b0 + v1 * b1 + v2 * b2)
    return pts


def one_sided_hausdorff_mm(
    start_pts: list[Vector],
    sub_objs: list[bpy.types.Object],
    depsgraph: bpy.types.Depsgraph,
) -> float:
    """Max one-sided Hausdorff distance (mm) from start surface points to submission BVH."""
    if not start_pts:
        return 0.0
    all_verts: list[Vector] = []
    all_tris: list[tuple[int, int, int]] = []
    for obj in sub_objs:
        v, t = get_world_triangles(obj, depsgraph)
        base = len(all_verts)
        all_verts.extend(v)
        all_tris.extend([(a + base, b + base, c + base) for (a, b, c) in t])

    if not all_tris:
        return 999.0

    bvh = BVHTree.FromPolygons(all_verts, all_tris)
    max_dist_m = 0.0
    for pt in start_pts:
        loc, _, _, dist = bvh.find_nearest(pt)
        if loc is not None and dist > max_dist_m:
            max_dist_m = dist
    return float(max_dist_m * 1000.0)


# --- Geometry Hash for G-reproducible ---

def compute_glb_geometry_hash(glb_path: str | Path) -> str:
    """Compute a deterministic geometry hash from a .glb file:
    positions quantized to 0.01 mm (1e-5 m), indices, and per-primitive material names.
    """
    import struct

    val = validate_glb(glb_path)
    if not val["pass"]:
        return f"INVALID:{':'.join(val['errors'])}"

    data = Path(glb_path).read_bytes()
    # Locate BIN chunk
    c0_len, _ = struct.unpack_from("<II", data, 12)
    bin_off = 12 + 8 + c0_len + 8
    bin_data = data[bin_off:]
    gltf = val["gltf"]

    accessors = gltf.get("accessors", [])
    buffer_views = gltf.get("bufferViews", [])
    materials = gltf.get("materials", [])
    meshes = sorted(gltf.get("meshes", []), key=lambda m: m.get("name", ""))

    h = hashlib.sha256()
    for mesh in meshes:
        h.update(f"MESH:{mesh.get('name', '')}\n".encode("utf-8"))
        for prim in mesh.get("primitives", []):
            mat_idx = prim.get("material")
            mat_name = materials[mat_idx].get("name", "") if (mat_idx is not None and 0 <= mat_idx < len(materials)) else ""
            h.update(f"MAT:{mat_name}\n".encode("utf-8"))

            pos_idx = prim.get("attributes", {}).get("POSITION")
            if pos_idx is not None and 0 <= pos_idx < len(accessors):
                acc = accessors[pos_idx]
                bv = buffer_views[acc["bufferView"]]
                off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
                stride = bv.get("byteStride", 12)
                count = acc.get("count", 0)
                for i in range(count):
                    x, y, z = struct.unpack_from("<fff", bin_data, off + i * stride)
                    # Quantize to 0.01 mm = 1e-5 m
                    qx = int(round(x * 100000.0))
                    qy = int(round(y * 100000.0))
                    qz = int(round(z * 100000.0))
                    h.update(f"{qx},{qy},{qz};".encode("utf-8"))

            ind_idx = prim.get("indices")
            if ind_idx is not None and 0 <= ind_idx < len(accessors):
                acc = accessors[ind_idx]
                bv = buffer_views[acc["bufferView"]]
                off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
                comp = acc["componentType"]
                count = acc.get("count", 0)
                fmt = "<B" if comp == 5121 else ("<H" if comp == 5123 else "<I")
                step = 1 if comp == 5121 else (2 if comp == 5123 else 4)
                h.update(f"IDX:{count}:".encode("utf-8"))
                for i in range(min(count, 4096)):
                    (iv,) = struct.unpack_from(fmt, bin_data, off + i * step)
                    h.update(f"{iv},".encode("utf-8"))

    return h.hexdigest()


# --- Full In-Blender Scene Evaluation Entry Point ---

def evaluate_scene_metrics3d(
    blueprint_dir: str | Path,
    start_blend_path: str | Path | None = None,
) -> dict[str, Any]:
    """Evaluate all in-Blender 3D metrics on the currently loaded scene."""
    bp = Path(blueprint_dir)
    dims_sheet = json.loads((bp / "dimensions.json").read_text(encoding="utf-8"))
    mat_sheet = json.loads((bp / "materials.json").read_text(encoding="utf-8"))
    parts_sheet = json.loads((bp / "parts.json").read_text(encoding="utf-8"))
    budget_sheet = json.loads((bp / "budget.json").read_text(encoding="utf-8"))

    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    obj_by_name = {o.name: o for o in scene.objects}
    mesh_objs = [o for o in scene.objects if o.type == "MESH"]

    # 1. scene.hierarchy
    req_parts = parts_sheet.get("parts", [])
    hier_passed = 0
    for p in req_parts:
        obj = obj_by_name.get(p["name"])
        if obj is None:
            continue
        actual_parent = obj.parent.name if obj.parent is not None else None
        if actual_parent == p.get("parent"):
            hier_passed += 1
    scene_hierarchy = {"passed": hier_passed, "total": len(req_parts)}

    # 2. dims.bbox_error & scene.units_origin
    bbox_info = get_hierarchy_bbox_mm(mesh_objs, depsgraph)
    sheet_bbox = dims_sheet.get("overall_bbox_mm", {"x": 207.846, "y": 180.0, "z": 418.0})
    sx, sy, sz = float(sheet_bbox["x"]), float(sheet_bbox["y"]), float(sheet_bbox["z"])
    bx, by, bz = bbox_info["size_mm"]
    if len(mesh_objs) == 0:
        bbox_error = 1.0
    else:
        bbox_error = max(
            abs(bx - sx) / max(1e-3, sx),
            abs(by - sy) / max(1e-3, sy),
            abs(bz - sz) / max(1e-3, sz),
        )

    unit_ok = (
        scene.unit_settings.system == "METRIC"
        and abs(scene.unit_settings.scale_length - 1.0) <= 1e-4
    )
    scales_ok = len(req_parts) > 0 and all(
        (p["name"] in obj_by_name)
        and all(abs(obj_by_name[p["name"]].scale[k] - 1.0) <= 1e-4 for k in range(3))
        for p in req_parts
    )
    lantern_obj = obj_by_name.get("Lantern")
    origin_ok = False
    if lantern_obj is not None and len(mesh_objs) > 0:
        lx, ly, lz = lantern_obj.matrix_world.translation * 1000.0
        cx, cy, _ = bbox_info["center_mm"]
        min_z = bbox_info["min_mm"][2]
        origin_ok = (abs(lx - cx) <= 1.0) and (abs(ly - cy) <= 1.0) and (abs(min_z - lz) <= 1.0) and (abs(min_z) <= 1.0)

    units_origin = {
        "passed": sum(1 for c in (unit_ok, scales_ok, origin_ok) if c),
        "total": 3,
    }

    # 3. dims.key_measurements
    handle_d = measure_handle_ring_inner_diameter_mm(obj_by_name.get("Handle"), depsgraph, dims_sheet)
    target_handle_d = float(dims_sheet.get("handle_ring_inner_d_mm", 56.0))
    km_handle = abs(handle_d - target_handle_d) / max(1e-3, target_handle_d) <= 0.02

    bar_w = measure_frame_bar_section_mm(obj_by_name.get("Frame"), depsgraph, dims_sheet)
    target_bar_w = float(dims_sheet.get("frame_bar_mm", 8.0))
    km_bar = abs(bar_w - target_bar_w) / max(1e-3, target_bar_w) <= 0.10

    glass_islands = count_mesh_islands(obj_by_name.get("Glass"), depsgraph)
    dglass_islands = count_mesh_islands(obj_by_name.get("Door_Glass"), depsgraph)
    target_panes = int(dims_sheet.get("pane_count", 5))
    km_panes = (glass_islands == target_panes and dglass_islands == 1) or (glass_islands + dglass_islands == target_panes + 1 and glass_islands >= target_panes)

    km_door = check_door_face_and_hinge(obj_by_name.get("Door"), obj_by_name.get("Door_Glass"), depsgraph, dims_sheet)
    key_measurements = {
        "passed": sum(1 for c in (km_handle, km_bar, km_panes, km_door) if c),
        "total": 4,
    }

    # 4. Topology & triangle budgets
    topo_res = evaluate_topology(obj_by_name, parts_sheet, depsgraph)
    max_tris = float(budget_sheet.get("max_triangles", 30000))
    budget_triangles = float(topo_res["budget.triangles_abs"] / max_tris)

    # 5. Rig & collision
    rig_res = evaluate_rig_and_collision(obj_by_name, dims_sheet, depsgraph)

    # 6. Materials & UVs
    mat_res = evaluate_materials_and_uvs(obj_by_name, parts_sheet, mat_sheet, depsgraph)

    # 7. vq.bevel_ratio
    metal_names = ["Frame", "Roof", "Base", "Handle", "Door"]
    metal_objs = [obj_by_name[n] for n in metal_names if n in obj_by_name and obj_by_name[n].type == "MESH"]
    bevel_ratio = compute_bevel_ratio(metal_objs)

    # 8. Hidden functional test helper checks (Flame emissive/no-shadow, Glass thickness >= 1 mm)
    flame_obj = obj_by_name.get("Flame")
    flame_ok = False
    if flame_obj is not None and flame_obj.type == "MESH" and len(flame_obj.data.materials) > 0:
        f_mat_info = extract_material_properties(flame_obj.data.materials[0])
        f_bbox = get_hierarchy_bbox_mm([flame_obj], depsgraph)
        f_max_dim = max(f_bbox["size_mm"])
        flame_ok = (f_mat_info["emission_strength"] >= 1.0) and (not flame_obj.visible_shadow or f_max_dim <= 30.0)

    glass_thick_ok = False
    glass_obj = obj_by_name.get("Glass")
    if glass_obj is not None and glass_obj.type == "MESH":
        eval_g = glass_obj.evaluated_get(depsgraph)
        m_g = eval_g.to_mesh()
        try:
            bm_g = bmesh.new()
            bm_g.from_mesh(m_g)
            bm_g.transform(glass_obj.matrix_world)
            bmesh.ops.triangulate(bm_g, faces=list(bm_g.faces))
            vol_mm3 = 0.0
            for f in bm_g.faces:
                if len(f.verts) == 3:
                    vol_mm3 += (f.verts[0].co.dot(f.verts[1].co.cross(f.verts[2].co)) / 6.0) * 1e9
            bm_g.free()
            # 5 panes of ~75x200x2 mm have volume ~150,000 mm^3; 1mm thickness has >= 50,000 mm^3
            glass_thick_ok = vol_mm3 >= 35000.0
        finally:
            eval_g.to_mesh_clear()

    out: dict[str, Any] = {
        "dims.bbox_error": round(float(bbox_error), 5),
        "dims.key_measurements": key_measurements,
        "scene.hierarchy": scene_hierarchy,
        "scene.units_origin": units_origin,
        "rig.hinge": rig_res["rig.hinge"],
        "rig.no_collision": rig_res["rig.no_collision"],
        "rig.open_angle": rig_res["rig.open_angle"],
        "topo.manifold": topo_res["topo.manifold"],
        "topo.normals_outward": round(topo_res["topo.normals_outward"], 5),
        "topo.degenerate": topo_res["topo.degenerate"],
        "budget.triangles": round(budget_triangles, 5),
        "budget.triangles_abs": topo_res["budget.triangles_abs"],
        "mat.assignment": mat_res["mat.assignment"],
        "mat.pbr_plausible": mat_res["mat.pbr_plausible"],
        "mat.color_delta": round(mat_res["mat.color_delta"], 5),
        "mat.roughness_mean": round(mat_res["mat.roughness_mean"], 5),
        "mat.variation": round(mat_res["mat.variation"], 5),
        "uv.overlap": round(mat_res["uv.overlap"], 5),
        "vq.texel_density_cv": round(mat_res["vq.texel_density_cv"], 5) if mat_res["vq.texel_density_cv"] is not None else None,
        "vq.bevel_ratio": round(bevel_ratio, 5),
        "_test_checks": {
            "flame_emissive_non_blocking": flame_ok,
            "glass_thickness_ge_1mm": glass_thick_ok,
            "door_glass_tracks_door": rig_res["door_glass_tracks_door"],
        },
        "_handle_bbox_size_mm": get_hierarchy_bbox_mm(
            [obj_by_name["Handle"]] if "Handle" in obj_by_name else [], depsgraph
        )["size_mm"],
    }

    # 9. If Renovation start_blend_path is provided, compute dims.part_scale, geo.others_hausdorff_mm, geo.frame_unchanged
    if start_blend_path and Path(start_blend_path).exists():
        # Sample submission surfaces and then open start_blend_path to sample start surfaces
        sub_handle_size = out["_handle_bbox_size_mm"]
        non_handle_names = ["Frame", "Roof", "Base", "Glass", "Candle", "Flame", "Door", "Door_Glass"]
        sub_other_objs = [obj_by_name[n] for n in non_handle_names if n in obj_by_name and obj_by_name[n].type == "MESH"]
        sub_frame_objs = [obj_by_name["Frame"]] if "Frame" in obj_by_name and obj_by_name["Frame"].type == "MESH" else []

        # Build BVHs of submission non-handle parts and Frame before loading start scene
        other_verts: list[Vector] = []
        other_tris: list[tuple[int, int, int]] = []
        for o in sub_other_objs:
            v, t = get_world_triangles(o, depsgraph)
            b_idx = len(other_verts)
            other_verts.extend(v)
            other_tris.extend([(a + b_idx, b + b_idx, c + b_idx) for (a, b, c) in t])
        other_bvh = BVHTree.FromPolygons(other_verts, other_tris) if other_tris else None

        frame_verts: list[Vector] = []
        frame_tris: list[tuple[int, int, int]] = []
        for o in sub_frame_objs:
            v, t = get_world_triangles(o, depsgraph)
            b_idx = len(frame_verts)
            frame_verts.extend(v)
            frame_tris.extend([(a + b_idx, b + b_idx, c + b_idx) for (a, b, c) in t])
        frame_bvh = BVHTree.FromPolygons(frame_verts, frame_tris) if frame_tris else None

        # Load start blend file in-process to extract start Handle bbox, start roughness_mean, and surface samples
        current_filepath = bpy.data.filepath
        bpy.ops.wm.open_mainfile(filepath=str(start_blend_path))
        bpy.context.scene.frame_set(1)
        bpy.context.view_layer.update()
        start_dg = bpy.context.evaluated_depsgraph_get()
        start_objs = {o.name: o for o in bpy.context.scene.objects}

        start_handle_size = get_hierarchy_bbox_mm(
            [start_objs["Handle"]] if "Handle" in start_objs else [], start_dg
        )["size_mm"]
        ratios = [
            sub_handle_size[k] / max(1e-3, start_handle_size[k])
            for k in range(3)
        ]
        # Worst axis relative to 1.25 target
        worst_ratio = max(ratios, key=lambda r: abs(r - 1.25))
        out["dims.part_scale"] = round(float(worst_ratio), 5)

        start_other_objs = [start_objs[n] for n in non_handle_names if n in start_objs and start_objs[n].type == "MESH"]
        start_other_pts = sample_surface_points(start_other_objs, start_dg, n_samples=20000, seed=1)

        if other_bvh is not None and start_other_pts:
            max_d = 0.0
            for pt in start_other_pts:
                loc, _, _, d = other_bvh.find_nearest(pt)
                if loc is not None and d > max_d:
                    max_d = d
            haus_others = round(float(max_d * 1000.0), 4)
        else:
            haus_others = 999.0

        start_frame_objs = [start_objs["Frame"]] if "Frame" in start_objs and start_objs["Frame"].type == "MESH" else []
        start_frame_pts = sample_surface_points(start_frame_objs, start_dg, n_samples=20000, seed=2)
        if frame_bvh is not None and start_frame_pts:
            max_df = 0.0
            for pt in start_frame_pts:
                loc, _, _, d = frame_bvh.find_nearest(pt)
                if loc is not None and d > max_df:
                    max_df = d
            haus_frame = round(float(max_df * 1000.0), 4)
        else:
            haus_frame = 999.0

        # Apply AT-R2 band relaxation note in r1.json:
        # "Because AT-R2 legitimately changes topology, geo.others_hausdorff_mm in AT-R1 uses a 1.5 mm full band when triangles < 16000."
        band_scale = 3.0 if out["budget.triangles_abs"] < 16000 else 1.0
        out["geo.others_hausdorff_mm"] = {"raw": haus_others, "bandScale": band_scale}
        out["geo.frame_unchanged"] = {"raw": haus_frame, "bandScale": band_scale}

        # Start roughness_mean for relative scoring of mat.roughness_mean
        start_mat_res = evaluate_materials_and_uvs(start_objs, parts_sheet, mat_sheet, start_dg)
        out["mat.roughness_mean"] = {
            "before": round(start_mat_res["mat.roughness_mean"], 5),
            "after": out["mat.roughness_mean"],
        }

        if current_filepath and Path(current_filepath).exists():
            bpy.ops.wm.open_mainfile(filepath=current_filepath)

    return out
