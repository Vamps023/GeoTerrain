# GeoTerrain Bridge for UNIGINE

**Lightweight UNIGINE editor plugin for importing Terrain Packages.**

The Bridge reads terrain data packages produced by **GeoTerrain Studio** and builds `LandscapeLayerMap` terrain assets inside the UNIGINE Editor. It contains **no GDAL, no libcurl, and no SQLite** — just a fast manifest parser and UNIGINE SDK integration.

## Why a Separate Bridge?

| Before (Monolithic) | After (Split) |
|--------------------|---------------|
| Plugin downloads, processes, and builds terrain | Studio downloads & processes; Bridge only imports |
| Requires GDAL + OSGeo4W (50+ MB) | ~2 MB Qt plugin |
| Locked to UNIGINE | Studio works with any engine |
| Must launch UNIGINE to download | Download terrain on any machine |

## Building

```bash
mkdir build_bridge && cd build_bridge
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja
ninja deploy_bridge
```

## Requirements

- UNIGINE SDK 2.18 sim
- Qt 5.12.3 MSVC 2017 x64
- Visual Studio 2022
- CMake 3.16+

## Usage

1. Export a Terrain Package from **GeoTerrain Studio**.
2. In UNIGINE Editor, open **VampsPlugin → GeoTerrain Bridge**.
3. Click **Browse** and select the `.terrain` folder.
4. Click **Validate** to inspect tiles and verify files.
5. Adjust **LMAP Resolution** and **Material Preset**.
6. Click **Build Terrain**.

The Bridge will:
- Parse `manifest.json`
- Create `LandscapeLayerMap` nodes for each tile
- Apply world-space offsets from the manifest
- Assign heightmap, albedo, and splat textures
- Set up materials

## Project Structure

```
GeoTerrainBridge/
├── CMakeLists.txt
├── GeoTerrainBridge.json      # Plugin manifest
├── src/
│   ├── bridge_plugin.h/cpp    # UNIGINE plugin entry
│   ├── bridge_panel.h/cpp     # Qt UI (browse, validate, build)
│   └── package_reader.h/cpp   # manifest.json parser (no external deps)
```
