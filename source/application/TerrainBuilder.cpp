#include "application/TerrainBuilder.h"

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

    // ---- Write TWO .lmap files -----------------------------------------
    // Following Sandworm's approach: one .lmap holds the heightmap, the
    // other holds the albedo. They are attached as two separate
    // LandscapeLayerMap nodes under the same ObjectLandscapeTerrain so they
    // can have independent resolution / extent.
    const QFileInfo out_info(req.output_lmap_path);
    const QString out_dir  = out_info.absolutePath();
    const QString out_base = out_info.completeBaseName();
    const QString height_lmap_path = out_dir + "/" + out_base + "_height.lmap";
    const QString albedo_lmap_path = out_dir + "/" + out_base + "_albedo.lmap";

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

    // Height-only .lmap (writes the height plane, leaves albedo black).
    auto height_fill = [height](const ImagePtr& dst, int tr, int gx, int gy, int tx, int ty)
    {
        fillHeightTile(dst, height, tr, gx, gy, tx, ty);
    };
    auto height_result_pair = writeSingleLayerLmap(
        height_lmap_path, height.width, height.height, height_fill, nullptr);
    if (!height_result_pair.success)
        return Result<TerrainBuildReport>::fail(
            height_result_pair.error_code, height_result_pair.message);
    const int height_grid = height_result_pair.value.first;

    // Albedo-only .lmap.
    auto albedo_fill = [albedo](const ImagePtr& dst, int tr, int gx, int gy, int tx, int ty)
    {
        fillAlbedoTile(dst, albedo, tr, gx, gy, tx, ty);
    };
    auto albedo_result_pair = writeSingleLayerLmap(
        albedo_lmap_path, albedo.width, albedo.height, nullptr, albedo_fill);
    if (!albedo_result_pair.success)
        return Result<TerrainBuildReport>::fail(
            albedo_result_pair.error_code, albedo_result_pair.message);
    const int albedo_grid = albedo_result_pair.value.first;

    if (log)
        log("[Terrain] Both .lmap files written successfully.");

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

    // Heightmap covers the full world extent; albedo uses its own extent
    // (often smaller) and is rendered on top via a higher order value so its
    // colours win wherever it's defined.
    const float height_scale = static_cast<float>(req.height_max_m - req.height_min_m);
    auto h_lm = spawnLayerMap(height_lmap_path, "height", req.world_size_m, height_scale, 0);
    if (!h_lm.success)
        return Result<TerrainBuildReport>::fail(h_lm.error_code, h_lm.message);

    // For now albedo uses the same world size so it aligns 1:1 with the
    // heightmap (same GeoTIFF extent case). True geo-offset positioning can
    // be added later once per-file geo extents are plumbed through.
    auto a_lm = spawnLayerMap(albedo_lmap_path, "albedo", req.world_size_m, height_scale, 1);
    if (!a_lm.success)
        return Result<TerrainBuildReport>::fail(a_lm.error_code, a_lm.message);

    TerrainBuildReport report;
    report.lmap_path = height_lmap_path;  // primary
    report.grid_x = height_grid;
    report.grid_y = height_grid;
    report.tile_resolution = tile_res;
    if (log)
    {
        log(QString("[Terrain] Build complete. Height grid=%1, Albedo grid=%2.")
                .arg(height_grid).arg(albedo_grid));
    }
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

    // Tile resolution: keep at 1024 (matches UNIGINE landscape defaults and
    // is a good balance of detail vs memory).
    p.tile_resolution = 1024;

    return Result<TerrainAutoParams>::ok(std::move(p));
}
