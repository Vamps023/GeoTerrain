#pragma once

#include "domain/Result.h"

#include <QString>
#include <functional>

// ---------------------------------------------------------------------------
// TerrainBuilder
//
// Turns a heightmap TIFF + albedo TIFF into a native UNIGINE LandscapeTerrain:
//   1. Decodes both TIFFs via GDAL (supports 16-bit / 32-bit grayscale for
//      height and 8-bit RGB/RGBA for albedo).
//   2. Drives LandscapeMapFileCreator to produce an .lmap on disk, filling
//      tiles on the fly from the decoded source data.
//   3. Spawns a LandscapeLayerMap node pointing at the .lmap plus an active
//      ObjectLandscapeTerrain if the world does not already own one.
//
// All UNIGINE API calls must happen on the engine main thread; GDAL decode is
// thread-safe and may be done ahead of time on a worker if desired, but the
// current implementation runs fully on the calling thread (build is invoked
// from the Qt UI thread inside the editor plugin).
struct TerrainBuildRequest
{
    QString heightmap_path;    // absolute path to heightmap TIFF
    QString albedo_path;       // absolute path to albedo TIFF
    QString output_lmap_path;  // absolute path to the .lmap to create
    // All remaining fields auto-computed from heightmap when left at 0:
    //   world_size_m   ← GeoTIFF pixel scale × width (or sensible default)
    //   height_min_m   ← min non-no-data pixel value
    //   height_max_m   ← max pixel value
    //   tile_resolution ← 1024 by default
    double world_size_m = 0.0;
    double height_min_m = 0.0;
    double height_max_m = 0.0;
    int tile_resolution = 0;
};

struct TerrainAutoParams
{
    double world_size_m = 0.0;
    double height_min_m = 0.0;
    double height_max_m = 0.0;
    int tile_resolution = 1024;
    int heightmap_width = 0;
    int heightmap_height = 0;
    bool has_geo_transform = false;
};

struct TerrainBuildReport
{
    QString lmap_path;
    int grid_x = 0;
    int grid_y = 0;
    int tile_resolution = 0;
};

// Request for building a full multi-chunk terrain from gathered folders.
// heightmap_folder must contain files named chunk_N_heightmap.tif
// albedo_folder    must contain files named chunk_N_albedo.tif
// output_lmap_folder is the directory where per-chunk .lmap files are written.
struct MultiTileBuildRequest
{
    QString heightmap_folder;
    QString albedo_folder;
    QString output_lmap_folder;
};

struct MultiTileBuildReport
{
    int chunks_built = 0;
    int chunks_failed = 0;
};

struct ChunkEntry
{
    int     index   = 0;
    QString hm_path;
    QString alb_path;
};

class TerrainBuilder
{
public:
    using LogFn = std::function<void(const QString&)>;

    Result<TerrainBuildReport> build(const TerrainBuildRequest& request, LogFn log) const;

    // Multi-chunk: scan heightmap/ and albedo/ folders, detect NxN grid,
    // build one .lmap per chunk and place each LandscapeLayerMap at the
    // correct world-space offset so they tile seamlessly.
    Result<MultiTileBuildReport> buildMultiTile(const MultiTileBuildRequest& request, LogFn log) const;

    // Exposed for unit testing / pre-flight validation (no engine calls).
    static Result<QString> validate(const TerrainBuildRequest& request);

    // Auto-compute terrain parameters from a heightmap TIFF via GDAL.
    // Used when the user leaves scale/elevation inputs unset in the UI.
    static Result<TerrainAutoParams> computeAutoParams(const QString& heightmap_path);
};
