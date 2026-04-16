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

        /**
         * Elevation range from the DEM (metres).
         * When ElevMax > ElevMin the ZScale is computed automatically using
         * the UE "Fit to Data" formula:
         *   ZScale = (ElevMax - ElevMin) * 100.0 / 512.0
         * Set both to 0 to use the fallback constant ZScaleFallback.
         */
        double          ElevMin            = 0.0;
        double          ElevMax            = 0.0;

        /** Used when ElevMin == ElevMax (flat terrain or unknown range). */
        float           ZScaleFallback     = 100.0f;

        FVector         WorldOffset        = FVector::ZeroVector;

        /** Compute the ZScale that will be passed to ALandscape::SetActorScale3D. */
        float ComputedZScale() const
        {
            const double Range = ElevMax - ElevMin;
            return (Range > 0.01)
                ? (float)(Range * 100.0 / 512.0)
                : ZScaleFallback;
        }
    };

    struct FChunkImportParams
    {
        FString           OutputDir;        // root output dir (contains chunk_R_C/ subdirs)
        FGeoBounds        TotalBounds;      // full selected area
        FGeoChunkSettings Chunking;         // same settings used during export
        /**
         * ZScale fallback — overridden per chunk when a GeoTerrain_meta.json
         * sidecar is found next to the heightmap.r16.
         */
        float             ZScaleFallback = 100.0f;
    };

    // Must be called on game thread. Spawns ALandscape in the current editor world.
    TGeoResult<AActor*> Import(const FImportParams& Params);

    // Import all chunk_R_C/heightmap.r16 files found under OutputDir.
    // Each chunk gets its own ALandscape actor placed at the correct world offset.
    TArray<TGeoResult<AActor*>> ImportChunks(const FChunkImportParams& Params);

    /**
     * Write a GeoTerrain_meta.json sidecar next to R16Path recording the
     * DEM elevation range. Call this from the exporter after each .r16 is
     * written so the importer can recover the correct "Fit to Data" ZScale.
     */
    static void WriteChunkMeta(const FString& R16Path, double ElevMin, double ElevMax);


private:
    // Snap file size to valid UE landscape dimension (127, 253, 505, 1009, 2017, 4033, 8129)
    static int32 NearestUnrealSize(int32 N);

    // Read .r16 into TArray<uint16>
    static bool ReadRawHeightmap(const FString& Path, TArray<uint16>& OutData,
                                  int32& OutWidth, int32& OutHeight);
};
