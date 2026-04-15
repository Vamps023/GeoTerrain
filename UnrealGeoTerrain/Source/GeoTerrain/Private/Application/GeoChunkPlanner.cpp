#include "GeoChunkPlanner.h"
#include "Math/UnrealMathUtility.h"

FGeoChunkPlan FGeoChunkPlanner::Plan(const FGeoBounds& Bounds, const FGeoChunkSettings& Settings)
{
    FGeoChunkPlan Plan;

    if (!Bounds.IsValid())
        return Plan;

    if (Settings.ChunkSizeKm < 1.0)
    {
        // Single chunk
        FGeoChunkDefinition Chunk;
        Chunk.Index         = 0;
        Chunk.Row           = 0;
        Chunk.Column        = 0;
        Chunk.Bounds        = Bounds;
        Chunk.DirectoryName = TEXT(".");
        Plan.Rows    = 1;
        Plan.Columns = 1;
        Plan.Chunks.Add(Chunk);
        Plan.EnabledChunks.Add(Chunk);
        return Plan;
    }

    const double CentreLatRad   = FMath::DegreesToRadians((Bounds.North + Bounds.South) * 0.5);
    const double DegPerKmLat    = 1.0 / 111.0;
    const double DegPerKmLon    = 1.0 / (111.0 * FMath::Cos(CentreLatRad));
    const double ChunkLatDeg    = Settings.ChunkSizeKm * DegPerKmLat;
    const double ChunkLonDeg    = Settings.ChunkSizeKm * DegPerKmLon;

    Plan.Rows    = FMath::Max(1, FMath::CeilToInt(Bounds.Height() / ChunkLatDeg));
    Plan.Columns = FMath::Max(1, FMath::CeilToInt(Bounds.Width()  / ChunkLonDeg));

    for (int32 R = 0; R < Plan.Rows; ++R)
    {
        for (int32 C = 0; C < Plan.Columns; ++C)
        {
            FGeoChunkDefinition Chunk;
            Chunk.Index         = Plan.Chunks.Num();
            Chunk.Row           = R;
            Chunk.Column        = C;
            Chunk.Bounds.South  = Bounds.South + R * ChunkLatDeg;
            Chunk.Bounds.North  = FMath::Min(Bounds.North, Chunk.Bounds.South + ChunkLatDeg);
            Chunk.Bounds.West   = Bounds.West  + C * ChunkLonDeg;
            Chunk.Bounds.East   = FMath::Min(Bounds.East,  Chunk.Bounds.West  + ChunkLonDeg);
            Chunk.DirectoryName = FString::Printf(TEXT("chunk_%d_%d"), R, C);
            Plan.Chunks.Add(Chunk);
        }
    }

    const TArray<bool>& Mask = Settings.EnabledMask;
    for (int32 I = 0; I < Plan.Chunks.Num(); ++I)
    {
        const bool bEnabled = (Mask.Num() == Plan.Chunks.Num()) ? Mask[I] : true;
        if (bEnabled)
            Plan.EnabledChunks.Add(Plan.Chunks[I]);
        else
            ++Plan.SkippedChunks;
    }

    return Plan;
}
