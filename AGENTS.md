# GeoTerrain Agent Guide

This file is for AI coding agents working in this repository. Read it before changing code. It describes the project architecture, build process, conventions, known issues, and traps that have already cost time.

---

## 1. Project Overview

GeoTerrain is a desktop geospatial terrain extraction tool. The main product is **GeoTerrain Studio**, an Electron application that lets users select a real-world map area, download DEM (elevation) and satellite imagery, and export engine-ready terrain packages. Exported packages can be previewed in a built-in Babylon.js 3D viewer or imported into Blender via a Python add-on.

There is also a Blender import add-on under `EnginesAddOn/GeoTerrainBlender/` and a packaged copy under `GeoTerrainStudio/EnginesAddOn/Blender/`.

### Repository Layout

```text
GeoTerrain/
  AGENTS.md                         # this guide
  README.md                         # human-facing project overview
  .gitignore
  images/                           # README assets
  EnginesAddOn/
    GeoTerrainBlender/              # Blender add-on source (Python)
    GeoTerrainBlender.zip           # generated add-on archive
  GeoTerrainStudio/                 # main Electron + React application
    electron/                       # main process, preload, export engine
      main.ts                       # BrowserWindow and IPC handlers
      preload.ts                    # contextBridge API definitions
      export-engine.ts              # Node DEM/imagery downloader + exporter
      geotiff-writer.ts             # minimal GeoTIFF writer
      native/                       # N-API C++ addon stubs
        binding.gyp
        src/
          addon.cpp
          session_bridge.cpp
          datasource_bridge.cpp
          pipeline_bridge.cpp
    src/                            # React renderer (Vite bundle)
      App.tsx                       # root component, tab layout, export overlay
      main.tsx                      # React entry point
      index.css                     # Tailwind directives + base styles
      components/
        MapViewport/MapViewport.tsx       # MapLibre map, bbox selection, tile grid, shapefile overlay
        ExportPanel/ExportPanel.tsx       # engine presets, format settings, export trigger
        Viewer3D/TerrainViewer3D.tsx      # Babylon.js terrain preview
        LayerStack/LayerStack.tsx         # layer/job side panel
        JobQueue/JobQueue.tsx             # generation job list
        Toast/Toast.tsx                   # notification toasts
      core/
        store.ts                      # Zustand application state
        ipc.ts                        # typed wrapper around window.electronAPI
        engines/                      # engine preset configs (if any)
      types/
        terrain.ts                    # shared domain and IPC types
    public/                         # icons, logo, static assets
    package.json                    # version 2.0.0, Electron 42, React 18
    tsconfig.json                   # renderer + electron included, strict
    vite.config.ts                  # aliases @, @components, @core, @types
    tailwind.config.cjs             # custom geo colors, Inter / JetBrains Mono fonts
    postcss.config.cjs
    CODE_REVIEW.md                  # bug backlog and known risks
    README.md                       # human developer onboarding
```

---

## 2. Technology Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Desktop Shell | Electron | `^42.2.0` (main: `dist-electron/main.js`) |
| UI Framework | React | `^18.3.1` |
| Language | TypeScript | `^5.4.5`, strict mode |
| Bundler | Vite | `^7.3.3` |
| Styling | Tailwind CSS | `^3.4.3` with custom `geo-*` colors |
| Icons | lucide-react | `^0.378.0` |
| State | Zustand | `^4.5.2` |
| 2D Map | MapLibre GL JS | `^5.24.0` |
| 3D Preview | Babylon.js Core | `^7.8.1` |
| Image Processing | sharp | `^0.34.5` (Node main process **only**) |
| GeoTIFF I/O | geotiff + custom writer | `geotiff-writer.ts` for 8/16/32-bit output |
| Native Addon | node-addon-api / node-gyp | C++20 stubs, not production ready |
| Blender Bridge | Python | Blender 4.0+ add-on |

---

## 3. Build and Development Commands

Run all commands from `GeoTerrainStudio/`.

```bash
# Install dependencies (both npm and pnpm lockfiles exist; avoid churn)
npm install

# Development — Vite dev server only (browser, mocked IPC)
npm run dev

# Development — Electron with hot-reload
npm run dev:electron

# Fast validation build (TypeScript compile only, no installer)
npm run build:vite
npm run build:electron

# Production installer builds
npm run build        # all platforms (via electron-builder)
npm run build:win    # NSIS
npm run build:mac    # DMG
npm run build:linux  # AppImage

# Optional: rebuild native addon stub
npm run rebuild:native

# Lint
npm run lint
```

Build outputs:
- `dist/` — Vite renderer bundle
- `dist-electron/` — compiled Electron main/preload JS
- `release/` — electron-builder installers

### Important Build Notes
- `electron/tsconfig.json` compiles to CommonJS (`module: "CommonJS"`) into `../dist-electron`.
- `tsconfig.json` uses `module: "ESNext"`, `noEmit: true`, `jsx: "react-jsx"`.
- Both `package-lock.json` and `pnpm-lock.yaml` exist. Avoid unnecessary lockfile changes.
- `sharp` and `@img` are unpacked from ASAR (`asarUnpack`) so native binaries remain accessible.

---

## 4. Code Organization and Architecture

### 4.1 Product Flow

1. **Map** tab — user draws a bounding box (Shift-drag). Tile grid is computed from `tileSizeKm`.
2. User clicks tiles to toggle selection; defaults select all.
3. **Export** tab — choose engine preset, output folder, heightmap/albedo format, data sources.
4. `electron/export-engine.ts` downloads tiles, merges/crops/resizes, writes per-tile files.
5. For Babylon exports, renderer reads the root `manifest.json`, creates Blob URLs, and renders with `MeshBuilder.CreateGroundFromHeightMap`.
6. Blender add-on imports the same package folder via `operators.py`.

### 4.2 IPC Architecture

The renderer **must never call `window.electronAPI` directly**. All communication goes through `src/core/ipc.ts`, which provides:

- `Native` — generation planning, export, progress
- `Dialog` — folder/package selection, project save/load
- `Settings` — API key persistence
- `FsAPI` — manifest read/write, binary file reading, project serialization
- `onProgressUpdate` — subscription for job progress

These wrappers also provide mock fallbacks when running in a plain browser (`npm run dev` without Electron).

The preload script (`electron/preload.ts`) defines the exact API shape exposed via `contextBridge.exposeInMainWorld('electronAPI', api)`. IPC channels are prefixed:
- `native:*`
- `dialog:*`
- `fs:*`
- `settings:*`

### 4.3 State Model

`src/core/store.ts` is a single Zustand store. Key fields:

| Field | Purpose |
|---|---|
| `selectedBounds` | Current map selection (`GeoBounds`) |
| `tileGrid` / `selectedTiles` | Computed grid and `"row,col"` selection set |
| `selectedPreset` | Target export preset (`ExportPreset`) |
| `heightmapFormat` / `albedoFormat` | Active output formats |
| `demSource` / `imagerySource` | Data sources for export |
| `exportedManifest` / `exportedPackagePath` | Data used by 3D viewer |
| `activeTab` | `map`, `layers`, `jobs`, `export`, `view3d` |
| `exportProgress` / `exportResult` / `exportStartTime` | Export overlay state |
| `notifications` | Toast queue |

### 4.4 Export Engine

`electron/export-engine.ts` is the **only** production export path. The native addon is intentionally **not** used for exports (`main.ts` always calls `executeExport`).

Supported heightmap formats:
- `png` — normalized 16-bit PNG (Babylon / browser viewing)
- `r16` — normalized raw 16-bit little-endian
- `geotiff` — signed 16-bit GeoTIFF (current implementation)
- `float32` — label says float32 GeoTIFF, but currently also written as int16 (known issue, see CODE_REVIEW.md)
- `dem` — currently identical to GeoTIFF-style output

Supported albedo formats:
- `png`
- `geotiff`

Supported export presets:
- `unigine`
- `unreal`
- `blender`
- `generic`
- `babylon`

Supported DEM sources (short IDs, used by `export-engine.ts`):
- `aws-terrarium`, `mapzen`, `mapbox-terrain-rgb`
- `opentopo-srtmgl1`, `opentopo-srtmgl3`, `opentopo-aw3d30`, `opentopo-cop30`, `opentopo-nasadem`, `opentopo-usgs10m`

Supported imagery sources:
- `arcgis`, `mapbox`, `maptiler`

**Critical:** When adding a new source ID or format, update **all** of:
- `src/types/terrain.ts`
- `src/core/store.ts`
- `src/components/ExportPanel/ExportPanel.tsx`
- `electron/export-engine.ts`
- `electron/preload.ts`
- `src/core/ipc.ts`

### 4.5 Terrain Package Format

A multi-tile export looks like:

```text
OutputFolder/
  manifest.json
  tile_0_1/
    manifest.json
    tile_0_1_heightmap.png
    tile_0_1_albedo.png
  tile_1_2/
    manifest.json
    tile_1_2_heightmap.png
    tile_1_2_albedo.png
```

The root manifest aggregates all tiles. The Blender add-on and Babylon viewer both consume this structure.

---

## 5. Code Style and Conventions

### TypeScript
- **Strict mode enabled.** `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are all on.
- Path aliases (resolved by both Vite and TypeScript):
  - `@/` → `src/`
  - `@components/` → `src/components/`
  - `@core/` → `src/core/`
  - `@types/` → `src/types/`
- Electron main code uses `require()` for Electron APIs to avoid ESM/CJS interop issues.
- Renderer code must be ESM and must not import Node-only packages.

### React / UI
- Functional components with hooks.
- Tailwind utility classes; custom theme colors in `tailwind.config.cjs`.
- Use `clsx` and `tailwind-merge` for conditional class composition where needed.

### Naming
- IPC channel names: `domain:action` (e.g., `native:exportPackage`).
- File names: PascalCase for components, camelCase for utilities.
- Zustand actions: `setXxx` pattern.

### No Renderer-side Node Dependencies
Do **not** import `sharp`, `fs`, `path`, or any Node module into files under `src/`. These will fail at runtime in Vite/Chromium with `process is not defined`. Use them **only** from `electron/` (main process).

---

## 6. Testing Strategy

**There is currently no automated test suite in the project source.** The only test files found are inside `node_modules/`. If you add tests, place them adjacent to the source files using a `.test.ts` or `.spec.ts` suffix, and update `package.json` scripts accordingly.

Manual validation workflow after TypeScript changes:
1. `npm run build:vite`
2. `npm run build:electron`
3. Launch `npm run dev:electron` and exercise the full export + 3D preview flow.
4. Verify `manifest.json` and referenced tile files exist in the output folder.

---

## 7. Security Considerations

- `contextIsolation: true` in `BrowserWindow` webPreferences.
- `nodeIntegration: false`.
- `sandbox: false` (required for native addon loading and `sharp` access from main).
- All privileged operations go through typed IPC in `preload.ts`.
- Renderer must use `src/core/ipc.ts` wrappers; never access `window.electronAPI` directly.
- API keys (OpenTopography, Mapbox, MapTiler) are stored in `settings.json` inside the user's `app.getPath('userData')` directory, not in source.

---

## 8. Known Issues and Cleanup Targets

These are documented in `CODE_REVIEW.md` and verified to still exist:

1. **Source ID mismatch (High)** — `export-engine.ts` uses short IDs (`arcgis`, `mapbox`, `maptiler`), but earlier versions of UI/store used longer IDs. Ensure any new UI code uses the short IDs expected by the engine.
2. **Heightmap GeoTIFF is int16, not float32 (High)** — The UI labels `float32` and `dem` as float32 GeoTIFF, but `export-engine.ts` currently quantizes to `Int16Array`. See `CODE_REVIEW.md` for fix paths.
3. **Triplicated transpiled files** — `CODE_REVIEW.md` warns about `.ts` + `.js` + `.cjs` drift in `electron/`. Always edit the `.ts` source and regenerate.
4. **Native addon is stubbed** — `session_bridge.cpp` contains TODOs and mock implementations. Do not re-enable native export in `main.ts`; keep using `executeExport`.
5. **OpenTopography 401** — If an export fails with `401` from `portal.opentopography.org`, the API key was rejected for that endpoint or account scope. This is not a viewer bug; switch to `aws-terrarium` for keyless export.
6. **Encoding artifacts** — Some older comments/docs contain mojibake from prior encoding issues. Prefer ASCII in new edits.

---

## 9. Common Debugging Checks

### Blank Babylon 3D View
1. Confirm export preset is `babylon`.
2. Confirm heightmap and albedo formats are `png`.
3. Confirm root `manifest.json` exists in the output folder.
4. Confirm root manifest lists **all** selected tiles, not just one.
5. Confirm tile file paths in the manifest exist on disk.
6. Confirm tile rows/columns are unique or recoverable from `tile_<row>_<col>` folder paths.
7. Restart the app after TypeScript changes so the latest Vite bundle loads.

### Export Appears to Succeed but Files Are Missing
1. Ensure `electron/main.ts` is using `executeExport`, not native stub export.
2. Inspect the selected output folder for `tile_<row>_<col>/manifest.json`.
3. Check console output from the Electron main process.

---

## 10. Agent Working Rules

- Prefer narrow changes that follow existing React/Electron patterns.
- Keep terrain package compatibility in mind: exporter, viewer, and Blender add-on all consume the same manifest contract.
- Do not add browser-side Node dependencies.
- Do not treat native addon stubs as production functionality.
- Use `rg` (ripgrep) or `grep` for search.
- After TypeScript changes, run `npm run build:vite && npm run build:electron`.
- When modifying export metadata, test with a real output folder and inspect `manifest.json` plus referenced files.
- If you modify Blender import behavior, check whether **both** add-on source locations need the same update:
  - `EnginesAddOn/GeoTerrainBlender/`
  - `GeoTerrainStudio/EnginesAddOn/Blender/`
