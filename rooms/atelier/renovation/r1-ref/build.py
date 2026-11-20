"""
Mediocre reference anchor (`rooms/atelier/anchors/a5/build.py`) and starting workspace
for Renovation `r1`.
Known traits of a5 (per rooms/atelier/renovation/r1.json):
  - No bevels (hard 90-degree edges on metal parts)
  - Uniform glossy metal (untextured constant roughness=0.20, zero surface variation)
  - ~41k triangles (over-subdivided meshes)
  - Door hinge pivot correct (90-degree `door_open` action around the front-left hinge line)
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector

# Tunable constants (facilitates clean minimal diff in Renovation r1)
HANDLE_SCALE = 1.25
BEVEL_OFFSET_MM = 0.75
BEVEL_SEGMENTS = 2
SUBDIVIDE_CUTS_MAIN = 0
SUBDIVIDE_CUTS_SECONDARY = 0
TEXTURED_BRASS = True
BRASS_ROUGHNESS = 0.19
BRASS_SRGB = [0.745, 0.615, 0.365]
PATINA_STRENGTH = 0.85
DOOR_OPEN_DEG = 90.0
DOOR_HINGE_Y_OFFSET_MM = 0.0
ROOF_EAVE_SCALE = 0.730
BODY_RADIAL_SCALE = 0.755


def srgb_to_linear_channel(c: float) -> float:
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def srgb_to_linear_rgba(rgb: list[float], alpha: float = 1.0) -> tuple[float, float, float, float]:
    return (
        srgb_to_linear_channel(rgb[0]),
        srgb_to_linear_channel(rgb[1]),
        srgb_to_linear_channel(rgb[2]),
        alpha,
    )


def clear_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh, do_unlink=True)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat, do_unlink=True)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act, do_unlink=True)
    for img in list(bpy.data.images):
        bpy.data.images.remove(img, do_unlink=True)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0


def create_aged_brass_textures(
    base_srgb: list[float],
    roughness_mean: float = 0.34,
    size: int = 256,
    patina_strength: float = 1.0,
) -> tuple[bpy.types.Image, bpy.types.Image]:
    img_color = bpy.data.images.new("brass_basecolor", width=size, height=size, alpha=False)
    img_color.colorspace_settings.name = "sRGB"
    img_mr = bpy.data.images.new("brass_orm", width=size, height=size, alpha=False)
    img_mr.colorspace_settings.name = "Non-Color"

    pixels_c = [0.0] * (size * size * 4)
    pixels_mr = [0.0] * (size * size * 4)
    r0, g0, b0 = base_srgb
    tau = 2.0 * math.pi

    for y in range(size):
        v = y / size
        sv1 = math.sin(tau * (2.0 * v + 0.13))
        sv2 = math.cos(tau * (5.0 * v - 0.27))
        sv3 = math.sin(tau * (11.0 * v + 0.41))
        for x in range(size):
            u = x / size
            su1 = math.cos(tau * (2.0 * u - 0.19))
            su2 = math.sin(tau * (5.0 * u + 0.31))
            su3 = math.cos(tau * (11.0 * u - 0.07))
            diag = math.sin(tau * (3.0 * (u + v) + 0.5))

            n = 0.42 * (su1 * sv1) + 0.33 * (su2 * sv2) + 0.15 * (su3 * sv3) + 0.10 * diag
            dc = 0.075 * patina_strength * n
            r = min(1.0, max(0.0, r0 + dc * 1.05))
            g = min(1.0, max(0.0, g0 + dc * 0.95))
            b = min(1.0, max(0.0, b0 + dc * 0.70))
            dr = -0.105 * patina_strength * n
            rough = min(0.54, max(0.18, roughness_mean + dr))

            idx = (y * size + x) * 4
            pixels_c[idx] = r
            pixels_c[idx + 1] = g
            pixels_c[idx + 2] = b
            pixels_c[idx + 3] = 1.0

            pixels_mr[idx] = 1.0
            pixels_mr[idx + 1] = rough
            pixels_mr[idx + 2] = 0.95
            pixels_mr[idx + 3] = 1.0

    img_color.pixels.foreach_set(pixels_c)
    img_color.pack()
    img_mr.pixels.foreach_set(pixels_mr)
    img_mr.pack()
    return img_color, img_mr


def build_materials(mat_sheet: dict) -> dict[str, bpy.types.Material]:
    roles = mat_sheet["roles"]
    out: dict[str, bpy.types.Material] = {}

    brass_cfg = roles["brass"]
    mat_brass = bpy.data.materials.new("brass_aged" if TEXTURED_BRASS else "brass_glossy")
    nt = mat_brass.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = srgb_to_linear_rgba(BRASS_SRGB)
    bsdf.inputs["Metallic"].default_value = float(brass_cfg["metallic_target"])
    bsdf.inputs["Roughness"].default_value = float(BRASS_ROUGHNESS)

    if TEXTURED_BRASS:
        img_c, img_mr = create_aged_brass_textures(
            BRASS_SRGB,
            roughness_mean=float(BRASS_ROUGHNESS),
            size=256,
            patina_strength=PATINA_STRENGTH,
        )
        tex_c = nt.nodes.new("ShaderNodeTexImage")
        tex_c.image = img_c
        tex_c.location = (-500, 300)
        nt.links.new(tex_c.outputs["Color"], bsdf.inputs["Base Color"])

        tex_mr = nt.nodes.new("ShaderNodeTexImage")
        tex_mr.image = img_mr
        tex_mr.location = (-500, 0)
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (-220, 0)
        nt.links.new(tex_mr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    out["brass"] = mat_brass

    glass_cfg = roles["glass"]
    mat_glass = bpy.data.materials.new("glass_pane")
    bsdf_g = mat_glass.node_tree.nodes["Principled BSDF"]
    bsdf_g.inputs["Base Color"].default_value = srgb_to_linear_rgba(glass_cfg["base_color_srgb"])
    bsdf_g.inputs["Metallic"].default_value = 0.0
    bsdf_g.inputs["Roughness"].default_value = float(glass_cfg["roughness_target"])
    bsdf_g.inputs["Transmission Weight"].default_value = float(glass_cfg["transmission_target"])
    bsdf_g.inputs["IOR"].default_value = float(glass_cfg["ior_target"])
    out["glass"] = mat_glass

    wax_cfg = roles["wax"]
    mat_wax = bpy.data.materials.new("wax_candle")
    bsdf_w = mat_wax.node_tree.nodes["Principled BSDF"]
    bsdf_w.inputs["Base Color"].default_value = srgb_to_linear_rgba(wax_cfg["base_color_srgb"])
    bsdf_w.inputs["Metallic"].default_value = 0.0
    bsdf_w.inputs["Roughness"].default_value = float(wax_cfg["roughness_target"])
    out["wax"] = mat_wax

    flame_cfg = roles["flame"]
    mat_flame = bpy.data.materials.new("flame_emissive")
    bsdf_f = mat_flame.node_tree.nodes["Principled BSDF"]
    bsdf_f.inputs["Base Color"].default_value = srgb_to_linear_rgba(flame_cfg["base_color_srgb"])
    bsdf_f.inputs["Metallic"].default_value = 0.0
    bsdf_f.inputs["Roughness"].default_value = float(flame_cfg["roughness_target"])
    bsdf_f.inputs["Emission Color"].default_value = srgb_to_linear_rgba(flame_cfg["emission_color_srgb"])
    bsdf_f.inputs["Emission Strength"].default_value = float(flame_cfg["emission_strength_target"])
    out["flame"] = mat_flame

    return out


def hex_corner_xy(i: int, radius_m: float, sides: int = 6) -> tuple[float, float]:
    angle = -math.pi / 2.0 - math.pi / sides + i * (2.0 * math.pi / sides)
    return (radius_m * math.cos(angle), radius_m * math.sin(angle))


def add_prism_frustum(
    bm: bmesh.types.BMesh,
    sides: int,
    r_bot: float,
    r_top: float,
    z_bot: float,
    z_top: float,
) -> None:
    v_bot = [bm.verts.new((*hex_corner_xy(i, r_bot, sides), z_bot)) for i in range(sides)]
    v_top = [bm.verts.new((*hex_corner_xy(i, r_top, sides), z_top)) for i in range(sides)]
    bm.faces.new(list(reversed(v_bot)))
    bm.faces.new(v_top)
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new([v_bot[i], v_bot[j], v_top[j], v_top[i]])


def add_oriented_box(
    bm: bmesh.types.BMesh,
    p0: Vector,
    p1: Vector,
    width: float,
    height: float,
    up_hint: Vector = Vector((0.0, 0.0, 1.0)),
) -> None:
    axis = p1 - p0
    length = axis.length
    if length < 1e-7:
        return
    fwd = axis / length
    if abs(fwd.dot(up_hint)) > 0.99:
        up_hint = Vector((0.0, 1.0, 0.0))
    right = fwd.cross(up_hint).normalized()
    up = right.cross(fwd).normalized()

    hw = width * 0.5
    hh = height * 0.5
    offsets = [
        -hw * right - hh * up,
        hw * right - hh * up,
        hw * right + hh * up,
        -hw * right + hh * up,
    ]
    v0 = [bm.verts.new(p0 + off) for off in offsets]
    v1 = [bm.verts.new(p1 + off) for off in offsets]
    bm.faces.new(list(reversed(v0)))
    bm.faces.new(v1)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new([v0[i], v0[j], v1[j], v1[i]])


def add_closed_torus(
    bm: bmesh.types.BMesh,
    center: Vector,
    major_r: float,
    minor_r: float,
    major_segs: int = 44,
    minor_segs: int = 16,
    scale_factor: float = 1.0,
) -> None:
    R = major_r * scale_factor
    r = minor_r * scale_factor
    ring_verts = []
    tau = 2.0 * math.pi
    for i in range(major_segs):
        theta = tau * i / major_segs
        ct, st = math.cos(theta), math.sin(theta)
        loop = []
        for j in range(minor_segs):
            phi = tau * j / minor_segs
            cp, sp = math.cos(phi), math.sin(phi)
            radial = R + r * cp
            pt = Vector((radial * ct, r * sp, radial * st)) + center
            loop.append(bm.verts.new(pt))
        ring_verts.append(loop)

    for i in range(major_segs):
        i_next = (i + 1) % major_segs
        for j in range(minor_segs):
            j_next = (j + 1) % minor_segs
            bm.faces.new([
                ring_verts[i][j],
                ring_verts[i_next][j],
                ring_verts[i_next][j_next],
                ring_verts[i][j_next],
            ])


def finalize_bmesh(
    bm: bmesh.types.BMesh,
    bevel_offset_m: float = 0.0,
    bevel_segments: int = 0,
    subdivide_cuts: int = 0,
    uv_slot: tuple[int, int] | None = None,
) -> None:
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if bevel_offset_m > 0.0 and bevel_segments > 0:
        sharp = [
            e
            for e in bm.edges
            if len(e.link_faces) == 2
            and e.link_faces[0].normal.angle(e.link_faces[1].normal, 0.0) > math.radians(40.0)
        ]
        if sharp:
            bmesh.ops.bevel(
                bm,
                geom=sharp,
                offset=bevel_offset_m,
                offset_type="OFFSET",
                segments=bevel_segments,
                profile=0.5,
                affect="EDGES",
                clamp_overlap=True,
            )

    if subdivide_cuts > 0:
        bmesh.ops.subdivide_edges(
            bm,
            edges=list(bm.edges),
            cuts=subdivide_cuts,
            use_grid_fill=True,
        )

    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=list(bm.edges))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if uv_slot is not None and TEXTURED_BRASS:
        slot_idx, total_slots = uv_slot
        uv_layer = bm.loops.layers.uv.verify()
        faces = list(bm.faces)
        n_faces = max(1, len(faces))
        cols = max(1, int(math.ceil(math.sqrt(n_faces))))
        rows = max(1, int(math.ceil(n_faces / cols)))

        band_w = 1.0 / max(1, total_slots)
        u_band0 = slot_idx * band_w
        cell_du = band_w / cols
        cell_dv = 1.0 / rows
        pad_u = cell_du * 0.08
        pad_v = cell_dv * 0.08

        for f_idx, f in enumerate(faces):
            c = f_idx % cols
            r = f_idx // cols
            u0 = u_band0 + c * cell_du + pad_u
            v0 = r * cell_dv + pad_v
            du = max(1e-5, cell_du - 2.0 * pad_u)
            dv = max(1e-5, cell_dv - 2.0 * pad_v)

            n = f.normal
            ref = Vector((0.0, 0.0, 1.0)) if abs(n.z) < 0.9 else Vector((1.0, 0.0, 0.0))
            t1 = n.cross(ref).normalized()
            t2 = n.cross(t1).normalized()

            pts2d = [Vector((loop.vert.co.dot(t1), loop.vert.co.dot(t2))) for loop in f.loops]
            xs = [p.x for p in pts2d]
            ys = [p.y for p in pts2d]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            span = max(1e-5, max(max_x - min_x, max_y - min_y))

            for loop, p in zip(f.loops, pts2d):
                lu = (p.x - min_x) / span
                lv = (p.y - min_y) / span
                loop[uv_layer].uv = (u0 + lu * du, v0 + lv * dv)


def create_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    parent: bpy.types.Object,
    material: bpy.types.Material,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    smooth_shading: bool = True,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = smooth_shading
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = Vector(location)
    obj.scale = Vector((1.0, 1.0, 1.0))
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    return obj


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

    bp_dir = Path(args.blueprint).resolve()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    params = json.loads((bp_dir / "dimensions.json").read_text(encoding="utf-8"))
    mat_sheet = json.loads((bp_dir / "materials.json").read_text(encoding="utf-8"))

    clear_scene()
    materials = build_materials(mat_sheet)

    mm = 0.001
    sides = int(params["sides"])
    r_in = float(params["r_in_mm"]) * mm * BODY_RADIAL_SCALE
    r_out = float(params["r_out_mm"]) * mm * BODY_RADIAL_SCALE
    base_r_out = float(params["base_r_out_mm"]) * mm * ROOF_EAVE_SCALE
    roof_r_out = float(params["roof_r_out_mm"]) * mm * ROOF_EAVE_SCALE

    foot_h = float(params["foot_height_mm"]) * mm
    base_top_z = float(params["base_top_z_mm"]) * mm
    body_top_z = float(params["body_top_z_mm"]) * mm
    bar_w = (float(params["frame_bar_mm"]) + 1.4) * mm
    bev_m = BEVEL_OFFSET_MM * mm

    lantern_root = bpy.data.objects.new("Lantern", None)
    lantern_root.location = Vector((0.0, 0.0, 0.0))
    lantern_root.scale = Vector((1.0, 1.0, 1.0))
    bpy.context.collection.objects.link(lantern_root)

    # 1. Base
    bm_base = bmesh.new()
    for i in range(sides):
        cx, cy = hex_corner_xy(i, base_r_out - 0.006, sides)
        add_oriented_box(bm_base, Vector((cx, cy, 0.0)), Vector((cx, cy, foot_h)), 0.012, 0.012, Vector((1.0, 0.0, 0.0)))
    add_prism_frustum(bm_base, sides, base_r_out, r_out + 0.002, foot_h, base_top_z)
    finalize_bmesh(bm_base, bevel_offset_m=bev_m, bevel_segments=BEVEL_SEGMENTS, subdivide_cuts=SUBDIVIDE_CUTS_SECONDARY, uv_slot=(0, 5))
    create_mesh_object("Base", bm_base, lantern_root, materials["brass"], smooth_shading=True)

    # 2. Frame
    bm_frame = bmesh.new()
    for i in range(sides):
        cx, cy = hex_corner_xy(i, r_out, sides)
        add_oriented_box(bm_frame, Vector((cx, cy, base_top_z)), Vector((cx, cy, body_top_z)), bar_w, bar_w, Vector((1.0, 0.0, 0.0)))

    rail_offset = bar_w * 0.72
    for i in range(sides):
        j = (i + 1) % sides
        p_i = Vector((*hex_corner_xy(i, r_out, sides), 0.0))
        p_j = Vector((*hex_corner_xy(j, r_out, sides), 0.0))
        edge_dir = (p_j - p_i).normalized()
        p0_xy = p_i + edge_dir * rail_offset
        p1_xy = p_j - edge_dir * rail_offset
        add_oriented_box(bm_frame, Vector((p0_xy.x, p0_xy.y, base_top_z + bar_w * 0.5)), Vector((p1_xy.x, p1_xy.y, base_top_z + bar_w * 0.5)), bar_w, bar_w, Vector((0.0, 0.0, 1.0)))
        add_oriented_box(bm_frame, Vector((p0_xy.x, p0_xy.y, body_top_z - bar_w * 0.5)), Vector((p1_xy.x, p1_xy.y, body_top_z - bar_w * 0.5)), bar_w, bar_w, Vector((0.0, 0.0, 1.0)))

    finalize_bmesh(bm_frame, bevel_offset_m=bev_m, bevel_segments=BEVEL_SEGMENTS, subdivide_cuts=SUBDIVIDE_CUTS_MAIN, uv_slot=(1, 5))
    frame_obj = create_mesh_object("Frame", bm_frame, lantern_root, materials["brass"], smooth_shading=True)

    # 3. Roof
    bm_roof = bmesh.new()
    z1 = body_top_z + float(params["roof_tier1_height_mm"]) * mm
    z2 = z1 + float(params["roof_tier2_height_mm"]) * mm
    z3 = float(params["roof_top_z_mm"]) * mm
    add_prism_frustum(bm_roof, sides, roof_r_out, roof_r_out * 0.55, body_top_z, z2)
    add_prism_frustum(bm_roof, sides, roof_r_out * 0.52, roof_r_out * 0.22, z2, z3)
    finalize_bmesh(bm_roof, bevel_offset_m=bev_m, bevel_segments=BEVEL_SEGMENTS, subdivide_cuts=SUBDIVIDE_CUTS_MAIN, uv_slot=(2, 5))
    create_mesh_object("Roof", bm_roof, lantern_root, materials["brass"], smooth_shading=True)

    # 4. Handle
    bm_handle = bmesh.new()
    major_r = (float(params["handle_ring_inner_d_mm"]) + float(params["handle_ring_wire_d_mm"])) * 0.5 * mm
    minor_r = float(params["handle_ring_wire_d_mm"]) * 0.5 * mm
    ring_center_z = z3 + major_r * HANDLE_SCALE
    add_closed_torus(bm_handle, Vector((0.0, 0.0, ring_center_z)), major_r, minor_r, major_segs=44, minor_segs=16, scale_factor=HANDLE_SCALE)
    finalize_bmesh(bm_handle, bevel_offset_m=0.0, bevel_segments=0, subdivide_cuts=SUBDIVIDE_CUTS_SECONDARY, uv_slot=(3, 5))
    create_mesh_object("Handle", bm_handle, lantern_root, materials["brass"], smooth_shading=True)

    # 5. Glass
    bm_glass = bmesh.new()
    pane_t = float(params["glass_pane_thickness_mm"]) * mm
    pane_z0 = base_top_z + bar_w + 0.001
    pane_z1 = body_top_z - bar_w - 0.001
    pane_h = pane_z1 - pane_z0
    pane_zc = 0.5 * (pane_z0 + pane_z1)
    for i in range(1, sides):
        j = (i + 1) % sides
        p_i = Vector((*hex_corner_xy(i, r_out, sides), pane_zc))
        p_j = Vector((*hex_corner_xy(j, r_out, sides), pane_zc))
        edge_dir = (p_j - p_i).normalized()
        inset = bar_w * 0.78
        add_oriented_box(bm_glass, p_i + edge_dir * inset, p_j - edge_dir * inset, pane_t, pane_h, Vector((0.0, 0.0, 1.0)))
    finalize_bmesh(bm_glass, bevel_offset_m=0.0, bevel_segments=0, subdivide_cuts=SUBDIVIDE_CUTS_SECONDARY, uv_slot=None)
    create_mesh_object("Glass", bm_glass, lantern_root, materials["glass"], smooth_shading=False)

    # 6. Candle
    bm_candle = bmesh.new()
    candle_r = float(params["candle_diameter_mm"]) * 0.5 * mm
    candle_z0 = base_top_z
    candle_z1 = candle_z0 + float(params["candle_height_mm"]) * mm
    add_prism_frustum(bm_candle, 16, candle_r, candle_r * 0.95, candle_z0, candle_z1)
    finalize_bmesh(bm_candle, bevel_offset_m=0.0, bevel_segments=0, subdivide_cuts=SUBDIVIDE_CUTS_SECONDARY, uv_slot=None)
    create_mesh_object("Candle", bm_candle, lantern_root, materials["wax"], smooth_shading=True)

    # 7. Flame
    bm_flame = bmesh.new()
    flame_z0 = float(params["flame_base_z_mm"]) * mm
    flame_h = float(params["flame_height_mm"]) * mm
    flame_r = float(params["flame_radius_mm"]) * mm
    add_prism_frustum(bm_flame, 12, flame_r * 0.45, flame_r, flame_z0, flame_z0 + flame_h * 0.45)
    add_prism_frustum(bm_flame, 12, flame_r, flame_r * 0.12, flame_z0 + flame_h * 0.45, flame_z0 + flame_h)
    finalize_bmesh(bm_flame, bevel_offset_m=0.0, bevel_segments=0, uv_slot=None)
    flame_obj = create_mesh_object("Flame", bm_flame, lantern_root, materials["flame"], smooth_shading=True)
    flame_obj.visible_shadow = False

    # 8. Door
    hinge_x = float(params["door_hinge_line_xy_mm"][0]) * mm
    hinge_y = (float(params["door_hinge_line_xy_mm"][1]) + DOOR_HINGE_Y_OFFSET_MM) * mm
    hinge_z = float(params["door_pivot_mm"][2]) * mm
    pivot = Vector((hinge_x, hinge_y, hinge_z))

    door_x0 = (-0.038 * BODY_RADIAL_SCALE + 0.004) - pivot.x
    door_x1 = (0.038 * BODY_RADIAL_SCALE - 0.004) - pivot.x
    door_y = (-r_in - 0.005) - pivot.y
    door_z0 = (base_top_z + bar_w + 0.005) - pivot.z
    door_z1 = (body_top_z - bar_w - 0.005) - pivot.z
    d_bar = 0.005

    bm_door = bmesh.new()
    add_oriented_box(bm_door, Vector((door_x0 + d_bar * 0.5, door_y, door_z0)), Vector((door_x0 + d_bar * 0.5, door_y, door_z1)), d_bar, d_bar, Vector((1.0, 0.0, 0.0)))
    add_oriented_box(bm_door, Vector((door_x1 - d_bar * 0.5, door_y, door_z0)), Vector((door_x1 - d_bar * 0.5, door_y, door_z1)), d_bar, d_bar, Vector((1.0, 0.0, 0.0)))
    add_oriented_box(bm_door, Vector((door_x0 + d_bar, door_y, door_z0 + d_bar * 0.5)), Vector((door_x1 - d_bar, door_y, door_z0 + d_bar * 0.5)), d_bar, d_bar, Vector((0.0, 0.0, 1.0)))
    add_oriented_box(bm_door, Vector((door_x0 + d_bar, door_y, door_z1 - d_bar * 0.5)), Vector((door_x1 - d_bar, door_y, door_z1 - d_bar * 0.5)), d_bar, d_bar, Vector((0.0, 0.0, 1.0)))
    finalize_bmesh(bm_door, bevel_offset_m=bev_m * 0.75, bevel_segments=BEVEL_SEGMENTS, subdivide_cuts=SUBDIVIDE_CUTS_SECONDARY, uv_slot=(4, 5))
    door_obj = create_mesh_object("Door", bm_door, frame_obj, materials["brass"], location=(pivot.x, pivot.y, pivot.z), smooth_shading=True)

    # 9. Door_Glass
    bm_dglass = bmesh.new()
    dg_x0 = door_x0 + d_bar
    dg_x1 = door_x1 - d_bar
    dg_h = (door_z1 - door_z0) - 2.0 * d_bar
    dg_zc = 0.5 * (door_z0 + door_z1)
    add_oriented_box(bm_dglass, Vector((dg_x0, door_y, dg_zc)), Vector((dg_x1, door_y, dg_zc)), pane_t, dg_h, Vector((0.0, 0.0, 1.0)))
    finalize_bmesh(bm_dglass, bevel_offset_m=0.0, bevel_segments=0, uv_slot=None)
    create_mesh_object("Door_Glass", bm_dglass, door_obj, materials["glass"], location=(0.0, 0.0, 0.0), smooth_shading=False)

    # 10. Hinge Action `door_open`
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 30
    door_obj.rotation_mode = "XYZ"
    scene.frame_set(1)
    door_obj.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
    door_obj.keyframe_insert(data_path="rotation_euler", frame=1)
    scene.frame_set(30)
    door_obj.rotation_euler = Euler((0.0, 0.0, -math.radians(DOOR_OPEN_DEG)), "XYZ")
    door_obj.keyframe_insert(data_path="rotation_euler", frame=30)
    if door_obj.animation_data and door_obj.animation_data.action:
        door_obj.animation_data.action.name = "door_open"

    scene.frame_set(1)
    bpy.context.view_layer.update()

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / "lantern.glb"),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_animations=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
