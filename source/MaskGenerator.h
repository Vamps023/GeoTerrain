#pragma once

#include "GeoBounds.h"
#include "OSMParser.h"

#include <functional>
#include <string>

// Rasterizes OSM way geometry into a multi-band GeoTIFF mask:
//   Band 1: Roads       (uint8, 0/255)
//   Band 2: Buildings   (uint8, 0/255)
//   Band 3: Vegetation  (uint8, 0/255)
class MaskGenerator
{
public:
    struct Config
    {
        std::string output_path;     // full path to output mask.tif
        std::string ref_tif_path;    // if set, match width/height/bounds of this GeoTIFF (albedo)
        double      resolution_m = 30.0;
        double      road_width_m = 10.0; // buffer radius for road lines
    };

    using ProgressCallback = std::function<void(const std::string& message, int percent)>;

    // Synchronous rasterization — call from worker thread.
    bool generate(const GeoBounds&           bounds,
                  const OSMParser::ParseResult& osm,
                  const Config&              config,
                  ProgressCallback           progress_cb);

private:
    // Draw a filled polygon into a single-band uint8 raster buffer
    void rasterizePolygon(std::vector<uint8_t>& buf, int width, int height,
                          const GeoBounds& bounds,
                          const std::vector<std::pair<double,double>>& ring,
                          uint8_t value);

    // Draw a line with buffer radius (in pixels) into a raster buffer
    void rasterizeLine(std::vector<uint8_t>& buf, int width, int height,
                       const GeoBounds& bounds,
                       const std::vector<std::pair<double,double>>& pts,
                       int radius_px, uint8_t value);

    // Convert lat/lon to pixel coordinate
    static void latLonToPixel(double lat, double lon,
                               const GeoBounds& bounds,
                               int width, int height,
                               int& px, int& py);
};
