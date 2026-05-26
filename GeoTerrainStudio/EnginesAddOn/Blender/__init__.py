bl_info = {
    "name": "GeoTerrain Bridge",
    "author": "GeoTerrain Studio",
    "version": (1, 0, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > GeoTerrain",
    "description": "Import terrain packages from GeoTerrain Studio",
    "category": "Import-Export",
}

import bpy
import json
import os
from pathlib import Path

from . import operators
from . import panels

classes = [
    operators.GEOTERRAIN_OT_import_package,
    panels.GEOTERRAIN_PT_main_panel,
]

def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    
    bpy.types.Scene.geoterrain_package_path = bpy.props.StringProperty(
        name="Package Path",
        description="Path to .terrain package folder",
        default="",
        subtype='DIR_PATH'
    )

def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
    
    del bpy.types.Scene.geoterrain_package_path

if __name__ == "__main__":
    register()
