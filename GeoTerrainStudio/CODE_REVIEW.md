# GeoTerrain Studio — Code Review

Scope: `GeoTerrainStudio/` only.
Goal: catalogue real bugs and risks so we can triage and fix them. Nothing has been changed in source yet — this is a review document.

Severity: **H** = bug that breaks a user-visible feature, **M** = correctness/maintenance risk, **L** = polish.

---

## 1. Data-source ID mismatch between UI, store and export engine (H)

The same logical source is named three different ways across the code:

- `src/core/store.ts` initial state: `imagerySource: 'arcgis-world-imagery'`, `demSource: 'aws-terrarium'`.
- `src/types/terrain.ts` `ImagerySource` union: `'arcgis-world-imagery' | 'mapbox-satellite' | 'maptiler-satellite'`.
- `src/components/ExportPanel/ExportPanel.tsx` `<option value="arcgis-world-imagery">`, `"mapbox-satellite"`, `"maptiler-satellite"`.
- `electron/export-engine.ts` switches on `'arcgis' | 'mapbox' | 'maptiler'` and falls back to ArcGIS for the default branch.

Effect: when the user picks **Mapbox Satellite** or **MapTiler Satellite** in the UI, the export engine receives `"mapbox-satellite"` / `"maptiler-satellite"`, which does **not** match any case, so it silently falls back to ArcGIS. Same situation for DEM if the union ever grows.

Also `store.ts` `defaultProfile.sources.demSource = 'aws-terrain'` (no `r`) which matches none of the IDs anywhere else.

**Fix:** pick one canonical set of IDs (recommend the short ones used by `export-engine.ts`) and use them everywhere; or add a translation table in `Native.exportPackage`. Tighten the `<select>` `onChange` from `as any` to the typed union.

Files: `src/core/store.ts:14-15,70-71`, `src/components/ExportPanel/ExportPanel.tsx:314,325,328-330`, `electron/export-engine.ts:548-575`, `src/types/terrain.ts:176-177`.

---

## 2. Heightmap GeoTIFF written as int16, not float32 (H)

The Export Format dropdown lists `DEM (GeoTIFF float32)` but `writeHeightmapDEM` and `writeHeightmapGeoTIFF` both quantise elevations into `Int16Array` and clamp to ±32767. Mount Everest (8849 m) fits, but:

- Fractional metres are lost.
- The label is misleading.
- The `dem` and `geotiff` cases produce identical output.

`electron/export-engine.ts:420-474`.

**Fix:** either rename the label to `(GeoTIFF 16-bit signed)` or implement true float32 output in `writeGeoTIFF` (add `sampleFormat=3`, `bitsPerSample=32`) and dispatch to it from the `dem` branch.

---

## 3. `main.ts` is out of sync with the shipped `main.cjs` (H)

`package.json` points `"main": "electron/main.cjs"`. `main.cjs` registers the IPC handlers `dialog:saveProject`, `dialog:loadProject`, `fs:saveProject`, `fs:loadProject` and sets `icon: '../public/logo/logo.png'`. `electron/main.ts` does **not** register any of those handlers and has no window icon. The renderer-side `ipc.ts` and `preload.cjs` call these channels, so:

- Today the app works because `main.cjs` is loaded directly.
- The moment anyone re-emits the TS sources (or someone reads `main.ts` as source-of-truth) the Save/Load Project feature silently disappears.

`electron/main.ts:1-258`, `electron/main.cjs:200-242`.

**Fix:** make `main.ts` the single source of truth, add the four missing handlers + the window icon, then regenerate `main.cjs` from it. Same drift exists for `preload.ts` vs `preload.cjs` (preload is in sync today but the dual-file pattern guarantees future drift).

---

## 4. Triplicated transpiled files (`*.ts` + `*.js` + `*.cjs`) (H)

`electron/` ships every file three times:

- `main.ts` / `main.js` / `main.cjs`
- `preload.ts` / `preload.js` / `preload.cjs`
- `export-engine.ts` / `.js` / `.cjs`
- `geotiff-writer.ts` / `.js` / `.cjs`

`tsconfig.json` has `"noEmit": true`, so no build step produces these — they must have been hand-committed. Issue (3) is a direct symptom.

**Fix:** keep only the `.ts` sources; add a small `tsc --project tsconfig.electron.json` step (or use `esbuild`/`tsx`) in `build:*` to emit a single set of `.cjs` files into `dist-electron/` and point `package.json#main` there. Then delete the duplicated `.js`/`.cjs` files from git.

---

## 5. `electron/main.ts` ignores the resolution/source params when the native addon is loaded (M)

```ts
return nativeAddon.exportPackage(sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat);
```

The native branch drops `heightmapResolution`, `albedoResolution`, `imageryZoom`, `demSource`, `imagerySource`. So once the native core is wired up, the user's Quality / Source selections will be silently ignored. `main.cjs` has the same bug.

`electron/main.ts:192`, `electron/main.cjs:170`.

**Fix:** forward all parameters to `nativeAddon.exportPackage(...)`.

---

## 6. `pnpm` listed as a runtime dependency (M)

`package.json:33` has `"pnpm": "^11.3.0"` under `dependencies`. That pulls the entire pnpm CLI into the installed/packaged app, bloating `node_modules` and the NSIS installer. It should not be a dep at all (pnpm is invoked by the developer's shell), and certainly not a runtime dep.

**Fix:** remove the entry.

---

## 7. `tsc` in build scripts vs. CommonJS Electron entry (M)

`build:*` runs `tsc && vite build && electron-builder`. With `noEmit: true` the `tsc` invocation only type-checks — fine — but it includes `electron/` whose source-of-truth is currently the hand-written `.cjs` files. If issue (4) is fixed by enabling emit, the existing strict TS in `main.ts` (which references `BrowserWindow`/`dialog` through `require('electron')` and types `mainWindow: any`) needs cleanup. Today both files coexist without warning.

---

## 8. 3D viewer cannot load real terrain in production (H)

`src/components/Viewer3D/TerrainViewer3D.tsx:194` does `fromUrl(\`file://${heightmapPath}\`)`. Two problems:

- In dev (`http://localhost:5173`) the renderer cannot `fetch` `file://` URLs — the file is rejected by Chromium's mixed-content rules. The code already bails to demo terrain in that case (`window.location.protocol === 'http:'`), so dev is fine.
- In packaged builds the renderer loads via `file://`, but `geotiff.fromUrl` still uses `fetch`, which on `file://` on Chromium **does not** support range requests. `fromUrl` issues a HEAD + ranged GETs; both fail. The catch falls back to demo terrain, so the user sees demo content every time they hit the 3D View tab.
- The albedo texture path `file://${albedoPath}` runs into the same issue and will silently fall back to the diffuse colour.

`src/components/Viewer3D/TerrainViewer3D.tsx:184-220, 301-310`.

**Fix:** add an IPC channel `fs:readBinary(path)` that returns a `Buffer` to the renderer, then use `geotiff.fromArrayBuffer(...)`. For the albedo, expose the file via a custom Electron `protocol.registerFileProtocol('geo', ...)` and use `geo://...` URLs.

Also unrelated: the existing escape-hatch `protocol === 'http:'` does not match `'https:'` and will mis-classify a future https dev server.

---

## 9. Babylon export path fabricates a manifest from constants (M)

When `selectedPreset === 'babylon'` the panel **skips the real exporter** and pushes a hand-crafted manifest with `heightmapResolution: 1024`, `elevation: { min: 0, max: 100 }`, file names `heightmap.tif` / `albedo.png` that don't exist on disk. The 3D viewer then tries to read those files, fails, and shows the demo mesh. The success banner ("Terrain prepared for 3D viewing") is misleading.

`src/components/ExportPanel/ExportPanel.tsx:69-121`.

**Fix:** either run the real export pipeline with format `geotiff`/`png` before switching tabs, or remove the Babylon preset until the in-engine pipeline is implemented.

---

## 10. No upper bound on tile / zoom combinations (M)

`executeExport` downloads `(maxX - minX + 1) * (maxY - minY + 1)` tiles sequentially with no cap. At imagery zoom 19 over a 1° × 1° box that is ≈ 4 M tiles. The user can trivially trigger this by selecting a large bbox and picking "Maximum" zoom. The Node process will run out of heap during `mergeImageryTiles` (it allocates `tilesX * tilesY * 256 * 256 * 4` bytes in a single Buffer).

**Fix:** compute the tile count up front, refuse / warn if it exceeds a threshold (e.g. > 1024 tiles per source), and clamp `chooseZoom` accordingly.

---

## 11. No concurrency limit on tile downloads (M)

`executeExport` downloads tiles in a serial `for` loop — slow but safe. The export of N selected tiles in `ExportPanel.handleExport` is also serial. With many tiles this is unbearably slow on fast connections; with parallelisation it could trigger ArcGIS / S3 rate-limiting. Either way it is not tuned.

**Fix:** add a bounded concurrency wrapper (e.g. 6 in-flight requests), wire `onProgressUpdate` so the UI shows per-tile progress.

---

## 12. Per-tile output paths use forward slashes on Windows (L)

```ts
const tileOutputPath = `${outputPath}/tile_${tile.row}_${tile.col}`;
```

Node accepts these on Windows but the resulting manifests will mix `\` and `/`. Use `path.join` (or pass to main process and let it normalise).

`src/components/ExportPanel/ExportPanel.tsx:141`.

---

## 13. `mainWindow` can be null when a dialog is opened (L)

After `mainWindow.on('closed', () => { mainWindow = null })`, any subsequent `dialog.showOpenDialog(mainWindow, ...)` passes `null`. Electron treats that as a detached dialog (fine on Win/Linux, ugly on macOS). Either guard or pass `BrowserWindow.getFocusedWindow() ?? undefined`.

`electron/main.ts:68-70, 196, 204`.

---

## 14. `downloadBuffer` redirect handling is incomplete (L)

Only `301` and `302` are handled; `303`, `307`, `308` are not. CDNs and S3 occasionally emit `307`. Also no max-redirect counter, so a misconfigured server could loop until the socket timeout.

`electron/export-engine.ts:111-136`.

---

## 15. Shapefile parser only supports record types 1/3/5 (L)

`parseShpBuffer` ignores Z- and M-coordinated polygons (types 11, 13, 15, 21, 23, 25) and MultiPoint (8). For OSM exports that's fine, but the drop-zone advertises ".shp" support generally. Worth a friendly error rather than silently parsing nothing.

Also the function is typed `number[][][][]` but polyline records push `[partPoints]` which is `number[][][]` (one level shallower), so `polygons.flat(2)` produces `number[]` for polylines and `number[][]` for polygons — the downstream `xs.map(c => c[0])` happens to work for both only because `flat(2)` unwraps just enough. Brittle.

`src/components/MapViewport/MapViewport.tsx:55-192, 688-764`.

---

## 16. Heightmap PNG / R16 outputs are min-max normalised without metadata (L)

`writeHeightmapPNG` and `writeHeightmapR16` rescale to 0–65535 against the per-export `[min,max]`. The actual elevations are then unrecoverable from the file alone. The manifest stores `elevation.min/max` only in the export-engine path; for tiles produced by the (future) native addon this will need to be standardised. Document the contract somewhere.

---

## 17. `useEffect` in `MapViewport` builds a `Set` it never uses (L)

```ts
const all = new Set<string>();
for (const tile of grid.tiles) { all.add(`${tile.row},${tile.col}`); }
useTerrainStore.getState().selectAllTiles();
```

`all` is constructed and discarded. `selectAllTiles()` is the only effective call.

`src/components/MapViewport/MapViewport.tsx:407-412`.

---

## 18. `defaultProfile.sources.demSource = 'aws-terrain'` (L)

Typo: the rest of the code uses `'aws-terrarium'`. Profile-driven plan generation will use a non-existent source ID. See (1).

`src/core/store.ts:14`.

---

## 19. `pngjs` dependency is declared but never imported (L)

`grep -r "from 'pngjs'"` returns nothing. Either remove the dep or use it in the heightmap writers (PNG is currently written via `sharp`).

`package.json:32`.

---

## 20. `electron-builder` config references `node_modules/cesium/**` but Cesium is not a dependency (L)

`package.json:74` ships Cesium build files, but `cesium` and `resium` are not in `dependencies`. The README also mentions CesiumJS, while the actual map is MapLibre and the 3D viewer is Babylon.js. Drop the file glob and update the README (done in the new README below).

---

## 21. Status bar reports incorrect tech (L)

`src/App.tsx:92` prints `"CesiumJS"` in the footer even though no Cesium is used.

---

## 22. Minor: `JSX.Element` return type (L)

`App(): JSX.Element` requires the global `JSX` namespace which `@types/react@18` no longer provides under `react-jsx` in some setups. Prefer `React.JSX.Element` or just drop the annotation.

`src/App.tsx:17`.

---

## 23. Imagery merge buffer overflow risk (M)

`mergeImageryTiles` allocates `canvasW * canvasH * 4` bytes synchronously. For e.g. 64×64 tiles that's 1 GB. Combined with (10), an unbounded selection on a high-zoom export will crash with `RangeError: Invalid typed array length` long before download finishes.

`electron/export-engine.ts:205-244`.

**Fix:** stream tile decoding into the final resized buffer directly, or process in chunks.

---

## 24. `cropDEM` height calculation can be negative (L)

`const height = Math.round(pxSouth - pxNorth);` — pixel-Y increases downward, so for a valid bbox this is positive, but at the equator-spanning case with mis-ordered bounds it can flip. Guard with `Math.abs` (or assert ordering in the caller).

`electron/export-engine.ts:265, 302`.

---

## Suggested fix order

1. (1) Source ID mismatch – cosmetically simple, currently breaking Mapbox/MapTiler.
2. (5) Forward all params to native `exportPackage`.
3. (3)/(4) Delete `.js`/`.cjs` duplicates, set up a single emit step, sync `main.ts`.
4. (2) Decide & label heightmap formats correctly.
5. (10)/(23) Tile-count guard.
6. (8) IPC-based heightmap loading for the 3D viewer.
7. (9) Wire Babylon preset to a real export.
8. Remaining polish items.

Each fix above is small in isolation; the dangerous compounding is (3)+(4) — almost every other change risks being lost across the three copies until that is resolved.
