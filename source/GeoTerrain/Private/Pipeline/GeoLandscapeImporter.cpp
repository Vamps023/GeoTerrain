#include "GeoLandscapeImporter.h"
#include "GeoChunkPlanner.h"

#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeInfo.h"
#include "LandscapeDataAccess.h"
#include "Editor.h"
#include "EditorModeManager.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Dom/JsonObject.h"

// ─────────────────────────────────────────────────────────────────────────────
//  Sidecar metadata helpers
//  We write a tiny "GeoTerrain_meta.json" next to every heightmap.r16 during
//  export so the importer can recover ElevMin / ElevMax without user input.
// ─────────────────────────────────────────────────────────────────────────────

/** Path of the sidecar written beside a .r16 file. */
static FString MetaPath(const FString& R16Path)
{
    return FPaths::Combine(FPaths::GetPath(R16Path), TEXT("GeoTerrain_meta.json"));
}

/**
 * Write a JSON sidecar with the DEM elevation statistics for a chunk.
 * Call this from the exporter immediately after ExportUnrealRaw() succeeds.
 */
void FGeoLandscapeImporter::WriteChunkMeta(const FString& R16Path,
                                             double ElevMin, double ElevMax)
{
    TSharedPtr<FJsonObject> J = MakeShared<FJsonObject>();
    J->SetNumberField(TEXT("elev_min_m"), ElevMin);
    J->SetNumberField(TEXT("elev_max_m"), ElevMax);

    FString Out;
    TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(J.ToSharedRef(), W);
    FFileHelper::SaveStringToFile(Out, *MetaPath(R16Path));
}

/** Read ElevMin / ElevMax back from the sidecar. Returns false if missing. */
static bool ReadChunkMeta(const FString& R16Path, double& OutMin, double& OutMax)
{
    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *MetaPath(R16Path))) return false;

    TSharedPtr<FJsonObject> J;
    TSharedRef<TJsonReader<>> R = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(R, J) || !J.IsValid()) return false;

    OutMin = J->GetNumberField(TEXT("elev_min_m"));
    OutMax = J->GetNumberField(TEXT("elev_max_m"));
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────

int32 FGeoLandscapeImporter::NearestUnrealSize(int32 N)
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

bool FGeoLandscapeImporter::ReadRawHeightmap(const FString& Path,
                                               TArray<uint16>& OutData,
                                               int32& OutWidth, int32& OutHeight)
{
    TUniquePtr<FArchive> Ar(IFileManager::Get().CreateFileReader(*Path));
    if (!Ar) return false;

    const int64 Size      = Ar->TotalSize();
    const int64 NumPixels = Size / sizeof(uint16);

    // Infer square dimension
    int32 Side = FMath::RoundToInt(FMath::Sqrt((double)NumPixels));
    // Accept if within 1 pixel (floating-point safety)
    if (FMath::Abs((int64)Side * Side - NumPixels) > 1) return false;

    OutWidth  = Side;
    OutHeight = Side;
    OutData.SetNumUninitialized(Side * Side);
    Ar->Serialize(OutData.GetData(), Size);
    return !Ar->IsError();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Core single-landscape importer
//  This is the UE equivalent of pressing "Import" → "Fit to Data" in the
//  New Landscape panel: it reads the .r16, computes the proper scale from the
//  elevation range, and spawns the ALandscape in the current editor world.
// ─────────────────────────────────────────────────────────────────────────────
TGeoResult<AActor*> FGeoLandscapeImporter::Import(const FImportParams& Params)
{
    if (!GEditor)
        return TGeoResult<AActor*>::Fail(1, TEXT("No GEditor — must be called in Editor context."));

    TArray<uint16> HeightData;
    int32 W = 0, H = 0;

    if (!ReadRawHeightmap(Params.HeightmapR16Path, HeightData, W, H))
        return TGeoResult<AActor*>::Fail(2, TEXT("Failed to read .r16 file: ") + Params.HeightmapR16Path);

    // Snap to a valid UE landscape size (the exporter already does this;
    // we round again here to be tolerant of files written by other tools).
    const int32 UESize = NearestUnrealSize(FMath::Max(W, H));

    // If file size doesn't match, resample in-place (bilinear) so we can still import.
    if (W != UESize || H != UESize)
    {
        // Simple nearest-neighbour rescale for the uint16 heightmap
        TArray<uint16> Resampled;
        Resampled.SetNumUninitialized(UESize * UESize);
        for (int32 DY = 0; DY < UESize; ++DY)
        {
            int32 SY = FMath::Clamp(FMath::RoundToInt((float)DY / UESize * H), 0, H - 1);
            for (int32 DX = 0; DX < UESize; ++DX)
            {
                int32 SX = FMath::Clamp(FMath::RoundToInt((float)DX / UESize * W), 0, W - 1);
                Resampled[DY * UESize + DX] = HeightData[SY * W + SX];
            }
        }
        HeightData = MoveTemp(Resampled);
        W = H = UESize;
    }

    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return TGeoResult<AActor*>::Fail(4, TEXT("No editor world available."));

    // ── Component layout ──────────────────────────────────────────────────────
    // Standard: QuadsPerSection=63, SectionsPerComponent=1 → ComponentSize=63
    const int32 QuadsPerSection      = 63;
    const int32 SectionsPerComponent = 1;
    const int32 ComponentSize        = QuadsPerSection * SectionsPerComponent;
    const int32 NumComponents        = (UESize - 1) / ComponentSize;

    FActorSpawnParameters SpawnParams;
    SpawnParams.Name = FName(*Params.LandscapeName);

    ALandscape* Landscape = World->SpawnActor<ALandscape>(
        ALandscape::StaticClass(),
        Params.WorldOffset,
        FRotator::ZeroRotator,
        SpawnParams);

    if (!Landscape)
        return TGeoResult<AActor*>::Fail(5, TEXT("Failed to spawn ALandscape actor."));

    Landscape->SetActorLabel(Params.LandscapeName);

    // Generate a new GUID for the landscape. We pass this to Import() which
    // handles registering the GUID internally. Do not call SetLandscapeGuid()
    // directly here because it triggers a crash/assertion in UE5.3.
    const FGuid LandscapeGuid = FGuid::NewGuid();

    // ── Height data map ───────────────────────────────────────────────────────
    TMap<FGuid, TArray<uint16>> HeightmapImportData;
    HeightmapImportData.Add(LandscapeGuid, HeightData);

    // ── "Fit to Data" scale ───────────────────────────────────────────────────
    // XY: convert geographic degrees → cm.
    // Z:  UE Landscape ZScale controls the full 65536-step height range.
    //     Formula matches the UE editor "Fit to Data" button:
    //       PixelHeightCm = ZScale * 256 / 100   (for UE's internal Z convention)
    //     So:  ZScale = ElevRangeM * 100.0 / 512.0
    const float ZScale = Params.ComputedZScale();

    const FVector Scale(
        (Params.Bounds.Width()  * 111320.0 * 100.0) / (UESize - 1),  // cm/pixel X
        (Params.Bounds.Height() * 111320.0 * 100.0) / (UESize - 1),  // cm/pixel Y
        ZScale
    );
    Landscape->SetActorScale3D(Scale);

    // ── Layer map ─────────────────────────────────────────────────────────────
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> LayerInfoMap;
    LayerInfoMap.Add(LandscapeGuid, TArray<FLandscapeImportLayerInfo>());

    Landscape->Import(
        LandscapeGuid,
        0, 0,                             // offset X/Y in quads
        UESize - 1, UESize - 1,           // total quads X/Y
        SectionsPerComponent,
        QuadsPerSection,
        HeightmapImportData,
        nullptr,                          // heightmap file path hint
        LayerInfoMap,
        ELandscapeImportAlphamapType::Additive);

    Landscape->StaticLightingResolution = 1.0f;
    Landscape->MarkPackageDirty();

    return TGeoResult<AActor*>::Ok(Landscape);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-chunk import
//  Each chunk gets its own ALandscape placed at the correct world offset.
//  ElevMin/ElevMax are read from the per-chunk GeoTerrain_meta.json sidecar
//  written by the exporter so the ZScale is computed correctly for each chunk.
// ─────────────────────────────────────────────────────────────────────────────
TArray<TGeoResult<AActor*>> FGeoLandscapeImporter::ImportChunks(const FChunkImportParams& Params)
{
    TArray<TGeoResult<AActor*>> Results;

    if (!Params.TotalBounds.IsValid())
    {
        Results.Add(TGeoResult<AActor*>::Fail(10, TEXT("ImportChunks: TotalBounds is invalid.")));
        return Results;
    }

    // Rebuild the exact same chunk plan the exporter used
    FGeoChunkPlan Plan = FGeoChunkPlanner::Plan(Params.TotalBounds, Params.Chunking);

    // ── Single-chunk case ────────────────────────────────────────────────────
    if (Plan.Chunks.Num() <= 1)
    {
        FString R16Path = FPaths::Combine(Params.OutputDir, TEXT("heightmap.r16"));

        FImportParams P;
        P.HeightmapR16Path = R16Path;
        P.Bounds           = Params.TotalBounds;
        P.LandscapeName    = TEXT("GeoTerrain_Landscape");
        P.WorldOffset      = FVector::ZeroVector;
        P.ZScaleFallback   = Params.ZScaleFallback;

        // Try to recover elevation range from sidecar
        double EMin = 0.0, EMax = 0.0;
        if (ReadChunkMeta(R16Path, EMin, EMax))
        {
            P.ElevMin = EMin;
            P.ElevMax = EMax;
        }

        Results.Add(Import(P));
        return Results;
    }

    // ── Multi-chunk: each chunk gets a separate ALandscape ───────────────────
    // 1 degree lat/lon ≈ 111 320 m at equator → convert to UE cm
    const double CmPerDegLat  = 111320.0 * 100.0;
    const double CentreLatRad = FMath::DegreesToRadians(
        (Params.TotalBounds.North + Params.TotalBounds.South) * 0.5);
    const double CmPerDegLon  = 111320.0 * 100.0 * FMath::Cos(CentreLatRad);

    for (const FGeoChunkDefinition& Chunk : Plan.Chunks)
    {
        // Path: OutputDir/chunk_R_C/heightmap.r16
        FString ChunkDir;
        if (Chunk.DirectoryName == TEXT(".") || Chunk.DirectoryName.IsEmpty())
            ChunkDir = Params.OutputDir;
        else
            ChunkDir = FPaths::Combine(Params.OutputDir, Chunk.DirectoryName);

        FString R16Path = FPaths::Combine(ChunkDir, TEXT("heightmap.r16"));
        if (!IFileManager::Get().FileExists(*R16Path))
        {
            Results.Add(TGeoResult<AActor*>::Fail(11,
                FString::Printf(TEXT("Missing: %s"), *R16Path)));
            continue;
        }

        // World offset in cm from the SW corner of the total bounds
        double OffsetX = (Chunk.Bounds.West  - Params.TotalBounds.West)  * CmPerDegLon;
        double OffsetY = (Chunk.Bounds.South - Params.TotalBounds.South) * CmPerDegLat;

        FImportParams P;
        P.HeightmapR16Path = R16Path;
        P.Bounds           = Chunk.Bounds;
        P.LandscapeName    = FString::Printf(TEXT("GeoTerrain_%s"), *Chunk.DirectoryName);
        P.ZScaleFallback   = Params.ZScaleFallback;
        P.WorldOffset      = FVector((float)OffsetX, (float)OffsetY, 0.f);

        // Recover per-chunk elevation range from sidecar → "Fit to Data" ZScale
        double EMin = 0.0, EMax = 0.0;
        if (ReadChunkMeta(R16Path, EMin, EMax))
        {
            P.ElevMin = EMin;
            P.ElevMax = EMax;
        }

        Results.Add(Import(P));
    }

    return Results;
}
