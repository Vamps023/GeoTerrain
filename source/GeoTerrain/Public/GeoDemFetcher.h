#pragma once
#include "CoreMinimal.h"
#include "GeoResult.h"
#include "GeoGenerationTypes.h"
#include "GeoRunContext.h"

struct FGeoDemArtifact
{
    FString OutputPath;      // absolute path to heightmap.tif
    FString UnrealRawPath;   // absolute path to heightmap.r16 (auto-generated)
    int32   WidthPx  = 0;
    int32   HeightPx = 0;
    double  ElevMin  = 0.0;
    double  ElevMax  = 0.0;
};

class GEOTERRAIN_API FGeoDemFetcher
{
public:
    // Download / clip DEM, warp to WGS84 Float32 GeoTIFF, then export .r16
    TGeoResult<FGeoDemArtifact> Fetch(const FGeoBounds&          Bounds,
                                      const FGeoTerrainDemConfig& Config,
                                      FGeoRunContext&             Context);

private:
    TGeoResult<FGeoDemArtifact> FetchFromOpenTopography(const FGeoBounds&          Bounds,
                                                         const FGeoTerrainDemConfig& Config,
                                                         FGeoRunContext&             Context);

    TGeoResult<FGeoDemArtifact> ClipLocalTiff(const FGeoBounds&          Bounds,
                                               const FGeoTerrainDemConfig& Config,
                                               FGeoRunContext&             Context);

    TGeoResult<FGeoDemArtifact> ConvertToHeightmapTiff(const FString&             SrcPath,
                                                        const FString&             DstPath,
                                                        const FGeoBounds&          Bounds,
                                                        const FGeoTerrainDemConfig& Config,
                                                        FGeoRunContext&             Context);

    // Export Float32 GeoTIFF → Unreal 16-bit RAW, auto-snapped to valid UE landscape size
    TGeoResult<FString>         ExportUnrealRaw(const FString& TifPath,
                                                 const FString& RawPath,
                                                 FGeoRunContext& Context);

    // HTTP download helper (uses UE IHttpRequest)
    bool DownloadFile(const FString& Url, const FString& DestPath, FGeoRunContext& Context);
};
