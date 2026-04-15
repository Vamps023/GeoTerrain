#include "GeoTileDownloader.h"

#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <cpl_string.h>
#include <cmath>

static const double kPI = 3.14159265358979323846;

// XYZ tile lat/lon helpers
static int32 LonToTileX(double LonDeg, int32 Zoom)
{
    return (int32)FMath::FloorToInt((LonDeg + 180.0) / 360.0 * (1 << Zoom));
}
static int32 LatToTileY(double LatDeg, int32 Zoom)
{
    double LatRad = LatDeg * kPI / 180.0;
    return (int32)FMath::FloorToInt((1.0 - FMath::Loge(FMath::Tan(LatRad) + 1.0 / FMath::Cos(LatRad)) / kPI) / 2.0 * (1 << Zoom));
}
static double TileXToLon(int32 X, int32 Zoom) { return X / (double)(1 << Zoom) * 360.0 - 180.0; }
static double TileYToLat(int32 Y, int32 Zoom)
{
    double N = kPI - 2.0 * kPI * Y / (double)(1 << Zoom);
    return 180.0 / kPI * FMath::Atan(0.5 * (FMath::Exp(N) - FMath::Exp(-N)));
}

void FGeoTileDownloader::BoundsToTileRange(const FGeoBounds& B, int32 Zoom,
                                            int32& XMin, int32& XMax,
                                            int32& YMin, int32& YMax)
{
    XMin = LonToTileX(B.West,  Zoom);
    XMax = LonToTileX(B.East,  Zoom);
    YMin = LatToTileY(B.North, Zoom);   // note: Y inverted in XYZ
    YMax = LatToTileY(B.South, Zoom);
}

TGeoResult<FGeoTileArtifact> FGeoTileDownloader::Download(const FGeoBounds& Bounds,
                                                            const FGeoTileSettings& Config,
                                                            FGeoRunContext& Context)
{
    // Determine tile range
    int32 XMin, XMax, YMin, YMax;
    BoundsToTileRange(Bounds, Config.ZoomLevel, XMin, XMax, YMin, YMax);

    const int32 Total = (XMax - XMin + 1) * (YMax - YMin + 1);
    Context.ReportProgress(FString::Printf(TEXT("Downloading %d tile(s) at zoom %d..."), Total, Config.ZoomLevel), 5);

    // Temp dir for individual tiles
    const FString TmpDir = FPaths::ProjectSavedDir() / TEXT("GeoTerrain_Tiles");
    IFileManager::Get().MakeDirectory(*TmpDir, true);

    TArray<FString> TilePaths;
    int32 Done = 0;

    for (int32 TX = XMin; TX <= XMax; ++TX)
    {
        for (int32 TY = YMin; TY <= YMax; ++TY)
        {
            if (Context.IsCancelled())
                return TGeoResult<FGeoTileArtifact>::Fail(999, TEXT("Cancelled."));

            FString Url = Config.UrlTemplate;
            Url = Url.Replace(TEXT("{z}"), *FString::FromInt(Config.ZoomLevel));
            Url = Url.Replace(TEXT("{x}"), *FString::FromInt(TX));
            Url = Url.Replace(TEXT("{y}"), *FString::FromInt(TY));

            const FString TilePath = FString::Printf(TEXT("%s/%d_%d_%d.png"), *TmpDir, Config.ZoomLevel, TX, TY);

            if (!IFileManager::Get().FileExists(*TilePath))
            {
                if (!DownloadTile(Url, TilePath, Context))
                {
                    Context.ReportWarning(FString::Printf(TEXT("Tile %d/%d failed: %s"), TX, TY, *Url));
                    continue;
                }
            }
            TilePaths.Add(TilePath);
            ++Done;
            Context.ReportProgress(FString::Printf(TEXT("Tiles: %d/%d"), Done, Total),
                                    5 + FMath::RoundToInt(85.0f * Done / Total));
        }
    }

    if (TilePaths.Num() == 0)
        return TGeoResult<FGeoTileArtifact>::Fail(1, TEXT("No tiles downloaded."));

    // Determine output path from Config — use ZoomLevel as discriminator
    const FString OutPath = FPaths::ProjectSavedDir() / TEXT("GeoTerrain_Tiles") /
                            FString::Printf(TEXT("albedo_%d.tif"), Config.ZoomLevel);

    if (!MergeTiles(TilePaths, Bounds, Config.ZoomLevel, OutPath))
        return TGeoResult<FGeoTileArtifact>::Fail(2, TEXT("Tile merge failed."));

    Context.ReportProgress(TEXT("Albedo tile merge complete."), 95);

    FGeoTileArtifact Art;
    Art.OutputPath = OutPath;
    return TGeoResult<FGeoTileArtifact>::Ok(Art);
}

bool FGeoTileDownloader::DownloadTile(const FString& Url, const FString& DestPath, FGeoRunContext& Context)
{
    FEvent* Done = FPlatformProcess::GetSynchEventFromPool(true);
    bool bOk = false;
    TArray<uint8> Bytes;

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(Url);
    Req->SetVerb(TEXT("GET"));
    Req->OnProcessRequestComplete().BindLambda(
        [&bOk, &Bytes, Done](FHttpRequestPtr, FHttpResponsePtr Res, bool bSucceeded)
        {
            if (bSucceeded && Res.IsValid() && Res->GetResponseCode() == 200)
            { Bytes = Res->GetContent(); bOk = true; }
            Done->Trigger();
        });
    Req->ProcessRequest();

    while (!Done->Wait(200)) { if (Context.IsCancelled()) { Req->CancelRequest(); break; } }
    FPlatformProcess::ReturnSynchEventToPool(Done);

    if (bOk)
    {
        TUniquePtr<FArchive> Ar(IFileManager::Get().CreateFileWriter(*DestPath));
        if (Ar) { Ar->Serialize(Bytes.GetData(), Bytes.Num()); return true; }
    }
    return false;
}

bool FGeoTileDownloader::MergeTiles(const TArray<FString>& TilePaths, const FGeoBounds& Bounds,
                                     int32 Zoom, const FString& OutputPath)
{
    if (TilePaths.Num() == 0) return false;

    GDALAllRegister();

    // Build VRT in memory listing all tile PNGs
    TArray<GDALDataset*> Datasets;
    for (const FString& P : TilePaths)
    {
        GDALDataset* Ds = static_cast<GDALDataset*>(GDALOpen(TCHAR_TO_UTF8(*P), GA_ReadOnly));
        if (Ds) Datasets.Add(Ds);
    }
    if (Datasets.Num() == 0) return false;

    // Use GDAL VRT to merge
    GDALDriver* VrtDriver = GetGDALDriverManager()->GetDriverByName("VRT");
    const int32 TileSize  = 256;
    const int32 NumCols   = FMath::CeilToInt(Bounds.Width()  / (360.0 / (1 << Zoom)));
    const int32 NumRows   = FMath::CeilToInt(Bounds.Height() / (180.0 / (1 << Zoom)));
    const int32 OutW      = FMath::Max(1, NumCols * TileSize);
    const int32 OutH      = FMath::Max(1, NumRows * TileSize);

    GDALDataset* VrtDs = VrtDriver->Create("", OutW, OutH, 3, GDT_Byte, nullptr);

    // Simple approach: warp each tile into final GTiff
    OGRSpatialReference Srs; Srs.importFromEPSG(4326);
    char* Wkt = nullptr; Srs.exportToWkt(&Wkt);

    GDALDriver* TiffDriver = GetGDALDriverManager()->GetDriverByName("GTiff");
    char** Opts = CSLSetNameValue(nullptr, "COMPRESS", "JPEG");
    GDALDataset* OutDs = TiffDriver->Create(TCHAR_TO_UTF8(*OutputPath), OutW, OutH, 3, GDT_Byte, Opts);
    CSLDestroy(Opts);

    if (!OutDs) { CPLFree(Wkt); for (auto* D : Datasets) GDALClose(D); if (VrtDs) GDALClose(VrtDs); return false; }

    const double PixW = Bounds.Width()  / OutW;
    const double PixH = Bounds.Height() / OutH;
    double GT[6] = { Bounds.West, PixW, 0.0, Bounds.North, 0.0, -PixH };
    OutDs->SetGeoTransform(GT);
    OutDs->SetProjection(Wkt);
    CPLFree(Wkt);

    // Warp all tiles in
    for (GDALDataset* SrcDs : Datasets)
    {
        GDALWarpOptions* WO = GDALCreateWarpOptions();
        WO->hSrcDS = SrcDs; WO->hDstDS = OutDs;
        WO->nBandCount = 3;
        WO->panSrcBands = (int*)CPLMalloc(3 * sizeof(int));
        WO->panDstBands = (int*)CPLMalloc(3 * sizeof(int));
        for (int32 I = 0; I < 3; ++I) { WO->panSrcBands[I] = I + 1; WO->panDstBands[I] = I + 1; }
        WO->eResampleAlg    = GRA_Bilinear;
        WO->pfnTransformer  = GDALGenImgProjTransform;
        WO->pTransformerArg = GDALCreateGenImgProjTransformer(
            SrcDs, nullptr, OutDs, GDALGetProjectionRef(OutDs), FALSE, 0.0, 1);
        if (WO->pTransformerArg)
        {
            GDALWarpOperation Op; Op.Initialize(WO);
            Op.ChunkAndWarpImage(0, 0, OutW, OutH);
        }
        GDALDestroyGenImgProjTransformer(WO->pTransformerArg);
        GDALDestroyWarpOptions(WO);
    }

    GDALClose(OutDs);
    if (VrtDs) GDALClose(VrtDs);
    for (auto* D : Datasets) GDALClose(D);
    return true;
}
