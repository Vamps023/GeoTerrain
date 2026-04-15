# GeoTerrain — Unreal Engine Plugin

Branch: `unreal_GeoTerrain`

Real-world geo terrain generator ported from the Unigine plugin.
Downloads DEM elevation + satellite tiles, exports `heightmap.tif` + `heightmap.r16` and `albedo.tif`, then imports directly into a UE Landscape actor.

---

## Requirements

| Dependency | Version | Notes |
|------------|---------|-------|
| Unreal Engine | 5.x | Plugin type: Editor |
| GDAL | 3.x | See setup below |
| C++ standard | C++17 | Set in Build.cs |

---

## Setup

### 1. Copy plugin into your project
```
<YourProject>/Plugins/GeoTerrain/   ← contents of UnrealGeoTerrain/
```

### 2. Add GDAL under ThirdParty
```
Plugins/GeoTerrain/ThirdParty/GDAL/
    include/     ← GDAL headers
    lib/         ← gdal_i.lib
    bin/         ← gdal310.dll  (copied to Binaries at build time)
```
You can get GDAL from OSGeo4W:
`C:\Users\<you>\AppData\Local\Programs\OSGeo4W\`

### 3. Regenerate project files
Right-click `.uproject` → **Generate Visual Studio project files**

### 4. Build
Open the `.sln` and build `Development Editor` config.

---

## Usage

1. Open editor → **Window** menu → **GeoTerrain Generator**
2. Enter bounding box (WGS84 decimal degrees)
3. Set OpenTopography API key (free at https://opentopography.org)
4. Set output directory and chunk size
5. Click **Export Terrain** — watch the log
6. When finished, click **Import Landscape** to create an `ALandscape` actor

---

## Output Files (per chunk)

| File | Format | Description |
|------|--------|-------------|
| `heightmap.tif` | Float32 GeoTIFF | Full-precision elevation (Unigine / GIS tools) |
| `heightmap.r16` | Uint16 RAW | Unreal landscape import format |
| `albedo.tif` | RGB GeoTIFF | Satellite imagery texture |
| `mask.tif` | RGBA GeoTIFF | Feature mask (roads/buildings/veg/water) |

---

## API vs Unigine Mapping

| Unigine (Qt) | Unreal |
|---|---|
| `QThread` + signals | `AsyncTask` + `TMulticastDelegate` |
| `QNetworkAccessManager` | `FHttpModule` / `IHttpRequest` |
| `QWidget` / `QPushButton` | `SCompoundWidget` / `SButton` (Slate) |
| `QUuid` | `FGuid::NewGuid()` |
| `SandwormExporter` | `FGeoLandscapeImporter` → `ALandscape::Import()` |
| `CMakeLists.txt` | `GeoTerrain.Build.cs` |
| `.sworm` / `.sworm.meta` | Not needed — direct landscape import |

---

## Z Scale Formula
When Unreal asks for Z Scale during landscape import:
```
Z Scale = (elev_max - elev_min) * 100.0 / 512.0
```
The plugin sets this automatically based on GDAL-detected elevation range.
