#include "GdalUtils.h"

#include <gdal_priv.h>
#include <gdalwarper.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>
#include <cpl_string.h>

#include <cstdio>

namespace GdalUtils
{

bool reprojectToMercator(const std::string& tif_path,
                          const std::string& /*tmp_path*/)
{
    GDALAllRegister();

    // Open source (EPSG:4326)
    GDALDataset* src_ds = static_cast<GDALDataset*>(
        GDALOpen(tif_path.c_str(), GA_ReadOnly));
    if (!src_ds)
        return false;

    // Target SRS: EPSG:3395 World Mercator (metres)
    OGRSpatialReference dst_srs;
    dst_srs.importFromEPSG(3395);
    char* dst_wkt = nullptr;
    dst_srs.exportToWkt(&dst_wkt);

    // Suggest output bounds/size in Mercator
    double gt_out[6];
    int out_w = 0, out_h = 0;
    void* transformer = GDALCreateGenImgProjTransformer(
        src_ds, GDALGetProjectionRef(src_ds),
        nullptr, dst_wkt,
        FALSE, 0.0, 1);
    if (!transformer)
    {
        CPLFree(dst_wkt);
        GDALClose(src_ds);
        return false;
    }
    GDALSuggestedWarpOutput(src_ds, GDALGenImgProjTransform,
                             transformer, gt_out, &out_w, &out_h);
    GDALDestroyGenImgProjTransformer(transformer);

    // Write to a vsimem temp file
    const std::string vpath = "/vsimem/reproject_tmp.tif";
    GDALDriver* drv = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!drv) { CPLFree(dst_wkt); GDALClose(src_ds); return false; }

    const int bands = src_ds->GetRasterCount();
    const GDALDataType dtype = src_ds->GetRasterBand(1)->GetRasterDataType();

    char** opts = nullptr;
    opts = CSLSetNameValue(opts, "COMPRESS", "LZW");
    GDALDataset* dst_ds = drv->Create(vpath.c_str(), out_w, out_h, bands, dtype, opts);
    CSLDestroy(opts);

    if (!dst_ds) { CPLFree(dst_wkt); GDALClose(src_ds); return false; }

    dst_ds->SetGeoTransform(gt_out);
    dst_ds->SetProjection(dst_wkt);
    CPLFree(dst_wkt);

    // Copy band descriptions
    for (int b = 1; b <= bands; ++b)
    {
        const char* desc = src_ds->GetRasterBand(b)->GetDescription();
        if (desc) dst_ds->GetRasterBand(b)->SetDescription(desc);
        dst_ds->GetRasterBand(b)->SetNoDataValue(
            src_ds->GetRasterBand(b)->GetNoDataValue());
    }

    // Warp
    GDALWarpOptions* warp = GDALCreateWarpOptions();
    warp->hSrcDS      = src_ds;
    warp->hDstDS      = dst_ds;
    warp->nBandCount  = bands;
    warp->panSrcBands = reinterpret_cast<int*>(CPLMalloc(bands * sizeof(int)));
    warp->panDstBands = reinterpret_cast<int*>(CPLMalloc(bands * sizeof(int)));
    for (int b = 0; b < bands; ++b)
    {
        warp->panSrcBands[b] = b + 1;
        warp->panDstBands[b] = b + 1;
    }
    warp->eResampleAlg    = GRA_Bilinear;
    warp->pfnTransformer  = GDALGenImgProjTransform;
    warp->pTransformerArg = GDALCreateGenImgProjTransformer(
        src_ds, GDALGetProjectionRef(src_ds),
        dst_ds, GDALGetProjectionRef(dst_ds),
        FALSE, 0.0, 1);

    GDALWarpOperation op;
    const CPLErr err = op.Initialize(warp);
    if (err == CE_None)
        op.ChunkAndWarpImage(0, 0, out_w, out_h);

    GDALDestroyGenImgProjTransformer(warp->pTransformerArg);
    GDALDestroyWarpOptions(warp);
    GDALClose(dst_ds);
    GDALClose(src_ds);

    if (err != CE_None)
    {
        VSIUnlink(vpath.c_str());
        return false;
    }

    // Copy vsimem result back over the original file
    GDALDataset* mem_ds = static_cast<GDALDataset*>(
        GDALOpen(vpath.c_str(), GA_ReadOnly));
    if (!mem_ds) { VSIUnlink(vpath.c_str()); return false; }

    GDALDataset* final_ds = drv->CreateCopy(tif_path.c_str(), mem_ds,
                                             FALSE, nullptr, nullptr, nullptr);
    GDALClose(mem_ds);
    VSIUnlink(vpath.c_str());

    if (!final_ds) return false;
    GDALClose(final_ds);
    return true;
}

} // namespace GdalUtils
