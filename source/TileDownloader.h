#pragma once

#include "GeoBounds.h"

#include <functional>
#include <string>
#include <vector>

// Downloads and stitches XYZ map tiles covering a geographic bounding box
// into a single GeoTIFF (albedo) at the specified output path.
class TileDownloader
{
public:
    struct Config
    {
        std::string url_template;   // e.g. "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        int         zoom_level  = 14;
        int         target_size = 0; // if >0, resample output to target_size x target_size (e.g. 1024, 2048, 4096)
        std::string output_path;     // full path to output albedo.tif
    };

    using ProgressCallback = std::function<void(const std::string& message, int percent)>;

    // Synchronous download + stitch — call from worker thread.
    // Returns true on success.
    bool download(const GeoBounds& bounds,
                  const Config&    config,
                  ProgressCallback progress_cb);

private:
    // Download one tile PNG into memory; returns raw bytes or empty on error.
    std::vector<uint8_t> fetchTile(int z, int x, int y,
                                   const std::string& url_template);
};
