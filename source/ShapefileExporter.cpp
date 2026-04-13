#include "ShapefileExporter.h"

#include <gdal_priv.h>
#include <ogrsf_frmts.h>
#include <ogr_spatialref.h>

#include <map>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Helper: create or open a layer inside a datasource
static OGRLayer* getOrCreateLayer(GDALDataset* ds,
                                   const char*  name,
                                   OGRwkbGeometryType geom_type,
                                   OGRSpatialReference* srs)
{
    OGRLayer* layer = ds->GetLayerByName(name);
    if (layer)
        return layer;
    layer = ds->CreateLayer(name, srs, geom_type, nullptr);
    if (!layer)
        return nullptr;

    // Add standard attribute fields
    OGRFieldDefn fld_subtype("subtype", OFTString);
    fld_subtype.SetWidth(64);
    layer->CreateField(&fld_subtype);

    OGRFieldDefn fld_name("name", OFTString);
    fld_name.SetWidth(128);
    layer->CreateField(&fld_name);

    return layer;
}

// ---------------------------------------------------------------------------
// Write one way as a LineString or Polygon feature into a layer
static void writeWay(OGRLayer* layer,
                     const OSMParser::Way& way,
                     bool as_polygon)
{
    if (way.nodes.size() < 2)
        return;

    OGRFeature* feat = OGRFeature::CreateFeature(layer->GetLayerDefn());
    feat->SetField("subtype", way.subtype.c_str());
    feat->SetField("name",    way.name.c_str());

    if (as_polygon && way.nodes.size() >= 3)
    {
        OGRPolygon poly;
        OGRLinearRing ring;
        for (const auto& [lat, lon] : way.nodes)
            ring.addPoint(lon, lat);
        ring.closeRings();
        poly.addRing(&ring);
        feat->SetGeometry(&poly);
    }
    else
    {
        OGRLineString line;
        for (const auto& [lat, lon] : way.nodes)
            line.addPoint(lon, lat);
        feat->SetGeometry(&line);
    }

    layer->CreateFeature(feat);
    OGRFeature::DestroyFeature(feat);
}

// ---------------------------------------------------------------------------
int ShapefileExporter::exportAll(const OSMParser::ParseResult& osm,
                                  const Config&                 config,
                                  ProgressCallback              progress_cb)
{
    if (!osm.success || osm.ways.empty())
    {
        if (progress_cb) progress_cb("SHP export: no OSM data to export", 0);
        return 0;
    }

    GDALAllRegister();
    GDALDriver* drv = GetGDALDriverManager()->GetDriverByName("ESRI Shapefile");
    if (!drv)
    {
        if (progress_cb) progress_cb("ERROR: ESRI Shapefile GDAL driver not found", 0);
        return 0;
    }

    OGRSpatialReference srs;
    srs.importFromEPSG(4326);

    // One datasource per layer (Shapefile driver = one file per dataset)
    struct LayerDef
    {
        OSMParser::Way::Tag tag;
        const char*         filename;
        OGRwkbGeometryType  geom;
        bool                as_polygon;
    };

    const std::vector<LayerDef> layers = {
        { OSMParser::Way::Tag::Road,       "roads",      wkbLineString, false },
        { OSMParser::Way::Tag::Railway,    "railways",   wkbLineString, false },
        { OSMParser::Way::Tag::Building,   "buildings",  wkbPolygon,    true  },
        { OSMParser::Way::Tag::Vegetation, "vegetation", wkbPolygon,    true  },
        { OSMParser::Way::Tag::Water,      "water",      wkbPolygon,    true  },
    };

    int total_features = 0;

    for (const auto& ld : layers)
    {
        // Collect ways for this layer
        std::vector<const OSMParser::Way*> matching;
        for (const auto& way : osm.ways)
            if (way.tag == ld.tag)
                matching.push_back(&way);

        if (matching.empty())
            continue;

        const std::string path = config.output_dir + "/" + ld.filename + ".shp";

        // Delete existing file first (Shapefile driver won't overwrite)
        VSIUnlink(path.c_str());
        const std::string dbf = config.output_dir + "/" + ld.filename + ".dbf";
        const std::string shx = config.output_dir + "/" + ld.filename + ".shx";
        const std::string prj = config.output_dir + "/" + ld.filename + ".prj";
        VSIUnlink(dbf.c_str());
        VSIUnlink(shx.c_str());
        VSIUnlink(prj.c_str());

        GDALDataset* ds = drv->Create(path.c_str(), 0, 0, 0, GDT_Unknown, nullptr);
        if (!ds)
        {
            if (progress_cb)
                progress_cb("ERROR: Cannot create " + path, 0);
            continue;
        }

        OGRLayer* layer = getOrCreateLayer(ds, ld.filename, ld.geom, &srs);
        if (!layer)
        {
            GDALClose(ds);
            continue;
        }

        int count = 0;
        for (const auto* way : matching)
        {
            writeWay(layer, *way, ld.as_polygon);
            count++;
        }

        GDALClose(ds);
        total_features += count;

        if (progress_cb)
            progress_cb("SHP [" + std::string(ld.filename) + ".shp] — " +
                        std::to_string(count) + " features", 0);
    }

    if (progress_cb)
        progress_cb("=== Shapefiles exported: " + std::to_string(total_features) +
                    " total features to " + config.output_dir + " ===", 0);

    return total_features;
}
