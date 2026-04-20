# GeoTerrain Generator — UNIGINE Editor Plugin

A UNIGINE 2.18 editor plugin that downloads real-world DEM (heightmap) and satellite imagery, processes them through GDAL, and generates `LandscapeLayerMap` terrain assets aligned in world space.

---

## Features

- **Interactive map selection** — draw a bounding box on a live TMS map
- **DEM download** — SRTM 30m/90m, ALOS AW3D30, Copernicus GLO-30, NASADEM, USGS 3DEP 10m via OpenTopography API
- **Satellite albedo download** — any TMS tile URL (default: Esri World Imagery)
- **Multi-chunk tiling** — divides large areas into NxN chunks, downloads and processes each independently
- **Terrain builder** — single-tile and multi-tile modes, generates `.lmap` files and places `LandscapeLayerMap` nodes at correct world-space positions
- **OSM vector data** — downloads roads, railways, buildings, water, vegetation from Overpass API
- **Mask generation** — rasterises OSM features into a road/feature mask GeoTIFF
- **Unreal Engine RAW export** — exports heightmap as a 16-bit `.r16` file for Unreal landscape import
- **API key hidden by default** — Show/Hide toggle on the Sources tab

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| UNIGINE SDK | 2.18 sim | `sim_windows_2.18.0.1_bin` |
| Qt | 5.12.3 | MSVC 2017 x64 |
| Visual Studio | 2022 (v143) | C++17 |
| CMake | 3.16+ | |
| OSGeo4W / GDAL | 3.x | `gdal_i.lib`, `libcurl_imp.lib` |
| OpenTopography API key | — | Free registration at [opentopography.org](https://opentopography.org) |

---

## Building

### 1. Install Dependencies

- Install [OSGeo4W](https://trac.osgeo.org/osgeo4w/) (includes GDAL + libcurl)
- Install [Qt 5.12.3 MSVC 2017 x64](https://download.qt.io/archive/qt/5.12/5.12.3/)
- Install Visual Studio 2022 with C++ Desktop workload

### 2. Configure Paths

Edit `CMakeLists.txt` to match your environment:

```cmake
set(UNIGINE_SDK_DIR  "C:/Path/To/unigine/browser/sdks/sim_windows_2.18.0.1_bin")
set(OSGEO4W_DIR      "C:/Path/To/OSGeo4W")
set(CMAKE_PREFIX_PATH "C:/Path/To/Qt5.12.3/5.12.3/msvc2017_64")
set(DEPLOY_DIR       "C:/Path/To/YourUnigineProject/bin/plugins/Vamps/GeoTerrain")
```

### 3. Build & Deploy

```bat
build_ninja.bat
```

This configures CMake, compiles the plugin DLL, and copies it to your UNIGINE project's plugin folder automatically.

---

## Usage

### Single-Tile Terrain

1. **Map tab** — draw a selection rectangle on the map
2. **Sources tab** — choose DEM source, enter API key, set TMS URL
3. **Parameters tab** — set resolution, zoom level, map size (1K–4K)
4. **Generate tab** — click **Generate**, monitor the log
5. **Generate tab** — click **Gather** to copy outputs to `GatheredExport/`
6. **Terrain tab** — set heightmap path, albedo path, output `.lmap` path → click **Build Terrain**

### Multi-Tile Terrain

1. Complete Steps 1–5 above for all chunks (enable all chunks in the chunk grid)
2. **Terrain tab** — enable **Multi-Tile Mode**
3. Set:
   - **Heightmap Folder** → `GatheredExport/heightmap/`
   - **Albedo Folder** → `GatheredExport/albedo/`
   - **Output .lmap Folder** → your UNIGINE `data/` folder
4. Click **Build Terrain**

The plugin reads `chunk_R_C_heightmap.tif` filenames to determine each chunk's row/col position in the full grid and places each `LandscapeLayerMap` node at the correct world-space offset.

---

## File Naming Convention

Files produced by **Gather** follow this pattern:

```
GatheredExport/
  heightmap/
    chunk_0_0_heightmap.tif    ← row 0, col 0
    chunk_0_1_heightmap.tif    ← row 0, col 1
    chunk_1_0_heightmap.tif
    ...
  albedo/
    chunk_0_0_albedo.tif
    chunk_0_1_albedo.tif
    ...
```

`R` = grid row (0 = northernmost), `C` = grid column (0 = westernmost).

---

## Project Structure

```
source/
  application/       ← Core logic (TerrainBuilder, ChunkPlanner, coordinators)
  domain/            ← Types, validation, Result<T>
  infrastructure/    ← GDAL utils, manifest writer, overlay loader
  pipeline/          ← DEMFetcher, TileDownloader, OSMParser, MaskGenerator
  ui/                ← Qt widgets (panel, sections)
  plugin/            ← UNIGINE plugin entry point
tests/               ← Core unit tests (no UNIGINE dependency)
third_party/
  nlohmann/          ← json.hpp (header-only)
```

---

## API Key Security

- The API key field is **masked by default** (password mode)
- Click **Show** / **Hide** next to the field to reveal it
- **Never commit your API key** — the field is not persisted to disk between sessions

To get a free OpenTopography API key: https://opentopography.org/developers

---

## Coordinate System Notes

- GeoTIFFs store row 0 at **north** (top of image)
- UNIGINE world Y increases **northward**
- The terrain builder flips Y globally when sampling heightmap/albedo tiles so north maps to +Y
- Chunk `chunk_R_C`: row 0 = northernmost row (+Y), increasing R moves south (−Y)

---

## License

Internal tool — Vamps. Not for redistribution.
