#include "TileDownloader.h"

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
    curl_easy_setopt(curl, CURLOPT_USERAGENT,      "GeoTerrainEditorPlugin/1.0");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        30L);

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
                                         out_w, out_h, 4, GDT_Byte, create_opts);
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

    std::vector<uint8_t> tile_buf(TILE_SIZE * TILE_SIZE * 4, 255u);
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
                continue;

            const std::string vpath = "/vsimem/dl_tile.png";
            VSILFILE* vf = VSIFileFromMemBuffer(vpath.c_str(), png.data(),
                                                static_cast<vsi_l_offset>(png.size()), FALSE);
            if (!vf) continue;
            VSIFCloseL(vf);

            GDALDataset* tds = static_cast<GDALDataset*>(GDALOpen(vpath.c_str(), GA_ReadOnly));
            if (!tds) { VSIUnlink(vpath.c_str()); continue; }

            const int nb = std::min(tds->GetRasterCount(), 4);
            std::fill(tile_buf.begin(), tile_buf.end(), 255u);

            for (int b = 0; b < nb; ++b)
            {
                tds->GetRasterBand(b + 1)->RasterIO(
                    GF_Read, 0, 0, TILE_SIZE, TILE_SIZE,
                    tile_buf.data() + b, TILE_SIZE, TILE_SIZE,
                    GDT_Byte, 4, 4 * TILE_SIZE);
            }
            GDALClose(tds);
            VSIUnlink(vpath.c_str());

            const int px = (tx - tx0) * TILE_SIZE;
            const int py = (ty - ty0) * TILE_SIZE;
            for (int b = 1; b <= 4; ++b)
            {
                out_ds->GetRasterBand(b)->RasterIO(
                    GF_Write, px, py, TILE_SIZE, TILE_SIZE,
                    tile_buf.data() + (b - 1), TILE_SIZE, TILE_SIZE,
                    GDT_Byte, 4, 4 * TILE_SIZE);
            }
        }
    }

    GDALClose(out_ds);
    if (progress_cb) progress_cb("Albedo saved: " + config.output_path, 95);
    return true;
}
