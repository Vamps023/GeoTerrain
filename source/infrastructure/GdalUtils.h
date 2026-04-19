#pragma once
#include <string>

namespace GdalUtils
{
    // Re-embed the correct EPSG:4326 WGS84 WKT1 CRS tag into a GeoTIFF in-place.
    // Ensures QGIS "Save Raster Layer as" and Unigine LayerGeo both read the CRS.
    // Data values and geotransform are preserved; no reprojection is performed.
    // Returns true on success.
    bool fixCrsTag(const std::string& tif_path);
}
