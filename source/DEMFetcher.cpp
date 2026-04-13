#include "DEMFetcher.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <gdal_priv.h>
#include <gdal_alg.h>
#include <gdalwarper.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>
#include <cpl_string.h>

#include <curl/curl.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ---------------------------------------------------------------------------
static size_t curlWriteVec(void* ptr, size_t size, size_t nmemb, void* udata)
{
    auto* buf = reinterpret_cast<std::vector<uint8_t>*>(udata);
    const size_t n = size * nmemb;
    buf->insert(buf->end(), reinterpret_cast<uint8_t*>(ptr),
                             reinterpret_cast<uint8_t*>(ptr) + n);
    return n;
}

static std::vector<uint8_t> httpGet(const std::string& url, long timeout_s = 120,
                                     long* http_code_out = nullptr)
{
    std::vector<uint8_t> buf;
    CURL* c = curl_easy_init();
    if (!c) return buf;
    curl_easy_setopt(c, CURLOPT_URL,            url.c_str());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION,  curlWriteVec);
    curl_easy_setopt(c, CURLOPT_WRITEDATA,      &buf);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT,        timeout_s);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(c, CURLOPT_USERAGENT,      "GeoTerrainEditorPlugin/1.0");
    const CURLcode res = curl_easy_perform(c);
    if (http_code_out)
    {
        *http_code_out = 0;
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, http_code_out);
    }
    curl_easy_cleanup(c);
    if (res != CURLE_OK) buf.clear();
    return buf;
}

// ---------------------------------------------------------------------------
static const char* demDatasetName(DEMFetcher::Source src)
{
    switch (src)
    {
    case DEMFetcher::Source::OpenTopography_SRTM30m: return "SRTMGL1";
    case DEMFetcher::Source::OpenTopography_SRTM90m: return "SRTMGL3";
    case DEMFetcher::Source::OpenTopography_AW3D30:  return "AW3D30";
    default:                                          return "SRTMGL1";
    }
}

// ---------------------------------------------------------------------------
bool DEMFetcher::fetch(const GeoBounds& bounds,
                        const Config&    config,
                        ProgressCallback progress_cb)
{
    if (!bounds.isValid())
    {
        if (progress_cb) progress_cb("ERROR: Invalid bounds for DEM fetch", 0);
        return false;
    }

    GDALAllRegister();

    if (config.source == Source::LocalGeoTIFF)
        return clipLocalTiff(bounds, config, progress_cb);

    return fetchFromOpenTopography(bounds, config, progress_cb);
}

// ---------------------------------------------------------------------------
bool DEMFetcher::fetchFromOpenTopography(const GeoBounds& bounds,
                                          const Config&    config,
                                          ProgressCallback progress_cb)
{
    if (progress_cb) progress_cb("Requesting DEM from OpenTopography...", 5);

    // Build OpenTopography REST URL
    std::ostringstream url;
    url << "https://portal.opentopography.org/API/globaldem"
        << "?demtype="   << demDatasetName(config.source)
        << "&south="     << bounds.south
        << "&north="     << bounds.north
        << "&west="      << bounds.west
        << "&east="      << bounds.east
        << "&outputFormat=GTiff";

    if (!config.api_key.empty())
        url << "&API_Key=" << config.api_key;

    const std::string url_str = url.str();
    if (progress_cb) progress_cb("URL: " + url_str, 8);
    if (progress_cb) progress_cb("Downloading DEM GeoTIFF...", 10);

    long http_code = 0;
    const std::vector<uint8_t> raw = httpGet(url_str, 180, &http_code);

    if (progress_cb)
        progress_cb("HTTP " + std::to_string(http_code) + " — " +
                    std::to_string(raw.size()) + " bytes received", 15);

    if (raw.empty())
    {
        if (progress_cb) progress_cb("ERROR: DEM download failed (curl error or timeout)", 0);
        return false;
    }

    // Check if response is actually a GeoTIFF (magic bytes: 49 49 or 4D 4D)
    const bool is_tiff = raw.size() > 4 &&
                         ((raw[0] == 0x49 && raw[1] == 0x49) ||
                          (raw[0] == 0x4D && raw[1] == 0x4D));
    if (!is_tiff)
    {
        // Log first 500 chars of server error response
        const std::string resp(reinterpret_cast<const char*>(raw.data()),
                               std::min(raw.size(), (size_t)500));
        if (progress_cb) progress_cb("ERROR: Server did not return a GeoTIFF.", 0);
        if (progress_cb) progress_cb("Server response: " + resp, 0);
        return false;
    }

    // Write raw bytes to a VSI memory file, then convert
    const std::string vpath = "/vsimem/dem_raw.tif";
    VSILFILE* vf = VSIFileFromMemBuffer(vpath.c_str(),
                                        const_cast<uint8_t*>(raw.data()),
                                        static_cast<vsi_l_offset>(raw.size()),
                                        FALSE);
    if (!vf)
    {
        if (progress_cb) progress_cb("ERROR: Cannot write DEM to memory buffer", 0);
        return false;
    }
    VSIFCloseL(vf);

    if (progress_cb) progress_cb("Processing DEM to Float32 heightmap...", 60);
    const bool ok = convertToHeightmapTiff(vpath, config.output_path,
                                            bounds, config.resolution_m, progress_cb);
    VSIUnlink(vpath.c_str());
    return ok;
}

// ---------------------------------------------------------------------------
bool DEMFetcher::clipLocalTiff(const GeoBounds& bounds,
                                const Config&    config,
                                ProgressCallback progress_cb)
{
    if (progress_cb) progress_cb("Clipping local GeoTIFF: " + config.local_tiff_path, 5);
    return convertToHeightmapTiff(config.local_tiff_path, config.output_path,
                                   bounds, config.resolution_m, progress_cb);
}

// ---------------------------------------------------------------------------
bool DEMFetcher::convertToHeightmapTiff(const std::string& src_path,
                                          const std::string& dst_path,
                                          const GeoBounds&   bounds,
                                          double             resolution_m,
                                          ProgressCallback   progress_cb)
{
    GDALDataset* src_ds = static_cast<GDALDataset*>(GDALOpen(src_path.c_str(), GA_ReadOnly));
    if (!src_ds)
    {
        if (progress_cb) progress_cb("ERROR: Cannot open source DEM: " + src_path, 0);
        return false;
    }

    // Target SRS: EPSG:4326 — export as WKT1 (GDAL legacy format Unigine understands)
    OGRSpatialReference dst_srs;
    dst_srs.importFromEPSG(4326);
    dst_srs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
    char* dst_wkt = nullptr;
    const char* wkt_opts[] = { "FORMAT=WKT1_GDAL", nullptr };
    dst_srs.exportToWkt(&dst_wkt, wkt_opts);

    // Compute output pixel size from resolution_m (degrees ~ 1m = 8.9e-6 deg at equator)
    const double deg_per_m = 1.0 / 111320.0;
    const double pixel_deg = resolution_m * deg_per_m;

    const int out_w = std::max(1, static_cast<int>(std::ceil(bounds.width()  / pixel_deg)));
    const int out_h = std::max(1, static_cast<int>(std::ceil(bounds.height() / pixel_deg)));

    if (progress_cb)
        progress_cb("Output heightmap size: " + std::to_string(out_w) + "x" + std::to_string(out_h), 65);

    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver) { GDALClose(src_ds); CPLFree(dst_wkt); return false; }

    char** opts = nullptr;
    opts = CSLSetNameValue(opts, "COMPRESS", "LZW");

    GDALDataset* dst_ds = driver->Create(dst_path.c_str(), out_w, out_h, 1, GDT_Float32, opts);
    CSLDestroy(opts);

    if (!dst_ds)
    {
        if (progress_cb) progress_cb("ERROR: Cannot create output heightmap: " + dst_path, 0);
        GDALClose(src_ds);
        CPLFree(dst_wkt);
        return false;
    }

    double gt[6] = {
        bounds.west,  pixel_deg,  0.0,
        bounds.north, 0.0,       -pixel_deg
    };
    dst_ds->SetGeoTransform(gt);
    dst_ds->SetProjection(dst_wkt);
    dst_ds->GetRasterBand(1)->SetNoDataValue(-9999.0);

    CPLFree(dst_wkt);

    // Warp (reproject + clip + resample)
    GDALWarpOptions* warp_opts = GDALCreateWarpOptions();
    warp_opts->hSrcDS         = src_ds;
    warp_opts->hDstDS         = dst_ds;
    warp_opts->nBandCount     = 1;
    warp_opts->panSrcBands    = reinterpret_cast<int*>(CPLMalloc(sizeof(int)));
    warp_opts->panDstBands    = reinterpret_cast<int*>(CPLMalloc(sizeof(int)));
    warp_opts->panSrcBands[0] = 1;
    warp_opts->panDstBands[0] = 1;
    warp_opts->eResampleAlg   = GRA_Bilinear;
    warp_opts->pfnTransformer = GDALGenImgProjTransform;
    warp_opts->pTransformerArg = GDALCreateGenImgProjTransformer(
        src_ds, GDALGetProjectionRef(src_ds),
        dst_ds, GDALGetProjectionRef(dst_ds),
        FALSE, 0.0, 1);

    GDALWarpOperation warp_op;
    const CPLErr err = warp_op.Initialize(warp_opts);
    if (err == CE_None)
    {
        warp_op.ChunkAndWarpImage(0, 0, out_w, out_h);
        if (progress_cb) progress_cb("Heightmap written: " + dst_path, 90);
    }
    else
    {
        if (progress_cb) progress_cb("ERROR: Warp operation failed", 0);
    }

    GDALDestroyGenImgProjTransformer(warp_opts->pTransformerArg);
    GDALDestroyWarpOptions(warp_opts);
    GDALClose(dst_ds);
    GDALClose(src_ds);

    return (err == CE_None);
}
