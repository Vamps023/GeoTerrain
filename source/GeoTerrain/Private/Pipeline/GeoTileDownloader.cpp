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

    // Use configured output path, or fall back to temp location
    const FString OutPath = Config.OutputPath.IsEmpty()
        ? (FPaths::ProjectSavedDir() / TEXT("GeoTerrain_Tiles") / FString::Printf(TEXT("albedo_%d.tif"), Config.ZoomLevel))
        : Config.OutputPath;

    if (!MergeTiles(TilePaths, Config.ZoomLevel, XMin, YMin, XMax, YMax, OutPath))
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

bool FGeoTileDownloader::MergeTiles(const TArray<FString>& TilePaths,
                                     int32 Zoom, int32 XMin, int32 YMin, int32 XMax, int32 YMax,
                                     const FString& OutputPath)
{
    if (TilePaths.Num() == 0) return false;

    GDALAllRegister();

    const int32 TileSize  = 256;
    const int32 NumTilesX = XMax - XMin + 1;
    const int32 NumTilesY = YMax - YMin + 1;
    const int32 OutW      = NumTilesX * TileSize;
    const int32 OutH      = NumTilesY * TileSize;

    GDALDriver* Driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!Driver) return false;

    char** Opts = CSLSetNameValue(nullptr, "COMPRESS", "JPEG");
    GDALDataset* OutDs = Driver->Create(TCHAR_TO_UTF8(*OutputPath), OutW, OutH, 3, GDT_Byte, Opts);
    CSLDestroy(Opts);
    if (!OutDs) return false;

    // Set geotransform in EPSG:4326 (approximate for tile grid)
    const double GeoW = TileXToLon(XMin, Zoom);
    const double GeoE = TileXToLon(XMax + 1, Zoom);
    const double GeoN = TileYToLat(YMin, Zoom);
    const double GeoS = TileYToLat(YMax + 1, Zoom);
    double GT[6] = { GeoW, (GeoE - GeoW) / OutW, 0.0, GeoN, 0.0, -(GeoN - GeoS) / OutH };
    OutDs->SetGeoTransform(GT);

    OGRSpatialReference Srs;
    Srs.importFromEPSG(4326);
    char* Wkt = nullptr;
    Srs.exportToWkt(&Wkt);
    OutDs->SetProjection(Wkt);
    CPLFree(Wkt);

    // Blit each tile into its correct position in the output
    for (const FString& TilePath : TilePaths)
    {
        // Parse Z_X_Y.png from filename
        FString Name = FPaths::GetBaseFilename(TilePath);
        TArray<FString> Parts;
        Name.ParseIntoArray(Parts, TEXT("_"));
        if (Parts.Num() < 3) continue;

        const int32 TX = FCString::Atoi(*Parts[1]);
        const int32 TY = FCString::Atoi(*Parts[2]);
        const int32 PixX = (TX - XMin) * TileSize;
        const int32 PixY = (TY - YMin) * TileSize;

        GDALDataset* TileDs = static_cast<GDALDataset*>(
            GDALOpen(TCHAR_TO_UTF8(*TilePath), GA_ReadOnly));
        if (!TileDs) continue;

        const int32 TW = TileDs->GetRasterXSize();
        const int32 TH = TileDs->GetRasterYSize();
        const int32 Bands = FMath::Min(TileDs->GetRasterCount(), 3);

        TArray<uint8> Buf;
        Buf.SetNumUninitialized(TW * TH);

        for (int32 B = 1; B <= Bands; ++B)
        {
            TileDs->GetRasterBand(B)->RasterIO(
                GF_Read, 0, 0, TW, TH, Buf.GetData(), TW, TH, GDT_Byte, 0, 0);
            OutDs->GetRasterBand(B)->RasterIO(
                GF_Write, PixX, PixY, TW, TH, Buf.GetData(), TW, TH, GDT_Byte, 0, 0);
        }

        // If source has only 1 band (greyscale PNG), duplicate to R/G/B
        if (Bands == 1)
        {
            for (int32 B = 2; B <= 3; ++B)
                OutDs->GetRasterBand(B)->RasterIO(
                    GF_Write, PixX, PixY, TW, TH, Buf.GetData(), TW, TH, GDT_Byte, 0, 0);
        }

        GDALClose(TileDs);
    }

    GDALClose(OutDs);
    return true;
}
