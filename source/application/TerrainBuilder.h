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
    double world_size_m = 0.0; // side length of the square terrain in metres
    double height_min_m = 0.0; // elevation floor  (metres above sea level)
    double height_max_m = 0.0; // elevation ceiling
    int tile_resolution = 1024;// per-tile texel count for the .lmap
};

struct TerrainBuildReport
{
    QString lmap_path;
    int grid_x = 0;
    int grid_y = 0;
    int tile_resolution = 0;
};

class TerrainBuilder
{
public:
    using LogFn = std::function<void(const QString&)>;

    Result<TerrainBuildReport> build(const TerrainBuildRequest& request, LogFn log) const;

    // Exposed for unit testing / pre-flight validation (no engine calls).
    static Result<QString> validate(const TerrainBuildRequest& request);
};
