# GeoTerrain Agent Guide

This file is for AI coding agents working in this repository. Read it before
changing code. It describes the current checkout, the major flows, the build
commands, and the traps that have already cost time.

## Repository Snapshot

GeoTerrain is currently centered on `GeoTerrainStudio/`, an Electron desktop
app for selecting real-world map areas, downloading terrain data, exporting
engine packages, and previewing terrain in Babylon.js.

There are also Blender import add-ons under `EnginesAddOn/` and
`GeoTerrainStudio/EnginesAddOn/`. There is no `GeoTerrainBridge/` directory in
this checkout, even if older notes mention one.

Top-level layout:

```text
GeoTerrain/
  AGENTS.md                         # this guide
  .gitignore
  EnginesAddOn/
    GeoTerrainBlender/              # Blender add-on source
    GeoTerrainBlender.zip           # generated/exported add-on archive
  GeoTerrainStudio/
    electron/                       # Electron main/preload/export engine
    src/                            # React renderer app
    public/                         # icons/logo/static assets
    EnginesAddOn/Blender/           # packaged Blender add-on copy
    package.json
    package-lock.json
    pnpm-lock.yaml
    CODE_REVIEW.md                  # older review; some items may now be fixed
    README.md
```

Generated or dependency folders such as `node_modules/`, `dist/`,
`dist-electron/`, `release/`, and native build outputs should not be edited by
hand unless the user explicitly asks for generated artifact work.

## Product Flow

The intended user flow is:

1. Use the Map tab to select a bounding box.
2. Choose a tile size and selected tiles.
3. Use the Export panel to pick an engine preset and output folder.
4. `electron/export-engine.ts` downloads DEM and imagery, crops/resizes them,
   writes heightmap/albedo files, and writes `manifest.json`.
5. For Babylon exports, the renderer combines per-tile manifests into a root
   manifest and opens the 3D View.
6. `src/components/Viewer3D/TerrainViewer3D.tsx` loads the manifest and renders
   terrain with Babylon.js.
7. Blender imports exported packages through the Python add-on.

The core package contract is a folder with `manifest.json` plus referenced
assets. Multi-tile Babylon exports look like:

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

## GeoTerrain Studio Architecture

Renderer app:

```text
GeoTerrainStudio/src/
  App.tsx
  main.tsx
  index.css
  components/
    MapViewport/MapViewport.tsx     # MapLibre map, bbox selection, tile grid
    ExportPanel/ExportPanel.tsx     # presets, format settings, export trigger
    Viewer3D/TerrainViewer3D.tsx    # Babylon terrain preview
    LayerStack/LayerStack.tsx       # layer/job side panel
    JobQueue/JobQueue.tsx
    Toast/Toast.tsx
  core/
    store.ts                        # Zustand app state
    ipc.ts                          # typed wrapper around window.electronAPI
  types/
    terrain.ts                      # shared domain and IPC types
```

Electron and export code:

```text
GeoTerrainStudio/electron/
  main.ts                           # BrowserWindow and IPC handlers
  preload.ts                        # contextBridge API exposed to renderer
  export-engine.ts                  # Node export pipeline
  geotiff-writer.ts                 # minimal GeoTIFF writer
  native/
    binding.gyp
    src/
      addon.cpp
      session_bridge.cpp            # native addon stubs
      datasource_bridge.cpp
      pipeline_bridge.cpp
```

Important rule: renderer components should call `Native`, `Dialog`, `Settings`,
or `FsAPI` from `src/core/ipc.ts`; they should not call `window.electronAPI`
directly.

## Export Engine

`electron/export-engine.ts` is the real export implementation today.

Primary responsibilities:

- validate bounds, tile counts, and memory estimates
- download DEM data from AWS Terrarium, Mapzen, Mapbox Terrain-RGB, or
  OpenTopography sources
- download imagery from ArcGIS, Mapbox, or MapTiler
- merge, crop, resize, and write output rasters
- write per-tile `manifest.json`

Supported height formats:

- `png`: normalized 16-bit heightmap PNG for Babylon/browser viewing
- `r16`: normalized raw 16-bit little-endian heightmap
- `geotiff`: signed 16-bit GeoTIFF
- `float32`: Float32 GeoTIFF
- `dem`: currently routed as a GeoTIFF-style height output

OpenTopography sources require a valid API key. A `401` from
`portal.opentopography.org` means the key was rejected by OpenTopography for
that request; it is not a Babylon viewer bug.

## Babylon 3D Viewer

File: `GeoTerrainStudio/src/components/Viewer3D/TerrainViewer3D.tsx`.

Current behavior:

- reads the root manifest from Zustand state
- reads local image files through `FsAPI.readFileBinary`
- creates Blob URLs for PNG heightmaps/albedo textures
- uses `MeshBuilder.CreateGroundFromHeightMap`
- previews relative elevation range, not absolute elevation above sea level
- normalizes loaded tile rows/columns so partial tile selections appear near
  the camera
- recovers row/column from paths like `tile_2_3/...` for older manifests where
  all tiles were written as `row: 0, col: 0`

Do not import `sharp` in renderer files. `sharp` is a Node module and will fail
in Vite/Chromium renderer code with `process is not defined`. Use `sharp` only
from Electron main/export code.

## Blender Add-on

Main source:

```text
EnginesAddOn/GeoTerrainBlender/
  __init__.py
  operators.py
  panels.py
  README.md
```

There is also a packaged copy under:

```text
GeoTerrainStudio/EnginesAddOn/Blender/
```

The add-on imports GeoTerrain packages into Blender as terrain planes with
displacement and albedo material. It supports root manifests and per-tile
folders. It uses row/col fallback placement when `worldOffset` is missing or
zero.

If changing Blender import behavior, check whether both add-on source locations
need the same update.

## Native Addon Status

The N-API addon under `GeoTerrainStudio/electron/native/` is not a real export
pipeline yet. Its `exportPackage` implementation is a stub in
`session_bridge.cpp`.

For this reason, `electron/main.ts` should keep exports on the Node
`executeExport` path until the native exporter is fully implemented. Do not
re-enable native export just because `geoterrain_native.node` exists.

## State Model

`src/core/store.ts` is the central Zustand store.

Important state fields:

- `selectedBounds`: current map selection
- `tileGrid`: computed row/column grid from selected bounds and tile size
- `selectedTiles`: set of selected `"row,col"` tile keys
- `selectedPreset`: target export preset
- `heightmapFormat`, `albedoFormat`: active output formats
- `demSource`, `imagerySource`: export data sources
- `exportedManifest`, `exportedPackagePath`: data used by the 3D viewer
- `activeTab`: `map`, `layers`, `jobs`, `export`, or `view3d`

When adding new source IDs or formats, update all of:

- `src/types/terrain.ts`
- `src/core/store.ts`
- `src/components/ExportPanel/ExportPanel.tsx`
- `electron/export-engine.ts`
- `electron/preload.ts`
- `src/core/ipc.ts`

## Build Commands

Run these from `GeoTerrainStudio/`.

```bash
npm run build:vite
npm run build:electron
```

These two commands are the fastest validation pass and have been used in this
workspace.

Other available scripts:

```bash
npm run dev
npm run dev:electron
npm run lint
npm run build
npm run build:win
npm run build:mac
npm run build:linux
npm run rebuild:native
```

Both `package-lock.json` and `pnpm-lock.yaml` exist. Avoid lockfile churn unless
the user asks for dependency changes.

## Common Debugging Checks

If Babylon 3D View is blank:

1. Confirm export preset is `babylon`.
2. Confirm heightmap and albedo formats are PNG.
3. Confirm root `manifest.json` exists in the output folder.
4. Confirm root manifest has all selected tiles, not only one tile.
5. Confirm tile file paths in the manifest exist on disk.
6. Confirm tile rows/columns are unique or recoverable from `tile_<row>_<col>`
   folder paths.
7. Confirm the app was restarted after TypeScript changes so the latest Vite
   bundle is loaded.

If export fails with OpenTopography `401`:

1. The request reached OpenTopography.
2. The key was rejected for that endpoint or account scope.
3. Use `aws-terrarium` for a keyless export path.
4. Do not debug Babylon until export succeeds.

If export appears to succeed but files are missing:

1. Ensure `electron/main.ts` is using `executeExport`, not native stub export.
2. Inspect the selected output folder for `tile_<row>_<col>/manifest.json`.
3. Check console output from Electron main process.

## Known Issues And Cleanup Targets

- `CODE_REVIEW.md` is older and contains items that may be partially fixed.
  Verify each item before acting on it.
- The native addon is mostly stubbed.
- `package-lock.json` may change when using `npm`; `pnpm-lock.yaml` also
  exists.
- There are generated zip archives for Blender add-ons. Do not edit zip files
  directly.
- Some comments and older docs contain mojibake characters from prior encoding
  issues. Prefer ASCII in new edits.
- Avoid editing generated `dist` or `dist-electron` files unless packaging
  artifacts are explicitly requested.

## Agent Working Rules

- Prefer narrow changes that follow the existing React/Electron patterns.
- Keep terrain package compatibility in mind: exporter, viewer, and Blender
  add-on all consume the same manifest contract.
- Do not add browser-side Node dependencies.
- Do not treat native addon stubs as production functionality.
- Use `rg` for search and run the two build commands after TypeScript changes.
- When modifying export metadata, test with a real output folder and inspect
  `manifest.json` plus referenced files.

