# GeoTerrain Studio

**Standalone real-world terrain data extractor and exporter.**

GeoTerrain Studio is a cross-platform desktop application built with **Electron + React + TypeScript + CesiumJS**. It downloads DEM (heightmap), satellite imagery, and OSM vector data from free sources (no API keys required), processes them with GDAL, and exports to multiple game engines.

## Supported Engines

| Engine | Export Format |
|--------|--------------|
| UNIGINE | `.lmap` + materials |
| Unreal Engine | 16-bit `.r16` + PNG albedo + splat |
| Unity | RAW heightmap + splat textures |
| Godot | EXR heightmap + JPG albedo |
| Generic | GeoTIFF bundle |

## Technology Stack

- **Shell:** Electron 30+
- **UI:** React 18, TypeScript 5, Tailwind CSS
- **3D Map:** CesiumJS + Resium
- **State:** Zustand
- **Native Core:** C++20 (reuses GeoTerrain `src/core` via N-API)

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode (with Vite HMR + Electron)
pnpm dev

# Build native addon (requires VS2022, CMake, GDAL)
pnpm rebuild:native

# Build production app
pnpm build:win
```

## Project Structure

```
GeoTerrainStudio/
├── electron/
│   ├── main.ts              # Electron main process
│   ├── preload.ts           # Secure IPC bridge
│   └── native/              # node-addon-api C++ bindings
│       ├── binding.gyp
│       └── src/
│           ├── addon.cpp
│           ├── session_bridge.cpp
│           ├── datasource_bridge.cpp
│           └── pipeline_bridge.cpp
├── src/
│   ├── components/
│   │   ├── MapViewport/     # CesiumJS 3D globe with selection
│   │   ├── LayerStack/      # Toggle data layers
│   │   ├── JobQueue/        # Progress tracking
│   │   └── ExportPanel/     # Engine preset selection
│   ├── core/
│   │   ├── ipc.ts           # Type-safe Electron IPC
│   │   ├── store.ts         # Zustand state management
│   │   └── engines/         # Per-engine export presets
│   └── types/
│       └── terrain.ts       # Shared TypeScript definitions
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## Terrain Package Format

Studio exports `.terrain` folders containing:

```
MyTerrain.terrain/
├── manifest.json
├── heightmap/     *.tif
├── albedo/        *.jpg
├── masks/         *.tif (road, water, vegetation, cliff)
├── vectors/       *.geojson
└── preview/       *.png
```

See `../TerrainPackageFormat/README.md` for full schema documentation.
