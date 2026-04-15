#pragma once
#include "CoreMinimal.h"
#include "GeoResult.h"
#include "GeoGenerationTypes.h"
#include "GeoRunContext.h"

struct FGeoTileArtifact
{
    FString OutputPath;   // absolute path to albedo.tif
};

class GEOTERRAIN_API FGeoTileDownloader
{
public:
    // Downloads XYZ/TMS tiles for the given bounds and merges into a GeoTIFF
    TGeoResult<FGeoTileArtifact> Download(const FGeoBounds&    Bounds,
                                           const FGeoTileSettings& Config,
                                           FGeoRunContext&      Context);

private:
    // Convert geographic coords to XYZ tile numbers
    static void BoundsToTileRange(const FGeoBounds& B, int32 Zoom,
                                  int32& OutXMin, int32& OutXMax,
                                  int32& OutYMin, int32& OutYMax);

    // Download one PNG tile — uses UE HTTP module (synchronous via event)
    bool DownloadTile(const FString& Url, const FString& DestPath, FGeoRunContext& Context);

    // Merge downloaded tiles into a single GeoTIFF by direct pixel blit
    bool MergeTiles(const TArray<FString>& TilePaths,
                    int32 Zoom, int32 XMin, int32 YMin, int32 XMax, int32 YMax,
                    const FString& OutputPath);
};
