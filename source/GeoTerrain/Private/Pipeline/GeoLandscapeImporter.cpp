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

    const int64 Size = Ar->TotalSize();
    const int64 NumPixels = Size / sizeof(uint16);

    // Infer square dimension
    int32 Side = FMath::RoundToInt(FMath::Sqrt((double)NumPixels));
    if ((int64)Side * Side != NumPixels) return false;

    OutWidth  = Side;
    OutHeight = Side;
    OutData.SetNumUninitialized(Side * Side);
    Ar->Serialize(OutData.GetData(), Size);
    return !Ar->IsError();
}

TGeoResult<AActor*> FGeoLandscapeImporter::Import(const FImportParams& Params)
{
    if (!GEditor)
        return TGeoResult<AActor*>::Fail(1, TEXT("No GEditor — must be called in Editor context."));

    TArray<uint16> HeightData;
    int32 W = 0, H = 0;

    if (!ReadRawHeightmap(Params.HeightmapR16Path, HeightData, W, H))
        return TGeoResult<AActor*>::Fail(2, TEXT("Failed to read .r16 file: ") + Params.HeightmapR16Path);

    // Ensure valid UE landscape size
    const int32 UESize = NearestUnrealSize(FMath::Max(W, H));
    if (W != UESize || H != UESize)
        return TGeoResult<AActor*>::Fail(3,
            FString::Printf(TEXT(".r16 size %dx%d does not match expected %dx%d. Re-export."), W, H, UESize, UESize));

    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return TGeoResult<AActor*>::Fail(4, TEXT("No editor world available."));

    // Landscape component layout: use 1 component = (UESize-1)/ComponentSize quads
    // Standard: QuadsPerSection=63, SectionsPerComponent=1 -> ComponentSize=63
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

    // Must assign GUID to the actor before calling Import() — UE5.3 asserts it is valid
    const FGuid LandscapeGuid = FGuid::NewGuid();
    Landscape->SetLandscapeGuid(LandscapeGuid);

    // Build import layer info
    TMap<FGuid, TArray<uint16>> HeightmapImportData;
    HeightmapImportData.Add(LandscapeGuid, HeightData);

    // Scale: UE landscape Z scale in cm. 1 unit = 1/128 cm by default.
    // ZScale controls the mapping: full 65536 range = ZScale * 256 cm
    const FVector Scale(
        (Params.Bounds.Width()  * 111320.0 * 100.0) / (UESize - 1),   // cm per pixel X
        (Params.Bounds.Height() * 111320.0 * 100.0) / (UESize - 1),   // cm per pixel Y
        Params.ZScale
    );
    Landscape->SetActorScale3D(Scale);

    // UE5 Import signature: TMap<FGuid,TArray<uint16>> for height data
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

TArray<TGeoResult<AActor*>> FGeoLandscapeImporter::ImportChunks(const FChunkImportParams& Params)
{
    TArray<TGeoResult<AActor*>> Results;

    if (!Params.TotalBounds.IsValid())
    {
        Results.Add(TGeoResult<AActor*>::Fail(10, TEXT("ImportChunks: TotalBounds is invalid.")));
        return Results;
    }

    // Rebuild the same chunk plan the exporter used
    FGeoChunkPlan Plan = FGeoChunkPlanner::Plan(Params.TotalBounds, Params.Chunking);

    // Single-chunk case: just look for heightmap.r16 directly in OutputDir
    if (Plan.Chunks.Num() <= 1)
    {
        FImportParams P;
        P.HeightmapR16Path = FPaths::Combine(Params.OutputDir, TEXT("heightmap.r16"));
        P.Bounds           = Params.TotalBounds;
        P.LandscapeName    = TEXT("GeoTerrain_Landscape");
        P.ZScale           = Params.ZScale;
        P.WorldOffset      = FVector::ZeroVector;
        Results.Add(Import(P));
        return Results;
    }

    // Multi-chunk: the exporter writes chunk_R_C/heightmap.r16
    // World offset: each chunk is placed relative to the SW corner of the total bounds.
    // 1 degree lat/lon ~ 111320 m at equator → convert to UE cm.
    const double CmPerDegLat = 111320.0 * 100.0;
    const double CentreLatRad = FMath::DegreesToRadians((Params.TotalBounds.North + Params.TotalBounds.South) * 0.5);
    const double CmPerDegLon = 111320.0 * 100.0 * FMath::Cos(CentreLatRad);

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
        P.ZScale           = Params.ZScale;
        P.WorldOffset      = FVector((float)OffsetX, (float)OffsetY, 0.f);

        Results.Add(Import(P));
    }

    return Results;
}
