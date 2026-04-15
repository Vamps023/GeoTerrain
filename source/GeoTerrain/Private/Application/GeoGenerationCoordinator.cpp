#include "GeoGenerationCoordinator.h"
#include "GeoChunkPlanner.h"
#include "GeoDemFetcher.h"
#include "GeoTileDownloader.h"
#include "GeoMaskGenerator.h"

#include "Async/Async.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"

void FGeoGenerationCoordinator::Run(const FGeoGenerationRequest& Request)
{
    if (bRunning) return;
    bRunning         = true;
    bCancelRequested = false;
    LastDemR16Path.Empty();
    LastAlbedoPath.Empty();

    // Capture shared ptr so coordinator stays alive during async work
    TSharedRef<FGeoGenerationCoordinator> Self = AsShared();

    AsyncTask(ENamedThreads::AnyBackgroundThreadNormalTask, [Self, Request]()
    {
        Self->RunInternal(Request);
    });
}

void FGeoGenerationCoordinator::Cancel()
{
    bCancelRequested = true;
}

void FGeoGenerationCoordinator::RunInternal(FGeoGenerationRequest Request)
{
    auto Log = [this](const FString& Msg, bool bError = false)
    {
        AsyncTask(ENamedThreads::GameThread, [this, Msg, bError]{
            OnLogMessage.Broadcast(Msg, bError);
        });
    };

    auto ReportProgress = [this](int32 Pct)
    {
        AsyncTask(ENamedThreads::GameThread, [this, Pct]{
            OnProgress.Broadcast(Pct);
        });
    };

    auto Finish = [this](EGeoJobStatus Status, const FString& Msg)
    {
        bRunning = false;
        AsyncTask(ENamedThreads::GameThread, [this, Status, Msg]{
            OnFinished.Broadcast(Status, Msg);
        });
    };

    // ── Build run context ─────────────────────────────────────────────────────
    FGeoRunContext Context;
    Context.CancelFlag = &bCancelRequested;
    Context.OnProgress = [&Log](const FString& Msg, int32 Pct){ Log(Msg); };
    Context.OnWarning  = [&Log](const FString& Msg){ Log(FString(TEXT("[WARN] ")) + Msg); };

    // ── Plan chunks ───────────────────────────────────────────────────────────
    FGeoChunkPlan Plan = FGeoChunkPlanner::Plan(Request.Bounds, Request.Chunking);
    Log(FString::Printf(TEXT("[Plan] %d chunk(s) planned (%d enabled)"),
        Plan.Chunks.Num(), Plan.EnabledChunks.Num()));

    int32 Failures = 0;
    int32 Total    = Plan.EnabledChunks.Num();

    for (int32 Idx = 0; Idx < Total; ++Idx)
    {
        if (Context.IsCancelled())
        {
            Finish(EGeoJobStatus::Cancelled, TEXT("Cancelled."));
            return;
        }

        const FGeoChunkDefinition& Chunk = Plan.EnabledChunks[Idx];
        // For single-chunk ('.'), use the output dir directly to avoid path weirdness
        const FString OutputDir = (Chunk.DirectoryName == TEXT(".") || Chunk.DirectoryName.IsEmpty())
            ? Request.Output.OutputDir
            : FPaths::Combine(Request.Output.OutputDir, Chunk.DirectoryName);
        IFileManager::Get().MakeDirectory(*OutputDir, true);

        Log(FString::Printf(TEXT("[Chunk %d/%d] %s"), Idx + 1, Total, *OutputDir));
        ReportProgress(FMath::RoundToInt(100.0f * Idx / Total));

        // ── Tile download ─────────────────────────────────────────────
        FGeoTileSettings TileCfg = Request.Sources.Tiles;
        TileCfg.OutputPath       = FPaths::Combine(OutputDir, TEXT("albedo.tif"));

        FGeoTileDownloader TileDL;
        auto TileResult = TileDL.Download(Chunk.Bounds, TileCfg, Context);
        if (!TileResult.bSuccess)
        {
            Log(FString::Printf(TEXT("[FAIL] Tile download: %s"), *TileResult.Message), true);
            ++Failures;
            continue;
        }
        Log(FString::Printf(TEXT("[OK] Albedo: %s"), *TileResult.Value.OutputPath));

        // ── DEM fetch + .r16 export ───────────────────────────────────────────
        FGeoTerrainDemConfig DemCfg  = Request.Sources.Dem;
        DemCfg.OutputPath            = FPaths::Combine(OutputDir, TEXT("heightmap.tif"));

        FGeoDemFetcher DemFetcher;
        auto DemResult = DemFetcher.Fetch(Chunk.Bounds, DemCfg, Context);
        if (!DemResult.bSuccess)
        {
            Log(FString::Printf(TEXT("[FAIL] DEM: %s"), *DemResult.Message), true);
            ++Failures;
            continue;
        }
        Log(FString::Printf(TEXT("[OK] Heightmap TIF: %s"), *DemResult.Value.OutputPath));
        Log(FString::Printf(TEXT("[OK] Heightmap R16: %s"), *DemResult.Value.UnrealRawPath));
        Log(FString::Printf(TEXT("[OK] Elevation range: %.1f m – %.1f m"),
            DemResult.Value.ElevMin, DemResult.Value.ElevMax));

        // Save last artifact paths for Import Landscape
        LastDemR16Path = DemResult.Value.UnrealRawPath;
        LastAlbedoPath = TileResult.Value.OutputPath;

        // ── Mask generation ───────────────────────────────────────────────────
        FGeoMaskConfig MaskCfg;
        MaskCfg.OutputPath  = FPaths::Combine(OutputDir, TEXT("mask.tif"));
        MaskCfg.RefTifPath  = TileResult.Value.OutputPath;
        MaskCfg.ResolutionM = Request.Mask.ResolutionM;
        MaskCfg.RoadWidthM  = Request.Mask.RoadWidthM;

        FGeoMaskGenerator MaskGen;
        auto MaskResult = MaskGen.Generate(Chunk.Bounds, MaskCfg, TEXT(""), Context);
        if (!MaskResult.bSuccess)
            Log(FString::Printf(TEXT("[WARN] Mask: %s"), *MaskResult.Message));
        else
            Log(FString::Printf(TEXT("[OK] Mask: %s"), *MaskResult.Value.MaskPath));
    }

    ReportProgress(100);

    if (Failures == 0)
        Finish(EGeoJobStatus::Succeeded, FString::Printf(TEXT("[Done] All %d chunk(s) succeeded."), Total));
    else if (Failures < Total)
        Finish(EGeoJobStatus::PartiallySucceeded, FString::Printf(TEXT("[Done] %d/%d chunk(s) failed."), Failures, Total));
    else
        Finish(EGeoJobStatus::Failed, TEXT("[Done] All chunks failed."));
}
