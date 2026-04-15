#include "GeoLandscapeImporter.h"

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
