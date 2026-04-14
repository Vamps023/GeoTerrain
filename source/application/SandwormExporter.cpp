#include "SandwormExporter.h"

#include <gdal_priv.h>
#include <ogr_spatialref.h>

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUuid>

// ---------------------------------------------------------------------------
static bool fileExists(const QString& path)
{
    return QFileInfo::exists(path);
}

// ---------------------------------------------------------------------------
// Generate a short lowercase hex ID from a UUID (40-char SHA1-style)
static QString makeId()
{
    return QUuid::createUuid().toString(QUuid::Id128).left(40);
}

// ---------------------------------------------------------------------------
// Hash a file to a short 8-char hex (used in .sworm.meta)
static QString fileHash8(const QString& path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return "00000000";
    QCryptographicHash h(QCryptographicHash::Sha1);
    h.addData(&f);
    return h.result().toHex().left(8);
}

// WGS84 EPSG:4326 WKT (projection field in raster_info)
static const char* kWgs84Wkt =
    "GEOGCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\","
    "ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],"
    "PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],"
    "CS[ellipsoidal,2],"
    "AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],"
    "AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]],"
    "USAGE[SCOPE[\"Horizontal component of 3D system.\"],AREA[\"World.\"],BBOX[-90,-180,90,180]],"
    "ID[\"EPSG\",4326]]";

// polygon_projection inside each layer — uses "Popular Visualisation Pseudo-Mercator" (hyphen)
static const char* kPseudoMercatorLayerWkt =
    "PROJCRS[\"WGS 84 / Pseudo-Mercator\","
    "BASEGEOGCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\","
    "ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],"
    "PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4326]],"
    "CONVERSION[\"Popular Visualisation Pseudo-Mercator\",METHOD[\"Popular Visualisation Pseudo Mercator\",ID[\"EPSG\",1024]],"
    "PARAMETER[\"Latitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8801]],"
    "PARAMETER[\"Longitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8802]],"
    "PARAMETER[\"False easting\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8806]],"
    "PARAMETER[\"False northing\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8807]]],"
    "CS[Cartesian,2],"
    "AXIS[\"easting (X)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],"
    "AXIS[\"northing (Y)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]],"
    "USAGE[SCOPE[\"Web mapping and visualisation.\"],AREA[\"World between 85.06\u00b0S and 85.06\u00b0N.\"],BBOX[-85.06,-180,85.06,180]],"
    "ID[\"EPSG\",3857]]";

// parameters.projection (top-level) — uses "unnamed"
static const char* kPseudoMercatorWkt =
    "PROJCRS[\"WGS 84 / Pseudo-Mercator\","
    "BASEGEOGCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\","
    "ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],"
    "PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],ID[\"EPSG\",4326]],"
    "CONVERSION[\"unnamed\",METHOD[\"Popular Visualisation Pseudo Mercator\",ID[\"EPSG\",1024]],"
    "PARAMETER[\"Latitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8801]],"
    "PARAMETER[\"Longitude of natural origin\",0,ANGLEUNIT[\"degree\",0.0174532925199433],ID[\"EPSG\",8802]],"
    "PARAMETER[\"False easting\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8806]],"
    "PARAMETER[\"False northing\",0,LENGTHUNIT[\"metre\",1],ID[\"EPSG\",8807]]],"
    "CS[Cartesian,2],"
    "AXIS[\"easting (X)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],"
    "AXIS[\"northing (Y)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]],"
    "USAGE[SCOPE[\"Web mapping and visualisation.\"],AREA[\"World between 85.06\u00b0S and 85.06\u00b0N.\"],BBOX[-85.06,-180,85.06,180]],"
    "ID[\"EPSG\",3857]]";

// ---------------------------------------------------------------------------
Result<QString> SandwormExporter::createProject(const QString& base_output_dir,
                                                 const GeoBounds& bounds,
                                                 const QString& project_name,
                                                 LogFn log) const
{
    if (base_output_dir.isEmpty())
        return Result<QString>::fail(1, "Output directory is empty.");

    if (!QDir(base_output_dir).exists())
        return Result<QString>::fail(1, "Output directory does not exist: " + base_output_dir.toStdString());

    GDALAllRegister();

    // Prefer GatheredExport, fall back to base dir itself for single-chunk
    const QString gathered = base_output_dir + "/GatheredExport";
    const QString scan_dir = QDir(gathered).exists() ? gathered : base_output_dir;

    log("[Sandworm] Scanning: " + scan_dir);

    std::vector<SandwormChunkEntry> chunks = scanChunks(scan_dir, base_output_dir, bounds);
    if (chunks.empty())
        return Result<QString>::fail(1, "No heightmap.tif / albedo.tif files found.");

    log(QString("[Sandworm] Found %1 chunk(s)").arg(static_cast<int>(chunks.size())));

    const QString sworm_path = base_output_dir + "/" + project_name + ".sworm";
    const QString meta_path  = sworm_path + ".meta";

    if (!writeSworm(sworm_path, project_name, chunks, base_output_dir, log))
        return Result<QString>::fail(1, "Failed to write .sworm");

    if (!writeSwormMeta(meta_path, project_name, sworm_path, log))
        return Result<QString>::fail(1, "Failed to write .sworm.meta");

    log("[Sandworm] Done: " + sworm_path);
    return Result<QString>::ok(sworm_path);
}

// ---------------------------------------------------------------------------
// Read GDAL raster metadata needed for raster_info block
static void readGdalInfo(const QString& tif_path, SandwormChunkEntry& e, bool is_heightmap)
{
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpen(tif_path.toUtf8().constData(), GA_ReadOnly));
    if (!ds) return;

    e.width  = ds->GetRasterXSize();
    e.height = ds->GetRasterYSize();
    e.num_bands = ds->GetRasterCount();

    double gt[6] = {0, 1, 0, 0, 0, -1};
    ds->GetGeoTransform(gt);
    // gt[0]=west, gt[3]=north, gt[1]=pixel_w, gt[5]=-pixel_h
    e.geo_west  = gt[0];
    e.geo_north = gt[3];
    e.geo_east  = gt[0] + gt[1] * e.width;
    e.geo_south = gt[3] + gt[5] * e.height;
    e.pixel_w   = gt[1];
    e.pixel_h   = gt[5];

    if (is_heightmap && ds->GetRasterCount() >= 1)
    {
        GDALRasterBand* band = ds->GetRasterBand(1);
        // no_data
        int has_nd = 0;
        e.no_data_value = band->GetNoDataValue(&has_nd);
        e.has_no_data = (has_nd != 0);
    }

    // file mtime
    QFileInfo fi(tif_path);
    e.mtime = fi.lastModified().toSecsSinceEpoch();

    // SHA1 hash — read entire file in chunks to avoid blocking too long on large TIFs
    QFile f(tif_path);
    if (f.open(QIODevice::ReadOnly))
    {
        QCryptographicHash h(QCryptographicHash::Sha1);
        while (!f.atEnd())
            h.addData(f.read(65536));
        e.file_hash = h.result().toHex();
        f.close();
    }

    GDALClose(ds);
}

// ---------------------------------------------------------------------------
std::vector<SandwormChunkEntry> SandwormExporter::scanChunks(
    const QString& scan_dir,
    const QString& /*base_output_dir*/,
    const GeoBounds& /*total_bounds*/) const
{
    std::vector<SandwormChunkEntry> result;

    QDir dir(scan_dir);
    QRegularExpression re_chunk("^(chunk_\\d+_\\d+)_(heightmap|albedo)\\.tif$");
    QRegularExpression re_single("^(heightmap|albedo)\\.tif$");

    QStringList files = dir.entryList(QStringList() << "*.tif", QDir::Files, QDir::Name);

    // Use QMap (Qt-native, no operator< issues) chunk_id -> entry index
    QMap<QString, int> chunk_index;
    std::vector<SandwormChunkEntry> chunk_list;

    auto getOrCreate = [&](const QString& chunk_id) -> int {
        if (!chunk_index.contains(chunk_id))
        {
            chunk_index[chunk_id] = static_cast<int>(chunk_list.size());
            SandwormChunkEntry e;
            e.id = chunk_id;
            chunk_list.push_back(e);
        }
        return chunk_index[chunk_id];
    };

    for (const QString& fname : files)
    {
        auto m = re_chunk.match(fname);
        if (m.hasMatch())
        {
            const QString chunk_id = m.captured(1);
            const QString kind     = m.captured(2);
            const QString full     = scan_dir + "/" + fname;
            const int idx          = getOrCreate(chunk_id);

            if (kind == "heightmap")
            {
                chunk_list[idx].heightmap_path = full;
                readGdalInfo(full, chunk_list[idx], true);
            }
            else // albedo
            {
                chunk_list[idx].albedo_path = full;
                SandwormChunkEntry tmp;
                readGdalInfo(full, tmp, false);
                chunk_list[idx].albedo_width      = tmp.width;
                chunk_list[idx].albedo_height     = tmp.height;
                chunk_list[idx].albedo_num_bands  = tmp.num_bands;
                chunk_list[idx].albedo_geo_west   = tmp.geo_west;
                chunk_list[idx].albedo_geo_north  = tmp.geo_north;
                chunk_list[idx].albedo_geo_east   = tmp.geo_east;
                chunk_list[idx].albedo_geo_south  = tmp.geo_south;
                chunk_list[idx].albedo_pixel_w    = tmp.pixel_w;
                chunk_list[idx].albedo_pixel_h    = tmp.pixel_h;
                chunk_list[idx].albedo_mtime      = tmp.mtime;
                chunk_list[idx].albedo_file_hash  = tmp.file_hash;
            }
            continue;
        }

        // Single-chunk flat files
        auto ms = re_single.match(fname);
        if (ms.hasMatch())
        {
            const QString kind = ms.captured(1);
            const QString full = scan_dir + "/" + fname;
            const int idx      = getOrCreate("root");

            if (kind == "heightmap")
            {
                chunk_list[idx].heightmap_path = full;
                readGdalInfo(full, chunk_list[idx], true);
            }
            else
            {
                chunk_list[idx].albedo_path = full;
                SandwormChunkEntry tmp;
                readGdalInfo(full, tmp, false);
                chunk_list[idx].albedo_width      = tmp.width;
                chunk_list[idx].albedo_height     = tmp.height;
                chunk_list[idx].albedo_num_bands  = tmp.num_bands;
                chunk_list[idx].albedo_geo_west   = tmp.geo_west;
                chunk_list[idx].albedo_geo_north  = tmp.geo_north;
                chunk_list[idx].albedo_geo_east   = tmp.geo_east;
                chunk_list[idx].albedo_geo_south  = tmp.geo_south;
                chunk_list[idx].albedo_pixel_w    = tmp.pixel_w;
                chunk_list[idx].albedo_pixel_h    = tmp.pixel_h;
                chunk_list[idx].albedo_mtime      = tmp.mtime;
                chunk_list[idx].albedo_file_hash  = tmp.file_hash;
            }
        }
    }

    for (const SandwormChunkEntry& e : chunk_list)
        if (!e.heightmap_path.isEmpty())
            result.push_back(e);

    return result;
}

// ---------------------------------------------------------------------------
// Build the raster_info JSON object for one TIF file
static QJsonObject makeRasterInfo(
    const QString& filename, int num_bands,
    int sx, int sy,
    double west, double south, double east, double north,
    double pixel_w, double pixel_h,
    bool has_no_data, double no_data_val,
    const QString& file_hash, qint64 mtime)
{
    QJsonObject ri;
    ri["name"]      = filename;
    ri["num_bands"] = num_bands;
    ri["size_x"]    = sx;
    ri["size_y"]    = sy;

    QJsonArray rect;
    rect << west << south << east << north;
    ri["rect"] = rect;

    QJsonObject nd;
    nd["valid"] = has_no_data;
    QJsonArray ndv;
    ndv << (has_no_data ? no_data_val : 0.0)
        << -1000000000.0 << -1000000000.0 << -1000000000.0;
    nd["value"] = ndv;
    ri["no_data"] = nd;

    QJsonArray geo;
    geo << west << pixel_w << 0.0 << north << 0.0 << pixel_h;
    ri["geotranform"] = geo;   // intentional typo — matches Sandworm format exactly

    QJsonObject proj;
    proj["wkt"]                   = QString(kWgs84Wkt);
    proj["axis_mapping_strategy"] = 0;
    ri["projection"] = proj;

    ri["color_table"]      = QJsonArray();
    ri["color_table_used"] = QJsonArray();
    ri["hash"]  = file_hash;
    ri["mtime"] = static_cast<qint64>(mtime);

    return ri;
}

// ---------------------------------------------------------------------------
bool SandwormExporter::writeSworm(const QString& path,
                                   const QString& project_name,
                                   const std::vector<SandwormChunkEntry>& chunks,
                                   const QString& generation_path,
                                   LogFn log) const
{
    // ---- parameters block ----
    QJsonObject params;

    QJsonObject area;
    area["points"]       = QJsonArray();
    area["is_lock_area"] = false;
    params["area"] = area;

    auto makeParam = [](const QString& name, int type, QJsonValue val) -> QJsonObject {
        QJsonObject o;
        o["name"]  = name;
        o["type"]  = type;
        o["value"] = val;
        return o;
    };

    QJsonArray export_params;
    export_params << makeParam("quality",                                   2,  1)
                  << makeParam("coordinate_system",                         0,  0)
                  << makeParam("export_albedo_lossy_compression",           0,  0)
                  << makeParam("export_heightmap_opacity_lossy_compression", 0, 0)
                  << makeParam("projection",                                16, QString("EPSG:3857"))
                  << makeParam("export_compression_type",                   0,  0)
                  << makeParam("export_compression_method",                 0,  0)
                  << makeParam("world",                                     17, QString(QUuid::createUuid().toString(QUuid::Id128)))
                  << makeParam("export_format",                             0,  1)
                  << makeParam("export_masks_lossy_compression",            0,  0);
    params["export_parameters"] = export_params;

    params["generation_path"] = generation_path + "/" + project_name + "/";
    params["cache_path"]      = generation_path + "/.sandworm_cache/";

    QJsonArray gen_params;
    gen_params << makeParam("distributed_server_port",      0, 7741)
               << makeParam("distributed_broadcast_port",   0, 7814)
               << makeParam("distributed_workload_on_master",0,100)
               << makeParam("distributed_enabled",          0, 0)
               << makeParam("to_generate", 16,
                    QString("{\n\t\"elevations\": true,\n\t\"imageries\": true,\n\t\"details\": true,\n\t\"landcovers\": true,\n\t\"vectors\": true\n}"));
    params["generation_parameters"] = gen_params;
    params["projection"] = QString(kPseudoMercatorWkt);

    // ---- elevation source (type 1) ----
    QJsonArray elev_layers;
    for (const SandwormChunkEntry& e : chunks)
    {
        if (e.heightmap_path.isEmpty()) continue;
        const QString fname = QFileInfo(e.heightmap_path).fileName();
        QJsonObject layer;
        layer["id"]      = makeId();
        layer["name"]    = fname.left(fname.lastIndexOf('.'));
        layer["enabled"] = true;
        layer["type"]    = 1;

        QJsonObject lp;
        QJsonObject poly;
        poly["points"] = QJsonArray();
        lp["polygon"]            = poly;
        lp["polygon_projection"] = QString(kPseudoMercatorLayerWkt);
        lp["filepath"]           = e.heightmap_path;
        layer["parameters"] = lp;

        layer["raster_info"] = makeRasterInfo(
            fname, e.num_bands, e.width, e.height,
            e.geo_west, e.geo_south, e.geo_east, e.geo_north,
            e.pixel_w, e.pixel_h,
            e.has_no_data, e.no_data_value,
            e.file_hash, e.mtime);

        elev_layers << layer;
    }
    QJsonObject elev_source;
    elev_source["layers"] = elev_layers;
    elev_source["type"]   = 1;

    // ---- imagery/albedo source (type 2) ----
    QJsonArray albedo_layers;
    for (const SandwormChunkEntry& e : chunks)
    {
        if (e.albedo_path.isEmpty()) continue;
        const QString fname = QFileInfo(e.albedo_path).fileName();
        QJsonObject layer;
        layer["id"]      = makeId();
        layer["name"]    = fname.left(fname.lastIndexOf('.'));
        layer["enabled"] = true;
        layer["type"]    = 1;

        QJsonObject lp;
        QJsonObject poly;
        poly["points"] = QJsonArray();
        lp["polygon"]            = poly;
        lp["polygon_projection"] = QString(kPseudoMercatorLayerWkt);
        lp["filepath"]           = e.albedo_path;
        layer["parameters"] = lp;

        layer["raster_info"] = makeRasterInfo(
            fname, e.albedo_num_bands, e.albedo_width, e.albedo_height,
            e.albedo_geo_west, e.albedo_geo_south, e.albedo_geo_east, e.albedo_geo_north,
            e.albedo_pixel_w, e.albedo_pixel_h,
            false, 0.0,
            e.albedo_file_hash, e.albedo_mtime);

        albedo_layers << layer;
    }
    QJsonObject albedo_source;
    albedo_source["layers"] = albedo_layers;
    albedo_source["type"]   = 2;

    QJsonArray sources;
    sources << elev_source << albedo_source;
    sources << QJsonObject({{"type", 3}});
    sources << QJsonObject({{"type", 4}});

    QJsonObject root;
    root["parameters"] = params;
    root["sources"]    = sources;
    root["objects"]    = QJsonArray();

    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Text))
    {
        log("[Sandworm] ERROR: Cannot write " + path);
        return false;
    }
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    log("[Sandworm] Written: " + path);
    return true;
}

// ---------------------------------------------------------------------------
bool SandwormExporter::writeSwormMeta(const QString& path,
                                       const QString& project_name,
                                       const QString& sworm_path,
                                       LogFn log) const
{
    const QString guid = QUuid::createUuid().toString(QUuid::WithoutBraces).replace("-", "").left(40);
    const QString hash = fileHash8(sworm_path);
    const QString sworm_filename = QFileInfo(sworm_path).fileName();

    const QString xml = QString(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<asset version=\"2.18.0.1\">\n"
        "\t<guid>%1</guid>\n"
        "\t<type>sandworm</type>\n"
        "\t<hash>%2</hash>\n"
        "\t<runtimes>\n"
        "\t\t<runtime id=\"%1\" name=\"%3\" link=\"0\"/>\n"
        "\t</runtimes>\n"
        "</asset>\n")
        .arg(guid)
        .arg(hash)
        .arg(sworm_filename);

    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Text))
    {
        log("[Sandworm] ERROR: Cannot write " + path);
        return false;
    }
    f.write(xml.toUtf8());
    log("[Sandworm] Written: " + path);
    return true;
}
