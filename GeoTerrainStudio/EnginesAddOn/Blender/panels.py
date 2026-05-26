import bpy

class GEOTERRAIN_PT_main_panel(bpy.types.Panel):
    bl_label = "GeoTerrain Bridge"
    bl_idname = "GEOTERRAIN_PT_main_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "GeoTerrain"
    
    def draw(self, context):
        layout = self.layout
        scene = context.scene
        
        # Header
        layout.label(text="Import Terrain Package", icon='IMPORT')
        layout.separator()
        
        # Package path
        layout.prop(scene, "geoterrain_package_path")
        layout.separator()
        
        # Import button
        row = layout.row()
        row.scale_y = 1.5
        row.operator("geoterrain.import_package", icon='MESH_GRID')
        
        # Instructions
        layout.separator()
        box = layout.box()
        box.label(text="Instructions:", icon='INFO')
        box.label(text="1. Export from GeoTerrain Studio")
        box.label(text="2. Select .terrain folder above")
        box.label(text="3. Click Import")
        
        # Info
        layout.separator()
        layout.label(text="v1.0.0 — Blender 4.0+", icon='FILE_BLEND')
