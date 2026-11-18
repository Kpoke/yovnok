"""
YOVNOK's own cars: original bodies, modelled here. The look is 1970s-80s street
machines, battle-prepped (user, 2026-11-15): flat panels and sharp edges, body-coloured
pillars, round lamps in a grille, chrome bumpers, a roof rack and rally lamps.

    blender -b --python scripts/blender/cars.py -- <out dir> [design ...] [--render]
    blender -b --python scripts/blender/cars.py -- assets-src/vehicles --game suv-sport

Each design is a set of stations along the car (a cross-section every so often),
lofted into a body and a greenhouse with crisp, lightly bevelled edges, with the wheel
arches cut out and the details (lamps, grille, bumpers, bull bar, roof rack, mirrors,
wheels) added from simple shapes. No real-world model is copied.

In Blender the car points along +Y and up is +Z; the glTF exporter turns that
into the game's axes (-Z forward, +Y up). Sizes come from VEHICLE_CLASSES in
src/shared/config.ts: the body's box is centred `rideHeight` above the ground.

With --render it also writes three stills per design (front and rear three-quarter
views and the side) to <out dir>/renders/, for choosing a design.

With --game it writes the game's parts instead (ASSET_SPEC.md): <out dir>/<design>/chassis.glb
(one mesh, origin at the chassis centre, the cabin hollow with open side windows, seats and a
dash inside) and wheel.glb (one wheel about its axle, hub facing -X).
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

# ---------------------------------------------------------------- game sizes

CLASSES = {
    "coupe": dict(half_w=0.97, half_l=2.45, box_h=1.2, wheel_r=0.351, ride=0.78, track=1.51, wheelbase=2.74),
    "suv": dict(half_w=1.0, half_l=2.45, box_h=1.85, wheel_r=0.41, ride=1.05, track=1.58, wheelbase=2.95),
}

# ---------------------------------------------------------------- materials


def material(name, colour, roughness, metallic=0.0, emission=0.0, alpha=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*colour, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission
    if "Coat Weight" in bsdf.inputs and name == "body":
        bsdf.inputs["Coat Weight"].default_value = 1.0
        bsdf.inputs["Coat Roughness"].default_value = 0.05
    return mat


def mats(paint):
    return {
        "body": material("body", paint, 0.32, 0.55),
        "bodyDark": material("bodyDark", (0.035, 0.038, 0.042), 0.55, 0.2),
        "trim": material("trim", (0.012, 0.014, 0.016), 0.12, 0.5),
        "glass": material("glass", (0.05, 0.07, 0.08), 0.05, 0.3),
        "metal": material("metal", (0.55, 0.57, 0.6), 0.28, 1.0),
        "lamp": material("lamp", (0.82, 0.93, 1.0), 0.2, 0.0, emission=6.0),
        "tailLamp": material("tailLamp", (1.0, 0.06, 0.04), 0.3, 0.0, emission=3.0),
        "wheel": material("wheel", (0.012, 0.012, 0.013), 0.85),
        "hub": material("hub", (0.16, 0.17, 0.18), 0.3, 0.9),
        "accent": material("accent", (0.92, 0.93, 0.9), 0.4, 0.0),
        "accent2": material("accent2", (1.0, 0.5, 0.05), 0.3, 0.0, emission=1.5),
        "interior": material("interior", (0.05, 0.053, 0.058), 0.8),
        "open": material("open", (1.0, 0.0, 1.0), 0.5),
    }


# ---------------------------------------------------------------- lofting


def lerp(a, b, t):
    return a + (b - a) * t


def sample(curve, y):
    """Piecewise-linear value of [(y, v), ...] at y (smoothstep between points)."""
    curve = sorted(curve)  # designs list them nose to tail (descending y)
    if y <= curve[0][0]:
        return curve[0][1]
    for (y0, v0), (y1, v1) in zip(curve, curve[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0) if y1 > y0 else 0.0
            t = t * t * (3 - 2 * t)
            return lerp(v0, v1, t)
    return curve[-1][1]


def loft(name, rings, face_material, materials, subdiv=0, cap=True, cap_material=None):
    """Rings are lists of (x, y, z) half-profiles (x >= 0, from the bottom centre to the top
    centre); each is mirrored into a closed loop. ``face_material(ring index, segment index)``
    names the material of each quad."""
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    slots = {}
    for key in materials:
        slots[key] = len(obj.data.materials)
        obj.data.materials.append(materials[key])
    bm = bmesh.new()
    loops = []
    n = len(rings[0])
    for ring in rings:
        right = [bm.verts.new(p) for p in ring]
        left = [bm.verts.new((-p[0], p[1], p[2])) for p in ring[1:-1]]
        loops.append(right + left[::-1])  # bottom centre -> up the right -> top centre -> down the left
    m = len(loops[0])
    for i in range(len(loops) - 1):
        a, b = loops[i], loops[i + 1]
        for j in range(m):
            k = (j + 1) % m
            face = bm.faces.new((a[j], a[k], b[k], b[j]))
            seg = j if j < n - 1 else m - 1 - j  # mirror the segment index on the left side
            face.material_index = slots[face_material(i, seg)]
            face.smooth = True
    if cap:
        for loop, flip in ((loops[0], False), (loops[-1], True)):
            face = bm.faces.new(loop if not flip else loop[::-1])
            face.material_index = slots[cap_material or face_material(0 if not flip else len(loops) - 2, 0)]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    if subdiv:
        mod = obj.modifiers.new("Subdiv", "SUBSURF")
        mod.levels = subdiv
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def hull_ring(y, w, floor, belt, top, top_w, crown=0.015):
    """One cross-section of the lower body: flat floor, a slab side with a crease half way up,
    a sharp shoulder at the belt line and a nearly flat top (bonnet, cowl or deck)."""
    mid = floor + (belt - floor) * 0.56
    return [
        (0.0, y, floor), (w * 0.8, y, floor), (w * 0.97, y, floor + 0.05), (w * 0.985, y, mid - 0.02),
        (w * 1.0, y, mid), (w * 0.975, y, belt), (max(top_w, 0.05), y, top),
        (max(top_w, 0.05) * 0.5, y, top + crown * 0.8), (0.0, y, top + crown),
    ]


def cabin_ring(y, base_w, roof_w, base, roof):
    """One cross-section of the greenhouse: a flat side leaning in to a roof rail and a flat roof.
    Segments: 0 the floor, 1 the base, 2 the side (glass or pillar), 3 the roof rail, 4-5 the roof."""
    h = roof - base
    return [
        (0.0, y, base - 0.03), (base_w * 0.9, y, base - 0.03), (base_w, y, base),
        (roof_w + 0.012, y, roof - min(0.07, h * 0.4)), (roof_w * 0.94, y, roof),
        (roof_w * 0.5, y, roof + min(0.012, h * 0.2)), (0.0, y, roof + min(0.016, h * 0.25)),
    ]


# ---------------------------------------------------------------- simple shapes

PARTS = []


def _add(obj, mat, bevel=0.0, smooth=35):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.shade_auto_smooth(angle=math.radians(smooth))
    obj.select_set(False)
    PARTS.append(obj)
    return obj


def box(size, at, mat, bevel=0.01, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at, rotation=rot)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return _add(obj, mat, bevel)


def tube(a, b, radius, mat, sides=12):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=d.length, location=(a + b) / 2)
    obj = bpy.context.object
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.transform_apply(rotation=True)
    return _add(obj, mat)


def disc(radius, depth, at, mat, sides=40, bevel=0.0):
    """A cylinder lying across the car (its axis along X)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=depth, location=at,
                                        rotation=(0, math.pi / 2, 0))
    obj = bpy.context.object
    bpy.ops.object.transform_apply(rotation=True)
    return _add(obj, mat, bevel)


def disc_y(radius, depth, at, mat, sides=32, bevel=0.0):
    """A cylinder lying along the car (its axis along Y)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=depth, location=at,
                                        rotation=(math.pi / 2, 0, 0))
    obj = bpy.context.object
    bpy.ops.object.transform_apply(rotation=True)
    return _add(obj, mat, bevel)


def round_lamp(at, radius, m, depth=0.07):
    """A round lamp facing forward: a chrome bezel with a lit lens."""
    disc_y(radius, depth, at, m["metal"], sides=24)
    disc_y(radius * 0.82, 0.02, (at[0], at[1] + depth / 2, at[2]), m["lamp"], sides=24)


def ribbon(points, width, mat):
    """A flat strip along a line of points (a painted stripe on the bonnet, roof or deck)."""
    mesh = bpy.data.meshes.new("stripe")
    obj = bpy.data.objects.new("stripe", mesh)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    rows = [(bm.verts.new((x - width / 2, y, z)), bm.verts.new((x + width / 2, y, z))) for x, y, z in points]
    for (a, b), (c2, d2) in zip(rows, rows[1:]):
        bm.faces.new((a, b, d2, c2))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    bm.to_mesh(mesh)
    bm.free()
    return _add(obj, mat)


def mirrored(fn):
    """Call fn(side) for the right (+1) and the left (-1)."""
    for side in (1, -1):
        fn(side)


# ---------------------------------------------------------------- one car


def delete_material(obj, name):
    """Remove every face with this material (the open windows and the cabin's own floor)."""
    slot = [s.material.name for s in obj.material_slots].index(name)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == slot], context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def carve(obj, size, at, mat):
    """Boolean a box out of obj; the new faces take the box's material."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    tool = bpy.context.object
    tool.scale = size
    bpy.ops.object.transform_apply(scale=True)
    tool.data.materials.append(mat)
    mod = obj.modifiers.new("Cut", "BOOLEAN")
    mod.operation, mod.object, mod.solver = "DIFFERENCE", tool, "EXACT"
    mod.material_mode = "TRANSFER"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(tool)


WHEEL = []


def wheel(m, wheel_r, at, s, style="mag", width_ratio=0.72):
    """One wheel centred at ``at``, its outer face towards s (+1 right, -1 left)."""
    before = len(PARTS)
    x, ay, z = at
    width = wheel_r * width_ratio
    disc(wheel_r, width, (x, ay, z), m["wheel"], bevel=0.035)
    disc(wheel_r * 0.7, width + 0.012, (x, ay, z), m["hub"], bevel=0.008)
    disc(wheel_r * 0.6, 0.02, (x + s * (width / 2 + 0.002), ay, z), m["trim"])
    disc(wheel_r * 0.2, 0.06, (x + s * (width / 2 + 0.01), ay, z), m["metal"], sides=16)
    if style == "steel":   # a plain steel wheel: a dished face with a chrome cap
        disc(wheel_r * 0.56, 0.03, (x + s * (width / 2 - 0.0), ay, z), m["hub"], sides=24)
        return PARTS[before:]
    for k in range(5):
        a = k * math.tau / 5
        tube((x + s * (width / 2 + 0.012), ay + math.sin(a) * wheel_r * 0.1, z + math.cos(a) * wheel_r * 0.1),
             (x + s * (width / 2 + 0.012), ay + math.sin(a) * wheel_r * 0.66, z + math.cos(a) * wheel_r * 0.66),
             0.03, m["hub"], sides=8)
    return PARTS[before:]


def build(design, m, game=False):
    c = CLASSES[design["class"]]
    half_l, half_w, wheel_r = c["half_l"], c["half_w"], c["wheel_r"]
    ground = 0.0
    floor = c["ride"] - c["box_h"] / 2 + design.get("floor_lift", 0.04)   # underside
    top = c["ride"] + c["box_h"] / 2                                      # roof height
    axle_f, axle_r = c["wheelbase"] / 2, -c["wheelbase"] / 2
    d = design

    # ---- the hull: stations from the nose (+Y) to the tail (-Y)
    ys = [half_l, half_l - 0.05, half_l - 0.22, half_l - 0.6, axle_f, lerp(axle_f, d["cowl"], 0.6), d["cowl"],
          d["cowl"] - 0.5, 0.0, d["deck"] + 0.5, d["deck"], lerp(d["deck"], -half_l, 0.5), -half_l + 0.25,
          -half_l + 0.06, -half_l]
    rings = []
    for y in ys:
        w = half_w * sample(d["plan"], y)
        belt = sample(d["belt"], y)
        surf = sample(d["surface"], y)
        fl = floor + sample(d["rocker"], y)
        top_w = w * sample(d["top_w"], y)
        rings.append(hull_ring(y, w, fl, min(belt, surf + 0.0), surf, top_w))
    tuck_w, tuck_h = d.get("tuck", (0.95, 0.9))   # how much the nose and tail ends round off

    def tucked(ring, dy):
        zs = [p[2] for p in ring]
        mid = (min(zs) + max(zs)) / 2
        return [(p[0] * tuck_w, p[1] + dy, mid + (p[2] - mid) * tuck_h) for p in ring]
    rings = [tucked(rings[0], 0.03)] + rings + [tucked(rings[-1], -0.03)]
    hull = loft("hull", rings, lambda i, s: "bodyDark" if s <= 1 else "body", m, cap_material="body")

    # ---- the greenhouse
    g = d["cabin"]
    # Stations: the cowl, the windscreen header and A-pillar, a pair either side of each further
    # pillar, then the tail. Odd intervals are pillars; the last one is the rear window.
    cy = [d["cowl"] + 0.02, g["header"], g["header"] - 0.07]
    for at in g["pillars"]:
        cy += [at + 0.045, at - 0.045]
    cy.append(d["deck"] + g.get("tail_in", 0.0))
    crings = []
    for i, y in enumerate(cy):
        base = sample(d["belt"], y) - 0.01
        roof = base + 0.015 if i in (0, len(cy) - 1) else top - sample(g["drop"], y)
        base_w = half_w * sample(d["plan"], y) * 0.93
        roof_w = base_w * (0.985 if i in (0, len(cy) - 1) else g["tumble"])
        crings.append(cabin_ring(y, base_w, roof_w, base, roof))

    def cabin_mat(i, s):
        if game and s == 0:                # the game's cabin is hollow: no floor of its own
            return "open"
        if s <= 1:                         # the base, tucked into the hull
            return "body"
        if i in (0, len(cy) - 2):          # windscreen and rear window, between body-colour corners
            return "glass" if s >= 3 else "body"
        if s >= 3:                         # the roof rail and skin
            return g.get("roof", "body")
        if i % 2 == 1:                     # pillars
            return "body"
        # Side windows: open in the game where a crew member leans out (every door window);
        # the last pane, behind the rear door, stays glass.
        return "open" if game and i in g.get("open", (2, 4)) else "glass"
    cabin = loft("cabin", crings, cabin_mat, m, cap=not game)
    if game:
        delete_material(cabin, "open")

    # ---- wheel arches: cut from the hull, lined in black
    cutters = []
    square = d.get("arch") == "square"     # an octagon: flat top and sides, chamfered corners
    arch_r = (wheel_r + d.get("arch_gap", 0.075)) / (math.cos(math.pi / 8) if square else 1.0)
    for ay in (axle_f, axle_r):
        if square:
            bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=arch_r, depth=half_w * 2 + 0.6,
                                                location=(0, ay, wheel_r), rotation=(0, 0, math.pi / 8))
            bpy.ops.object.transform_apply(rotation=True)
            bpy.context.object.rotation_euler = (0, math.pi / 2, 0)
        else:
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=arch_r, depth=half_w * 2 + 0.6,
                                                location=(0, ay, wheel_r), rotation=(0, math.pi / 2, 0))
        cut = bpy.context.object
        bpy.ops.object.transform_apply(rotation=True)
        cut.data.materials.append(m["trim"])
        # keep the middle of the car: two cutters would meet under the floor otherwise
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, ay, wheel_r))
        keep = bpy.context.object
        keep.scale = ((c["track"] - 0.36), wheel_r * 4, wheel_r * 4)
        bpy.ops.object.transform_apply(scale=True)
        mod = cut.modifiers.new("Keep", "BOOLEAN")
        mod.operation, mod.object, mod.solver = "DIFFERENCE", keep, "EXACT"
        bpy.context.view_layer.objects.active = cut
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(keep)
        cutters.append(cut)
    for cut in cutters:
        mod = hull.modifiers.new("Arch", "BOOLEAN")
        mod.operation, mod.object, mod.solver = "DIFFERENCE", cut, "EXACT"
        mod.material_mode = "TRANSFER"
        bpy.context.view_layer.objects.active = hull
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(cut)
    if game:
        # The cabin tub: deep where the crew sit, narrower beside the rear wheel wells, and a
        # raised luggage floor over the rear axle.
        seat_floor = c["ride"] + d["seat_y"] - 0.14
        dash_y, rear_well = d["cowl"] - 0.22, axle_r + wheel_r + d.get("arch_gap", 0.075) + 0.04
        tub_w = half_w * 1.6
        for y0, y1, width, z0 in ((dash_y, rear_well, tub_w, seat_floor),
                                  (rear_well, rear_well - 0.3, c["track"] - wheel_r * 0.72 - 0.16, seat_floor),
                                  (rear_well - 0.3, d["deck"] + 0.22, tub_w, wheel_r * 2 + d.get("arch_gap", 0.075) + 0.05)):
            carve(hull, (width, abs(y0 - y1) + 0.002, 3.0), (0, (y0 + y1) / 2, z0 + 1.5), m["interior"])
    for obj in (hull, cabin):
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.shade_auto_smooth(angle=math.radians(24))
        obj.select_set(False)
        PARTS.append(obj)

    belt_at = lambda y: sample(d["belt"], y)
    surf_at = lambda y: sample(d["surface"], y)
    w_at = lambda y: half_w * sample(d["plan"], y)

    # ---- nose: a dark grille panel with round lamps, a chrome bumper
    nose_y = half_l + 0.03
    nose_w = w_at(half_l) * 0.95
    nose_top = surf_at(half_l)
    panel_h = d.get("grille_h", 0.2)
    panel_z = nose_top - 0.05 - panel_h / 2
    box((nose_w * 2 - 0.1, 0.06, panel_h), (0, nose_y - 0.02, panel_z), m["trim"], 0.01)
    lamp_r = d.get("lamp_r", 0.075)
    for s in (1, -1):
        for k in range(d.get("lamps", 2)):
            lx = s * (nose_w - 0.16 - k * (lamp_r * 2 + 0.03))
            round_lamp((lx, nose_y + 0.0, panel_z), lamp_r, m)
    for k in range(d.get("grille_bars", 4)):                         # grille slats between the lamps
        z = panel_z - panel_h / 2 + (k + 0.5) * panel_h / d.get("grille_bars", 4)
        inner = nose_w - 0.2 - d.get("lamps", 2) * (lamp_r * 2 + 0.03)
        box((inner * 2, 0.02, 0.012), (0, nose_y + 0.012, z), m["metal"], 0.0)
    bumper = m["metal"] if d.get("chrome", True) else m["bodyDark"]
    bump_z = floor + sample(d["rocker"], half_l) + d.get("bumper_up", 0.1)
    box((half_w * 2 + 0.04, 0.13, 0.1), (0, half_l + 0.08, bump_z), bumper, 0.02)
    mirrored(lambda s: box((0.06, 0.05, 0.16), (s * 0.42, half_l + 0.15, bump_z + 0.02), bumper, 0.015))   # overriders
    mirrored(lambda s: box((0.16, 0.03, 0.05), (s * (nose_w - 0.12), half_l + 0.15, bump_z), m["accent2"], 0.01))  # indicators
    # ---- tail: a dark panel with lamp blocks, a chrome bumper, exhausts
    tail_w = w_at(-half_l) * 0.95
    tail_top = surf_at(-half_l)
    tail_h = d.get("tail_h", 0.16)
    tail_z = tail_top - 0.06 - tail_h / 2
    box((tail_w * 2 - 0.1, 0.06, tail_h), (0, -half_l - 0.01, tail_z), m["trim"], 0.01)
    for s in (1, -1):
        for k in range(d.get("tail_lamps", 3)):
            box((0.13, 0.04, tail_h - 0.05), (s * (tail_w - 0.14 - k * 0.15), -half_l - 0.035, tail_z), m["tailLamp"], 0.012)
    rbump_z = floor + sample(d["rocker"], -half_l) + d.get("bumper_up", 0.1)
    box((half_w * 2 + 0.04, 0.13, 0.1), (0, -half_l - 0.08, rbump_z), bumper, 0.02)
    mirrored(lambda s: tube((s * 0.5, -half_l + 0.2, rbump_z - 0.09), (s * 0.5, -half_l - 0.12, rbump_z - 0.09), 0.04, m["metal"]))
    # ---- mirrors, door handles, a side stripe
    mir_y = g["header"] + 0.06
    mirrored(lambda s: box((0.14, 0.05, 0.1), (s * (w_at(mir_y) + 0.07), mir_y, belt_at(mir_y) + 0.06), m["metal"], 0.02))
    for y in d.get("handles", ()):
        mirrored(lambda s: box((0.02, 0.13, 0.03), (s * (w_at(y) * 0.99 + 0.006), y, belt_at(y) - 0.09), m["metal"], 0.008))
    stripe_z = floor + (belt_at(0) - floor) * 0.3
    mirrored(lambda s: box((0.012, c["wheelbase"] - wheel_r * 2 - 0.36, 0.05), (s * (half_w * 0.99), 0.0, stripe_z),
                           m["accent"], 0.0))
    # ---- top stripes and a bonnet scoop (the muscle coupe)
    if d.get("stripes"):
        for s in (1, -1):
            ribbon([(s * 0.16, y, surf_at(y) + 0.02) for y in
                    [half_l - 0.02 - k * (half_l - 0.02 - d["cowl"]) / 8 for k in range(9)]], 0.13, m["accent"])
            ribbon([(s * 0.16, y, top - sample(g["drop"], y) + 0.02) for y in
                    [g["header"] - 0.04 - k * (g["header"] - 0.08 - g["pillars"][-1]) / 6 for k in range(7)]], 0.13, m["accent"])
            ribbon([(s * 0.16, y, surf_at(y) + 0.02) for y in
                    [d["deck"] - 0.04 - k * (d["deck"] - 0.06 + half_l) / 5 for k in range(6)]], 0.13, m["accent"])
    if d.get("scoop"):
        sy = lerp(d["cowl"], half_l, 0.42)
        box((0.5, 0.7, 0.07), (0, sy, surf_at(sy) + 0.045), m["body"], 0.02)
        box((0.42, 0.02, 0.04), (0, sy + 0.35, surf_at(sy) + 0.045), m["trim"], 0.0)
    if d.get("spoiler"):
        box((tail_w * 2 - 0.06, 0.16, 0.035), (0, -half_l + 0.1, tail_top + 0.05), m["body"], 0.012)
    # ---- battle kit: bull bar, roof rack and rally lamps, spare wheel, side steps
    if d.get("bullbar", True):
        bz0, bz1 = bump_z - 0.02, nose_top + 0.02
        by = half_l + 0.17
        bw = nose_w - 0.34
        for z in ((bz0 + bz1) / 2, bz1):
            tube((-bw, by, z), (bw, by, z), 0.024, m["bodyDark"])
        mirrored(lambda s: tube((s * bw, by, bz0), (s * bw, by, bz1), 0.028, m["bodyDark"]))
        mirrored(lambda s: tube((s * bw, by, bz0 + 0.02), (s * bw, half_l + 0.08, bz0 + 0.02), 0.024, m["bodyDark"]))
    roof_z = lambda y: top - sample(g["drop"], y) + 0.02
    if d.get("rally_lamps"):
        ly = g["header"] - 0.16
        lw = w_at(ly) * g["tumble"] * 0.8
        tube((-lw, ly, roof_z(ly) + 0.05), (lw, ly, roof_z(ly) + 0.05), 0.016, m["bodyDark"])
        mirrored(lambda s: tube((s * lw, ly, roof_z(ly) + 0.05), (s * lw, ly, roof_z(ly) - 0.01), 0.014, m["bodyDark"]))
        for k in range(d["rally_lamps"]):
            lx = -lw * 0.82 + k * (lw * 1.64) / (d["rally_lamps"] - 1)
            round_lamp((lx, ly + 0.02, roof_z(ly) + 0.13), 0.085, m, depth=0.09)
    if d.get("rack") and not game:     # in the game a rack crosses the gunners' view over the roof
        y0, y1 = d["rack"]
        rw = w_at(0) * g["tumble"] * 0.82
        rz = roof_z((y0 + y1) / 2) + 0.07
        mirrored(lambda s: tube((s * rw, y0, rz), (s * rw, y1, rz), 0.016, m["bodyDark"]))
        for k in range(5):
            y = y0 + k * (y1 - y0) / 4
            tube((-rw, y, rz), (rw, y, rz), 0.013, m["bodyDark"])
            mirrored(lambda s: tube((s * rw, y, rz), (s * rw, y, roof_z(y) - 0.01), 0.012, m["bodyDark"]))
    if d.get("spare"):
        sz = rbump_z + 0.1 + wheel_r
        disc_y(wheel_r * 0.95, wheel_r * 0.6, (0.28, -half_l - 0.07 - wheel_r * 0.3, sz), m["wheel"], bevel=0.03)
        disc_y(wheel_r * 0.55, wheel_r * 0.62, (0.28, -half_l - 0.08 - wheel_r * 0.3, sz), m["hub"])
    if d.get("steps"):
        mirrored(lambda s: tube((s * (half_w + 0.03), axle_f - wheel_r - 0.2, floor + 0.04),
                                (s * (half_w + 0.03), axle_r + wheel_r + 0.2, floor + 0.04), 0.03, m["bodyDark"]))

    # ---- arch trims: a dark lip round each wheel opening
    gap = d.get("arch_gap", 0.075)
    for ay in (axle_f, axle_r):
        for s in (1, -1):
            x = s * (w_at(ay) * 0.992)
            angles = ([math.radians(-22.5 + k * 45) for k in range(6)] if square
                      else [math.radians(-12 + k * 204 / 20) for k in range(21)])
            pts = [(x, ay + math.cos(a) * arch_r, wheel_r + math.sin(a) * arch_r) for a in angles]
            pts = [p for p in pts if p[2] > floor + sample(d["rocker"], p[1]) + 0.1]
            for a, b in zip(pts, pts[1:]):
                tube(a, b, 0.028, m["bodyDark"], sides=8)
    # ---- door lines down the body side
    for y in d.get("doors", ()):
        ring = hull_ring(y, w_at(y), floor + sample(d["rocker"], y), min(belt_at(y), surf_at(y)), surf_at(y), 1.0)
        for s in (1, -1):
            line = [(s * (p[0] + 0.004), p[1], p[2]) for p in ring[2:6]]
            for a, b in zip(line, line[1:]):
                tube(a, b, 0.006, m["trim"], sides=6)
    # ---- the inside: seats, dash, steering wheel
    if game:
        for sx, sy, sz in d["seats"]:                       # game coordinates: x right, y up, z back
            bx, by, bz = sx, -sz, c["ride"] + sy
            # Cushion a little ahead of the hip point and a thin backrest, so the rear pair clear
            # the wheel wells behind them.
            box((0.46, 0.44, 0.14), (bx, by + 0.15, bz - 0.07), m["interior"], 0.03)
            box((0.46, 0.08, 0.6), (bx, by - 0.04, bz + 0.25), m["interior"], 0.03, rot=(math.radians(-8), 0, 0))
        dash_z = belt_at(d["cowl"] - 0.3) - 0.1
        box((half_w * 1.56, 0.34, 0.24), (0, d["cowl"] - 0.36, dash_z), m["interior"], 0.04)
        drv = d["seats"][0]
        bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.016, major_segments=20, minor_segments=6,
                                         location=(drv[0], d["cowl"] - 0.62, dash_z + 0.06),
                                         rotation=(math.radians(68), 0, 0))
        _add(bpy.context.object, m["trim"])
        return ground
    # ---- wheels (the game places its own)
    for ay in (axle_f, axle_r):
        for s in (1, -1):
            wheel(m, wheel_r, (s * c["track"] / 2, ay, wheel_r), s, d.get("wheels", "mag"), d.get("tyre_w", 0.72))
    return ground


# ---------------------------------------------------------------- designs
# Curves are [(y, value), ...] from the nose (+2.45) to the tail (-2.45), heights in metres
# above the ground, widths as a share of the class's half width.

DESIGNS = {
    # A 1970s muscle coupe: long flat bonnet, a short upright cabin set back, a flat boot with a lip.
    "coupe-muscle": dict(
        **{"class": "coupe"}, label="Muscle coupe",
        # Narrower at the doors, full width over the rear wheels: the haunches. The cabin sits well
        # back behind a long bonnet, with a low, raked screen.
        plan=[(2.45, 0.93), (2.3, 0.97), (1.37, 0.985), (0.3, 0.955), (-0.6, 0.955), (-1.37, 1.0), (-2.3, 0.985),
              (-2.45, 0.94)],
        rocker=[(2.45, 0.1), (2.2, 0.02), (1.9, 0.0), (-1.9, 0.0), (-2.2, 0.03), (-2.45, 0.12)],
        top_w=[(2.45, 0.9), (0.0, 0.92), (-2.45, 0.9)],
        cowl=0.55, deck=-1.62,
        belt=[(2.45, 0.8), (2.2, 0.83), (0.55, 0.87), (-0.5, 0.88), (-1.1, 0.93), (-1.6, 0.955), (-2.45, 0.94)],
        surface=[(2.45, 0.8), (2.2, 0.84), (0.55, 0.88), (-1.62, 0.94), (-1.9, 0.955), (-2.45, 0.945)],
        cabin=dict(header=-0.08, pillars=(-0.9, -1.16), tumble=0.82, tail_in=0.0,
                   drop=[(0.55, 0.04), (-0.08, 0.04), (-0.9, 0.04), (-1.16, 0.08), (-1.62, 0.34)]),
        paint=(0.62, 0.07, 0.05), grille_h=0.17, lamps=2, lamp_r=0.07, tail_lamps=3, tail_h=0.15, bumper_up=0.16,
        stripes=True, scoop=True, spoiler=True, bullbar=True, rally_lamps=0, wheels="mag", arch_gap=0.06,
        handles=(-0.55,),
        seat_y=-0.4, seats=[(-0.42, -0.4, 0.35), (0.42, -0.4, 0.35)], doors=(0.4, -0.86),
    ),
    # A 1980s 4x4: slab sides, a flat roof, an upright screen, square arches, a spare on the back.
    "suv-4x4": dict(
        **{"class": "suv"}, label="Old-school 4x4",
        # Square nose and a flat bonnet; the body rides high over big, square arches.
        plan=[(2.45, 0.985), (2.3, 0.995), (1.4, 1.0), (0.0, 1.0), (-2.3, 1.0), (-2.45, 0.985)],
        rocker=[(2.45, 0.2), (2.2, 0.1), (1.95, 0.0), (-1.95, 0.0), (-2.2, 0.12), (-2.45, 0.22)],
        top_w=[(2.45, 0.97), (0.0, 0.97), (-2.45, 0.96)],
        cowl=1.02, deck=-2.38, floor_lift=0.15, tuck=(0.99, 0.97), arch="square", tyre_w=0.9,
        belt=[(2.45, 1.16), (1.02, 1.22), (-2.45, 1.22)],
        surface=[(2.45, 1.17), (1.02, 1.23), (-2.45, 1.23)],
        cabin=dict(header=0.72, pillars=(-0.42, -1.45, -2.18), tumble=0.9, tail_in=0.05, open=(2, 4),
                   drop=[(1.02, 0.02), (0.72, 0.0), (-2.25, 0.0), (-2.38, 0.02)]),
        paint=(0.75, 0.7, 0.55), grille_h=0.24, lamps=1, lamp_r=0.095, grille_bars=5, tail_lamps=1, tail_h=0.22,
        bumper_up=0.14, chrome=False, bullbar=True, rally_lamps=4, rack=(0.3, -2.0), spare=True, steps=True,
        wheels="steel", arch_gap=0.13, handles=(0.15, -0.95),
        # The game's SUV seats (src/shared/crews.ts SUV_SEATS): x right, y up from the chassis centre, z back.
        seat_y=-0.52, seats=[(-0.45, -0.52, -0.25), (0.45, -0.52, -0.25), (-0.45, -0.52, 0.85), (0.45, -0.52, 0.85)],
        doors=(0.92, -0.42, -1.45),
    ),
}


# ---------------------------------------------------------------- scene, render, export


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PARTS.clear()


def stage():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.cycles.device = "CPU"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.view_settings.view_transform = "Filmic" if "Filmic" in [
        v.name for v in type(scene.view_settings).bl_rna.properties["view_transform"].enum_items] else "AgX"
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.74, 0.86, 1.0)
    bg.inputs["Strength"].default_value = 0.55
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    floor = bpy.context.object
    floor.data.materials.append(material("floor", (0.035, 0.04, 0.046), 0.55))
    bpy.ops.object.light_add(type="AREA", location=(3.5, 4.0, 5.0))
    key = bpy.context.object
    key.data.energy, key.data.size = 700, 5
    key.rotation_euler = (math.radians(40), 0, math.radians(140))
    bpy.ops.object.light_add(type="AREA", location=(-5.0, -3.0, 3.5))
    fill = bpy.context.object
    fill.data.energy, fill.data.size = 180, 8
    fill.rotation_euler = (math.radians(60), 0, math.radians(-60))
    bpy.ops.object.camera_add()
    scene.camera = bpy.context.object
    scene.camera.data.lens = 55


def shoot(path, eye, target=(0, 0, 0.7)):
    cam = bpy.context.scene.camera
    cam.location = eye
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = obj.data.name = name
    return obj


def export_game(out, name):
    """<out>/<name>/chassis.glb and wheel.glb in the game's convention."""
    design = DESIGNS[name]
    c = CLASSES[design["class"]]
    folder = os.path.join(out, name)
    os.makedirs(folder, exist_ok=True)
    # Paint is applied in the game: the body is a neutral mid grey there.
    clear()
    m = mats((0.32, 0.32, 0.32))
    build(design, m, game=True)
    chassis = join(list(PARTS), "chassis")
    chassis.location.z -= c["ride"]            # origin at the chassis centre
    bpy.ops.object.transform_apply(location=True)
    tris = sum(len(p.vertices) - 2 for p in chassis.data.polygons)
    bpy.ops.export_scene.gltf(filepath=os.path.join(folder, "chassis.glb"), use_selection=True, export_apply=True)
    clear()
    m = mats((0.32, 0.32, 0.32))
    w = join(wheel(m, c["wheel_r"], (0, 0, 0), -1, design.get("wheels", "mag"), design.get("tyre_w", 0.72)), "wheel")
    wtris = sum(len(p.vertices) - 2 for p in w.data.polygons)
    bpy.ops.export_scene.gltf(filepath=os.path.join(folder, "wheel.glb"), use_selection=True, export_apply=True)
    print(f"{name}: chassis {tris} triangles, wheel {wtris} triangles -> {folder}")


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--game" in args:
        args = [a for a in args if not a.startswith("--")]
        for name in args[1:]:
            export_game(args[0], name)
        return
    render = "--render" in args
    args = [a for a in args if not a.startswith("--")]
    out = args[0]
    names = args[1:] or list(DESIGNS)
    os.makedirs(os.path.join(out, "renders"), exist_ok=True)
    for name in names:
        design = DESIGNS[name]
        clear()
        build(design, mats(design["paint"]))
        tris = sum(len(o.data.polygons) for o in PARTS)
        print(f"{name}: {len(PARTS)} parts, about {tris * 2} triangles")
        bpy.ops.object.select_all(action="DESELECT")
        for o in PARTS:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, f"{name}.glb"), use_selection=True, export_apply=True)
        if render:
            stage()
            high = 0.35 if design["class"] == "suv" else 0.0
            shoot(os.path.join(out, "renders", f"{name}-front.png"), (5.2, 7.0, 1.7 + high), (0, 0, 0.62 + high))
            shoot(os.path.join(out, "renders", f"{name}-rear.png"), (-5.6, -6.8, 1.9 + high), (0, 0, 0.62 + high))
            shoot(os.path.join(out, "renders", f"{name}-side.png"), (10.5, 0.0, 1.25 + high), (0, 0, 0.8 + high))


main()
