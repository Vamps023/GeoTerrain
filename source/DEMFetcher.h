#pragma once

#include "GeoBounds.h"

#include <functional>
#include <string>

// Fetches a DEM (Digital Elevation Model) for the given geographic bounding
// box and writes a Float32 GeoTIFF heightmap to the output path.
//
// Supported sources:
//   - OpenTopography REST API (SRTMGL3 / SRTMGL1 / AW3D30)
//   - Local GeoTIFF file (clip + reproject)
class DEMFetcher
{
public:
    enum class Source
    {
        OpenTopography_SRTM30m,   // SRTMGL1 (~30 m)
        OpenTopography_SRTM90m,   // SRTMGL3 (~90 m)
        OpenTopography_AW3D30,    // ALOS World 3D-30m
        LocalGeoTIFF              // user-supplied file
    };

    struct Config
    {
        Source      source           = Source::OpenTopography_SRTM30m;
        std::string api_key;          // required for OpenTopography
        std::string local_tiff_path;  // only for LocalGeoTIFF source
        std::string output_path;      // full path to output heightmap.tif
        std::string ref_tif_path;     // if set, match width/height of this GeoTIFF (albedo)
        double      resolution_m = 30.0; // desired output resolution in metres (fallback)
    };

    using ProgressCallback = std::function<void(const std::string& message, int percent)>;

    // Synchronous fetch — call from worker thread.
    bool fetch(const GeoBounds& bounds,
               const Config&    config,
               ProgressCallback progress_cb);

private:
    // Download DEM bytes from OpenTopography API
    bool fetchFromOpenTopography(const GeoBounds& bounds,
                                  const Config&    config,
                                  ProgressCallback progress_cb);

    // Clip + reproject a local GeoTIFF
    bool clipLocalTiff(const GeoBounds& bounds,
                        const Config&    config,
                        ProgressCallback progress_cb);

    // Write raw bytes from HTTP to a temp file, then warp to Float32 GeoTIFF
    bool convertToHeightmapTiff(const std::string& src_path,
                                 const std::string& dst_path,
                                 const GeoBounds&   bounds,
                                 const Config&      config,
                                 ProgressCallback   progress_cb);
};
