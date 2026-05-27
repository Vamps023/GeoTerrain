# GeoTerrain Bridge for Blender

> **SYNC NOTE**: This directory is a copy of the canonical addon source at
> `EnginesAddOn/GeoTerrainBlender/`. Do NOT edit files here directly.
> Any changes must be made in the canonical source and then copied here.
> To sync: copy all files from `EnginesAddOn/GeoTerrainBlender/` into this directory.

Blender addon to import terrain packages from **GeoTerrain Studio**.

## Features

- Import `.terrain` packages with one click
- Automatic displacement modifier setup
- Albedo texture mapping
- Multi-tile support

## Installation

1. Download this folder as ZIP
2. Blender → Edit → Preferences → Add-ons → Install
3. Select `GeoTerrainBlender.zip`
4. Enable "GeoTerrain Bridge"

## Usage

1. **Export** from GeoTerrain Studio (any preset)
2. In Blender, open Sidebar (N) → **GeoTerrain** tab
3. Click folder icon, select your `.terrain` package folder
4. Click **Import GeoTerrain Package**

## Requirements

- Blender 4.0 or newer
- GeoTerrain Studio exported package

## How It Works

The addon reads `manifest.json` and creates:
- Subdivided plane mesh per tile
- Displacement modifier with heightmap
- Subdivision Surface for smoothness
- Material with albedo texture

Terrain is positioned using `worldOffset` from the manifest.

## File Structure

```
GeoTerrainBlender/
├── __init__.py      # Addon entry point
├── operators.py     # Import logic
├── panels.py        # UI panel
└── README.md        # This file
```

## Support

For issues, contact GeoTerrain Studio support.
