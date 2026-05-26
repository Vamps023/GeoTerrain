import bpy
import bmesh
import json
import os
from pathlib import Path

class GEOTERRAIN_OT_import_package(bpy.types.Operator):
    bl_idname = "geoterrain.import_package"
    bl_label = "Import GeoTerrain Package"
    bl_description = "Import a .terrain package from GeoTerrain Studio"
    bl_options = {'REGISTER', 'UNDO'}
    
    filepath: bpy.props.StringProperty(subtype='DIR_PATH')
    
    def execute(self, context):
        package_path = context.scene.geoterrain_package_path
        
        if not package_path or not os.path.isdir(package_path):
            self.report({'ERROR'}, "Please select a valid package folder")
            return {'CANCELLED'}
        
        manifest_path = os.path.join(package_path, "manifest.json")
        if not os.path.exists(manifest_path):
            self.report({'ERROR'}, "No manifest.json found in package")
            return {'CANCELLED'}
        
        # Load manifest
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
        
        tiles = manifest.get('tiles', [])
        if not tiles:
            self.report({'ERROR'}, "No tiles in manifest")
            return {'CANCELLED'}
        
        imported_count = 0
        
        for tile in tiles:
            row = tile.get('row', 0)
            col = tile.get('col', 0)
            files = tile.get('files', {})
            elevation = tile.get('elevation', {})
            world_offset = tile.get('worldOffset', {'x': 0, 'y': 0, 'z': 0})
            
            heightmap_file = files.get('heightmap')
            albedo_file = files.get('albedo')
            
            if not heightmap_file:
                continue
            
            heightmap_path = os.path.join(package_path, heightmap_file)
            if not os.path.exists(heightmap_path):
                continue
            
            # Create mesh for this tile
            mesh_name = f"Terrain_{row}_{col}"
            mesh = bpy.data.meshes.new(mesh_name)
            obj = bpy.data.objects.new(mesh_name, mesh)
            context.collection.objects.link(obj)
            
            # Build displacement modifier setup
            self._setup_terrain_mesh(context, obj, mesh, heightmap_path, albedo_file, 
                                       elevation, world_offset, package_path)
            
            imported_count += 1
        
        self.report({'INFO'}, f"Imported {imported_count} tile(s)")
        return {'FINISHED'}
    
    def _setup_terrain_mesh(self, context, obj, mesh, heightmap_path, albedo_file, 
                           elevation, world_offset, package_path):
        """Setup a plane with displacement modifier for terrain"""
        
        # Get resolution from manifest or default
        res = 128  # default subdivision (cuts)
        
        # Create base plane
        bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
        plane_obj = context.active_object
        
        # Rename and setup
        plane_obj.name = obj.name
        
        # Set world position
        plane_obj.location.x = world_offset.get('x', 0) / 1000  # convert to km
        plane_obj.location.y = world_offset.get('z', 0) / 1000  # z in GeoTerrain = y in Blender
        plane_obj.location.z = 0
        
        # Scale to tile size (chunkSizeM from manifest, default 4km)
        tile_size_m = 4000
        plane_obj.scale = (tile_size_m / 1000, tile_size_m / 1000, 1)
        
        # Subdivide for displacement
        bpy.context.view_layer.objects.active = plane_obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.subdivide(number_cuts=res)
        bpy.ops.object.mode_set(mode='OBJECT')
        
        # Add subdivision surface for smoothness
        subsurf = plane_obj.modifiers.new(name="Subdivision", type='SUBSURF')
        subsurf.levels = 2
        subsurf.render_levels = 3
        
        # Add displacement modifier
        disp = plane_obj.modifiers.new(name="GeoTerrain_Displace", type='DISPLACE')
        
        # Load heightmap as texture
        tex = bpy.data.textures.new(name=f"Height_{obj.name}", type='IMAGE')
        
        # Import the heightmap image
        img = bpy.data.images.load(heightmap_path)
        tex.image = img
        
        disp.texture = tex
        disp.texture_coords = 'LOCAL'
        disp.direction = 'Z'
        disp.mid_level = 0
        
        # Calculate strength from elevation range
        elev_min = elevation.get('min', 0)
        elev_max = elevation.get('max', 100)
        elev_range = elev_max - elev_min
        disp.strength = elev_range / 1000  # scale to km
        
        # Apply albedo texture if available
        if albedo_file:
            albedo_path = os.path.join(package_path, albedo_file)
            if os.path.exists(albedo_path):
                # Create material with albedo
                mat = bpy.data.materials.new(name=f"Mat_{obj.name}")
                mat.use_nodes = True
                nodes = mat.node_tree.nodes
                links = mat.node_tree.links
                
                # Clear default
                nodes.clear()
                
                # Add nodes
                output = nodes.new('ShaderNodeOutputMaterial')
                diffuse = nodes.new('ShaderNodeBsdfDiffuse')
                tex_image = nodes.new('ShaderNodeTexImage')
                
                # Load albedo
                albedo_img = bpy.data.images.load(albedo_path)
                tex_image.image = albedo_img
                
                # Link
                links.new(tex_image.outputs['Color'], diffuse.inputs['Color'])
                links.new(diffuse.outputs['BSDF'], output.inputs['Surface'])
                
                # Assign material
                plane_obj.data.materials.append(mat)
        
        # Shade smooth
        bpy.ops.object.shade_smooth()
        
        return plane_obj

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self)
