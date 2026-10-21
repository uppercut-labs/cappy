"""Build Cappy's purple glass logo in Blender; the mascot texture is unchanged.

Run with Blender 5.2+: blender -b -P scripts/brand/glass-logo.py -- --preview
The scene and preview are written to artifacts/brand/, outside source control.
"""

import argparse
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--plate", action="store_true", help="Render the approved 3-second logo plate")
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.size < 128 or args.samples < 1:
        parser.error("size must be at least 128 and samples must be positive")
    return args


def link(name, data):
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return obj


def material(name, **values):
    mat = bpy.data.materials.new(name)
    shader = mat.node_tree.nodes.get("Principled BSDF")
    if shader is None:
        raise RuntimeError("Blender did not create the Principled material nodes")
    for key, value in values.items():
        shader.inputs[key].default_value = value
    return mat


def slab(name, half_width, thickness, bevel, rings=24, segments=192):
    # Elliptical edge rings keep the glass curvature continuous around the squircle.
    points = []
    for i in range(segments):
        angle = math.tau * i / segments
        x, z = math.cos(angle), math.sin(angle)
        points.append(Vector((half_width * math.copysign(abs(x) ** 0.4, x),
                              half_width * math.copysign(abs(z) ** 0.4, z))))
    normals = []
    for i in range(segments):
        tangent = points[(i + 1) % segments] - points[(i - 1) % segments]
        normals.append(Vector((tangent.y, -tangent.x)).normalized())
    mesh = bmesh.new()
    rows = []
    for j in range(rings + 1):
        angle = -math.pi / 2 + math.pi * j / rings
        row = []
        for point, normal in zip(points, normals):
            p = point + normal * (bevel * (math.cos(angle) - 1))
            row.append(mesh.verts.new((p.x, thickness / 2 * math.sin(angle), p.y)))
        rows.append(row)
    for j in range(rings):
        for i in range(segments):
            k = (i + 1) % segments
            mesh.faces.new((rows[j][i], rows[j][k], rows[j + 1][k], rows[j + 1][i]))
    mesh.faces.new(rows[0])
    mesh.faces.new(list(reversed(rows[-1])))
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    data = bpy.data.meshes.new(name)
    mesh.to_mesh(data)
    mesh.free()
    for polygon in data.polygons:
        polygon.use_smooth = True
    return link(name, data)


def artwork(texture, rig):
    data = bpy.data.meshes.new("Unchanged Cappy artwork")
    extent = 1.27
    data.from_pydata([(-extent, -0.172, -extent), (extent, -0.172, -extent),
                     (extent, -0.172, extent), (-extent, -0.172, extent)], [], [(0, 1, 2, 3)])
    uv = data.uv_layers.new()
    for loop, coordinates in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = coordinates
    obj = link("Cappy artwork - original colors and proportions", data)
    obj.parent = rig
    mat = material("Cappy artwork", **{"Roughness": 0.38, "Emission Strength": 0.25})
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    image = nodes.new("ShaderNodeTexImage")
    image.image = bpy.data.images.load(str(texture))
    image.image.pack()
    image.extension = "CLIP"
    shader = nodes["Principled BSDF"]
    links.new(image.outputs["Color"], shader.inputs["Base Color"])
    links.new(image.outputs["Color"], shader.inputs["Emission Color"])
    links.new(image.outputs["Alpha"], shader.inputs["Alpha"])
    obj.data.materials.append(mat)
    return obj


def light(name, location, energy, width, height, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, "AREA")
    data.shape, data.size, data.size_y = "RECTANGLE", width, height
    data.energy, data.color = energy, color
    obj = link(name, data)
    obj.location = location
    obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def build(args):
    root = Path(__file__).resolve().parents[2]
    texture = root / "assets/brand/cappy-transparent.png"
    if not texture.is_file():
        raise FileNotFoundError("assets/brand/cappy-transparent.png is required")
    output = (args.output or root / "artifacts/brand").resolve()
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 16
    scene.cycles.transmission_bounces = 12
    scene.cycles.transparent_max_bounces = 16
    scene.render.resolution_x = scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 180
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Khronos PBR Neutral"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    if "METAL" in [item.identifier for item in preferences.bl_rna.properties["compute_device_type"].enum_items]:
        preferences.compute_device_type = "METAL"
        preferences.get_devices()
        if any(device.type == "METAL" for device in preferences.devices):
            for device in preferences.devices:
                device.use = device.type == "METAL"
            scene.cycles.device = "GPU"

    world = bpy.data.worlds.new("Diffuse studio fill")
    scene.world = world
    if not world.node_tree:
        world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.2, 0.2, 0.24, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    world.cycles_visibility.glossy = False
    world.cycles_visibility.transmission = False

    rig = link("Cappy glass emblem", None)
    shell = slab("Polished glass outer", 1.5, 0.52, 0.2)
    cavity = slab("Glass cavity", 1.455, 0.43, 0.155)
    for polygon in cavity.data.polygons:
        polygon.flip()
    glass = material("Purple liquid glass", **{
        "Base Color": (0.87, 0.78, 1, 1), "Roughness": 0.015,
        "Transmission Weight": 1, "IOR": 1.47,
        "Coat Weight": 1, "Coat Roughness": 0.025,
        "Thin Film Thickness": 310, "Thin Film IOR": 1.33,
    })
    for obj in [shell, cavity]:
        obj.parent = rig
        obj.data.materials.append(glass)

    back = slab("Violet anodized backing", 1.43, 0.11, 0.13)
    back.location.y = 0.18
    back.parent = rig
    back.data.materials.append(material("Polished violet metal", **{
        "Base Color": (0.105, 0.012, 0.27, 1), "Metallic": 0.82,
        "Roughness": 0.13, "Coat Weight": 1, "Coat Roughness": 0.045,
    }))
    artwork(texture, rig)

    key = light("Soft artwork key", (-3.2, -4, 4), 850, 3.5, 2)
    key.visible_glossy = key.visible_transmission = False
    light("Silver left strip", (-4, -0.5, 0.2), 1100, 0.18, 7)
    light("Violet right strip", (4, 0.4, 0.5), 1000, 0.2, 7, (0.68, 0.42, 1))
    light("Top bevel", (0, -0.4, 4.6), 500, 5, 0.18)
    light("Rear purple rim", (1, 3, 2), 650, 0.2, 5, (0.55, 0.2, 1))
    sweep = light("Moving reflection strip", (-4, -4, 0.5), 0, 0.12, 5)
    sweep.visible_diffuse = sweep.visible_transmission = False

    camera = link("Camera", bpy.data.cameras.new("Camera"))
    camera.location = (0, -8.2, 0.05)
    camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 54
    scene.camera = camera
    for frame, yaw, pitch in [(1, -18, -5), (60, 18, 4), (120, -8, -2), (180, -18, -5)]:
        rig.rotation_euler = (math.radians(pitch), 0, math.radians(yaw))
        rig.keyframe_insert(data_path="rotation_euler", frame=frame)
    for frame, x in [(1, -4), (75, 4), (76, -4), (180, -4)]:
        sweep.location.x = x
        sweep.rotation_euler = (-sweep.location).to_track_quat("-Z", "Y").to_euler()
        sweep.keyframe_insert(data_path="location", frame=frame)
        sweep.keyframe_insert(data_path="rotation_euler", frame=frame)
    for frame, energy in [(1, 0), (25, 0), (35, 350), (65, 350), (75, 0), (180, 0)]:
        sweep.data.energy = energy
        sweep.data.keyframe_insert(data_path="energy", frame=frame)
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "cappy-glass.blend"))
    if args.preview:
        scene.render.filepath = str(output / "cappy-glass-preview.png")
        bpy.ops.render.render(write_still=True)
    if args.plate:
        scene.frame_end = 90
        scene.render.filepath = str(output / "frames" / "glass-")
        (output / "frames").mkdir(exist_ok=True)
        bpy.ops.render.render(animation=True)
    print("Cappy glass scene saved; original mascot artwork preserved.")


if __name__ == "__main__":
    build(arguments())
