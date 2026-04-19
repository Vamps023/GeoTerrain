#include "ShapefileExporter.h"

#include <gdal_priv.h>
#include <ogrsf_frmts.h>

#include <vector>

namespace
{
void report(RunContext& context, const std::string& message, int percent)
{
    if (context.progress)
        context.progress(message, percent);
}

OGRLayer* getOrCreateLayer(GDALDataset* ds, const char* name, OGRwkbGeometryType geom_type,
                           OGRSpatialReference* srs)
{
    OGRLayer* layer = ds->GetLayerByName(name);
    if (layer)
        return layer;
    layer = ds->CreateLayer(name, srs, geom_type, nullptr);
    if (!layer)
        return nullptr;

    OGRFieldDefn fld_subtype("subtype", OFTString);
    fld_subtype.SetWidth(64);
    layer->CreateField(&fld_subtype);

    OGRFieldDefn fld_name("name", OFTString);
    fld_name.SetWidth(128);
    layer->CreateField(&fld_name);
    return layer;
}

void writeWay(OGRLayer* layer, const OSMParser::Way& way, bool as_polygon)
{
    if (way.nodes.size() < 2)
        return;
    OGRFeature* feat = OGRFeature::CreateFeature(layer->GetLayerDefn());
    feat->SetField("subtype", way.subtype.c_str());
    feat->SetField("name", way.name.c_str());
    if (as_polygon && way.nodes.size() >= 3)
    {
        OGRPolygon poly;
        OGRLinearRing ring;
        for (const auto& node : way.nodes)
            ring.addPoint(node.second, node.first);
        ring.closeRings();
        poly.addRing(&ring);
        feat->SetGeometry(&poly);
    }
    else
    {
        OGRLineString line;
        for (const auto& node : way.nodes)
            line.addPoint(node.second, node.first);
        feat->SetGeometry(&line);
    }
    layer->CreateFeature(feat);
    OGRFeature::DestroyFeature(feat);
}
}

Result<VectorExportSummary> ShapefileExporter::exportAll(const OSMParser::ParseResult& osm,
                                                        const Config& config, RunContext& context)
{
    if (!osm.success || osm.ways.empty())
        return Result<VectorExportSummary>::ok(VectorExportSummary{});

    GDALAllRegister();
    GDALDriver* drv = GetGDALDriverManager()->GetDriverByName("ESRI Shapefile");
    if (!drv)
        return Result<VectorExportSummary>::fail(1, "ESRI Shapefile driver not found.");

    OGRSpatialReference srs;
    srs.importFromEPSG(4326);

    struct LayerDef
    {
        OSMParser::Way::Tag tag;
        const char* filename;
        OGRwkbGeometryType geom;
        bool as_polygon;
    };

    const std::vector<LayerDef> layers = {
        { OSMParser::Way::Tag::Road, "roads", wkbLineString, false },
        { OSMParser::Way::Tag::Railway, "railways", wkbLineString, false },
        { OSMParser::Way::Tag::Building, "buildings", wkbPolygon, true },
        { OSMParser::Way::Tag::Vegetation, "vegetation", wkbPolygon, true },
        { OSMParser::Way::Tag::Water, "water", wkbPolygon, true },
    };

    VectorExportSummary summary;
    for (const auto& ld : layers)
    {
        std::vector<const OSMParser::Way*> matching;
        for (const auto& way : osm.ways)
        {
            if (way.tag == ld.tag)
                matching.push_back(&way);
        }
        if (matching.empty())
            continue;

        const std::string path = config.output_dir + "/" + ld.filename + ".shp";
        VSIUnlink(path.c_str());
        VSIUnlink((config.output_dir + "/" + ld.filename + ".dbf").c_str());
        VSIUnlink((config.output_dir + "/" + ld.filename + ".shx").c_str());
        VSIUnlink((config.output_dir + "/" + ld.filename + ".prj").c_str());

        GDALDataset* ds = drv->Create(path.c_str(), 0, 0, 0, GDT_Unknown, nullptr);
        if (!ds)
            continue;
        OGRLayer* layer = getOrCreateLayer(ds, ld.filename, ld.geom, &srs);
        if (!layer)
        {
            GDALClose(ds);
            continue;
        }

        int count = 0;
        for (const auto* way : matching)
        {
            if (context.isCancelled())
            {
                GDALClose(ds);
                return Result<VectorExportSummary>::fail(999, "Cancelled.");
            }
            writeWay(layer, *way, ld.as_polygon);
            ++count;
        }
        GDALClose(ds);
        summary.total_features += count;
        report(context, "SHP [" + std::string(ld.filename) + ".shp] - " + std::to_string(count) + " features", 72);
    }

    return Result<VectorExportSummary>::ok(summary);
}
