#include "pipeline/DEMFetcher.h"
#include "infrastructure/GdalUtils.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

#include <gdal_priv.h>
#include <gdal_alg.h>
#include <gdalwarper.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>

#include <curl/curl.h>

#include <algorithm>
#include <fstream>
#include <sstream>
#include <vector>

namespace
{
void report(RunContext& context, const std::string& message, int percent)
{
    if (context.progress)
        context.progress(message, percent);
}

Result<DemArtifact> cancelled()
{
    return Result<DemArtifact>::fail(999, "Cancelled.");
}

size_t curlWriteVec(void* ptr, size_t size, size_t nmemb, void* udata)
{
    auto* buf = reinterpret_cast<std::vector<uint8_t>*>(udata);
    const size_t n = size * nmemb;
    buf->insert(buf->end(), reinterpret_cast<uint8_t*>(ptr), reinterpret_cast<uint8_t*>(ptr) + n);
    return n;
}

std::vector<uint8_t> httpGet(const std::string& url, long timeout_s, long* http_code_out)
{
    std::vector<uint8_t> buf;
    CURL* c = curl_easy_init();
    if (!c)
        return buf;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, curlWriteVec);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, timeout_s);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "GeoTerrainEditorPlugin/1.0");
    const CURLcode res = curl_easy_perform(c);
    if (http_code_out)
    {
        *http_code_out = 0;
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, http_code_out);
    }
    curl_easy_cleanup(c);
    if (res != CURLE_OK)
        buf.clear();
    return buf;
}

const char* demDatasetName(DEMFetcher::Source src)
{
    switch (src)
    {
    case DEMFetcher::Source::OpenTopography_SRTM30m: return "SRTMGL1";
    case DEMFetcher::Source::OpenTopography_SRTM90m: return "SRTMGL3";
    case DEMFetcher::Source::OpenTopography_AW3D30: return "AW3D30";
    case DEMFetcher::Source::OpenTopography_COP30: return "COP30";
    case DEMFetcher::Source::OpenTopography_NASADEM: return "NASADEM";
    case DEMFetcher::Source::OpenTopography_3DEP10m: return "USGS10m";
    default: return "SRTMGL1";
    }
}
}

Result<DemArtifact> DEMFetcher::fetch(const GeoBounds& bounds, const Config& config, RunContext& context)
{
    if (context.isCancelled())
        return cancelled();
    if (!bounds.isValid())
        return Result<DemArtifact>::fail(1, "Invalid bounds for DEM fetch.");

    GDALAllRegister();
    if (config.source == Source::LocalGeoTIFF)
        return clipLocalTiff(bounds, config, context);
    return fetchFromOpenTopography(bounds, config, context);
}

Result<DemArtifact> DEMFetcher::fetchFromOpenTopography(const GeoBounds& bounds, const Config& config,
                                                        RunContext& context)
{
    report(context, "Requesting DEM from OpenTopography...", 5);

    const bool is_3dep = (config.source == Source::OpenTopography_3DEP10m);
    std::ostringstream url;
    if (is_3dep)
    {
        url << "https://portal.opentopography.org/API/usgsdem"
            << "?datasetName=" << demDatasetName(config.source)
            << "&south=" << bounds.south
            << "&north=" << bounds.north
            << "&west=" << bounds.west
            << "&east=" << bounds.east
            << "&outputFormat=GTiff";
    }
    else
    {
        url << "https://portal.opentopography.org/API/globaldem"
            << "?demtype=" << demDatasetName(config.source)
            << "&south=" << bounds.south
            << "&north=" << bounds.north
            << "&west=" << bounds.west
            << "&east=" << bounds.east
            << "&outputFormat=GTiff";
    }

    if (!config.api_key.empty())
        url << "&API_Key=" << config.api_key;

    long http_code = 0;
    report(context, "Downloading DEM GeoTIFF...", 10);
    const std::vector<uint8_t> raw = httpGet(url.str(), 180, &http_code);
    report(context, "HTTP " + std::to_string(http_code) + " - " + std::to_string(raw.size()) + " bytes received", 15);

    if (context.isCancelled())
        return cancelled();
    if (raw.empty())
        return Result<DemArtifact>::fail(2, "DEM download failed.");

    const bool is_tiff = raw.size() > 4 &&
        ((raw[0] == 0x49 && raw[1] == 0x49) || (raw[0] == 0x4D && raw[1] == 0x4D));
    if (!is_tiff)
    {
        const std::string resp(reinterpret_cast<const char*>(raw.data()),
                               std::min(raw.size(), static_cast<size_t>(500)));
        if (context.warning)
            context.warning("Server response: " + resp);
        return Result<DemArtifact>::fail(3, "DEM server did not return a GeoTIFF.");
    }

    const std::string vpath = "/vsimem/dem_raw.tif";
    VSILFILE* vf = VSIFileFromMemBuffer(vpath.c_str(), const_cast<uint8_t*>(raw.data()),
                                        static_cast<vsi_l_offset>(raw.size()), FALSE);
    if (!vf)
        return Result<DemArtifact>::fail(4, "Cannot create DEM memory buffer.");
    VSIFCloseL(vf);

    report(context, "Processing DEM to Float32 heightmap...", 60);
    Result<DemArtifact> result = convertToHeightmapTiff(vpath, config.output_path, bounds, config, context);
    VSIUnlink(vpath.c_str());
    if (!result.success)
        return result;

    report(context, "Tagging heightmap CRS: EPSG:4326...", 95);
    GdalUtils::fixCrsTag(config.output_path);
    result.value.output_path = config.output_path;
    return result;
}

Result<DemArtifact> DEMFetcher::clipLocalTiff(const GeoBounds& bounds, const Config& config, RunContext& context)
{
    report(context, "Clipping local GeoTIFF: " + config.local_tiff_path, 5);
    return convertToHeightmapTiff(config.local_tiff_path, config.output_path, bounds, config, context);
}

Result<DemArtifact> DEMFetcher::convertToHeightmapTiff(const std::string& src_path, const std::string& dst_path,
                                                       const GeoBounds& bounds, const Config& config, RunContext& context)
{
    if (context.isCancelled())
        return cancelled();

    GDALDataset* src_ds = static_cast<GDALDataset*>(GDALOpen(src_path.c_str(), GA_ReadOnly));
    if (!src_ds)
        return Result<DemArtifact>::fail(5, "Cannot open source DEM: " + src_path);

    OGRSpatialReference dst_srs;
    dst_srs.importFromEPSG(4326);
    char* dst_wkt = nullptr;
    dst_srs.exportToWkt(&dst_wkt);

    int out_w = 0;
    int out_h = 0;
    double pixel_deg_x = 0.0;
    double pixel_deg_y = 0.0;

    if (!config.ref_tif_path.empty())
    {
        GDALDataset* ref_ds = static_cast<GDALDataset*>(GDALOpen(config.ref_tif_path.c_str(), GA_ReadOnly));
        if (ref_ds)
        {
            double gt[6];
            if (ref_ds->GetGeoTransform(gt) == CE_None)
            {
                out_w = ref_ds->GetRasterXSize();
                out_h = ref_ds->GetRasterYSize();
                pixel_deg_x = gt[1];
                pixel_deg_y = -gt[5];
            }
            GDALClose(ref_ds);
        }
    }

    if (out_w <= 0 || out_h <= 0)
    {
        double src_gt[6];
        if (src_ds->GetGeoTransform(src_gt) == CE_None && src_gt[1] > 0.0 && src_gt[5] < 0.0)
        {
            pixel_deg_x = src_gt[1];
            pixel_deg_y = -src_gt[5];
            out_w = std::max(1, static_cast<int>(std::ceil(bounds.width() / pixel_deg_x)));
            out_h = std::max(1, static_cast<int>(std::ceil(bounds.height() / pixel_deg_y)));
        }
        else
        {
            const double deg_per_m = 1.0 / 111320.0;
            const double pixel_deg = config.resolution_m * deg_per_m;
            pixel_deg_x = pixel_deg;
            pixel_deg_y = pixel_deg;
            out_w = std::max(1, static_cast<int>(std::ceil(bounds.width() / pixel_deg)));
            out_h = std::max(1, static_cast<int>(std::ceil(bounds.height() / pixel_deg)));
        }
    }

    report(context, "Output heightmap size: " + std::to_string(out_w) + "x" + std::to_string(out_h), 65);

    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver)
    {
        GDALClose(src_ds);
        CPLFree(dst_wkt);
        return Result<DemArtifact>::fail(6, "GTiff driver not available.");
    }

    char** opts = nullptr;
    opts = CSLSetNameValue(opts, "COMPRESS", "LZW");
    GDALDataset* dst_ds = driver->Create(dst_path.c_str(), out_w, out_h, 1, GDT_Float32, opts);
    CSLDestroy(opts);
    if (!dst_ds)
    {
        GDALClose(src_ds);
        CPLFree(dst_wkt);
        return Result<DemArtifact>::fail(7, "Cannot create output heightmap.");
    }

    double gt[6] = { bounds.west, pixel_deg_x, 0.0, bounds.north, 0.0, -pixel_deg_y };
    dst_ds->SetGeoTransform(gt);
    dst_ds->SetProjection(dst_wkt);
    dst_ds->GetRasterBand(1)->SetNoDataValue(-9999.0);
    CPLFree(dst_wkt);

    GDALWarpOptions* warp_opts = GDALCreateWarpOptions();
    warp_opts->hSrcDS = src_ds;
    warp_opts->hDstDS = dst_ds;
    warp_opts->nBandCount = 1;
    warp_opts->panSrcBands = reinterpret_cast<int*>(CPLMalloc(sizeof(int)));
    warp_opts->panDstBands = reinterpret_cast<int*>(CPLMalloc(sizeof(int)));
    warp_opts->panSrcBands[0] = 1;
    warp_opts->panDstBands[0] = 1;
    warp_opts->eResampleAlg = GRA_Bilinear;
    warp_opts->pfnTransformer = GDALGenImgProjTransform;
    warp_opts->pTransformerArg = GDALCreateGenImgProjTransformer(
        src_ds, GDALGetProjectionRef(src_ds), dst_ds, GDALGetProjectionRef(dst_ds), FALSE, 0.0, 1);

    GDALWarpOperation warp_op;
    const CPLErr err = warp_op.Initialize(warp_opts);
    if (err == CE_None)
    {
        warp_op.ChunkAndWarpImage(0, 0, out_w, out_h);
        report(context, "Heightmap written: " + dst_path, 90);
    }

    GDALDestroyGenImgProjTransformer(warp_opts->pTransformerArg);
    GDALDestroyWarpOptions(warp_opts);
    GDALClose(dst_ds);
    GDALClose(src_ds);

    if (err != CE_None)
        return Result<DemArtifact>::fail(8, "Warp operation failed.");

    DemArtifact artifact;
    artifact.output_path = dst_path;
    return Result<DemArtifact>::ok(artifact);
}

// ---------------------------------------------------------------------------
// Returns nearest valid Unreal Engine landscape dimension.
// Valid sizes: (n * ComponentSize) + 1  where ComponentSize = 2^k * 7 (k=0..5)
// Common valid widths/heights: 127,253,505,1009,2017,4033,8129
static int nearestUnrealSize(int n)
{
    // Full list of valid Unreal landscape square dimensions
    static const int kValid[] = {
        127, 253, 505, 1009, 2017, 4033, 8129
    };
    int best = kValid[0];
    int bestDiff = std::abs(n - best);
    for (int v : kValid)
    {
        int diff = std::abs(n - v);
        if (diff < bestDiff) { bestDiff = diff; best = v; }
    }
    return best;
}

// Bilinear resample float buffer from (sw x sh) -> (dw x dh)
static std::vector<float> resampleBilinear(const std::vector<float>& src,
                                            int sw, int sh, int dw, int dh)
{
    std::vector<float> dst(static_cast<size_t>(dw) * dh);
    const float sx = static_cast<float>(sw) / dw;
    const float sy = static_cast<float>(sh) / dh;
    for (int dy = 0; dy < dh; ++dy)
    {
        float fy = (dy + 0.5f) * sy - 0.5f;
        int y0 = static_cast<int>(fy); if (y0 < 0) y0 = 0;
        int y1 = y0 + 1;               if (y1 >= sh) y1 = sh - 1;
        float ty = fy - y0;
        for (int dx = 0; dx < dw; ++dx)
        {
            float fx = (dx + 0.5f) * sx - 0.5f;
            int x0 = static_cast<int>(fx); if (x0 < 0) x0 = 0;
            int x1 = x0 + 1;               if (x1 >= sw) x1 = sw - 1;
            float tx = fx - x0;
            float v00 = src[y0 * sw + x0];
            float v10 = src[y0 * sw + x1];
            float v01 = src[y1 * sw + x0];
            float v11 = src[y1 * sw + x1];
            dst[dy * dw + dx] = (v00 * (1 - tx) + v10 * tx) * (1 - ty)
                               + (v01 * (1 - tx) + v11 * tx) * ty;
        }
    }
    return dst;
}

// ---------------------------------------------------------------------------
// Export a Float32 GeoTIFF heightmap to Unreal Engine 16-bit RAW (.r16)
// Auto-resamples to nearest valid Unreal landscape resolution.
// Unreal expects: unsigned 16-bit little-endian, row-major, no header.
Result<std::string> DEMFetcher::exportUnrealRaw(const std::string& tif_path,
                                                 const std::string& raw_path,
                                                 RunContext& context)
{
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpen(tif_path.c_str(), GA_ReadOnly));
    if (!ds)
        return Result<std::string>::fail(1, "Cannot open heightmap TIF: " + tif_path);

    const int src_w = ds->GetRasterXSize();
    const int src_h = ds->GetRasterYSize();
    GDALRasterBand* band = ds->GetRasterBand(1);

    // Read entire band as float32
    std::vector<float> buf(static_cast<size_t>(src_w) * src_h);
    CPLErr err = band->RasterIO(GF_Read, 0, 0, src_w, src_h,
                                buf.data(), src_w, src_h,
                                GDT_Float32, 0, 0);
    GDALClose(ds);

    if (err != CE_None)
        return Result<std::string>::fail(2, "Failed to read heightmap band.");

    // Snap to nearest valid Unreal landscape resolution (square)
    const int ue_size = nearestUnrealSize(std::max(src_w, src_h));
    const int out_w   = ue_size;
    const int out_h   = ue_size;

    // Resample if needed
    std::vector<float> resampled;
    const std::vector<float>& data = (src_w == out_w && src_h == out_h)
        ? buf
        : (resampled = resampleBilinear(buf, src_w, src_h, out_w, out_h), resampled);

    // Compute valid min/max (ignore nodata <= -9000)
    float elev_min =  1e38f;
    float elev_max = -1e38f;
    for (float v : data)
    {
        if (v <= -9000.0f) continue;
        if (v < elev_min) elev_min = v;
        if (v > elev_max) elev_max = v;
    }
    if (elev_min >= elev_max) { elev_min = 0.0f; elev_max = 1.0f; }
    const float range = elev_max - elev_min;

    // Normalise to uint16
    std::vector<uint16_t> raw(static_cast<size_t>(out_w) * out_h);
    for (size_t i = 0; i < data.size(); ++i)
    {
        float v = data[i] <= -9000.0f ? elev_min : data[i];
        float norm = (v - elev_min) / range;
        if (norm < 0.0f) norm = 0.0f;
        if (norm > 1.0f) norm = 1.0f;
        raw[i] = static_cast<uint16_t>(norm * 65535.0f + 0.5f);
    }

    // Write little-endian binary (no header)
    std::ofstream ofs(raw_path, std::ios::binary);
    if (!ofs)
        return Result<std::string>::fail(3, "Cannot create RAW file: " + raw_path);

    ofs.write(reinterpret_cast<const char*>(raw.data()),
              static_cast<std::streamsize>(raw.size() * sizeof(uint16_t)));
    ofs.close();

    if (context.progress)
        context.progress("Unreal RAW written (" + std::to_string(out_w) + "x" +
                         std::to_string(out_h) + " resampled from " +
                         std::to_string(src_w) + "x" + std::to_string(src_h) +
                         "): " + raw_path, 95);

    return Result<std::string>::ok(raw_path);
}
