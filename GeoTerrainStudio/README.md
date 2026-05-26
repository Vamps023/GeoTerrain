# GeoTerrain Studio

**Standalone, cross-platform desktop tool for extracting real-world terrain and exporting it to game engines.**

GeoTerrain Studio downloads DEM (heightmap) and satellite imagery from free public tile services, crops/resizes them to a user-selected bounding box, and writes a self-contained `.terrain` package that can be imported into UNIGINE, Unreal, Unity, Godot, Babylon.js, or any GeoTIFF-aware pipeline.

![status](https://img.shields.io/badge/status-beta-blue) ![license](https://img.shields.io/badge/license-UNLICENSED-lightgrey) ![platform](https://img.shields.io/badge/platform-Win%20%7C%20macOS%20%7C%20Linux-informational)

---

## Features

- **Interactive 2D map** (MapLibre GL + ArcGIS World Imagery basemap) with shift-drag bounding-box selection and a click-to-toggle tile grid.
- **Configurable tile grid** (1 / 2 / 4 / 8 km tiles) so large areas can be exported chunk-by-chunk.
- **Free data sources, no API key required** for the defaults:
  - DEM: AWS Terrarium (`elevation-tiles-prod`)
  - Imagery: ArcGIS World Imagery
  - Optional: Mapbox Satellite, MapTiler Satellite (require user-supplied tokens)
- **Multiple heightmap formats:** GeoTIFF (signed 16-bit), RAW R16, 16-bit PNG.
- **Engine presets:** UNIGINE, Unreal Engine, Unity, Godot, Babylon.js, Generic.
- **Built-in 3D preview** using Babylon.js — load an exported package and walk the terrain.
- **Project save / load** (`.gtp`) with bounds, tile selection and imported shapefile overlay.
- **Shapefile overlay** — drag-and-drop a `.shp` (+`.dbf`/`.prj`) to display reference polygons/lines on the map.

---

## Supported Engines

| Engine | Heightmap | Albedo | Notes |
|--------|-----------|--------|-------|
| UNIGINE | GeoTIFF | PNG | `.lmap` + material set built by the GeoTerrain Bridge plugin |
| Unreal Engine | R16 | PNG | Drop straight into the Landscape importer |
| Unity | R16 | PNG | Terrain importer "Raw" mode |
| Godot | GeoTIFF | PNG | HeightMapShape3D / TextureLayered |
| Babylon.js | GeoTIFF | PNG | Previewed directly in the built-in 3D viewer |
| Generic | GeoTIFF | GeoTIFF | Geo-referenced bundle for QGIS / GDAL workflows |

---

## Technology Stack

| Layer | Tech |
|-------|------|
| Shell | Electron 34 |
| UI | React 18, TypeScript 5.4, Tailwind CSS 3.4 |
| Bundler | Vite 5 |
| State | Zustand |
| 2D Map | MapLibre GL JS 5 |
| 3D Preview | Babylon.js 7 |
| Image processing | `sharp` |
| GeoTIFF I/O | `geotiff` + custom writer (`electron/geotiff-writer.ts`) |
| Optional native core | C++20 via `node-addon-api` (stubs shipped today) |

---

## Quick Start

### Prerequisites

- Node.js 18+ and [pnpm](https://pnpm.io) 9+
- Windows / macOS / Linux
- (Optional, for the native addon) Visual Studio 2022 with C++ workload, CMake 3.20+, Python 3, GDAL

### Run in development

```bash
pnpm install
pnpm dev:electron
```

`pnpm dev:electron` launches Vite on `http://localhost:5173` and an Electron shell pointed at it. The UI also works in a plain browser via `pnpm dev` (with mocked IPC), useful for component work.

### Build a production binary

```bash
pnpm build:win     # NSIS installer
pnpm build:mac     # DMG
pnpm build:linux   # AppImage
```

Output is written to `release/`.

### Rebuild the native addon (optional)

```bash
pnpm rebuild:native
```

If `electron/native/build/Release/geoterrain_native.node` is not present, the app automatically falls back to a pure-Node export engine (`electron/export-engine.ts`) that produces identical packages.

---

## How to Export a Terrain

1. **Pick an area.** On the **Map** tab, hold **Shift** and drag to draw a bounding box.
2. **Choose a tile size** (1 / 2 / 4 / 8 km) from the overlay. Click tiles to deselect any you don't want.
3. Open the **Export** tab.
4. Pick the **Target Engine** preset, an **Output Folder**, and a **Heightmap / Albedo** format.
5. Optionally tweak **Resolution & Quality** and **Data Sources**.
6. Click **Export N Tiles**. Each tile is written to `outputPath/tile_<row>_<col>/`.
7. (Optional) Switch to **3D View** to inspect the result with Babylon.js.

---

## Project Structure

```
GeoTerrainStudio/
├── electron/
│   ├── main.ts                 # Electron main process (IPC handlers, window)
│   ├── preload.ts              # Secure contextBridge API
│   ├── export-engine.ts        # Pure-Node DEM/imagery downloader + exporter
│   ├── geotiff-writer.ts       # Minimal GeoTIFF writer (8-bit RGB, 16-bit signed)
│   └── native/                 # Optional C++ N-API addon (stubs)
│       ├── binding.gyp
│       └── src/
│           ├── addon.cpp
│           ├── session_bridge.cpp
│           ├── datasource_bridge.cpp
│           └── pipeline_bridge.cpp
├── src/
│   ├── components/
│   │   ├── MapViewport/        # MapLibre map, bounds selection, tile grid, shapefile overlay
│   │   ├── LayerStack/         # Layer toggles
│   │   ├── JobQueue/           # Generation job list
│   │   ├── ExportPanel/        # Engine preset + format + export trigger
│   │   └── Viewer3D/           # Babylon.js terrain preview
│   ├── core/
│   │   ├── ipc.ts              # Type-safe wrapper around window.electronAPI
│   │   └── store.ts            # Zustand application state
│   ├── types/terrain.ts        # Shared domain types & IPC contract
│   ├── App.tsx
│   └── main.tsx
├── public/                     # App icon and static assets
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.cjs
```

---

## Terrain Package Format (`.terrain`)

Every export produces a folder containing a `manifest.json` plus the binary assets it references. Manifest version is `1.0.0` and is consumed by the companion `GeoTerrainBridge` UNIGINE plugin.

```
MyTerrain.terrain/
├── manifest.json
├── heightmap.tif            # or .r16 / .png depending on selected format
├── albedo.png               # or albedo.tif
└── (future) masks/, vectors/, preview/
```

Manifest excerpt:

```json
{
  "version": "1.0.0",
  "createdBy": "GeoTerrain Studio",
  "terrainName": "Terrain_<sessionId>",
  "bounds": { "west": ..., "south": ..., "east": ..., "north": ... },
  "crs": "EPSG:4326",
  "tileGrid": { "rows": 1, "cols": 1, "heightmapResolution": 1024, "albedoResolution": 1024 },
  "tiles": [ { "row": 0, "col": 0, "files": { "heightmap": "...", "albedo": "..." }, "elevation": { "min": 12.3, "max": 487.6, "units": "meters" } } ],
  "sources": { "dem": { "id": "aws-terrarium", ... }, "imagery": { "id": "arcgis", ... } },
  "exportPreset": "unigine",
  "processing": { ... }
}
```

The full schema is mirrored by `src/types/terrain.ts` (`TerrainManifest`).

---

## Attributions

- **AWS Terrain Tiles / Terrarium** — © Mapzen / Amazon Web Services. See [registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/).
- **ArcGIS World Imagery** — © Esri and its contributors.
- **Mapbox Satellite** / **MapTiler Satellite** — used only when the user supplies their own access token.

Please respect each provider's terms of service. The defaults are suitable for development and small-scale production use; for high-volume usage host your own tile cache.

---

## Known Limitations

- The current `heightmap.tif` / `heightmap_dem.tif` outputs are **signed 16-bit integer**, not float32, despite what the UI label suggests.
- Some engine-preset labels (Unreal "splat", Godot "EXR", Unity "splat textures") describe planned outputs — today every preset emits the same `heightmap + albedo + manifest.json` bundle.
- Exports run tile-by-tile and tile-internally sequentially; no concurrency or rate-limit handling.
- See [`CODE_REVIEW.md`](./CODE_REVIEW.md) for the current bug backlog.

---

## License

UNLICENSED — internal Vamps project. Do not redistribute without permission.

