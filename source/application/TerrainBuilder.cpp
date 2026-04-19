#include "application/TerrainBuilder.h"

#include <QFileInfo>

#include <algorithm>
#include <cmath>
#include <vector>

#include <gdal_priv.h>
#include <cpl_conv.h>

#include <UnigineImage.h>
#include <UnigineLog.h>
#include <UnigineObjects.h>
#include <UnigineMathLib.h>
#include <UnigineNode.h>
#include <UnigineWorld.h>

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
// Decoded source raster held in memory while the .lmap is being written.
// Kept alive for the whole duration of LandscapeMapFileCreator::run(); the
// per-tile event callback reads from it by pixel coordinate.
struct HeightRaster
{
    int width = 0;
    int height = 0;
    std::vector<float> pixels;     // normalised [0..1] in row-major order
};

struct AlbedoRaster
{
    int width = 0;
    int height = 0;
    int channels = 4;              // always expanded to RGBA8
    std::vector<unsigned char> pixels;
};

Result<HeightRaster> decodeHeightmap(const QString& path, double height_min_m, double height_max_m,
                                     const TerrainBuilder::LogFn& log)
{
    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(GDALOpen(path.toUtf8().constData(), GA_ReadOnly));
    if (!ds)
        return Result<HeightRaster>::fail(1, "Failed to open heightmap TIFF: " + path.toStdString());

    HeightRaster raster;
    raster.width = ds->GetRasterXSize();
    raster.height = ds->GetRasterYSize();
    if (raster.width <= 0 || raster.height <= 0)
    {
        GDALClose(ds);
        return Result<HeightRaster>::fail(1, "Heightmap has invalid dimensions.");
    }

    GDALRasterBand* band = ds->GetRasterBand(1);
    if (!band)
    {
        GDALClose(ds);
        return Result<HeightRaster>::fail(1, "Heightmap has no readable band.");
    }

    raster.pixels.assign(static_cast<size_t>(raster.width) * raster.height, 0.0f);
    const CPLErr err = band->RasterIO(GF_Read, 0, 0, raster.width, raster.height,
                                      raster.pixels.data(),
                                      raster.width, raster.height,
                                      GDT_Float32, 0, 0);
    GDALClose(ds);
    if (err != CE_None)
        return Result<HeightRaster>::fail(1, "Failed to read heightmap pixels.");

    const double range = std::max(1e-6, height_max_m - height_min_m);
    float seen_min = std::numeric_limits<float>::infinity();
    float seen_max = -std::numeric_limits<float>::infinity();
    for (float& v : raster.pixels)
    {
        seen_min = std::min(seen_min, v);
        seen_max = std::max(seen_max, v);
        const double normalised = (static_cast<double>(v) - height_min_m) / range;
        v = static_cast<float>(std::clamp(normalised, 0.0, 1.0));
    }

    if (log)
    {
        log(QString("[Terrain] Heightmap decoded: %1x%2, source elevation %3..%4 m, mapped to [%5..%6] m.")
                .arg(raster.width).arg(raster.height)
                .arg(seen_min, 0, 'f', 2).arg(seen_max, 0, 'f', 2)
                .arg(height_min_m, 0, 'f', 2).arg(height_max_m, 0, 'f', 2));
    }
    return Result<HeightRaster>::ok(std::move(raster));
}

Result<AlbedoRaster> decodeAlbedo(const QString& path, const TerrainBuilder::LogFn& log)
{
    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(GDALOpen(path.toUtf8().constData(), GA_ReadOnly));
    if (!ds)
        return Result<AlbedoRaster>::fail(1, "Failed to open albedo TIFF: " + path.toStdString());

    AlbedoRaster raster;
    raster.width = ds->GetRasterXSize();
    raster.height = ds->GetRasterYSize();
    const int src_bands = ds->GetRasterCount();
    if (raster.width <= 0 || raster.height <= 0 || src_bands < 1)
    {
        GDALClose(ds);
        return Result<AlbedoRaster>::fail(1, "Albedo has invalid dimensions or no bands.");
    }

    // Always expand to RGBA8 to keep downstream copy trivial.
    raster.pixels.assign(static_cast<size_t>(raster.width) * raster.height * 4, 255);
    const int read_bands = std::min(src_bands, 4);
    for (int b = 0; b < read_bands; ++b)
    {
        GDALRasterBand* band = ds->GetRasterBand(b + 1);
        if (!band)
            continue;
        const CPLErr err = band->RasterIO(GF_Read, 0, 0, raster.width, raster.height,
                                          raster.pixels.data() + b,
                                          raster.width, raster.height,
                                          GDT_Byte, 4, static_cast<GSpacing>(raster.width) * 4);
        if (err != CE_None)
        {
            GDALClose(ds);
            return Result<AlbedoRaster>::fail(1, "Failed to read albedo band " + std::to_string(b + 1) + ".");
        }
    }
    GDALClose(ds);

    // If the source is single-band grayscale, broadcast R to G and B so we
    // get a proper RGB albedo rather than pure red.
    if (src_bands == 1)
    {
        for (size_t i = 0; i < raster.pixels.size(); i += 4)
        {
            const unsigned char g = raster.pixels[i];
            raster.pixels[i + 1] = g;
            raster.pixels[i + 2] = g;
            raster.pixels[i + 3] = 255;
        }
    }
    else if (src_bands == 3)
    {
        for (size_t i = 0; i < raster.pixels.size(); i += 4)
            raster.pixels[i + 3] = 255;
    }

    if (log)
        log(QString("[Terrain] Albedo decoded: %1x%2, source channels=%3.")
                .arg(raster.width).arg(raster.height).arg(src_bands));
    return Result<AlbedoRaster>::ok(std::move(raster));
}

// Copy a tile-sized region from the in-memory source into the Unigine Image.
// If the source is smaller than the destination tile, pixels outside the
// source are left at zero (height) or opaque black (albedo).
void fillHeightTile(const ImagePtr& dst, const HeightRaster& src, int tile_res,
                    int tile_x, int tile_y)
{
    // LandscapeMapFileCreator guarantees the destination image is already
    // allocated with a float-friendly format for height; write via set2D.
    const int res = tile_res;
    const int src_x0 = tile_x * res;
    const int src_y0 = tile_y * res;
    for (int y = 0; y < res; ++y)
    {
        const int sy = src_y0 + y;
        for (int x = 0; x < res; ++x)
        {
            const int sx = src_x0 + x;
            float h = 0.0f;
            if (sx >= 0 && sx < src.width && sy >= 0 && sy < src.height)
                h = src.pixels[static_cast<size_t>(sy) * src.width + sx];
            dst->set2D(x, y, Image::Pixel(h, 0.0f, 0.0f, 0.0f));
        }
    }
}

void fillAlbedoTile(const ImagePtr& dst, const AlbedoRaster& src, int tile_res,
                    int tile_x, int tile_y)
{
    const int res = tile_res;
    const int src_x0 = tile_x * res;
    const int src_y0 = tile_y * res;
    for (int y = 0; y < res; ++y)
    {
        const int sy = src_y0 + y;
        for (int x = 0; x < res; ++x)
        {
            const int sx = src_x0 + x;
            int r = 0, g = 0, b = 0, a = 255;
            if (sx >= 0 && sx < src.width && sy >= 0 && sy < src.height)
            {
                const size_t idx = (static_cast<size_t>(sy) * src.width + sx) * 4;
                r = src.pixels[idx];
                g = src.pixels[idx + 1];
                b = src.pixels[idx + 2];
                a = src.pixels[idx + 3];
            }
            dst->set2D(x, y, Image::Pixel(r, g, b, a));
        }
    }
}

ObjectLandscapeTerrainPtr ensureActiveTerrain()
{
    if (ObjectLandscapeTerrainPtr active = Landscape::getActiveTerrain())
        return active;

    Vector<Ptr<Node>> nodes;
    World::getNodesByType(Node::OBJECT_LANDSCAPE_TERRAIN, nodes);
    for (const auto& node : nodes)
    {
        if (auto t = Unigine::checked_ptr_cast<ObjectLandscapeTerrain>(node))
        {
            t->setActiveTerrain(true);
            return t;
        }
    }

    ObjectLandscapeTerrainPtr terrain = ObjectLandscapeTerrain::create();
    terrain->setActiveTerrain(true);
    terrain->setName("GeoTerrain_LandscapeTerrain");
    return terrain;
}
}

Result<QString> TerrainBuilder::validate(const TerrainBuildRequest& request)
{
    if (request.heightmap_path.isEmpty() || !QFileInfo::exists(request.heightmap_path))
        return Result<QString>::fail(1, "Heightmap TIFF is missing or not found.");
    if (request.albedo_path.isEmpty() || !QFileInfo::exists(request.albedo_path))
        return Result<QString>::fail(1, "Albedo TIFF is missing or not found.");
    if (request.output_lmap_path.isEmpty())
        return Result<QString>::fail(1, "Output .lmap path is required.");
    if (request.world_size_m <= 0.0)
        return Result<QString>::fail(1, "World size must be positive.");
    if (request.height_max_m <= request.height_min_m)
        return Result<QString>::fail(1, "Elevation max must be greater than min.");
    if (request.tile_resolution < 64 || request.tile_resolution > 8192)
        return Result<QString>::fail(1, "Tile resolution must be in [64..8192] texels.");
    return Result<QString>::ok(request.output_lmap_path);
}

Result<TerrainBuildReport> TerrainBuilder::build(const TerrainBuildRequest& request, LogFn log) const
{
    if (auto v = validate(request); !v.success)
        return Result<TerrainBuildReport>::fail(v.error_code, v.message);

    auto height_result = decodeHeightmap(request.heightmap_path,
                                         request.height_min_m, request.height_max_m, log);
    if (!height_result.success)
        return Result<TerrainBuildReport>::fail(height_result.error_code, height_result.message);

    auto albedo_result = decodeAlbedo(request.albedo_path, log);
    if (!albedo_result.success)
        return Result<TerrainBuildReport>::fail(albedo_result.error_code, albedo_result.message);

    const HeightRaster& height = height_result.value;
    const AlbedoRaster& albedo = albedo_result.value;

    // Use the larger of the two source dimensions to drive grid size; the
    // smaller one will simply upscale via nearest-neighbour in the tile copy.
    const int source_max = std::max({ height.width, height.height, albedo.width, albedo.height });
    const int tile_res = request.tile_resolution;
    const int grid = std::max(1, static_cast<int>(std::ceil(static_cast<double>(source_max) / tile_res)));

    if (log)
        log(QString("[Terrain] Writing .lmap: grid=%1x%1, tile=%2px, total=%3x%3 texels")
                .arg(grid).arg(tile_res).arg(grid * tile_res));

    LandscapeMapFileCreatorPtr creator = LandscapeMapFileCreator::create();
    creator->setPath(request.output_lmap_path.toUtf8().constData());
    creator->setResolution(Math::ivec2(tile_res, tile_res));
    creator->setGrid(Math::ivec2(grid, grid));

    creator->getEventCreate().connect(
        [&height, &albedo, tile_res]
        (const LandscapeMapFileCreatorPtr& /*creator*/,
         const LandscapeImagesPtr& images,
         int tile_x, int tile_y)
        {
            if (!images)
                return;
            if (ImagePtr h = images->getHeight())
                fillHeightTile(h, height, tile_res, tile_x, tile_y);
            if (ImagePtr a = images->getAlbedo())
                fillAlbedoTile(a, albedo, tile_res, tile_x, tile_y);
        });

    if (!creator->run(/*is_empty*/ false, /*is_safe*/ true))
        return Result<TerrainBuildReport>::fail(1, "LandscapeMapFileCreator::run failed.");

    // The .lmap is on disk. Now wire an ObjectLandscapeTerrain + LandscapeLayerMap
    // into the active world.
    ObjectLandscapeTerrainPtr terrain = ensureActiveTerrain();
    (void)terrain; // currently no per-terrain settings required

    LandscapeLayerMapPtr layer_map = LandscapeLayerMap::create();
    layer_map->setName(QFileInfo(request.output_lmap_path).completeBaseName().toUtf8().constData());
    layer_map->setPath(request.output_lmap_path.toUtf8().constData());
    layer_map->setSize(Math::Vec2(static_cast<float>(request.world_size_m),
                                  static_cast<float>(request.world_size_m)));
    layer_map->setHeightScale(static_cast<float>(request.height_max_m - request.height_min_m));

    if (log)
        log(QString("[Terrain] LandscapeLayerMap spawned: size=%1m, heightScale=%2m.")
                .arg(request.world_size_m, 0, 'f', 1)
                .arg(request.height_max_m - request.height_min_m, 0, 'f', 1));

    TerrainBuildReport report;
    report.lmap_path = request.output_lmap_path;
    report.grid_x = grid;
    report.grid_y = grid;
    report.tile_resolution = tile_res;
    return Result<TerrainBuildReport>::ok(std::move(report));
}
