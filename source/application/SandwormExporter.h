#pragma once

#include "../domain/Result.h"
#include "domain/GeoBounds.h"

#include <QString>
#include <functional>
#include <vector>

// ---------------------------------------------------------------------------
// Metadata for one terrain chunk — heightmap + albedo TIF files
struct SandwormChunkEntry
{
    QString id;               // "root" | "chunk_0_0" etc.

    // --- heightmap ---
    QString heightmap_path;   // absolute path
    int     width      = 0;
    int     height     = 0;
    int     num_bands  = 1;
    double  geo_west   = 0.0;
    double  geo_north  = 0.0;
    double  geo_east   = 0.0;
    double  geo_south  = 0.0;
    double  pixel_w    = 0.0;
    double  pixel_h    = 0.0;
    bool    has_no_data    = false;
    double  no_data_value  = -9999.0;
    QString file_hash;        // SHA1 hex
    qint64  mtime      = 0;

    // --- albedo ---
    QString albedo_path;
    int     albedo_width      = 0;
    int     albedo_height     = 0;
    int     albedo_num_bands  = 3;
    double  albedo_geo_west   = 0.0;
    double  albedo_geo_north  = 0.0;
    double  albedo_geo_east   = 0.0;
    double  albedo_geo_south  = 0.0;
    double  albedo_pixel_w    = 0.0;
    double  albedo_pixel_h    = 0.0;
    QString albedo_file_hash;
    qint64  albedo_mtime      = 0;
};

// ---------------------------------------------------------------------------
// Generates a Unigine Sandworm project (.sworm + .sworm.meta) from the
// GatheredExport folder produced by GeoTerrain's gather step.
//
// Sources scanned (in order of preference):
//   1. <base_output_dir>/GatheredExport/  — files: chunk_R_C_heightmap.tif, chunk_R_C_albedo.tif
//   2. <base_output_dir>/                 — files: heightmap.tif, albedo.tif  (single-chunk)
//
// Output:
//   <base_output_dir>/<project_name>.sworm
//   <base_output_dir>/<project_name>.sworm.meta
class SandwormExporter
{
public:
    using LogFn = std::function<void(const QString&)>;

    Result<QString> createProject(const QString& base_output_dir,
                                  const GeoBounds& bounds,
                                  const QString& project_name,
                                  LogFn log) const;

private:
    std::vector<SandwormChunkEntry> scanChunks(const QString& scan_dir,
                                               const QString& base_output_dir,
                                               const GeoBounds& bounds) const;

    bool writeSworm(const QString& path,
                    const QString& project_name,
                    const std::vector<SandwormChunkEntry>& chunks,
                    const QString& generation_path,
                    LogFn log) const;

    bool writeSwormMeta(const QString& path,
                        const QString& project_name,
                        const QString& sworm_path,
                        LogFn log) const;
};
