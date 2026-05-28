# GeoTerrain Bridge for Unigine

Unigine Editor plugin to import terrain packages from **GeoTerrain Studio** directly into Unigine Landscape Terrain.

## Features

- Import heightmaps (PNG / GeoTIFF) into Landscape Terrain tiles
- Import albedo (satellite imagery) into terrain albedo channel
- Multi-tile support — matches tiles by `tile_<row>_<col>` naming
- Async GPU dispatch via `Landscape::asyncTextureDraw` (non-blocking)
- Deferred save batching via `LandscapeSaveManager`

## Requirements

- Unigine 2.18+ (Editor2, double precision, x64)
- Qt5 (matching Unigine Editor's Qt version)
- Visual Studio 2022 Build Tools (or full VS2022)
- Ninja build system
- GeoTerrain Studio exported package

## Project Structure

```
GeoTerrainUnigine/
├── CMakeLists.txt                          # Main build configuration
├── build_ninja.bat                         # Windows build script
├── local_paths.cmake.example               # Template for SDK paths
├── Content/
│   ├── geoterrain_brush_r32f_overwrite.basebrush      # Height overwrite brush
│   └── geoterrain_brush_albedo_overwrite.basebrush    # Albedo overwrite brush
└── source/
    ├── core/
    │   ├── GeoTerrainBridgeEditorPlugin.h/.cpp/.json   # Plugin entry point
    │   └── NodeTreeWalker.h                            # Scene graph utilities
    ├── landscape/
    │   └── LandscapeSaveManager.h/.cpp                 # Async save batching
    ├── terrain/
    │   └── BrushMaterialFactory.h/.cpp                 # Material helpers
    ├── importer/
    │   └── GeoTerrainImporter.h/.cpp                   # Package parsing + import
    └── ui/
        ├── GeoTerrainPanel.h/.cpp                      # Qt dockable panel
        └── GeoTerrainController.h/.cpp                 # UI logic mediator
```

## Build Instructions

### 1. Configure Local Paths

Copy `local_paths.cmake.example` to `local_paths.cmake` and edit the paths:

```cmake
set(QT5_DIR        "C:/Qt/Qt5.12.3/5.12.3/msvc2017_64")
set(UNIGINE_SDK_DIR "C:/Users/<you>/AppData/Local/unigine/browser/sdks/sim_windows_2.18.1_bin")
set(DEPLOY_BASE_DIR "D:/Unigine/unigine_project")
```

### 2. Build

```batch
build_ninja.bat
```

This will:
- Configure CMake with Ninja generator
- Build the plugin DLL
- Deploy to `<DEPLOY_BASE_DIR>/bin/plugins/GeoTerrainStudio/GeoTerrainBridge/`
- Copy brush assets to `<DEPLOY_BASE_DIR>/data/`

### 3. Deploy Structure

After build, your Unigine project should have:

```
<UnigineProject>/
├── bin/
│   └── plugins/
│       └── GeoTerrainStudio/
│           └── GeoTerrainBridge/
│               ├── GeoTerrainBridge_editorplugin_double_x64.dll
│               └── GeoTerrainBridgeEditorPlugin.json
└── data/
    ├── geoterrain_brush_r32f_overwrite.basebrush
    └── geoterrain_brush_albedo_overwrite.basebrush
```

## Usage

1. **Export** from GeoTerrain Studio using the `unigine` preset (or any preset with PNG heightmap + albedo)
2. Open **Unigine Editor2**
3. Look for **GeoTerrain** menu in the menu bar
4. Click **GeoTerrain Bridge** to open the panel
5. Click **Browse...** and select your exported package folder
6. Choose target tile (or leave "All Tiles" for auto-match by name)
7. Check **Import Albedo** if you want satellite imagery
8. Click **Import GeoTerrain Package**
9. Watch the progress bar — saves are batched and flushed automatically

## How It Works

1. **Parse Manifest** — reads `manifest.json` (root or tile subfolders)
2. **Match Tiles** — finds `LandscapeLayerMap` tiles by `tile_<row>_<col>` name
3. **Load Images** — converts heightmap PNG to `RGBA32F` world-space heights
4. **Async Dispatch** — queues `Landscape::asyncTextureDraw` per tile
5. **GPU Overwrite** — custom `.basebrush` material overwrites height + opacity
6. **Save Batching** — `LandscapeSaveManager` batches all tile saves into one transaction

## Troubleshooting

| Issue | Solution |
|---|---|
| Plugin not showing in Editor | Verify DLL and `.json` are in `bin/plugins/GeoTerrainStudio/GeoTerrainBridge/` |
| "No active landscape terrain" | Create a Landscape Terrain object in the world first |
| "Failed to load height overwrite material" | Verify `.basebrush` files are in the project's `data/` folder |
| Heightmap looks flat | Check `elevation.min` / `elevation.max` in manifest.json |
| Tiles not matching | Ensure LandscapeLayerMap children are named `tile_0_0`, `tile_0_1`, etc. |

## License

Part of the GeoTerrain project. See root repository for license details.
