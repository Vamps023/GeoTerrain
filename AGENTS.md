# GeoTerrain — Agent Guide

> This file is written for AI coding agents. It describes the actual project structure, build steps, and conventions as they exist today. Do not assume anything not stated here.

---

## Project Overview

GeoTerrain is a split-architecture toolchain for real-world terrain extraction and engine import. It consists of two independent sub-projects in this repository:

1. **GeoTerrain Studio** (`GeoTerrainStudio/`) — A cross-platform desktop application that downloads DEM (heightmap), satellite imagery, and OSM vector data from free sources, processes them with GDAL, and exports a `.terrain` package. Built with **Electron + React + TypeScript + Vite**.
2. **GeoTerrain Bridge** (`GeoTerrainBridge/`) — A lightweight **C++17 Qt5 plugin** for the UNIGINE Editor. It reads `.terrain` packages produced by Studio and builds `LandscapeLayerMap` terrain assets inside UNIGINE. Contains no GDAL, no libcurl, and no SQLite — only a fast manifest parser and UNIGINE SDK integration.

The two halves communicate through a well-defined **Terrain Package** format (a folder containing `manifest.json` plus image/mask/vector assets).

---

## Repository Layout

```
GeoTerrain/
├── GeoTerrainBridge/          # UNIGINE editor plugin (C++17, Qt5)
│   ├── CMakeLists.txt
│   ├── GeoTerrainBridge.json  # Plugin manifest (name, version, entry points)
│   ├── build_bridge.bat       # Windows build script
│   ├── README.md
│   └── src/
│       ├── bridge_plugin.h/cpp    # UNIGINE plugin entry / lifecycle
│       ├── bridge_panel.h/cpp     # Qt dock-widget UI (browse, validate, build)
│       └── package_reader.h/cpp   # manifest.json parser (no external deps)
│
├── GeoTerrainStudio/          # Desktop terrain extractor (Electron + React + TS)
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   ├── tailwind.config.cjs
│   ├── postcss.config.cjs
│   ├── index.html
│   ├── README.md
│   ├── electron/
│   │   ├── main.ts              # Electron main process
│   │   ├── preload.ts           # Secure context-bridge IPC definitions
│   │   └── native/
│   │       ├── binding.gyp      # node-gyp config for native addon
│   │       └── src/
│   │           ├── addon.cpp           # N-API module entry
│   │           ├── session_bridge.cpp  # Generation plan / progress / export
│   │           ├── datasource_bridge.cpp # Data-source listing
│   │           └── pipeline_bridge.cpp   # Raster processing stubs
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── index.css
│       ├── vite-env.d.ts
│       ├── components/
│       │   ├── MapViewport/MapViewport.tsx      # MapLibre 2D map + bounds selection
│       │   ├── LayerStack/LayerStack.tsx        # Layer toggles
│       │   ├── JobQueue/JobQueue.tsx            # Progress tracking
│       │   ├── ExportPanel/ExportPanel.tsx      # Engine preset selection & export
│       │   └── Viewer3D/TerrainViewer3D.tsx     # Babylon.js 3D preview
│       ├── core/
│       │   ├── store.ts         # Zustand state management
│       │   └── ipc.ts           # Type-safe Electron IPC wrapper + web mocks
│       └── types/
│           └── terrain.ts       # Shared TypeScript domain model
│
├── build/                     # Shared CMake build output (root-level C++ core)
│   └── bin/
│
└── AGENTS.md                  # This file
```

**Important:** The root-level `src/core`, `src/datasources`, `src/pipeline`, `src/cache`, `src/session`, `third_party/nlohmann`, and `third_party/gdal` directories are **referenced by** `binding.gyp` but are **not present in this repository** (they belong to a larger upstream project). The native addon therefore compiles against stub/mock implementations today.

---

## Technology Stack

| Component | Tech |
|-----------|------|
| Studio UI | React 18, TypeScript 5.4, Tailwind CSS 3.4, Vite 5.2 |
| Studio Shell | Electron 34, electron-builder 24 |
| Studio 2D Map | MapLibre GL JS 5.24 |
| Studio 3D Preview | Babylon.js 7.8 (`@babylonjs/core`) |
| Studio State | Zustand 4.5 |
| Studio Icons | Lucide React |
| Studio Native Core | C++20 exposed via `node-addon-api` + `node-gyp` |
| Bridge Plugin | C++17, Qt5.12.3 Widgets, UNIGINE SDK 2.18 |
| Bridge Build | CMake 3.16+, Ninja, MSVC 2017/2022 |
| Shared JSON | nlohmann/json (header-only, in `third_party/nlohmann` — referenced but not in repo) |

---

## Build and Test Commands

### GeoTerrain Studio

```bash
cd GeoTerrainStudio

# Install dependencies (pnpm is the lockfile of record)
pnpm install

# Development mode (Vite HMR + Electron)
pnpm dev
# or
pnpm dev:electron

# Lint
pnpm lint

# Build production app (Windows)
pnpm build:win

# Build production app (macOS)
pnpm build:mac

# Build production app (Linux)
pnpm build:linux

# Rebuild native C++ addon (requires VS2022, CMake, GDAL)
pnpm rebuild:native
```

**Key paths:**
- Vite output: `GeoTerrainStudio/dist/`
- Electron-builder output: `GeoTerrainStudio/release/`
- Native addon build: `GeoTerrainStudio/electron/native/build/Release/geoterrain_native.node`

### GeoTerrain Bridge

```bash
cd GeoTerrainBridge

# Option A: use the provided batch file (edit hard-coded paths first!)
build_bridge.bat

# Option B: manual CMake + Ninja
mkdir build_bridge && cd build_bridge
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja
ninja deploy_bridge
```

**Hard-coded paths in `CMakeLists.txt` / `build_bridge.bat` (must match your machine):**
- `UNIGINE_SDK_DIR` → `C:/Unigine/browser/sdks/sim_windows_2.18.0.1_bin`
- `CMAKE_PREFIX_PATH` (Qt5) → `C:/Qt/5.12.3/msvc2017_64`
- `DEPLOY_DIR` → `C:/UnigineProject/bin/plugins/Vamps/GeoTerrain`

**Output binary naming convention (UNIGINE requirement):**
```
GeoTerrainBridge_editorplugin_double_x64.dll
```

---

## Code Organization

### Studio — Frontend (TypeScript/React)

| Path | Responsibility |
|------|----------------|
| `src/App.tsx` | Root layout: title bar, left tab nav, center panel switcher, status bar |
| `src/components/MapViewport/` | MapLibre 2D globe, rectangle selection, live bounds calculation |
| `src/components/Viewer3D/` | Babylon.js terrain preview (consumes exported manifest) |
| `src/components/LayerStack/` | Toggle data layers (imagery, DEM, OSM overlays) |
| `src/components/JobQueue/` | Generation job list, progress bars, cancel buttons |
| `src/components/ExportPanel/` | Preset picker (UNIGINE, Unreal, Unity, Godot, Generic, Babylon), folder dialog, export trigger |
| `src/core/store.ts` | Zustand store: bounds, profile, generation plan, active job, progress, output path, active tab |
| `src/core/ipc.ts` | Type-safe wrapper around `window.electronAPI`. Falls back to mock implementations when running in a browser (no Electron) |
| `src/types/terrain.ts` | Canonical domain types: `GeoBounds`, `TerrainProfile`, `GenerationPlan`, `JobProgress`, `TerrainManifest`, `ExportPreset`, etc. |

### Studio — Electron Main Process

| Path | Responsibility |
|------|----------------|
| `electron/main.ts` | Window creation, native-addon loader, IPC handlers (`native:*`, `dialog:*`, `fs:*`) |
| `electron/preload.ts` | `contextBridge.exposeInMainWorld('electronAPI', api)` — strictly typed |

### Studio — Native Addon (C++ / N-API)

| File | Responsibility |
|------|----------------|
| `electron/native/src/addon.cpp` | Module init, registers `getVersion`, delegates to bridge init functions |
| `electron/native/src/session_bridge.cpp` | `planGeneration`, `startGeneration`, `cancelGeneration`, `getProgress`, `exportPackage` — currently stubs returning mock JSON |
| `electron/native/src/datasource_bridge.cpp` | `listSources`, `pingSource` — stub data-source metadata |
| `electron/native/src/pipeline_bridge.cpp` | `getProcessorCapabilities`, `processRaster` — stub pipeline ops |

### Bridge — UNIGINE Plugin (C++ / Qt5)

| File | Responsibility |
|------|----------------|
| `src/bridge_plugin.h/cpp` | Plugin singleton, `init()`/`shutdown()`/`update()`, C exports (`InitPlugin`, `ShutdownPlugin`, `UpdatePlugin`), creates dock widget and menu item under **VampsPlugin → GeoTerrain Bridge** |
| `src/bridge_panel.h/cpp` | Qt `QDockWidget` UI: browse for `.terrain` folder, validate manifest, show tree inspector, configure LMAP resolution & material preset, build terrain (currently logs to `qDebug()` and shows message box) |
| `src/package_reader.h/cpp` | Reads `manifest.json` into `TerrainPackageManifest` struct. Validates version (expects `1.x`), parses bounds, tile grid, tiles, files, sources. `validateFileExistence()` checks that referenced heightmaps/albedos exist on disk. No external dependencies beyond Qt5. |

---

## Terrain Package Format

A `.terrain` folder is the contract between Studio and Bridge:

```
MyTerrain.terrain/
├── manifest.json
├── heightmap/     *.tif
├── albedo/        *.jpg
├── masks/         *.tif (road, water, vegetation, cliff)
├── vectors/       *.geojson
└── preview/       *.png
```

`manifest.json` schema (version `1.x`) is defined in `src/types/terrain.ts` (`TerrainManifest`) and parsed by `PackageReader` in C++.

---

## Development Conventions

### TypeScript / React

- **Strict TypeScript:** `tsconfig.json` has `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`.
- **Path aliases:** `@/` → `src/`, `@components/` → `src/components/`, `@core/` → `src/core/`, `@types/` → `src/types/`.
- **Functional components:** All React components are function components; hooks are used for state and effects.
- **Tailwind-first styling:** No CSS-in-JS libraries; custom colors are defined in `tailwind.config.cjs` under `theme.extend.colors.geo`.
- **IPC abstraction:** Never call `window.electronAPI` directly from components; always go through `src/core/ipc.ts` (`Native`, `Dialog`, `FsAPI`, `onProgressUpdate`). This ensures the app can run in a plain browser during early development.

### C++ (Bridge)

- **C++17 standard** (`CMAKE_CXX_STANDARD 17`).
- **Qt5 naming:** Member variables use trailing underscore (`panel_`, `dockWidget_`).
- **No raw pointers for ownership:** `std::unique_ptr<PackageReader>` is used; Qt parent-child hierarchy handles widget lifetime.
- **Comments:** Section dividers use `// ─── Section Name ───────────────────────────────`.

### Native Addon (C++ / N-API)

- **C++20** (`/std:c++20` on MSVC) because the upstream core uses C++20 features.
- **Exception handling enabled:** `NAPI_CPP_EXCEPTIONS`, `ExceptionHandling: 1` in `msvs_settings`.
- **Stubs clearly marked:** Every unimplemented integration has a `TODO: Integrate with ...` comment and returns a sensible mock value so the UI never crashes.

---

## Testing Strategy

There is **no automated test suite** in this repository today.

- **Studio:** Manual end-to-end testing via `pnpm dev:electron`. The `ipc.ts` mock layer allows UI testing without a compiled native addon.
- **Bridge:** Manual testing inside UNIGINE Editor. Load the plugin, browse a `.terrain` package exported by Studio, click Validate, then Build.

If you add tests:
- For Studio, use **Vitest** (aligns with the Vite toolchain) and place tests next to source files or in `src/__tests__/`.
- For Bridge, consider adding a `CTest` target in `CMakeLists.txt` and using **Qt Test** for `PackageReader` validation.

---

## Security Considerations

- **Electron `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`.** The preload script is the only bridge between renderer and main process.
- **CSP in `index.html`:** Restrictive Content-Security-Policy is set for development (`localhost:5173`). Update it for production builds.
- **Native addon path:** Loaded from a path relative to `__dirname` (`../native/geoterrain_native.node`). In a packaged app this is inside `app.asar.unpacked`.
- **No secrets or API keys:** All data sources used (AWS Terrain Tiles, Copernicus DEM, ArcGIS World Imagery, Overpass OSM) are free and require no authentication.

---

## Common Pitfalls for Agents

1. **Missing upstream C++ core:** Do not try to `#include` files from `src/core`, `src/datasources`, etc., unless you are working in the upstream monorepo that contains them. In this repo the native addon only has stubs.
2. **Bridge paths are Windows-centric:** `CMakeLists.txt` and `build_bridge.bat` hard-code Windows paths. If you need to build on Linux/macOS you must rewrite the path variables.
3. **Qt5 vs Qt6:** The Bridge is locked to Qt5.12.3 because UNIGINE SDK 2.18 uses that version. Do not upgrade to Qt6.
4. **Electron version:** `package.json` specifies Electron 34. Do not downgrade below 30 because newer `node-addon-api` features are assumed.
5. **pnpm vs npm:** The lockfile of record is `pnpm-lock.yaml`. Use `pnpm install`, not `npm install`, to avoid lockfile drift.
