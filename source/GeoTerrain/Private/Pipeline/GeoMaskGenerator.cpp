#include "GeoMaskGenerator.h"
#include "HAL/FileManager.h"

#include <gdal_priv.h>
#include <ogr_api.h>
#include <ogr_geometry.h>
#include <cpl_conv.h>

TGeoResult<FGeoMaskArtifact> FGeoMaskGenerator::Generate(const FGeoBounds& Bounds,
                                                           const FGeoMaskConfig& Config,
                                                           const FString& OsmDataPath,
                                                           FGeoRunContext& Context)
{
    Context.ReportProgress(TEXT("Generating mask..."), 10);

    // Get output dimensions from reference TIF if provided
    int32 OutW = 512, OutH = 512;
    if (!Config.RefTifPath.IsEmpty())
    {
        GDALDataset* RefDs = static_cast<GDALDataset*>(
            GDALOpen(TCHAR_TO_UTF8(*Config.RefTifPath), GA_ReadOnly));
        if (RefDs)
        {
            OutW = RefDs->GetRasterXSize();
            OutH = RefDs->GetRasterYSize();
            GDALClose(RefDs);
        }
    }

    GDALAllRegister();
    GDALDriver* Driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!Driver)
        return TGeoResult<FGeoMaskArtifact>::Fail(1, TEXT("GTiff driver unavailable."));

    // Create 4-band RGBA mask (roads / buildings / vegetation / water)
    char** Opts = CSLSetNameValue(nullptr, "COMPRESS", "LZW");
    GDALDataset* Ds = Driver->Create(TCHAR_TO_UTF8(*Config.OutputPath), OutW, OutH, 4, GDT_Byte, Opts);
    CSLDestroy(Opts);
    if (!Ds)
        return TGeoResult<FGeoMaskArtifact>::Fail(2, TEXT("Cannot create mask TIF."));

    // Set geotransform
    const double PixW = Bounds.Width()  / OutW;
    const double PixH = Bounds.Height() / OutH;
    double GT[6] = { Bounds.West, PixW, 0.0, Bounds.North, 0.0, -PixH };
    Ds->SetGeoTransform(GT);

    // Fill all bands with zero (empty mask — OSM rasterisation is a future extension)
    for (int32 B = 1; B <= 4; ++B)
        Ds->GetRasterBand(B)->Fill(0.0);

    GDALClose(Ds);

    Context.ReportProgress(TEXT("Mask written."), 90);

    FGeoMaskArtifact Art;
    Art.MaskPath = Config.OutputPath;
    return TGeoResult<FGeoMaskArtifact>::Ok(Art);
}
