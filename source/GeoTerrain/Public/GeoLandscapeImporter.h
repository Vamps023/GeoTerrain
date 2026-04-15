#pragma once
#include "CoreMinimal.h"
#include "GeoResult.h"
#include "GeoGenerationTypes.h"

// Replaces SandwormExporter — imports generated .r16 + albedo.tif directly
// into a UE Landscape actor in the current world.
class GEOTERRAIN_API FGeoLandscapeImporter
{
public:
    struct FImportParams
    {
        FString         HeightmapR16Path;   // heightmap.r16
        FString         AlbedoTifPath;      // albedo.tif  (optional)
        FGeoBounds      Bounds;
        FString         LandscapeName      = TEXT("GeoTerrain_Landscape");
        // Z scale: Unreal units per 65536 height steps.
        // Set to (elev_max - elev_min) * 100 / 512  (cm / UE default)
        float           ZScale             = 100.0f;
        FVector         WorldOffset        = FVector::ZeroVector;
    };

    // Must be called on game thread. Spawns ALandscape in the current editor world.
    TGeoResult<AActor*> Import(const FImportParams& Params);

private:
    // Snap file size to valid UE landscape dimension (127, 253, 505, 1009, 2017, 4033, 8129)
    static int32 NearestUnrealSize(int32 N);

    // Read .r16 into TArray<uint16>
    static bool ReadRawHeightmap(const FString& Path, TArray<uint16>& OutData,
                                  int32& OutWidth, int32& OutHeight);
};
