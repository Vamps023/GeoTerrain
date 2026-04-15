#include "GeoDemFetcher.h"

#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

#include <gdal_priv.h>
#include <gdal_alg.h>
#include <gdalwarper.h>
#include <ogr_spatialref.h>
#include <cpl_conv.h>
#include <algorithm>
#include <vector>
#include <fstream>
#include <cmath>

// ── Valid Unreal landscape dimensions ─────────────────────────────────────────
static int32 NearestUnrealSize(int32 N)
{
    static const int32 kValid[] = { 127, 253, 505, 1009, 2017, 4033, 8129 };
    int32 Best = kValid[0], BestDiff = FMath::Abs(N - Best);
    for (int32 V : kValid)
    {
        int32 D = FMath::Abs(N - V);
        if (D < BestDiff) { BestDiff = D; Best = V; }
    }
    return Best;
}

// ── Bilinear resample ─────────────────────────────────────────────────────────
static TArray<float> ResampleBilinear(const TArray<float>& Src, int32 SW, int32 SH, int32 DW, int32 DH)
{
    TArray<float> Dst;
    Dst.SetNumUninitialized(DW * DH);
    const float SX = (float)SW / DW;
    const float SY = (float)SH / DH;
    for (int32 DY = 0; DY < DH; ++DY)
    {
        float FY = (DY + 0.5f) * SY - 0.5f;
        int32 Y0 = FMath::Clamp((int32)FY,     0, SH - 1);
        int32 Y1 = FMath::Clamp((int32)FY + 1, 0, SH - 1);
        float TY = FY - (int32)FY;
        for (int32 DX = 0; DX < DW; ++DX)
        {
            float FX = (DX + 0.5f) * SX - 0.5f;
            int32 X0 = FMath::Clamp((int32)FX,     0, SW - 1);
            int32 X1 = FMath::Clamp((int32)FX + 1, 0, SW - 1);
            float TX = FX - (int32)FX;
            float V00 = Src[Y0 * SW + X0], V10 = Src[Y0 * SW + X1];
            float V01 = Src[Y1 * SW + X0], V11 = Src[Y1 * SW + X1];
            Dst[DY * DW + DX] = (V00*(1-TX)+V10*TX)*(1-TY) + (V01*(1-TX)+V11*TX)*TY;
        }
    }
    return Dst;
}

// ── Public: Fetch ─────────────────────────────────────────────────────────────
TGeoResult<FGeoDemArtifact> FGeoDemFetcher::Fetch(const FGeoBounds& Bounds,
                                                    const FGeoTerrainDemConfig& Config,
                                                    FGeoRunContext& Context)
{
    if (Config.Source == EGeoTerrainDemSource::LocalGeoTIFF)
        return ClipLocalTiff(Bounds, Config, Context);
    return FetchFromOpenTopography(Bounds, Config, Context);
}

// ── OpenTopography download ───────────────────────────────────────────────────
TGeoResult<FGeoDemArtifact> FGeoDemFetcher::FetchFromOpenTopography(const FGeoBounds& Bounds,
                                                                      const FGeoTerrainDemConfig& Config,
                                                                      FGeoRunContext& Context)
{
    static const TMap<EGeoTerrainDemSource, FString> kDemCodes = {
        { EGeoTerrainDemSource::OpenTopography_SRTM30m, TEXT("SRTMGL1")    },
        { EGeoTerrainDemSource::OpenTopography_SRTM90m, TEXT("SRTMGL3")    },
        { EGeoTerrainDemSource::OpenTopography_AW3D30,  TEXT("AW3D30")     },
        { EGeoTerrainDemSource::OpenTopography_COP30,   TEXT("COP30")      },
        { EGeoTerrainDemSource::OpenTopography_NASADEM, TEXT("NASADEM_HGT")},
        { EGeoTerrainDemSource::OpenTopography_3DEP10m, TEXT("3DEP_10m")   },
    };

    const FString* CodePtr = kDemCodes.Find(Config.Source);
    if (!CodePtr)
        return TGeoResult<FGeoDemArtifact>::Fail(1, TEXT("Unknown DEM source."));

    const FString Url = FString::Printf(
        TEXT("https://portal.opentopography.org/API/globaldem?demtype=%s"
             "&south=%f&north=%f&west=%f&east=%f&outputFormat=GTiff&API_Key=%s"),
        **CodePtr, Bounds.South, Bounds.North, Bounds.West, Bounds.East, *Config.ApiKey);

    // Download raw GeoTIFF
    const FString RawPath = Config.OutputPath + TEXT("_raw.tif");
    Context.ReportProgress(TEXT("Downloading DEM..."), 10);

    if (!DownloadFile(Url, RawPath, Context))
        return TGeoResult<FGeoDemArtifact>::Fail(2, TEXT("DEM download failed."));

    return ConvertToHeightmapTiff(RawPath, Config.OutputPath, Bounds, Config, Context);
}

// ── Clip local GeoTIFF ────────────────────────────────────────────────────────
TGeoResult<FGeoDemArtifact> FGeoDemFetcher::ClipLocalTiff(const FGeoBounds& Bounds,
                                                            const FGeoTerrainDemConfig& Config,
                                                            FGeoRunContext& Context)
{
    if (Config.LocalTiffPath.IsEmpty() || !IFileManager::Get().FileExists(*Config.LocalTiffPath))
        return TGeoResult<FGeoDemArtifact>::Fail(1, TEXT("Local GeoTIFF not found: ") + Config.LocalTiffPath);

    return ConvertToHeightmapTiff(Config.LocalTiffPath, Config.OutputPath, Bounds, Config, Context);
}

// ── Warp to WGS84 Float32 GeoTIFF ────────────────────────────────────────────
TGeoResult<FGeoDemArtifact> FGeoDemFetcher::ConvertToHeightmapTiff(const FString& SrcPath,
                                                                     const FString& DstPath,
                                                                     const FGeoBounds& Bounds,
                                                                     const FGeoTerrainDemConfig& Config,
                                                                     FGeoRunContext& Context)
{
    GDALAllRegister();

    GDALDataset* SrcDs = static_cast<GDALDataset*>(
        GDALOpen(TCHAR_TO_UTF8(*SrcPath), GA_ReadOnly));
    if (!SrcDs)
        return TGeoResult<FGeoDemArtifact>::Fail(3, TEXT("Cannot open source DEM: ") + SrcPath);

    OGRSpatialReference DstSrs;
    DstSrs.importFromEPSG(4326);
    char* DstWkt = nullptr;
    DstSrs.exportToWkt(&DstWkt);

    // Compute output size
    const double DegPerM   = 1.0 / 111320.0;
    const double PixelDeg  = Config.ResolutionM * DegPerM;
    int32 OutW = FMath::Max(1, FMath::CeilToInt(Bounds.Width()  / PixelDeg));
    int32 OutH = FMath::Max(1, FMath::CeilToInt(Bounds.Height() / PixelDeg));

    Context.ReportProgress(FString::Printf(TEXT("Heightmap size: %dx%d"), OutW, OutH), 50);

    GDALDriver* Driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!Driver) { GDALClose(SrcDs); CPLFree(DstWkt); return TGeoResult<FGeoDemArtifact>::Fail(4, TEXT("GTiff driver unavailable.")); }

    char** Opts = nullptr;
    Opts = CSLSetNameValue(Opts, "COMPRESS", "LZW");
    GDALDataset* DstDs = Driver->Create(TCHAR_TO_UTF8(*DstPath), OutW, OutH, 1, GDT_Float32, Opts);
    CSLDestroy(Opts);
    if (!DstDs) { GDALClose(SrcDs); CPLFree(DstWkt); return TGeoResult<FGeoDemArtifact>::Fail(5, TEXT("Cannot create output heightmap.")); }

    double GT[6] = { Bounds.West, PixelDeg, 0.0, Bounds.North, 0.0, -PixelDeg };
    DstDs->SetGeoTransform(GT);
    DstDs->SetProjection(DstWkt);
    DstDs->GetRasterBand(1)->SetNoDataValue(-9999.0);
    CPLFree(DstWkt);

    GDALWarpOptions* WOpts = GDALCreateWarpOptions();
    WOpts->hSrcDS = SrcDs; WOpts->hDstDS = DstDs; WOpts->nBandCount = 1;
    WOpts->panSrcBands = (int*)CPLMalloc(sizeof(int)); WOpts->panSrcBands[0] = 1;
    WOpts->panDstBands = (int*)CPLMalloc(sizeof(int)); WOpts->panDstBands[0] = 1;
    WOpts->eResampleAlg = GRA_Bilinear;
    WOpts->pfnTransformer = GDALGenImgProjTransform;
    WOpts->pTransformerArg = GDALCreateGenImgProjTransformer(
        SrcDs, GDALGetProjectionRef(SrcDs), DstDs, GDALGetProjectionRef(DstDs), 0, 0.0, 1);

    GDALWarpOperation WarpOp;
    CPLErr Err = WarpOp.Initialize(WOpts);
    if (Err == CE_None) WarpOp.ChunkAndWarpImage(0, 0, OutW, OutH);

    GDALDestroyGenImgProjTransformer(WOpts->pTransformerArg);
    GDALDestroyWarpOptions(WOpts);
    GDALClose(DstDs);
    GDALClose(SrcDs);

    if (Err != CE_None)
        return TGeoResult<FGeoDemArtifact>::Fail(6, TEXT("Warp failed."));

    // Export .r16
    const FString RawPath = FPaths::ChangeExtension(DstPath, TEXT("r16"));
    auto RawResult = ExportUnrealRaw(DstPath, RawPath, Context);

    FGeoDemArtifact Art;
    Art.OutputPath    = DstPath;
    Art.UnrealRawPath = RawResult.bSuccess ? RawResult.Value : TEXT("");
    Art.WidthPx  = OutW;
    Art.HeightPx = OutH;
    return TGeoResult<FGeoDemArtifact>::Ok(Art);
}

// ── Export .r16 ───────────────────────────────────────────────────────────────
TGeoResult<FString> FGeoDemFetcher::ExportUnrealRaw(const FString& TifPath,
                                                      const FString& RawPath,
                                                      FGeoRunContext& Context)
{
    GDALDataset* Ds = static_cast<GDALDataset*>(GDALOpen(TCHAR_TO_UTF8(*TifPath), GA_ReadOnly));
    if (!Ds) return TGeoResult<FString>::Fail(1, TEXT("Cannot open TIF for RAW export."));

    const int32 SrcW = Ds->GetRasterXSize();
    const int32 SrcH = Ds->GetRasterYSize();

    TArray<float> Buf;
    Buf.SetNumUninitialized(SrcW * SrcH);
    Ds->GetRasterBand(1)->RasterIO(GF_Read, 0, 0, SrcW, SrcH, Buf.GetData(), SrcW, SrcH, GDT_Float32, 0, 0);
    GDALClose(Ds);

    // Snap to valid UE landscape size
    const int32 UESize = NearestUnrealSize(FMath::Max(SrcW, SrcH));
    TArray<float> Data = (SrcW == UESize && SrcH == UESize) ? Buf : ResampleBilinear(Buf, SrcW, SrcH, UESize, UESize);

    float EMin = 1e38f, EMax = -1e38f;
    for (float V : Data) { if (V <= -9000.f) continue; EMin = FMath::Min(EMin, V); EMax = FMath::Max(EMax, V); }
    if (EMin >= EMax) { EMin = 0.f; EMax = 1.f; }
    const float Range = EMax - EMin;

    TArray<uint16> Raw;
    Raw.SetNumUninitialized(UESize * UESize);
    for (int32 I = 0; I < Data.Num(); ++I)
    {
        float V = Data[I] <= -9000.f ? EMin : Data[I];
        float N = FMath::Clamp((V - EMin) / Range, 0.f, 1.f);
        Raw[I]  = (uint16)(N * 65535.f + 0.5f);
    }

    TUniquePtr<FArchive> Ar(IFileManager::Get().CreateFileWriter(*RawPath));
    if (!Ar) return TGeoResult<FString>::Fail(2, TEXT("Cannot create .r16 file."));
    Ar->Serialize(Raw.GetData(), Raw.Num() * sizeof(uint16));

    Context.ReportProgress(FString::Printf(
        TEXT("Unreal RAW: %dx%d (resampled from %dx%d)"), UESize, UESize, SrcW, SrcH), 95);

    return TGeoResult<FString>::Ok(RawPath);
}

// ── HTTP download (synchronous via event) ─────────────────────────────────────
bool FGeoDemFetcher::DownloadFile(const FString& Url, const FString& DestPath, FGeoRunContext& Context)
{
    // Shared ownership prevents use-after-free when HTTP callback races cancellation
    TSharedPtr<FEventRef, ESPMode::ThreadSafe> DoneRef =
        MakeShared<FEventRef, ESPMode::ThreadSafe>(EEventMode::ManualReset);

    TSharedPtr<bool,          ESPMode::ThreadSafe> bOkPtr   = MakeShared<bool,          ESPMode::ThreadSafe>(false);
    TSharedPtr<TArray<uint8>, ESPMode::ThreadSafe> BytesPtr = MakeShared<TArray<uint8>, ESPMode::ThreadSafe>();

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(Url);
    Req->SetVerb(TEXT("GET"));
    Req->OnProcessRequestComplete().BindLambda(
        [bOkPtr, BytesPtr, DoneRef](FHttpRequestPtr, FHttpResponsePtr Res, bool bSucceeded)
        {
            if (bSucceeded && Res.IsValid() && Res->GetResponseCode() == 200)
            {
                *BytesPtr = Res->GetContent();
                *bOkPtr   = true;
            }
            (*DoneRef)->Trigger();
        });
    Req->ProcessRequest();

    while (!(*DoneRef)->Wait(200))
    {
        if (Context.IsCancelled()) { Req->CancelRequest(); break; }
    }

    if (*bOkPtr && BytesPtr->Num() > 0)
    {
        TUniquePtr<FArchive> Ar(IFileManager::Get().CreateFileWriter(*DestPath));
        if (Ar) { Ar->Serialize(BytesPtr->GetData(), BytesPtr->Num()); return true; }
    }
    return false;
}
