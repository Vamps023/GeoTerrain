#pragma once
#include "CoreMinimal.h"
#include "GeoGenerationTypes.h"

/**
 * @brief Planner for dividing geographic bounds into chunks based on settings.
 */
class GEOTERRAIN_API FGeoChunkPlanner
{
public:
    // Divide bounds into a grid of chunks based on chunk_size_km.
    // ChunkSizeKm <= 0 means single chunk (no splitting).
    static FGeoChunkPlan Plan(const FGeoBounds&       Bounds,
                               const FGeoChunkSettings& Settings);
};
