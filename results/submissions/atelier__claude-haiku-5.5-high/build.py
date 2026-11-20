"""
Procedural build of the Museum Lantern (room `atelier`).

Run headless:
    blender -b --factory-startup --python build.py -- --blueprint blueprint/ --out out/

All geometry is generated here from the numbers in blueprint/ (dimensions, materials,
parts). Units: the script works in millimetres and converts to metres (scene scale 1.0).
Output: out/lantern.blend (rest pose at frame 1) and out/lantern.glb (glTF 2.0 binary).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy

MM = 0.001  # millimetre -> metre
COS30 = math.cos(math.radians(30.0))

# ---------------------------------------------------------------------------
# Blueprint numbers (mm). Source: blueprint/dimensions.json, verified against the
# three orthographic silhouettes (front/side/top) in blueprint/.
# ---------------------------------------------------------------------------
BODY_R_OUT = 92.376          # body hex circumradius (vertices on +/-X), apothem 80
BODY_APO = 80.0
POST = 8.0                   # frame bar section (square)
BODY_BOTTOM_Z = 40.0         # base top / frame bottom
BODY_TOP_Z = 280.0           # body top / roof bottom
RAIL_BOTTOM = (40.5, 48.5)   # bottom rail z-range (kept 0.5 mm off the post faces)
RAIL_TOP = (271.5, 279.5)    # top rail z-range
GLASS_Z = (48.5, 271.5)      # glass pane z-range (between rails)
PANE_T = 2.0                 # glass pane physical thickness
PANE_APO = 79.0              # pane centre apothem (78..80)
PANE_HALF_W = 42.19          # pane half width (between the corner posts)

BASE_TOP_Z = 40.0
FOOT_H = 14.0                # feet 0..14 (12 mm tall visible + 2 mm overlap into plinth)
BASE_R_OUT = 101.6136        # base hex circumradius (apothem 88 at the bottom)
BASE_PROFILE = [             # (z, apothem)  footed plinth, tapers toward the body
    (12.0, 88.0),
    (25.0, 86.2),
    (29.0, 84.0),
    (BASE_TOP_Z, 82.5),
]
FOOT_SIZE = 12.0

ROOF_PROFILE = [             # (z, apothem) stepped hex roof: tier1, tier2, cap
    (280.0, 90.0),
    (308.0, 66.0),
    (334.0, 33.5),
    (350.0, 19.5),
]

HANDLE_CENTER = (0.0, 0.0, 382.0)
HANDLE_MAJOR_R = 32.0        # (56 + 72) / 4
HANDLE_MINOR_R = 4.0         # 8 mm wire

CANDLE_R = 18.0
CANDLE_Z = (BODY_BOTTOM_Z, 135.0)   # 95 mm tall, base at z=40
FLAME_PROFILE = [            # (z, radius) teardrop, z 136..152, r 4.5
    (136.0, 0.0),
    (137.5, 3.0),
    (140.0, 4.5),
    (144.0, 4.3),
    (148.0, 3.0),
    (152.0, 0.0),
]

DOOR_PIVOT = (-38.0, -80.0, 160.0)   # hinge line on the front (-Y) face, left side
DOOR_OUTER_X = (-40.0, 40.0)
DOOR_OUTER_Z = (48.5, 271.5)
DOOR_INNER_X = (-32.0, 32.0)         # 8 mm brass bars around the glass
DOOR_INNER_Z = (56.5, 263.5)
DOOR_Y = (-82.0, -78.0)              # door leaf thickness
DOOR_GLASS_Y = (-80.0, -78.0)
DOOR_OPEN_RAD = -math.pi / 2.0       # 90 deg outward (toward -Y) about Z
DOOR_FRAMES = 30

# Materials (blueprint/materials.json). Swatches are sRGB; Blender wants linear.
BRASS_SRGB = (0.758, 0.62, 0.345)
GLASS_SRGB = (0.885, 0.918, 0.922)
WAX_SRGB = (0.882, 0.835, 0.728)
FLAME_SRGB = (0.99, 0.725, 0.24)

BOX_FACES = [
    [0, 3, 2, 1],  # bottom
    [4, 5, 6, 7],  # top
    [0, 1, 5, 4],  # -y
    [1, 2, 6, 5],  # +x
    [2, 3, 7, 6],  # +y
    [3, 0, 4, 7],  # -x
]


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


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_radius(apothem: float) -> float:
    return apothem / COS30


class MeshBuilder:
    """Collects closed shells (vertices in mm, faces as index lists)."""

    def __init__(self) -> None:
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[list[int]] = []

    def _add_box_corners(self, corners: list[tuple[float, float, float]]) -> None:
        base = len(self.verts)
        self.verts.extend(corners)
        for f in BOX_FACES:
            self.faces.append([base + i for i in f])

    def box(self, x0, x1, y0, y1, z0, z1) -> None:
        self._add_box_corners(
            [
                (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
            ]
        )

    def oriented_box(self, cx, cy, ang, hx, hy, z0, z1) -> None:
        """Box whose local x axis is rotated by `ang` (radians) about Z."""
        ca, sa = math.cos(ang), math.sin(ang)
        plan = []
        for u, v in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
            plan.append((cx + u * ca - v * sa, cy + u * sa + v * ca))
        self._add_box_corners(
            [(x, y, z0) for x, y in plan] + [(x, y, z1) for x, y in plan]
        )

    def lathe(self, profile, sides, circum=False, rot=0.0) -> None:
        """Revolve a (z, radius) profile around Z. Radius 0 = a pole vertex.
        circum=True means the radius is an apothem of a hexagon (converted)."""
        rings = []
        for z, r in profile:
            if r <= 1e-9:
                rings.append(("pole", self._vert((0.0, 0.0, z))))
                continue
            rad = hex_radius(r) if circum else r
            idx = []
            for k in range(sides):
                a = rot + 2.0 * math.pi * k / sides
                idx.append(self._vert((rad * math.cos(a), rad * math.sin(a), z)))
            rings.append(("ring", idx))
        for (ka, a), (kb, b) in zip(rings, rings[1:]):
            if ka == "ring" and kb == "ring":
                n = len(a)
                for k in range(n):
                    k2 = (k + 1) % n
                    self.faces.append([a[k], a[k2], b[k2], b[k]])
            elif ka == "pole" and kb == "ring":
                n = len(b)
                for k in range(n):
                    self.faces.append([a, b[k], b[(k + 1) % n]])
            elif ka == "ring" and kb == "pole":
                n = len(a)
                for k in range(n):
                    self.faces.append([a[k], a[(k + 1) % n], b])
        first, last = rings[0], rings[-1]
        if first[0] == "ring":
            self.faces.append(list(reversed(first[1])))
        if last[0] == "ring":
            self.faces.append(list(last[1]))

    def torus(self, center, major, minor, nu, nv) -> None:
        cx, cy, cz = center
        grid = []
        for i in range(nu):
            u = 2.0 * math.pi * i / nu
            row = []
            for j in range(nv):
                v = 2.0 * math.pi * j / nv
                rad = major + minor * math.cos(v)
                row.append(
                    self._vert((cx + rad * math.cos(u), cy + minor * math.sin(v), cz + rad * math.sin(u)))
                )
            grid.append(row)
        for i in range(nu):
            i2 = (i + 1) % nu
            for j in range(nv):
                j2 = (j + 1) % nv
                self.faces.append([grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]])

    def frame_prism(self, outer, inner, y0, y1) -> None:
        """Rectangular ring (annulus) extruded along Y. outer/inner: 4 (x, z) points, same order."""
        ov0 = [self._vert((x, y0, z)) for x, z in outer]
        ov1 = [self._vert((x, y1, z)) for x, z in outer]
        iv0 = [self._vert((x, y0, z)) for x, z in inner]
        iv1 = [self._vert((x, y1, z)) for x, z in inner]
        for k in range(4):
            k2 = (k + 1) % 4
            self.faces.append([ov0[k], ov0[k2], ov1[k2], ov1[k]])
            self.faces.append([iv0[k], iv1[k], iv1[k2], iv0[k2]])
            self.faces.append([ov0[k], iv0[k], iv0[k2], ov0[k2]])
            self.faces.append([ov1[k], ov1[k2], iv1[k2], iv1[k]])

    def _vert(self, p) -> int:
        self.verts.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.verts) - 1


def make_material(name, base_srgb, metallic=0.0, roughness=0.5,
                  transmission=None, ior=None, emission=None, emission_strength=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def setin(names, value):
        for nm in names:
            if nm in bsdf.inputs:
                bsdf.inputs[nm].default_value = value
                return

    setin(["Base Color"], tuple(srgb_to_linear(c) for c in base_srgb) + (1.0,))
    setin(["Metallic"], metallic)
    setin(["Roughness"], roughness)
    if transmission is not None:
        setin(["Transmission Weight", "Transmission"], transmission)
    if ior is not None:
        setin(["IOR"], ior)
    if emission is not None:
        setin(["Emission Color"], tuple(srgb_to_linear(c) for c in emission) + (1.0,))
        setin(["Emission Strength"], emission_strength)
    return mat


def build_object(name, builder, material, offset_mm=(0.0, 0.0, 0.0),
                 bevel_mm=0.0, smooth=False, parent=None, location_mm=(0.0, 0.0, 0.0)):
    """Turn a MeshBuilder into a Blender object. Coordinates are shifted by offset_mm
    (so child parts can use parent-local space) and converted to metres."""
    ox, oy, oz = offset_mm
    mesh = bpy.data.meshes.new(name + "_mesh")
    bm = bmesh.new()
    bverts = [
        bm.verts.new(((x - ox) * MM, (y - oy) * MM, (z - oz) * MM))
        for x, y, z in builder.verts
    ]
    for f in builder.faces:
        bm.faces.new([bverts[i] for i in f])
    bm.verts.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel_mm > 0.0:
        bmesh.ops.bevel(
            bm,
            geom=bm.edges[:],
            offset=bevel_mm * MM,
            offset_type="OFFSET",
            segments=2,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.smooth = smooth and len(f.verts) <= 4
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    mesh.materials.append(material)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = tuple(c * MM for c in location_mm)
    if parent is not None:
        obj.parent = parent
    return obj


def mesh_stats(obj) -> tuple[int, int]:
    """Return (non-manifold edge count, triangle count) for diagnostics."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bad = sum(1 for e in bm.edges if not e.is_manifold)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    bm.free()
    return bad, tris


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Clean factory scene (remove default cube/light/camera).
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh, do_unlink=True)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0

    # Materials: role prefixes brass_ / glass_ / wax_ / flame_.
    mat_brass = make_material("brass_metal", BRASS_SRGB, metallic=0.95, roughness=0.34)
    mat_glass = make_material("glass_pane", GLASS_SRGB, metallic=0.0, roughness=0.05,
                              transmission=0.95, ior=1.5)
    mat_wax = make_material("wax_candle", WAX_SRGB, metallic=0.0, roughness=0.5)
    mat_flame = make_material("flame_emissive", FLAME_SRGB, metallic=0.0, roughness=0.4,
                              emission=FLAME_SRGB, emission_strength=8.0)

    # Root: Lantern empty at world origin (bottom centre of the base, z = 0).
    root = bpy.data.objects.new("Lantern", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.1
    bpy.context.collection.objects.link(root)

    # --- Frame: corner posts + top/bottom rails on the body hex --------------
    frame_b = MeshBuilder()
    corner_angles = [60.0 * i for i in range(6)]
    for a in corner_angles:
        cx = BODY_R_OUT * math.cos(math.radians(a))
        cy = BODY_R_OUT * math.sin(math.radians(a))
        frame_b.box(cx - POST / 2, cx + POST / 2, cy - POST / 2, cy + POST / 2,
                    BODY_BOTTOM_Z, BODY_TOP_Z)
    half_edge = BODY_R_OUT / 2.0  # hex side length = circumradius
    for i in range(6):
        phi = math.radians(30.0 + 60.0 * i)           # apothem direction of face i
        mx, my = BODY_APO * math.cos(phi), BODY_APO * math.sin(phi)
        for z0, z1 in (RAIL_BOTTOM, RAIL_TOP):
            frame_b.oriented_box(mx, my, phi + math.pi / 2, half_edge, POST / 2, z0, z1)
    frame = build_object("Frame", frame_b, mat_brass, bevel_mm=0.5, parent=root)

    # --- Door (child of Frame), pivot on the left hinge of the front face ----
    pivot = DOOR_PIVOT
    door_b = MeshBuilder()
    door_b.frame_prism(
        [(DOOR_OUTER_X[0], DOOR_OUTER_Z[0]), (DOOR_OUTER_X[1], DOOR_OUTER_Z[0]),
         (DOOR_OUTER_X[1], DOOR_OUTER_Z[1]), (DOOR_OUTER_X[0], DOOR_OUTER_Z[1])],
        [(DOOR_INNER_X[0], DOOR_INNER_Z[0]), (DOOR_INNER_X[1], DOOR_INNER_Z[0]),
         (DOOR_INNER_X[1], DOOR_INNER_Z[1]), (DOOR_INNER_X[0], DOOR_INNER_Z[1])],
        DOOR_Y[0], DOOR_Y[1],
    )
    door = build_object("Door", door_b, mat_brass, offset_mm=pivot, bevel_mm=0.5,
                        parent=frame, location_mm=pivot)

    door_glass_b = MeshBuilder()
    door_glass_b.box(DOOR_INNER_X[0], DOOR_INNER_X[1], DOOR_GLASS_Y[0], DOOR_GLASS_Y[1],
                     DOOR_INNER_Z[0], DOOR_INNER_Z[1])
    door_glass = build_object("Door_Glass", door_glass_b, mat_glass, offset_mm=pivot,
                              parent=door, location_mm=(0.0, 0.0, 0.0))

    # --- Roof: stepped hex roof (lathe over hex sides) -----------------------
    roof_b = MeshBuilder()
    roof_b.lathe(ROOF_PROFILE, 6, circum=True)
    roof = build_object("Roof", roof_b, mat_brass, bevel_mm=0.5, parent=root)

    # --- Base: six 12 mm feet + footed hex plinth ---------------------------
    base_b = MeshBuilder()
    for i in range(6):
        a = math.radians(60.0 * i)
        rc = BASE_R_OUT - FOOT_SIZE / 2.0
        cx, cy = rc * math.cos(a), rc * math.sin(a)
        base_b.box(cx - FOOT_SIZE / 2, cx + FOOT_SIZE / 2, cy - FOOT_SIZE / 2, cy + FOOT_SIZE / 2,
                   0.0, FOOT_H)
    base_b.lathe(BASE_PROFILE, 6, circum=True)
    base = build_object("Base", base_b, mat_brass, bevel_mm=0.5, parent=root)

    # --- Handle: ring in the XZ plane, centre (0, 0, 382) -------------------
    handle_b = MeshBuilder()
    handle_b.torus(HANDLE_CENTER, HANDLE_MAJOR_R, HANDLE_MINOR_R, 48, 16)
    handle = build_object("Handle", handle_b, mat_brass, smooth=True, parent=root)

    # --- Glass: five static panes (the front face is the door) -------------
    glass_b = MeshBuilder()
    for deg in (30.0, 90.0, 150.0, 210.0, 330.0):
        phi = math.radians(deg)
        glass_b.oriented_box(PANE_APO * math.cos(phi), PANE_APO * math.sin(phi),
                             phi + math.pi / 2, PANE_HALF_W, PANE_T / 2, GLASS_Z[0], GLASS_Z[1])
    glass = build_object("Glass", glass_b, mat_glass, parent=root)

    # --- Candle: 36 mm cylinder, z 40..135 ----------------------------------
    candle_b = MeshBuilder()
    candle_b.lathe([(CANDLE_Z[0], CANDLE_R), (CANDLE_Z[1], CANDLE_R)], 32)
    candle = build_object("Candle", candle_b, mat_wax, smooth=True, parent=root)

    # --- Flame: emissive teardrop above the candle, z 136..152 --------------
    flame_b = MeshBuilder()
    flame_b.lathe(FLAME_PROFILE, 16)
    flame = build_object("Flame", flame_b, mat_flame, smooth=True, parent=root)
    try:
        flame.visible_shadow = False  # keep the emitter from shadowing the glass
    except (AttributeError, TypeError):
        pass

    # --- Door rig: rotate about Z at the hinge line, 0 -> -90 deg -------------
    door.rotation_euler = (0.0, 0.0, 0.0)
    door.keyframe_insert(data_path="rotation_euler", index=2, frame=1)
    door.rotation_euler = (0.0, 0.0, DOOR_OPEN_RAD)
    door.keyframe_insert(data_path="rotation_euler", index=2, frame=DOOR_FRAMES)
    door.animation_data.action.name = "door_open"
    door.rotation_euler = (0.0, 0.0, 0.0)

    scene.frame_start = 1
    scene.frame_end = DOOR_FRAMES
    scene.frame_set(1)

    # Diagnostics (non-fatal): manifold + triangle counts per part.
    for ob in (frame, door, door_glass, roof, base, handle, glass, candle, flame):
        bad, tris = mesh_stats(ob)
        print(f"[build] {ob.name}: non_manifold_edges={bad} triangles={tris}")

    bpy.ops.wm.save_as_mainfile(filepath=str(out_dir / "lantern.blend"), compress=False)
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / "lantern.glb"),
        export_format="GLB",
        export_yup=True,
        export_animations=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
