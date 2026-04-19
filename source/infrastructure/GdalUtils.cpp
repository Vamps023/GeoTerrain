#include "GdalUtils.h"

#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>

namespace GdalUtils
{

bool fixCrsTag(const std::string& tif_path)
{
    GDALAllRegister();

    // Open in update mode so we can write the projection tag in-place
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpen(tif_path.c_str(), GA_Update));
    if (!ds)
        return false;

    // Build EPSG:4326 WGS84 WKT1 (the format QGIS and Unigine both recognise)
    OGRSpatialReference srs;
    srs.importFromEPSG(4326);
    srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);

    char* wkt = nullptr;
    // Export as WKT1_GDAL — the legacy format that older GDAL/QGIS pipelines expect
    const char* const opts[] = { "FORMAT=WKT1_GDAL", nullptr };
    srs.exportToWkt(&wkt, opts);

    if (!wkt)
    {
        GDALClose(ds);
        return false;
    }

    ds->SetProjection(wkt);
    CPLFree(wkt);
    GDALClose(ds);
    return true;
}

} // namespace GdalUtils
