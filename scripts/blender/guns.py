"""
YOVNOK's window gunners' guns: eight original firearms, modelled here.

    blender -b --python scripts/blender/guns.py -- <out dir> [id ...]

Writes <out dir>/hand-<id>/gun.glb for each: in game convention once exported
(metres, barrel along -Z, top +Y, the butt at the origin, level with the top of
the stock). In Blender the barrel runs along +Y and up is +Z; the glTF
exporter turns that into the game's axes.

Realistic in style but no real-world model: each is assembled from simple
bevelled shapes and cylinders. Materials: "GunMetal", "Polymer", "Furniture"
(a tan stock or grip on some) and "Glass" for optics.

Where the hands go on each gun is in src/client/vehicle/figures.ts (GRIPS),
measured against these shapes.
"""

import math
import os
import sys

import bpy
from mathutils import Vector


def material(name, colour, roughness, metallic=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def metal():
    return material("GunMetal", (0.045, 0.048, 0.052), 0.38, 0.75)


def polymer():
    return material("Polymer", (0.07, 0.072, 0.075), 0.7)


def furniture():
    return material("Furniture", (0.42, 0.35, 0.25), 0.65)


def glass():
    return material("Glass", (0.03, 0.05, 0.06), 0.05, 0.3)


PARTS = []


def _finish(obj, mat, bevel):
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    PARTS.append(obj)
    return obj


def block(size, at, mat, bevel=0.004, tilt=0.0):
    """A bevelled box: `size` (across, along, up), centred `at` (x, along, up),
    tipped `tilt` degrees about the across axis (a grip's rake)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=at, rotation=(math.radians(tilt), 0, 0))
    obj = bpy.context.active_object
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    return _finish(obj, mat, bevel)


def tube(radius, start, end, mat, up=0.0, across=0.0, sides=16, bevel=0.0):
    """A cylinder along the barrel axis, from `start` to `end` (along)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=end - start, location=(across, (start + end) / 2, up), rotation=(math.radians(90), 0, 0))
    return _finish(bpy.context.active_object, mat, bevel)


def ribs(radius, start, end, count, mat, up=0.0):
    """Raised rings along a tube: a pump's grip, a shroud's fins."""
    step = (end - start) / count
    for k in range(count):
        a = start + k * step + step * 0.2
        tube(radius, a, a + step * 0.5, mat, up)


def rail(start, end, up, width=0.022):
    block((width, end - start, 0.012), (0, (start + end) / 2, up), metal(), 0.002)
    for k in range(int((end - start) / 0.02)):
        block((width + 0.004, 0.006, 0.004), (0, start + 0.01 + k * 0.02, up + 0.007), metal(), 0)


def optic(at, length=0.09, radius=0.017, up=0.06):
    """A compact sight on the rail: body and a front lens."""
    block((0.032, length, 0.04), (0, at, up), polymer(), 0.006)
    tube(radius, at + length / 2 - 0.004, at + length / 2 + 0.002, glass(), up + 0.004)


def scope(start, end, up=0.07):
    tube(0.018, start, end, metal(), up)
    tube(0.026, start, start + 0.05, metal(), up)
    tube(0.03, end - 0.06, end, metal(), up)
    tube(0.027, end - 0.002, end + 0.001, glass(), up)
    for y in (start + 0.08, end - 0.1):
        block((0.02, 0.02, 0.05), (0, y, up - 0.035), metal(), 0.002)


def trigger(at, up=-0.055):
    """A trigger guard (a flat loop) and the trigger inside it."""
    block((0.006, 0.07, 0.006), (0, at + 0.02, up - 0.03), metal(), 0.001)
    block((0.006, 0.006, 0.035), (0, at + 0.055, up - 0.012), metal(), 0.001)
    block((0.005, 0.006, 0.022), (0, at + 0.02, up - 0.012), metal(), 0.001, tilt=-15)


def port(at, up, length=0.05):
    """The ejection port on the right of the receiver, and its cover."""
    block((0.004, length, 0.018), (0.026, at, up), polymer(), 0.0)
    block((0.003, length * 0.9, 0.012), (0.029, at, up - 0.01), metal(), 0.0)


def magazine(at, up, length=0.13, depth=0.055, curve=8.0):
    """A curved box magazine, in two tipped halves."""
    block((0.024, depth, length / 2), (0, at, up), metal(), 0.003, tilt=curve * 0.5)
    block((0.024, depth, length / 2 + 0.004), (0, at + math.sin(math.radians(curve)) * length / 2, up - length / 2), metal(), 0.003, tilt=curve * 1.5)


def sights(rear, front, up):
    block((0.018, 0.012, 0.022), (0, rear, up + 0.011), metal(), 0.002)
    block((0.006, 0.01, 0.026), (0, front, up + 0.013), metal(), 0.001)


# ---------------------------------------------------------------- the guns


def rifle():
    """A carbine: collapsing stock, flat-top receiver, slotted handguard."""
    block((0.04, 0.17, 0.085), (0, 0.085, -0.035), polymer(), 0.008)
    block((0.026, 0.14, 0.03), (0, 0.2, -0.005), polymer(), 0.004)  # buffer tube
    block((0.05, 0.3, 0.07), (0, 0.36, -0.015), metal(), 0.005)
    block((0.03, 0.045, 0.1), (0, 0.27, -0.085), polymer(), 0.006, tilt=-18)  # grip
    magazine(0.38, -0.08)
    trigger(0.29)
    port(0.38, -0.005)
    block((0.01, 0.03, 0.012), (0.0, 0.235, 0.026), metal(), 0.002)  # charging handle
    tube(0.03, 0.5, 0.68, polymer(), -0.015, sides=8, bevel=0.003)
    for k in range(4):  # handguard vents
        block((0.062, 0.018, 0.008), (0, 0.53 + k * 0.04, -0.015), metal(), 0.0)
    sights(0.27, 0.66, 0.03)
    tube(0.009, 0.68, 0.8, metal(), -0.015)
    tube(0.014, 0.8, 0.84, metal(), -0.015, sides=12)
    rail(0.26, 0.64, 0.024)
    optic(0.36)


def burst():
    """A bullpup: the magazine behind the grip, a long body, a carry sight."""
    block((0.048, 0.48, 0.09), (0, 0.24, -0.03), polymer(), 0.01)
    block((0.03, 0.045, 0.1), (0, 0.4, -0.11), polymer(), 0.006, tilt=-15)  # grip
    block((0.03, 0.04, 0.03), (0, 0.4, -0.065), polymer(), 0.004)  # guard
    magazine(0.24, -0.11, 0.12)
    trigger(0.4, -0.075)
    port(0.2, -0.01, 0.06)
    block((0.05, 0.03, 0.06), (0, 0.015, -0.03), polymer(), 0.006)  # butt pad
    tube(0.026, 0.48, 0.62, polymer(), -0.02, sides=10, bevel=0.003)
    tube(0.009, 0.62, 0.76, metal(), -0.02)
    tube(0.015, 0.76, 0.8, metal(), -0.02, sides=12)
    block((0.03, 0.26, 0.03), (0, 0.36, 0.035), polymer(), 0.008)  # carry handle
    tube(0.012, 0.47, 0.49, glass(), 0.04)


def marksman():
    """A long rifle: skeleton stock, free-floating barrel, a full scope, bipod."""
    block((0.04, 0.12, 0.1), (0, 0.06, -0.045), furniture(), 0.01)
    block((0.03, 0.12, 0.025), (0, 0.15, -0.01), furniture(), 0.006)
    block((0.03, 0.12, 0.025), (0, 0.15, -0.08), furniture(), 0.006)
    block((0.032, 0.05, 0.11), (0, 0.29, -0.08), furniture(), 0.006, tilt=-15)
    block((0.05, 0.32, 0.075), (0, 0.38, -0.015), metal(), 0.005)
    block((0.026, 0.07, 0.1), (0, 0.42, -0.085), metal(), 0.004)
    block((0.03, 0.06, 0.025), (0, 0.2, -0.045), furniture(), 0.004)  # stock web
    trigger(0.31)
    port(0.44, 0.0, 0.07)
    tube(0.008, 0.47, 0.5, metal(), 0.0, 0.035)  # the bolt handle
    tube(0.028, 0.54, 0.78, furniture(), -0.02, sides=10, bevel=0.003)
    tube(0.011, 0.78, 0.99, metal(), -0.02)
    tube(0.017, 0.99, 1.03, metal(), -0.02, sides=12)
    scope(0.26, 0.6)
    for x in (-0.012, 0.012):  # the bipod, folded forward
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.005, depth=0.2, location=(x, 0.86, -0.05), rotation=(math.radians(90), 0, 0))
        _finish(bpy.context.active_object, metal(), 0)


def shotgun():
    """A pump gun: tube magazine under the barrel, ribbed pump, solid stock."""
    block((0.04, 0.24, 0.1), (0, 0.12, -0.045), furniture(), 0.01)
    block((0.034, 0.06, 0.07), (0, 0.26, -0.035), furniture(), 0.008)  # wrist
    block((0.032, 0.05, 0.1), (0, 0.29, -0.08), furniture(), 0.006, tilt=-20)
    trigger(0.3, -0.06)
    port(0.4, 0.0, 0.07)
    block((0.05, 0.2, 0.08), (0, 0.38, -0.02), metal(), 0.006)
    tube(0.012, 0.47, 1.0, metal(), -0.005)
    tube(0.012, 0.47, 0.9, metal(), -0.04)
    tube(0.024, 0.55, 0.74, polymer(), -0.04)
    ribs(0.026, 0.56, 0.73, 6, polymer(), -0.04)
    tube(0.004, 0.98, 1.0, metal(), 0.012)  # bead sight


def smg():
    """A compact SMG: wire stock, short receiver, vertical foregrip, long magazine."""
    for up in (-0.0, -0.06):
        block((0.008, 0.16, 0.008), (0.02, 0.08, up), metal(), 0)
        block((0.008, 0.16, 0.008), (-0.02, 0.08, up), metal(), 0)
    block((0.05, 0.012, 0.075), (0, 0.006, -0.03), polymer(), 0.003)
    block((0.046, 0.24, 0.07), (0, 0.27, -0.02), metal(), 0.006)
    block((0.03, 0.045, 0.1), (0, 0.22, -0.09), polymer(), 0.006, tilt=-15)
    magazine(0.31, -0.1, 0.17, 0.034, 4)
    trigger(0.23, -0.055)
    port(0.29, -0.005, 0.045)
    block((0.01, 0.04, 0.01), (0.026, 0.33, 0.012), metal(), 0.001)  # cocking handle
    block((0.028, 0.035, 0.09), (0, 0.42, -0.08), polymer(), 0.006)  # foregrip
    tube(0.022, 0.39, 0.5, polymer(), -0.02, sides=10)
    tube(0.008, 0.5, 0.58, metal(), -0.02)
    tube(0.014, 0.58, 0.62, metal(), -0.02, sides=12)
    optic(0.27, 0.07, 0.015, 0.035)


def lmg():
    """A light machine gun: heavy shrouded barrel, box magazine, carry handle, bipod."""
    block((0.045, 0.2, 0.1), (0, 0.1, -0.04), polymer(), 0.01)
    block((0.032, 0.05, 0.1), (0, 0.29, -0.085), polymer(), 0.006, tilt=-15)
    block((0.06, 0.34, 0.085), (0, 0.38, -0.015), metal(), 0.006)
    block((0.08, 0.1, 0.11), (0, 0.42, -0.11), polymer(), 0.01)  # box magazine
    block((0.03, 0.05, 0.02), (0.045, 0.42, -0.03), metal(), 0.003)  # feed tray
    trigger(0.3, -0.06)
    port(0.4, -0.005, 0.07)
    tube(0.035, 0.55, 0.85, metal(), -0.015, sides=12)  # shroud
    for k in range(6):  # its cooling holes, as darker rings
        tube(0.0355, 0.57 + k * 0.045, 0.59 + k * 0.045, polymer(), -0.015, sides=12)
    tube(0.012, 0.85, 0.96, metal(), -0.015)
    tube(0.019, 0.96, 1.0, metal(), -0.015, sides=12)
    block((0.02, 0.16, 0.02), (0, 0.6, 0.05), metal(), 0.004)  # carry handle
    block((0.02, 0.02, 0.05), (0, 0.53, 0.03), metal(), 0.003)
    block((0.02, 0.02, 0.05), (0, 0.67, 0.03), metal(), 0.003)
    rail(0.26, 0.5, 0.03)
    for x in (-0.014, 0.014):
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.006, depth=0.22, location=(x, 0.82, -0.06), rotation=(math.radians(90), 0, 0))
        _finish(bpy.context.active_object, metal(), 0)


def revolver():
    """A heavy revolver, held out at arm's length: it sits well forward of the
    shoulder 'butt' origin (the hands meet round its grip)."""
    z0 = 0.46
    block((0.034, 0.05, 0.11), (0, z0, -0.07), furniture(), 0.01, tilt=-12)  # grip
    block((0.036, 0.1, 0.05), (0, z0 + 0.06, -0.005), metal(), 0.006)  # frame
    tube(0.026, z0 + 0.05, z0 + 0.1, metal(), -0.005, sides=12, bevel=0.002)  # cylinder
    for k in range(6):
        a = k * math.pi / 3
        tube(0.0055, z0 + 0.099, z0 + 0.101, polymer(), -0.005 + 0.015 * math.cos(a), 0.015 * math.sin(a), sides=8)
    tube(0.011, z0 + 0.1, z0 + 0.26, metal(), 0.005)
    block((0.016, 0.16, 0.012), (0, z0 + 0.18, 0.018), metal(), 0.003)  # rib
    block((0.008, 0.012, 0.012), (0, z0 + 0.25, 0.028), metal(), 0.002)  # front sight
    block((0.01, 0.02, 0.025), (0, z0 + 0.025, 0.025), metal(), 0.002)  # hammer
    trigger(z0 - 0.02, -0.035)
    tube(0.006, z0 + 0.1, z0 + 0.2, metal(), -0.022)  # ejector rod


def launcher():
    """A six-shot grenade launcher: revolving drum, short wide barrel, folding stock."""
    block((0.04, 0.16, 0.08), (0, 0.08, -0.04), polymer(), 0.01)
    block((0.032, 0.05, 0.1), (0, 0.27, -0.1), polymer(), 0.006, tilt=-15)
    block((0.05, 0.12, 0.07), (0, 0.24, -0.03), metal(), 0.006)
    tube(0.075, 0.3, 0.45, metal(), -0.06, sides=18, bevel=0.004)  # the drum
    for k in range(6):
        a = k * math.pi / 3
        tube(0.022, 0.449, 0.452, polymer(), -0.06 + 0.045 * math.cos(a), 0.045 * math.sin(a), sides=10)
    tube(0.032, 0.45, 0.76, metal(), -0.02, sides=14)
    tube(0.034, 0.74, 0.78, metal(), -0.02, sides=14)
    block((0.03, 0.035, 0.1), (0, 0.55, -0.1), polymer(), 0.006)  # foregrip
    trigger(0.28, -0.065)
    block((0.03, 0.012, 0.012), (0, 0.29, -0.06), metal(), 0.002)  # drum axle
    tube(0.012, 0.29, 0.46, metal(), -0.06)
    optic(0.38, 0.06, 0.016, 0.03)


GUNS = {"rifle": rifle, "burst": burst, "marksman": marksman, "shotgun": shotgun, "smg": smg, "lmg": lmg, "revolver": revolver, "launcher": launcher}


def build(gun_id, out_dir):
    bpy.ops.wm.read_homefile(use_empty=True)
    PARTS.clear()
    GUNS[gun_id]()
    bpy.ops.object.select_all(action="DESELECT")
    for p in PARTS:
        p.select_set(True)
    bpy.context.view_layer.objects.active = PARTS[0]
    bpy.ops.object.join()
    gun = bpy.context.active_object
    gun.name = gun_id
    folder = os.path.join(out_dir, f"hand-{gun_id}")
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, "gun.glb")
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format="GLB", export_yup=True, export_apply=True)
    tris = sum(len(p.vertices) - 2 for p in gun.data.polygons)
    print(f"[guns] wrote {out} ({tris} tris)")


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir = os.path.abspath(args[0] if args else ".")
    for gun_id in args[1:] or list(GUNS):
        build(gun_id, out_dir)


main()
