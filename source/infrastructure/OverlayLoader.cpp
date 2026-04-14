#include "OverlayLoader.h"

#include <gdal_priv.h>
#include <ogrsf_frmts.h>

namespace
{
GeoBounds invalidExtent()
{
    GeoBounds extent;
    extent.west = 1e9;
    extent.east = -1e9;
    extent.south = 1e9;
    extent.north = -1e9;
    return extent;
}
}

Result<QStringList> OverlayLoader::listLayers(const QString& path) const
{
    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpenEx(path.toUtf8().constData(), GDAL_OF_VECTOR | GDAL_OF_READONLY, nullptr, nullptr, nullptr));
    if (!ds)
        return Result<QStringList>::fail(1, "Failed to open vector file.");

    QStringList layers;
    for (int i = 0; i < ds->GetLayerCount(); ++i)
    {
        OGRLayer* layer = ds->GetLayer(i);
        if (layer)
            layers << QString::fromUtf8(layer->GetName());
    }
    GDALClose(ds);
    return Result<QStringList>::ok(layers);
}

Result<OverlayLoadResult> OverlayLoader::loadLayer(const QString& path, int layer_index, const QString& layer_name) const
{
    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpenEx(path.toUtf8().constData(), GDAL_OF_VECTOR | GDAL_OF_READONLY, nullptr, nullptr, nullptr));
    if (!ds)
        return Result<OverlayLoadResult>::fail(1, "Failed to open vector file.");

    OGRLayer* layer = ds->GetLayer(layer_index);
    if (!layer)
    {
        GDALClose(ds);
        return Result<OverlayLoadResult>::fail(2, "Requested layer was not found.");
    }

    OGRSpatialReference wgs84;
    wgs84.importFromEPSG(4326);
    wgs84.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);

    const OGRSpatialReference* src_srs_const = layer->GetSpatialRef();
    OGRCoordinateTransformation* ct = nullptr;
    if (src_srs_const)
    {
        OGRSpatialReference src_copy(*src_srs_const);
        src_copy.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
        ct = OGRCreateCoordinateTransformation(&src_copy, &wgs84);
    }

    OverlayLoadResult result;
    result.overlay.name = layer_name;
    result.overlay.color = QColor(255, 165, 0);
    result.extent = invalidExtent();

    std::function<void(OGRGeometry*)> extract = [&](OGRGeometry* geom)
    {
        if (!geom)
            return;

        const OGRwkbGeometryType gt = wkbFlatten(geom->getGeometryType());
        if (gt == wkbLineString || gt == wkbLinearRing)
        {
            OGRLineString* line = static_cast<OGRLineString*>(geom);
            OverlayRing ring;
            ring.closed = (gt == wkbLinearRing);
            for (int i = 0; i < line->getNumPoints(); ++i)
            {
                const double lon = line->getX(i);
                const double lat = line->getY(i);
                if (lon < -180.0 || lon > 180.0 || lat < -90.0 || lat > 90.0)
                    return;
                ring.points << QPointF(lon, lat);
                result.extent.west = std::min(result.extent.west, lon);
                result.extent.east = std::max(result.extent.east, lon);
                result.extent.south = std::min(result.extent.south, lat);
                result.extent.north = std::max(result.extent.north, lat);
            }
            if (ring.points.size() >= 2)
                result.overlay.rings << ring;
            return;
        }

        if (gt == wkbPolygon)
        {
            OGRPolygon* poly = static_cast<OGRPolygon*>(geom);
            if (OGRLinearRing* ext = poly->getExteriorRing())
                extract(ext);
            return;
        }

        if (gt == wkbMultiLineString || gt == wkbMultiPolygon || gt == wkbGeometryCollection)
        {
            OGRGeometryCollection* collection = static_cast<OGRGeometryCollection*>(geom);
            for (int i = 0; i < collection->getNumGeometries(); ++i)
                extract(collection->getGeometryRef(i));
        }
    };

    layer->ResetReading();
    OGRFeature* feature = nullptr;
    while ((feature = layer->GetNextFeature()) != nullptr)
    {
        OGRGeometry* geom = feature->GetGeometryRef();
        if (geom)
        {
            OGRGeometry* clone = geom->clone();
            if (ct)
                clone->transform(ct);
            extract(clone);
            OGRGeometryFactory::destroyGeometry(clone);
        }
        OGRFeature::DestroyFeature(feature);
        ++result.feature_count;
    }

    if (ct)
        OCTDestroyCoordinateTransformation(ct);
    GDALClose(ds);

    return Result<OverlayLoadResult>::ok(result);
}
