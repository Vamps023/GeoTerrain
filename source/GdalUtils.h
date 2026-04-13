#pragma once
#include <string>

namespace GdalUtils
{
    // Reproject a GeoTIFF file in-place to EPSG:3395 (World Mercator, metres).
    // Unigine LayerGeo requires Mercator/metres — EPSG:4326 (degrees) is rejected.
    // Returns true on success; on failure the original file is left untouched.
    bool reprojectToMercator(const std::string& tif_path,
                             const std::string& tmp_path = "");
}
