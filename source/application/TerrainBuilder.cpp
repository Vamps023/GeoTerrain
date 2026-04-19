#include "application/TerrainBuilder.h"

#include <QFile>
#include <QFileInfo>

#include <algorithm>
#include <cmath>

#include <gdal_priv.h>
#include <cpl_conv.h>
#include <ogr_spatialref.h>

#include <UnigineImage.h>
#include <UnigineLog.h>
#include <UnigineObjects.h>
#include <UnigineMathLib.h>
#include <UnigineNode.h>
#include <UnigineWorld.h>
#include <UnigineFileSystem.h>

#include <functional>
#include <limits>
#include <utility>

using Unigine::Image;
using Unigine::ImagePtr;
using Unigine::Landscape;
using Unigine::LandscapeImages;
using Unigine::LandscapeImagesPtr;
using Unigine::LandscapeLayerMap;
using Unigine::LandscapeLayerMapPtr;
using Unigine::LandscapeMapFileCreator;
using Unigine::LandscapeMapFileCreatorPtr;
using Unigine::Node;
using Unigine::ObjectLandscapeTerrain;
using Unigine::ObjectLandscapeTerrainPtr;
using Unigine::Ptr;
using Unigine::Vector;
using Unigine::World;

namespace Math = Unigine::Math;

namespace
{
// ---------------------------------------------------------------------------
// Source images held in memory while the .lmap is being written.
// Kept alive for the whole duration of LandscapeMapFileCreator::run(); the
// per-tile event callback reads from them by pixel coordinate.
struct HeightSource
{
    ImagePtr image;
    int width = 0;
    int height = 0;
    // Native-unit elevation range. Source heights are normalised into [0..1]
    // when written into the destination R16 image so UNIGINE's heightScale
    // can multiply back out to metres.
    float height_min = 0.0f;
    float height_max = 1.0f;
};

struct AlbedoSource
{
    ImagePtr image;
    int width = 0;
    int height = 0;
};

Result<HeightSource> loadHeightmap(const QString& path, const TerrainBuilder::LogFn& log)
{
    if (log)
        log(QString("[Terrain] loadHeightmap: Loading file: %1").arg(path));

    ImagePtr img = Image::create();
    if (!img)
        return Result<HeightSource>::fail(1, "Failed to create Image object.");

    if (!img->load(path.toUtf8().constData()))
        return Result<HeightSource>::fail(1, "Failed to load heightmap image: " + path.toStdString());

    // Normalise the source format to R32F so get2D() always returns a single
    // float metre value via Pixel.f.r. The rest of the pipeline can then
    // ignore whether the TIFF was 16-bit integer or 32-bit float on disk.
    if (img->getFormat() != Image::FORMAT_R32F)
    {
        if (!img->convertToFormat(Image::FORMAT_R32F))
        {
            if (log)
                log("[Terrain] WARNING: convertToFormat(R32F) failed; reading raw pixels.");
        }
    }

    HeightSource src;
    src.image = img;
    src.width = img->getWidth();
    src.height = img->getHeight();

    if (src.width <= 0 || src.height <= 0)
        return Result<HeightSource>::fail(1, "Heightmap has invalid dimensions.");

    if (log)
        log(QString("[Terrain] Heightmap loaded: %1x%2").arg(src.width).arg(src.height));

    return Result<HeightSource>::ok(std::move(src));
}

Result<AlbedoSource> loadAlbedo(const QString& path, const TerrainBuilder::LogFn& log)
{
    if (log)
        log(QString("[Terrain] loadAlbedo: Loading file: %1").arg(path));

    ImagePtr img = Image::create();
    if (!img)
        return Result<AlbedoSource>::fail(1, "Failed to create Image object.");

    if (!img->load(path.toUtf8().constData()))
        return Result<AlbedoSource>::fail(1, "Failed to load albedo image: " + path.toStdString());

    AlbedoSource src;
    src.image = img;
    src.width = img->getWidth();
    src.height = img->getHeight();

    if (src.width <= 0 || src.height <= 0)
        return Result<AlbedoSource>::fail(1, "Albedo has invalid dimensions.");

    if (log)
        log(QString("[Terrain] Albedo loaded: %1x%2").arg(src.width).arg(src.height));

    return Result<AlbedoSource>::ok(std::move(src));
}

// Copy one tile's worth of data from the in-memory source into the Unigine
// destination Image, stretching the source across the full grid so the tile
// never has "blank" regions just because the source is smaller than the tile.
//
// The total destination extent is (grid_x * tile_res, grid_y * tile_res)
// texels. Destination texel (x_in_tile, y_in_tile) of tile (tx, ty) maps to
// source coord ( (tx*tile_res + x) * src.width / (grid_x*tile_res),
//                 (ty*tile_res + y) * src.height / (grid_y*tile_res) ).
//
// Height values are normalised to [0..1] using src.height_min/height_max so
// UNIGINE's LandscapeLayerMap::setHeightScale() multiplies them back to the
// correct metres.
void fillHeightTile(const ImagePtr& dst, const HeightSource& src,
                    int tile_res, int grid_x, int grid_y,
                    int tile_x, int tile_y)
{
    if (dst->getWidth() != tile_res || dst->getHeight() != tile_res)
        dst->create2D(tile_res, tile_res, Image::FORMAT_R16);

    const double range = std::max(1e-6, static_cast<double>(src.height_max - src.height_min));
    const double inv_range = 1.0 / range;
    const double total_x = static_cast<double>(grid_x) * tile_res;
    const double total_y = static_cast<double>(grid_y) * tile_res;

    for (int y = 0; y < tile_res; ++y)
    {
        const int global_y = tile_y * tile_res + y;
        const int sy = std::min(src.height - 1,
            static_cast<int>((global_y + 0.5) * src.height / total_y));
        for (int x = 0; x < tile_res; ++x)
        {
            const int global_x = tile_x * tile_res + x;
            const int sx = std::min(src.width - 1,
                static_cast<int>((global_x + 0.5) * src.width / total_x));

            Image::Pixel s = src.image->get2D(sx, sy);
            const double v_m = static_cast<double>(s.f.r);
            double n = (v_m - src.height_min) * inv_range;
            if (n < 0.0) n = 0.0;
            else if (n > 1.0) n = 1.0;
            dst->set2D(x, y, Image::Pixel(static_cast<float>(n), 0.0f, 0.0f, 0.0f));
        }
    }
}

void fillAlbedoTile(const ImagePtr& dst, const AlbedoSource& src,
                    int tile_res, int grid_x, int grid_y,
                    int tile_x, int tile_y)
{
    if (dst->getWidth() != tile_res || dst->getHeight() != tile_res)
        dst->create2D(tile_res, tile_res, Image::FORMAT_RGBA8);

    const double total_x = static_cast<double>(grid_x) * tile_res;
    const double total_y = static_cast<double>(grid_y) * tile_res;

    for (int y = 0; y < tile_res; ++y)
    {
        const int global_y = tile_y * tile_res + y;
        const int sy = std::min(src.height - 1,
            static_cast<int>((global_y + 0.5) * src.height / total_y));
        for (int x = 0; x < tile_res; ++x)
        {
            const int global_x = tile_x * tile_res + x;
            const int sx = std::min(src.width - 1,
                static_cast<int>((global_x + 0.5) * src.width / total_x));
            dst->set2D(x, y, src.image->get2D(sx, sy));
        }
    }
}

ObjectLandscapeTerrainPtr ensureActiveTerrain(const TerrainBuilder::LogFn& log)
{
    if (log)
        log("[Terrain] ensureActiveTerrain: Checking for existing active terrain...");
    if (ObjectLandscapeTerrainPtr active = Landscape::getActiveTerrain())
    {
        if (log)
            log("[Terrain] ensureActiveTerrain: Found existing active terrain.");
        return active;
    }

    if (log)
        log("[Terrain] ensureActiveTerrain: Searching world for terrain nodes...");
    Vector<Ptr<Node>> nodes;
    World::getNodesByType(Node::OBJECT_LANDSCAPE_TERRAIN, nodes);
    for (const auto& node : nodes)
    {
        if (auto t = Unigine::checked_ptr_cast<ObjectLandscapeTerrain>(node))
        {
            if (log)
                log("[Terrain] ensureActiveTerrain: Found terrain node, activating it.");
            t->setActiveTerrain(true);
            return t;
        }
    }

    if (log)
        log("[Terrain] ensureActiveTerrain: Creating new terrain...");
    ObjectLandscapeTerrainPtr terrain = ObjectLandscapeTerrain::create();
    if (!terrain)
    {
        if (log)
            log("[Terrain] ensureActiveTerrain: ERROR - ObjectLandscapeTerrain::create() returned null!");
        return nullptr;
    }
    terrain->setActiveTerrain(true);
    terrain->setName("GeoTerrain_LandscapeTerrain");
    if (log)
        log("[Terrain] ensureActiveTerrain: New terrain created successfully.");
    return terrain;
}
}

Result<QString> TerrainBuilder::validate(const TerrainBuildRequest& request)
{
    // Only file inputs are strictly required up-front; the remaining scale
    // fields are auto-computed from the heightmap when the UI leaves them
    // at zero.
    if (request.heightmap_path.isEmpty() || !QFileInfo::exists(request.heightmap_path))
        return Result<QString>::fail(1, "Heightmap TIFF is missing or not found.");
    if (request.albedo_path.isEmpty() || !QFileInfo::exists(request.albedo_path))
        return Result<QString>::fail(1, "Albedo TIFF is missing or not found.");
    if (request.output_lmap_path.isEmpty())
        return Result<QString>::fail(1, "Output .lmap path is required.");
    QFileInfo out_info(request.output_lmap_path);
    if (out_info.isDir())
        return Result<QString>::fail(1, "Output .lmap path must be a file, not a directory. Include the filename (e.g., terrain.lmap).");
    if (!request.output_lmap_path.endsWith(".lmap", Qt::CaseInsensitive))
        return Result<QString>::fail(1, "Output .lmap path must have .lmap extension.");
    return Result<QString>::ok(request.output_lmap_path);
}

Result<TerrainBuildReport> TerrainBuilder::build(const TerrainBuildRequest& request, LogFn log) const
{
    if (log)
        log("[Terrain] Starting build process...");
    if (auto v = validate(request); !v.success)
        return Result<TerrainBuildReport>::fail(v.error_code, v.message);

    // Auto-fill any unset scale fields from the heightmap's GeoTIFF metadata.
    TerrainBuildRequest req = request;
    const bool needs_auto = req.world_size_m <= 0.0
                         || req.height_max_m <= req.height_min_m
                         || req.tile_resolution < 64;
    if (needs_auto)
    {
        if (log)
            log("[Terrain] Auto-computing parameters from heightmap...");
        auto auto_result = computeAutoParams(req.heightmap_path);
        if (!auto_result.success)
            return Result<TerrainBuildReport>::fail(auto_result.error_code, auto_result.message);
        const auto& p = auto_result.value;
        if (req.world_size_m <= 0.0)      req.world_size_m   = p.world_size_m;
        if (req.height_max_m <= req.height_min_m)
        {
            req.height_min_m = p.height_min_m;
            req.height_max_m = p.height_max_m;
        }
        if (req.tile_resolution < 64)     req.tile_resolution = p.tile_resolution;
        if (log)
            log(QString("[Terrain] Auto params: world=%1m, elevation=%2..%3m, tile=%4px%5")
                    .arg(req.world_size_m, 0, 'f', 2)
                    .arg(req.height_min_m, 0, 'f', 2)
                    .arg(req.height_max_m, 0, 'f', 2)
                    .arg(req.tile_resolution)
                    .arg(p.has_geo_transform ? " (from GeoTIFF)" : " (no geo metadata)"));
    }

    if (log)
        log("[Terrain] Loading heightmap...");
    auto height_result = loadHeightmap(req.heightmap_path, log);
    if (!height_result.success)
        return Result<TerrainBuildReport>::fail(height_result.error_code, height_result.message);
    if (log)
        log("[Terrain] Heightmap loaded successfully.");

    if (log)
        log("[Terrain] Loading albedo...");
    auto albedo_result = loadAlbedo(req.albedo_path, log);
    if (!albedo_result.success)
        return Result<TerrainBuildReport>::fail(albedo_result.error_code, albedo_result.message);
    if (log)
        log("[Terrain] Albedo loaded successfully.");

    HeightSource height = height_result.value;
    const AlbedoSource& albedo = albedo_result.value;

    // Pass the elevation range down to the tile filler so it can normalise
    // the float-metre source into a [0..1] R16 destination.
    height.height_min = static_cast<float>(req.height_min_m);
    height.height_max = static_cast<float>(req.height_max_m);

    const int tile_res = req.tile_resolution;

    // ---- Write ONE combined .lmap file ---------------------------------
    // Match Sandworm's output: a single .lmap per "Refrnace_31.68mpx.lmap"
    // carries BOTH the heightmap plane and the albedo plane. UNIGINE binds
    // one LandscapeLayerMap node to it and drives both channels at once.
    //
    // Filename convention: <basename>_<density>mpx.lmap where density is the
    // effective metres-per-texel (world_size / tile_res). Mirrors Sandworm's
    // naming so outputs from the two tools are directly comparable.
    const QFileInfo out_info(req.output_lmap_path);
    const QString out_dir  = out_info.absolutePath();
    const QString out_base = out_info.completeBaseName();
    const double  density_m_per_px = req.world_size_m / static_cast<double>(tile_res);
    const QString density_suffix = QString::number(density_m_per_px, 'f', 2) + "mpx";
    const QString combined_lmap_path = out_dir + "/" + out_base + "_" + density_suffix + ".lmap";

    auto writeSingleLayerLmap = [&](const QString& path,
                                    int src_w, int src_h,
                                    const std::function<void(const ImagePtr& dst,
                                                             int tile_res,
                                                             int grid_x, int grid_y,
                                                             int tx, int ty)>& fill_height,
                                    const std::function<void(const ImagePtr& dst,
                                                             int tile_res,
                                                             int grid_x, int grid_y,
                                                             int tx, int ty)>& fill_albedo)
        -> Result<std::pair<int, int>>
    {
        const int source_max = std::max(src_w, src_h);
        const int grid = std::max(1, static_cast<int>(std::ceil(
            static_cast<double>(source_max) / tile_res)));
        if (log)
            log(QString("[Terrain] Writing %1: grid=%2x%2, tile=%3px, total=%4x%4 texels")
                    .arg(QFileInfo(path).fileName()).arg(grid).arg(tile_res).arg(grid * tile_res));

        LandscapeMapFileCreatorPtr creator = LandscapeMapFileCreator::create();
        if (!creator)
            return Result<std::pair<int,int>>::fail(1, "Failed to create LandscapeMapFileCreator.");

        const QByteArray path_utf8 = path.toUtf8();
        creator->setPath(path_utf8.constData());
        creator->setResolution(Math::ivec2(tile_res, tile_res));
        creator->setGrid(Math::ivec2(grid, grid));

        creator->getEventCreate().connect(
            [tile_res, grid, fill_height, fill_albedo, log]
            (const LandscapeMapFileCreatorPtr& /*creator*/,
             const LandscapeImagesPtr& images,
             int tile_x, int tile_y)
            {
                if (!images) return;
                if (fill_height)
                {
                    if (ImagePtr h = images->getHeight())
                        fill_height(h, tile_res, grid, grid, tile_x, tile_y);
                }
                if (fill_albedo)
                {
                    if (ImagePtr a = images->getAlbedo())
                        fill_albedo(a, tile_res, grid, grid, tile_x, tile_y);
                }
                if (log)
                    log(QString("[Terrain] Tile %1,%2 filled.").arg(tile_x).arg(tile_y));
            });

        if (!creator->run(/*is_empty*/ false, /*is_safe*/ true))
            return Result<std::pair<int,int>>::fail(1, "LandscapeMapFileCreator::run failed.");
        return Result<std::pair<int,int>>::ok(std::make_pair(grid, grid));
    };

    // Combined .lmap — fill BOTH planes in the same tile callback so the
    // single output carries height + albedo like Sandworm does.
    auto height_fill = [height](const ImagePtr& dst, int tr, int gx, int gy, int tx, int ty)
    {
        fillHeightTile(dst, height, tr, gx, gy, tx, ty);
    };
    auto albedo_fill = [albedo](const ImagePtr& dst, int tr, int gx, int gy, int tx, int ty)
    {
        fillAlbedoTile(dst, albedo, tr, gx, gy, tx, ty);
    };
    // Grid sizing uses the larger of the two sources so we don't drop detail
    // when heightmap and albedo have mismatched dims (they are the same in
    // the common 1:1 pipeline, but stay defensive).
    const int combined_src = std::max({height.width, height.height,
                                       albedo.width, albedo.height});
    auto combined_result = writeSingleLayerLmap(
        combined_lmap_path, combined_src, combined_src, height_fill, albedo_fill);
    if (!combined_result.success)
        return Result<TerrainBuildReport>::fail(
            combined_result.error_code, combined_result.message);
    const int combined_grid = combined_result.value.first;

    if (log)
        log(QString("[Terrain] Combined .lmap written: %1").arg(combined_lmap_path));

    // ---- Scene wiring --------------------------------------------------
    if (!World::isLoaded())
        return Result<TerrainBuildReport>::fail(1, "No world is loaded. Please create or load a world first.");

    ObjectLandscapeTerrainPtr terrain = ensureActiveTerrain(log);
    if (!terrain)
        return Result<TerrainBuildReport>::fail(1, "Failed to create or find active terrain.");

    auto spawnLayerMap = [&](const QString& lmap_path, const QString& name_suffix,
                             double size_m, float height_scale_m, int order)
        -> Result<LandscapeLayerMapPtr>
    {
        LandscapeLayerMapPtr lm = LandscapeLayerMap::create();
        if (!lm)
            return Result<LandscapeLayerMapPtr>::fail(1, "Failed to create LandscapeLayerMap.");

        const QByteArray name_utf8 = (out_base + "_" + name_suffix).toUtf8();
        lm->setName(name_utf8.constData());

        // IMPORTANT: setSize / setHeightScale / setOrder must be called BEFORE
        // setPath. setPath triggers the .lmap load which initialises the layer
        // at its stored defaults and will overwrite the node properties if
        // they were set earlier in the wrong order.
        lm->setSize(Math::Vec2(static_cast<float>(size_m),
                               static_cast<float>(size_m)));
        lm->setHeightScale(height_scale_m);
        lm->setOrder(order);

        const QByteArray abs_utf8 = lmap_path.toUtf8();
        Unigine::String vpath = Unigine::FileSystem::getVirtualPath(abs_utf8.constData());
        if (vpath.empty())
            lm->setPath(QFileInfo(lmap_path).fileName().toUtf8().constData());
        else
            lm->setPath(vpath.get());

        // Re-apply after setPath in case the load pass reset them to defaults.
        lm->setSize(Math::Vec2(static_cast<float>(size_m),
                               static_cast<float>(size_m)));
        lm->setHeightScale(height_scale_m);
        lm->setOrder(order);

        const Math::Vec2 actual = lm->getSize();
        if (log)
            log(QString("[Terrain] Spawned LandscapeLayerMap '%1' requested size=%2m "
                        "→ node reports size=(%3, %4) heightScale=%5m order=%6")
                    .arg(QString::fromUtf8(name_utf8))
                    .arg(size_m, 0, 'f', 1)
                    .arg(static_cast<double>(actual.x), 0, 'f', 1)
                    .arg(static_cast<double>(actual.y), 0, 'f', 1)
                    .arg(height_scale_m, 0, 'f', 1)
                    .arg(order));
        return Result<LandscapeLayerMapPtr>::ok(lm);
    };

    // Single LandscapeLayerMap bound to the combined .lmap — mirrors the
    // Sandworm output where one node drives both height and albedo.
    const float height_scale = static_cast<float>(req.height_max_m - req.height_min_m);
    const QString layer_node_name = out_base + "_" + density_suffix;
    auto combined_lm = spawnLayerMap(combined_lmap_path, density_suffix,
                                     req.world_size_m, height_scale, 0);
    if (!combined_lm.success)
        return Result<TerrainBuildReport>::fail(combined_lm.error_code, combined_lm.message);

    // ---- Persist the node into the .world XML -------------------------
    // The UNIGINE API's LandscapeLayerMap::setSize() races the async .lmap
    // load — by the time the user sees the node the Size often resets to
    // the 1000 m default. Workaround: save the world, patch <size> and
    // <height_scale> on our node directly in the XML, then reload. This
    // matches how Sandworm ships a preconfigured node.
    const char* world_path_c = World::getPath();
    QString world_path = world_path_c ? QString::fromUtf8(world_path_c) : QString();
    if (log)
        log(QString("[Terrain] Saving world to persist LandscapeLayerMap node (%1)...")
                .arg(world_path.isEmpty() ? "no path" : world_path));

    if (World::saveWorld() && !world_path.isEmpty() && QFileInfo::exists(world_path))
    {
        QFile wf(world_path);
        if (wf.open(QIODevice::ReadOnly | QIODevice::Text))
        {
            QString xml = QString::fromUtf8(wf.readAll());
            wf.close();

            // Locate our node block by name attribute (unique per build).
            const QString name_attr = QString("name=\"%1\"").arg(layer_node_name);
            const int name_pos = xml.indexOf(name_attr);
            if (name_pos < 0)
            {
                if (log)
                    log(QString("[Terrain] WARNING: node '%1' not found in world XML; "
                                "size patch skipped.").arg(layer_node_name));
            }
            else
            {
                // Find the opening <node ...> that owns this name, then its
                // closing </node>. Search within that range only.
                const int block_start = xml.lastIndexOf("<node ", name_pos);
                const int block_end_tag = xml.indexOf("</node>", name_pos);
                if (block_start >= 0 && block_end_tag > block_start)
                {
                    const int block_end = block_end_tag + 7; // include </node>
                    QString block = xml.mid(block_start, block_end - block_start);

                    auto replaceOrInsert = [&block](const QString& tag, const QString& value)
                    {
                        const QString open  = "<" + tag + ">";
                        const QString close = "</" + tag + ">";
                        const int o = block.indexOf(open);
                        const int c = block.indexOf(close);
                        if (o >= 0 && c > o)
                        {
                            block.replace(o + open.size(), c - (o + open.size()), value);
                        }
                        else
                        {
                            // Insert the element just before </node>.
                            const int end = block.indexOf("</node>");
                            if (end > 0)
                            {
                                const QString line = "\t\t\t" + open + value + close + "\n\t\t";
                                block.insert(end, line);
                            }
                        }
                    };

                    const QString size_val = QString("%1 %2")
                        .arg(req.world_size_m, 0, 'f', 6)
                        .arg(req.world_size_m, 0, 'f', 6);
                    const QString hs_val = QString::number(height_scale, 'f', 6);
                    replaceOrInsert("size", size_val);
                    replaceOrInsert("height_scale", hs_val);
                    replaceOrInsert("order", "0");

                    xml.replace(block_start, block_end - block_start, block);

                    QFile wfw(world_path);
                    if (wfw.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
                    {
                        wfw.write(xml.toUtf8());
                        wfw.close();
                        if (log)
                            log(QString("[Terrain] Patched world XML: size=%1, height_scale=%2")
                                    .arg(size_val).arg(hs_val));
                        // Reload so the editor picks up the patched values.
                        World::reloadWorld();
                    }
                    else if (log)
                    {
                        log("[Terrain] WARNING: failed to write patched world XML.");
                    }
                }
            }
        }
    }
    else if (log)
    {
        log("[Terrain] WARNING: World::saveWorld failed or world path empty; "
            "LandscapeLayerMap Size may show the default.");
    }

    TerrainBuildReport report;
    report.lmap_path = combined_lmap_path;
    report.grid_x = combined_grid;
    report.grid_y = combined_grid;
    report.tile_resolution = tile_res;
    if (log)
        log(QString("[Terrain] Build complete. Grid=%1x%1, density=%2 m/px.")
                .arg(combined_grid).arg(density_m_per_px, 0, 'f', 2));
    return Result<TerrainBuildReport>::ok(std::move(report));
}

namespace
{
// Convert a GeoTIFF's pixel scale (from the GDAL geotransform) into metres.
// Projected CRS (UTM, Web Mercator …) already report linear metres, while
// geographic CRS (WGS84 degrees) need a cosine-latitude correction.
// center_lat_deg is only used when the CRS is geographic.
struct PixelScaleMeters
{
    double px_x_m = 1.0;
    double px_y_m = 1.0;
    bool is_geographic = false;
};

PixelScaleMeters pixelScaleInMeters(GDALDataset* ds, const double gt[6])
{
    PixelScaleMeters out;
    const double raw_px = std::abs(gt[1]);
    const double raw_py = std::abs(gt[5]);

    const OGRSpatialReference* srs = ds->GetSpatialRef();
    if (srs && srs->IsGeographic())
    {
        out.is_geographic = true;
        // Latitude of the raster centre for the cosine correction.
        const int h = ds->GetRasterYSize();
        const double center_lat = gt[3] + gt[5] * (h / 2.0);
        constexpr double kPi = 3.14159265358979323846;
        const double m_per_deg_lat = 111320.0;
        const double m_per_deg_lon = 111320.0 * std::cos(center_lat * kPi / 180.0);
        out.px_x_m = raw_px * m_per_deg_lon;
        out.px_y_m = raw_py * m_per_deg_lat;
    }
    else
    {
        // Projected or unknown CRS: assume linear metres.
        out.px_x_m = raw_px;
        out.px_y_m = raw_py;
    }
    return out;
}

} // namespace

Result<TerrainAutoParams> TerrainBuilder::computeAutoParams(const QString& heightmap_path)
{
    if (heightmap_path.isEmpty() || !QFileInfo::exists(heightmap_path))
        return Result<TerrainAutoParams>::fail(1, "Heightmap file not found.");

    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpen(heightmap_path.toUtf8().constData(), GA_ReadOnly));
    if (!ds)
        return Result<TerrainAutoParams>::fail(1, "Failed to open heightmap with GDAL.");

    TerrainAutoParams p;
    p.heightmap_width  = ds->GetRasterXSize();
    p.heightmap_height = ds->GetRasterYSize();

    // World size from GeoTIFF pixel scale when available, converted to metres
    // based on the dataset's CRS (geographic CRS need cosine-latitude scaling).
    double gt[6] = {0};
    if (ds->GetGeoTransform(gt) == CE_None && (gt[1] != 0.0 || gt[5] != 0.0))
    {
        p.has_geo_transform = true;
        const PixelScaleMeters s = pixelScaleInMeters(ds, gt);
        const double width_m  = s.px_x_m * p.heightmap_width;
        const double height_m = s.px_y_m * p.heightmap_height;
        // Use the larger linear extent to size the square terrain so the
        // source is never down-cropped.
        p.world_size_m = std::max(width_m, height_m);
    }
    else
    {
        // Fallback: assume 1 m per pixel so the terrain matches the image
        // extent in meters.
        p.world_size_m = std::max(p.heightmap_width, p.heightmap_height);
    }
    if (p.world_size_m <= 0.0)
        p.world_size_m = 4096.0;

    // Elevation min/max from the heightmap band. GDAL can compute stats
    // directly (including no-data handling) - much faster than scanning
    // every pixel from our side.
    GDALRasterBand* band = ds->GetRasterBand(1);
    if (band)
    {
        double gmin = 0.0, gmax = 0.0, gmean = 0.0, gstd = 0.0;
        CPLErr err = band->ComputeStatistics(/*bApproxOK*/ TRUE,
                                             &gmin, &gmax, &gmean, &gstd,
                                             nullptr, nullptr);
        if (err == CE_None && gmax > gmin)
        {
            p.height_min_m = gmin;
            p.height_max_m = gmax;
        }
        else
        {
            // Couldn't compute stats — fall back to sane defaults so the
            // caller still gets a usable range.
            p.height_min_m = 0.0;
            p.height_max_m = 1000.0;
        }
    }
    else
    {
        p.height_min_m = 0.0;
        p.height_max_m = 1000.0;
    }

    GDALClose(ds);

    // Tile resolution auto-picked so the resulting .lmap density matches
    // the source GeoTIFF's native pixel scale. This mirrors Sandworm's
    // behaviour where the exported file is named after its real m/px
    // (e.g. "project_31.74mpx"): world_size / tile_res ≈ native_pixel_scale.
    //
    // We round the longer source side UP to the next power of two and clamp
    // to [256, 4096]. If the source is 567 px the result is 1024 tile, giving
    // density = world / 1024. If the source is 2100 px we use 2048, etc.
    auto nextPowerOfTwo = [](int v) {
        if (v < 1) return 1;
        int p = 1;
        while (p < v) p <<= 1;
        return p;
    };
    const int max_src = std::max(p.heightmap_width, p.heightmap_height);
    int tile = nextPowerOfTwo(max_src);
    if (tile < 256)  tile = 256;
    if (tile > 4096) tile = 4096;
    p.tile_resolution = tile;

    return Result<TerrainAutoParams>::ok(std::move(p));
}
