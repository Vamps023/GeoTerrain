#pragma once

#include "OSMParser.h"

#include <functional>
#include <string>

// Exports OSM ParseResult into per-layer Shapefiles using GDAL OGR.
// Output files written to output_dir:
//   roads.shp          - highway ways (subtype = road class)
//   railways.shp       - railway ways (subtype = rail/tram/subway etc.)
//   buildings.shp      - building footprints
//   vegetation.shp     - parks, forests, grassland
//   water.shp          - rivers, lakes, reservoirs
class ShapefileExporter
{
public:
    struct Config
    {
        std::string output_dir;   // directory to write .shp files into
    };

    using ProgressCallback = std::function<void(const std::string& message, int percent)>;

    // Writes all layers — returns number of features written total.
    int exportAll(const OSMParser::ParseResult& osm,
                  const Config&                 config,
                  ProgressCallback              progress_cb);
};
