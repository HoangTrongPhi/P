"""Run inside Blender to generate real-world fixtures:

    blender -b --factory-startup -P blender_make_fixtures.py -- <out_dir> <external_tex_dir>

Creates:
  <out_dir>/crate_abs.fbx        binary FBX whose texture points at an absolute path
  <out_dir>/crate.glb, crate.obj (+ .mtl, texture copied next to it)
  <out_dir>/scene/crate.blend    .blend referencing the same external texture (not packed)
  <external_tex_dir>/crate_diffuse.png
"""
import os
import sys

import bpy

out_dir, tex_dir = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(out_dir, exist_ok=True)
os.makedirs(tex_dir, exist_ok=True)
os.makedirs(os.path.join(out_dir, "scene"), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

tex_path = os.path.join(tex_dir, "crate_diffuse.png")
img = bpy.data.images.new("crate_diffuse", 16, 16)
img.pixels[:] = [0.8, 0.4, 0.1, 1.0] * (16 * 16)
img.filepath_raw = tex_path
img.file_format = "PNG"
img.save()

bpy.ops.mesh.primitive_cube_add()
obj = bpy.context.active_object
obj.name = "Crate"
mat = bpy.data.materials.new("CrateMat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
tex_node = nodes.new("ShaderNodeTexImage")
tex_node.image = img
mat.node_tree.links.new(tex_node.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
obj.data.materials.append(mat)

bpy.ops.export_scene.fbx(
    filepath=os.path.join(out_dir, "crate_abs.fbx"),
    path_mode="ABSOLUTE",
    embed_textures=False,
)
bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, "crate.glb"), export_format="GLB")
bpy.ops.wm.obj_export(filepath=os.path.join(out_dir, "crate.obj"), path_mode="COPY")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "scene", "crate.blend"), relative_remap=False)
# keep the absolute path in the .blend so the packer has something to fix
print("FIXTURES_OK")
