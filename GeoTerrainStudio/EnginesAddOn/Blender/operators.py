import bpy
import bmesh
import json
import os
from pathlib import Path
import glob

class GEOTERRAIN_OT_import_package(bpy.types.Operator):
    bl_idname = "geoterrain.import_package"
    bl_label = "Import GeoTerrain Package"
    bl_description = "Import a .terrain package from GeoTerrain Studio"
    bl_options = {'REGISTER', 'UNDO'}
    
    filepath: bpy.props.StringProperty(subtype='DIR_PATH')
    
    def _find_tiles(self, package_path):
        """Find all tiles in the package, supporting both single manifest and multi-tile subfolder structures."""
        tiles = []
        
        # First, try to find a root manifest.json (single tile or multi-tile package)
        manifest_path = os.path.join(package_path, "manifest.json")
        if os.path.exists(manifest_path):
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            manifest_tiles = manifest.get('tiles', [])
            if manifest_tiles:
                # Root manifest exists with tiles - use it
                for tile in manifest_tiles:
                    tiles.append({
                        'tile_data': tile,
                        'tile_path': package_path  # Files are relative to root
                    })
                return tiles
        
        # No root manifest or empty - look for tile subfolders (GeoTerrain Studio multi-tile export)
        tile_pattern = os.path.join(package_path, "tile_*_*")
        tile_folders = glob.glob(tile_pattern)
        
        if not tile_folders:
            self.report({'ERROR'}, "No manifest.json found and no tile folders detected.\nExpected tile_0_0, tile_0_1, etc.")
            return None
        
        # Collect tiles from each subfolder
        for tile_folder in sorted(tile_folders):
            tile_manifest_path = os.path.join(tile_folder, "manifest.json")
            if not os.path.exists(tile_manifest_path):
                continue
            
            try:
                with open(tile_manifest_path, 'r') as f:
                    tile_manifest = json.load(f)
                tile_data = tile_manifest.get('tiles', [])
                if tile_data:
                    tiles.append({
                        'tile_data': tile_data[0],  # Each subfolder has 1 tile
                        'tile_path': tile_folder    # Files are relative to this subfolder
                    })
            except (json.JSONDecodeError, IOError) as e:
                print(f"[GeoTerrain] Warning: Could not read {tile_manifest_path}: {e}")
                continue
        
        if not tiles:
            self.report({'ERROR'}, "Found tile folders but could not read any manifests")
            return None
            
        return tiles
    
    def execute(self, context):
        package_path = context.scene.geoterrain_package_path
        
        # Debug output
        print(f"[GeoTerrain] Package path raw: '{package_path}'")
        
        # Normalize path (handle Blender's path format)
        if package_path:
            package_path = os.path.normpath(package_path)
            # Remove trailing backslash if present (can cause issues)
            package_path = package_path.rstrip('\\/')
        
        print(f"[GeoTerrain] Package path normalized: '{package_path}'")
        print(f"[GeoTerrain] Path exists: {os.path.exists(package_path) if package_path else False}")
        print(f"[GeoTerrain] Is directory: {os.path.isdir(package_path) if package_path else False}")
        
        if not package_path:
            self.report({'ERROR'}, "No package folder selected.\nClick the 'Package Path' field and browse for your export folder.")
            return {'CANCELLED'}
        
        if not os.path.exists(package_path):
            self.report({'ERROR'}, f"Path does not exist:\n{package_path}")
            return {'CANCELLED'}
            
        if not os.path.isdir(package_path):
            self.report({'ERROR'}, f"Selected path is not a folder:\n{package_path}")
            return {'CANCELLED'}
        
        # Find all tiles (handles both single and multi-tile structures)
        tile_infos = self._find_tiles(package_path)
        if tile_infos is None:
            return {'CANCELLED'}
        
        if not tile_infos:
            self.report({'ERROR'}, "No tiles found in package")
            return {'CANCELLED'}
        
        root_manifest = None
        root_manifest_path = os.path.join(package_path, "manifest.json")
        if os.path.exists(root_manifest_path):
            try:
                with open(root_manifest_path, "r") as f:
                    root_manifest = json.load(f)
            except Exception:
                root_manifest = None

        imported_count = 0
        failed_tiles = []
        
        for tile_info in tile_infos:
            tile = tile_info['tile_data']
            tile_path = tile_info['tile_path']  # Path where this tile's files are located
            
            row = tile.get('row', 0)
            col = tile.get('col', 0)
            files = tile.get('files', {})
            elevation = tile.get('elevation', {})
            world_offset = tile.get('worldOffset', {'x': 0, 'y': 0, 'z': 0})
            
            heightmap_file = files.get('heightmap')
            albedo_file = files.get('albedo')
            
            if not heightmap_file:
                failed_tiles.append(f"tile_{row}_{col} (no heightmap file)")
                continue
            
            # Look for heightmap in the tile's specific folder
            heightmap_path = os.path.join(tile_path, heightmap_file)
            if not os.path.exists(heightmap_path):
                # Try alternative: maybe files are in subdirectories
                alt_path = os.path.join(tile_path, "heightmap", heightmap_file)
                if os.path.exists(alt_path):
                    heightmap_path = alt_path
                else:
                    failed_tiles.append(f"tile_{row}_{col} (heightmap not found: {heightmap_file})")
                    continue
            
            # Create mesh for this tile
            mesh_name = f"Terrain_{row}_{col}"
            mesh = bpy.data.meshes.new(mesh_name)
            obj = bpy.data.objects.new(mesh_name, mesh)
            context.collection.objects.link(obj)
            
            # Build displacement modifier setup (pass tile_path for finding albedo)
            try:
                self._setup_terrain_mesh(
                    context,
                    obj,
                    mesh,
                    heightmap_path,
                    albedo_file,
                    elevation,
                    world_offset,
                    tile_path,
                    row,
                    col,
                    root_manifest
                )
                imported_count += 1
            except Exception as e:
                failed_tiles.append(f"tile_{row}_{col} ({str(e)})")
                print(f"[GeoTerrain] Error importing tile_{row}_{col}: {e}")
                continue
        
        # Report results
        if failed_tiles:
            self.report({'WARNING'}, f"Imported {imported_count} tile(s), failed: {', '.join(failed_tiles[:3])}{'...' if len(failed_tiles) > 3 else ''}")
        else:
            self.report({'INFO'}, f"Successfully imported {imported_count} tile(s)")
        return {'FINISHED'}
    
    def _setup_terrain_mesh(self, context, obj, mesh, heightmap_path, albedo_file,
                           elevation, world_offset, package_path, row, col, root_manifest):
        """Setup a plane with displacement modifier for terrain"""
        
        # Get resolution from manifest or default
        res = 128  # default subdivision (cuts)
        
        # Create base plane
        bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
        plane_obj = context.active_object
        
        # Rename and setup
        plane_obj.name = obj.name
        
        # Resolve tile size (meters) from manifest if present.
        tile_size_m = 4000.0
        if root_manifest:
            tile_grid = root_manifest.get("tileGrid", {}) or {}
            tile_size_m = float(tile_grid.get("chunkSizeM", tile_size_m))

        # Resolve world placement.
        # Use manifest worldOffset when valid, otherwise deterministic row/col fallback.
        wx = float(world_offset.get('x', 0.0))
        wz = float(world_offset.get('z', 0.0))
        has_world_offset = abs(wx) > 1e-6 or abs(wz) > 1e-6
        if not has_world_offset:
            wx = float(col) * tile_size_m
            wz = float(row) * tile_size_m

        # Blender default units are meters; keep meter scale (no km conversion).
        plane_obj.location.x = wx
        plane_obj.location.y = wz  # GeoTerrain Z axis maps to Blender Y for ground plane
        plane_obj.location.z = 0.0

        # primitive_plane_add(size=1) gives 2m x 2m plane -> scale to desired meters
        plane_obj.scale = (tile_size_m * 0.5, tile_size_m * 0.5, 1.0)
        
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
        # Heightmaps are normalized to 0..1 for displacement texture sampling.
        # 0.5 keeps average elevation around base plane; gives visible relief.
        disp.mid_level = 0.5
        
        # Calculate strength from elevation range
        elev_min = elevation.get('min', 0)
        elev_max = elevation.get('max', 100)
        elev_range = elev_max - elev_min
        # Keep elevation in meters for Blender scenes using metric units.
        # Avoid tiny/flat terrain caused by km conversion.
        disp.strength = max(1.0, float(elev_range))
        
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
