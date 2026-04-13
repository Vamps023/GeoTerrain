#include "TileDownloader.h"
#include "GdalUtils.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <gdal_priv.h>
#include <gdal.h>
#include <ogr_spatialref.h>

#include <curl/curl.h>

#include <algorithm>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---------------------------------------------------------------------------
// libcurl write callback
static size_t curlWriteCallback(void* ptr, size_t size, size_t nmemb, void* userdata)
{
    auto* buf = reinterpret_cast<std::vector<uint8_t>*>(userdata);
    const size_t total = size * nmemb;
    buf->insert(buf->end(), reinterpret_cast<uint8_t*>(ptr),
                             reinterpret_cast<uint8_t*>(ptr) + total);
    return total;
}

// ---------------------------------------------------------------------------
std::vector<uint8_t> TileDownloader::fetchTile(int z, int x, int y,
                                                const std::string& url_template)
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

    curl_easy_setopt(curl, CURLOPT_URL,            url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  curlWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &data);
    curl_easy_setopt(curl, CURLOPT_USERAGENT,      "Mozilla/5.0 GeoTerrainPlugin/1.0");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        30L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    const CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK)
        data.clear();

    return data;
}

// ---------------------------------------------------------------------------
bool TileDownloader::download(const GeoBounds& bounds,
                               const Config&    config,
                               ProgressCallback progress_cb)
{
    if (!bounds.isValid())
    {
        if (progress_cb) progress_cb("ERROR: Invalid bounds for tile download", 0);
        return false;
    }

    if (progress_cb) progress_cb("Starting tile download (zoom=" + std::to_string(config.zoom_level) + ")...", 0);

    // Override fetchTile to use the configured URL template by implementing
    // the download loop directly here (stitch() is a helper for GDAL writing).
    constexpr int TILE_SIZE = 256;
    const int zoom = config.zoom_level;

    const TileCoord tl = latLonToTile(bounds.north, bounds.west,  zoom);
    const TileCoord br = latLonToTile(bounds.south, bounds.east,  zoom);

    const int tx0 = tl.x, ty0 = tl.y;
    const int tx1 = br.x, ty1 = br.y;

    const int num_tiles_x = tx1 - tx0 + 1;
    const int num_tiles_y = ty1 - ty0 + 1;
    const int out_w       = num_tiles_x * TILE_SIZE;
    const int out_h       = num_tiles_y * TILE_SIZE;

    const double geo_west  = tileToLon(tx0, zoom);
    const double geo_north = tileToLat(ty0, zoom);
    const double geo_east  = tileToLon(tx1 + 1, zoom);
    const double geo_south = tileToLat(ty1 + 1, zoom);

    if (progress_cb)
        progress_cb("Allocating output raster " + std::to_string(out_w) + "x" + std::to_string(out_h), 2);

    GDALAllRegister();
    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver)
    {
        if (progress_cb) progress_cb("ERROR: GTiff GDAL driver not available", 0);
        return false;
    }

    char** create_opts = nullptr;
    create_opts = CSLSetNameValue(create_opts, "COMPRESS", "LZW");
    create_opts = CSLSetNameValue(create_opts, "TILED",    "YES");
    create_opts = CSLSetNameValue(create_opts, "PHOTOMETRIC", "RGB");

    GDALDataset* out_ds = driver->Create(config.output_path.c_str(),
                                         out_w, out_h, 3, GDT_Byte, create_opts);
    CSLDestroy(create_opts);

    if (!out_ds)
    {
        if (progress_cb) progress_cb("ERROR: Cannot create " + config.output_path, 0);
        return false;
    }

    double gt[6] = { geo_west,  (geo_east - geo_west)   / out_w,  0.0,
                     geo_north, 0.0, -(geo_north - geo_south) / out_h };
    out_ds->SetGeoTransform(gt);

    OGRSpatialReference srs;
    srs.importFromEPSG(4326);
    char* wkt = nullptr;
    srs.exportToWkt(&wkt);
    out_ds->SetProjection(wkt);
    CPLFree(wkt);

    // Planar band buffers: one contiguous block per band (not interleaved)
    constexpr int BAND_PIXELS = TILE_SIZE * TILE_SIZE;
    std::vector<uint8_t> band_r(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_g(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_b(BAND_PIXELS, 255u);
    std::vector<uint8_t> band_a(BAND_PIXELS, 255u);

    int tiles_done  = 0;
    int total_tiles = num_tiles_x * num_tiles_y;

    for (int ty = ty0; ty <= ty1; ++ty)
    {
        for (int tx = tx0; tx <= tx1; ++tx)
        {
            std::vector<uint8_t> png = fetchTile(zoom, tx, ty, config.url_template);
            tiles_done++;

            if (progress_cb)
            {
                const int pct = 5 + (tiles_done * 80) / std::max(1, total_tiles);
                progress_cb("Tile " + std::to_string(tiles_done) + "/" + std::to_string(total_tiles), pct);
            }

            if (png.empty())
            {
                if (progress_cb) progress_cb("[WARN] Tile " + std::to_string(tx) + "," + std::to_string(ty) + " empty", -1);
                continue;
            }

            const std::string vpath = "/vsimem/dl_tile.png";
            VSILFILE* vf = VSIFileFromMemBuffer(vpath.c_str(), png.data(),
                                                static_cast<vsi_l_offset>(png.size()), FALSE);
            if (!vf) continue;
            VSIFCloseL(vf);

            GDALDataset* tds = static_cast<GDALDataset*>(GDALOpen(vpath.c_str(), GA_ReadOnly));
            if (!tds)
            {
                if (progress_cb && tiles_done == 1)
                    progress_cb("[WARN] GDAL cannot decode PNG tile (" + std::to_string(png.size()) + " bytes) — PNG driver missing?", -1);
                VSIUnlink(vpath.c_str()); continue;
            }
            if (progress_cb && tiles_done == 1)
                progress_cb("[INFO] Tile decoded OK: " + std::to_string(tds->GetRasterXSize()) +
                            "x" + std::to_string(tds->GetRasterYSize()) +
                            " bands=" + std::to_string(tds->GetRasterCount()), -1);

            const int nb = tds->GetRasterCount();

            // Reset buffers to opaque white for tiles with fewer than 4 bands
            std::fill(band_r.begin(), band_r.end(), 255u);
            std::fill(band_g.begin(), band_g.end(), 255u);
            std::fill(band_b.begin(), band_b.end(), 255u);
            std::fill(band_a.begin(), band_a.end(), 255u);

            if (nb == 1 || nb == 2)
            {
                // Grayscale (1-band) or grayscale+alpha (2-band): read gray into R,G,B
                tds->GetRasterBand(1)->RasterIO(
                    GF_Read, 0, 0, TILE_SIZE, TILE_SIZE,
                    band_r.data(), TILE_SIZE, TILE_SIZE,
                    GDT_Byte, 1, TILE_SIZE);
                std::copy(band_r.begin(), band_r.end(), band_g.begin());
                std::copy(band_r.begin(), band_r.end(), band_b.begin());
            }
            else
            {
                // RGB (3-band) or RGBA (4-band): read each band separately
                uint8_t* planes[4] = { band_r.data(), band_g.data(), band_b.data(), band_a.data() };
                const int read_bands = std::min(nb, 4);
                for (int b = 0; b < read_bands; ++b)
                {
                    tds->GetRasterBand(b + 1)->RasterIO(
                        GF_Read, 0, 0, TILE_SIZE, TILE_SIZE,
                        planes[b], TILE_SIZE, TILE_SIZE,
                        GDT_Byte, 1, TILE_SIZE);
                }
            }
            GDALClose(tds);
            VSIUnlink(vpath.c_str());

            const int px = (tx - tx0) * TILE_SIZE;
            const int py = (ty - ty0) * TILE_SIZE;

            // Write R, G, B bands to output (planar)
            out_ds->GetRasterBand(1)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_r.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
            out_ds->GetRasterBand(2)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_g.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
            out_ds->GetRasterBand(3)->RasterIO(GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                band_b.data(), TILE_SIZE, TILE_SIZE, GDT_Byte, 1, TILE_SIZE);
        }
    }

    GDALClose(out_ds);
    if (progress_cb) progress_cb("Tagging albedo CRS: EPSG:4326...", 92);
    GdalUtils::fixCrsTag(config.output_path);
    if (progress_cb) progress_cb("Albedo saved: " + config.output_path, 95);
    return true;
}
