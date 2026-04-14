#include "TileDownloader.h"
#include "GdalUtils.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <gdal_priv.h>
#include <gdalwarper.h>
#include <ogr_spatialref.h>

#include <curl/curl.h>

#include <algorithm>
#include <sstream>

namespace
{
void report(RunContext& context, const std::string& message, int percent)
{
    if (context.progress)
        context.progress(message, percent);
}

Result<RasterArtifact> cancelledRaster()
{
    return Result<RasterArtifact>::fail(999, "Cancelled.");
}

size_t curlWriteCallback(void* ptr, size_t size, size_t nmemb, void* userdata)
{
    auto* buf = reinterpret_cast<std::vector<uint8_t>*>(userdata);
    const size_t total = size * nmemb;
    buf->insert(buf->end(), reinterpret_cast<uint8_t*>(ptr), reinterpret_cast<uint8_t*>(ptr) + total);
    return total;
}
}

std::vector<uint8_t> TileDownloader::fetchTile(int z, int x, int y, const std::string& url_template)
{
    std::string url = url_template;
    auto replace = [](std::string& s, const std::string& from, const std::string& to)
    {
        size_t pos = s.find(from);
        while (pos != std::string::npos)
        {
            s.replace(pos, from.size(), to);
            pos = s.find(from, pos + to.size());
        }
    };
    replace(url, "{z}", std::to_string(z));
    replace(url, "{x}", std::to_string(x));
    replace(url, "{y}", std::to_string(y));

    std::vector<uint8_t> data;
    CURL* curl = curl_easy_init();
    if (!curl)
        return data;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &data);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "Mozilla/5.0 GeoTerrainPlugin/1.0");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    const CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    if (res != CURLE_OK)
        data.clear();
    return data;
}

Result<RasterArtifact> TileDownloader::download(const GeoBounds& bounds, const Config& config, RunContext& context)
{
    if (context.isCancelled())
        return cancelledRaster();
    if (!bounds.isValid())
        return Result<RasterArtifact>::fail(1, "Invalid bounds for tile download.");

    report(context, "Starting tile download (zoom=" + std::to_string(config.zoom_level) + ")...", 0);

    constexpr int TILE_SIZE = 256;
    const int zoom = config.zoom_level;
    const TileCoord tl = latLonToTile(bounds.north, bounds.west, zoom);
    const TileCoord br = latLonToTile(bounds.south, bounds.east, zoom);

    const int tx0 = tl.x;
    const int ty0 = tl.y;
    const int tx1 = br.x;
    const int ty1 = br.y;
    const int num_tiles_x = tx1 - tx0 + 1;
    const int num_tiles_y = ty1 - ty0 + 1;
    const int out_w = num_tiles_x * TILE_SIZE;
    const int out_h = num_tiles_y * TILE_SIZE;

    const double geo_west = tileToLon(tx0, zoom);
    const double geo_north = tileToLat(ty0, zoom);
    const double geo_east = tileToLon(tx1 + 1, zoom);
    const double geo_south = tileToLat(ty1 + 1, zoom);

    GDALAllRegister();
    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver)
        return Result<RasterArtifact>::fail(2, "GTiff driver not available.");

    char** create_opts = nullptr;
    create_opts = CSLSetNameValue(create_opts, "COMPRESS", "LZW");
    create_opts = CSLSetNameValue(create_opts, "TILED", "YES");
    create_opts = CSLSetNameValue(create_opts, "PHOTOMETRIC", "RGB");
    GDALDataset* out_ds = driver->Create(config.output_path.c_str(), out_w, out_h, 3, GDT_Byte, create_opts);
    CSLDestroy(create_opts);
    if (!out_ds)
        return Result<RasterArtifact>::fail(3, "Cannot create output raster.");

    double gt[6] = { geo_west, (geo_east - geo_west) / out_w, 0.0, geo_north, 0.0,
                     -(geo_north - geo_south) / out_h };
    out_ds->SetGeoTransform(gt);
    OGRSpatialReference srs;
    srs.importFromEPSG(4326);
    char* wkt = nullptr;
    srs.exportToWkt(&wkt);
    out_ds->SetProjection(wkt);
    CPLFree(wkt);

    constexpr int BAND_PIXELS = TILE_SIZE * TILE_SIZE;
    std::vector<uint8_t> band_r(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_g(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_b(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_a(BAND_PIXELS, 255u);

    int tiles_done = 0;
    const int total_tiles = num_tiles_x * num_tiles_y;

    for (int ty = ty0; ty <= ty1; ++ty)
    {
        for (int tx = tx0; tx <= tx1; ++tx)
        {
            if (context.isCancelled())
            {
                GDALClose(out_ds);
                return cancelledRaster();
            }

            std::vector<uint8_t> png = fetchTile(zoom, tx, ty, config.url_template);
            ++tiles_done;
            const int pct = 5 + (tiles_done * 80) / std::max(1, total_tiles);
            report(context, "Tile " + std::to_string(tiles_done) + "/" + std::to_string(total_tiles), pct);

            if (png.empty())
            {
                if (context.warning)
                    context.warning("Tile " + std::to_string(tx) + "," + std::to_string(ty) + " was empty.");
                continue;
            }

            const std::string vpath = "/vsimem/dl_tile.png";
            VSILFILE* vf = VSIFileFromMemBuffer(vpath.c_str(), png.data(), static_cast<vsi_l_offset>(png.size()), FALSE);
            if (!vf)
                continue;
            VSIFCloseL(vf);

            GDALDataset* tds = static_cast<GDALDataset*>(GDALOpen(vpath.c_str(), GA_ReadOnly));
            if (!tds)
            {
                VSIUnlink(vpath.c_str());
                continue;
            }

            std::fill(band_r.begin(), band_r.end(), 255u);
            std::fill(band_g.begin(), band_g.end(), 255u);
            std::fill(band_b.begin(), band_b.end(), 255u);
            std::fill(band_a.begin(), band_a.end(), 255u);

            const int nb = tds->GetRasterCount();
            if (nb == 1 || nb == 2)
            {
                tds->GetRasterBand(1)->RasterIO(GF_Read, 0, 0, TILE_SIZE, TILE_SIZE,
                    band_r.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
                std::copy(band_r.begin(), band_r.end(), band_g.begin());
                std::copy(band_r.begin(), band_r.end(), band_b.begin());
            }
            else
            {
                uint8_t* planes[4] = { band_r.data(), band_g.data(), band_b.data(), band_a.data() };
                const int read_bands = std::min(nb, 4);
                for (int b = 0; b < read_bands; ++b)
                {
                    tds->GetRasterBand(b + 1)->RasterIO(GF_Read, 0, 0, TILE_SIZE, TILE_SIZE,
                        planes[b], TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
                }
            }
            GDALClose(tds);
            VSIUnlink(vpath.c_str());

            const int px = (tx - tx0) * TILE_SIZE;
            const int py = (ty - ty0) * TILE_SIZE;
            out_ds->GetRasterBand(1)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_r.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
            out_ds->GetRasterBand(2)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_g.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
            out_ds->GetRasterBand(3)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_b.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
        }
    }

    GDALClose(out_ds);

    if (config.target_size > 0)
    {
        const int ts = config.target_size;
        report(context, "Resampling albedo to " + std::to_string(ts) + "x" + std::to_string(ts) + "...", 88);
        const std::string tmp_path = config.output_path + ".tmp.tif";

        GDALDataset* src_ds = static_cast<GDALDataset*>(GDALOpen(config.output_path.c_str(), GA_ReadOnly));
        if (src_ds)
        {
            double src_gt[6];
            src_ds->GetGeoTransform(src_gt);
            const double new_px = (src_gt[1] * src_ds->GetRasterXSize()) / ts;
            const double new_py = (-src_gt[5] * src_ds->GetRasterYSize()) / ts;
            src_gt[1] = new_px;
            src_gt[5] = -new_py;

            GDALDriver* drv = GetGDALDriverManager()->GetDriverByName("GTiff");
            char** opts2 = nullptr;
            opts2 = CSLSetNameValue(opts2, "COMPRESS", "LZW");
            GDALDataset* dst_ds = drv->Create(tmp_path.c_str(), ts, ts, 3, GDT_Byte, opts2);
            CSLDestroy(opts2);
            if (dst_ds)
            {
                dst_ds->SetGeoTransform(src_gt);
                dst_ds->SetProjection(src_ds->GetProjectionRef());
                GDALWarpOptions* wo = GDALCreateWarpOptions();
                wo->hSrcDS = src_ds;
                wo->hDstDS = dst_ds;
                wo->nBandCount = 3;
                wo->panSrcBands = reinterpret_cast<int*>(CPLMalloc(3 * sizeof(int)));
                wo->panDstBands = reinterpret_cast<int*>(CPLMalloc(3 * sizeof(int)));
                for (int b = 0; b < 3; ++b)
                {
                    wo->panSrcBands[b] = b + 1;
                    wo->panDstBands[b] = b + 1;
                }
                wo->eResampleAlg = GRA_Bilinear;
                wo->pfnTransformer = GDALGenImgProjTransform;
                wo->pTransformerArg = GDALCreateGenImgProjTransformer(
                    src_ds, src_ds->GetProjectionRef(), dst_ds, dst_ds->GetProjectionRef(), FALSE, 0.0, 1);

                GDALWarpOperation wop;
                if (wop.Initialize(wo) == CE_None)
                    wop.ChunkAndWarpImage(0, 0, ts, ts);

                GDALDestroyGenImgProjTransformer(wo->pTransformerArg);
                GDALDestroyWarpOptions(wo);
                GDALClose(dst_ds);
            }
            GDALClose(src_ds);
            VSIUnlink(config.output_path.c_str());
            VSIRename(tmp_path.c_str(), config.output_path.c_str());
        }
    }

    GdalUtils::fixCrsTag(config.output_path);
    report(context, "Albedo saved: " + config.output_path, 95);
    RasterArtifact artifact;
    artifact.output_path = config.output_path;
    return Result<RasterArtifact>::ok(artifact);
}
