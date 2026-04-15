#pragma once
#include "CoreMinimal.h"
#include "GeoResult.h"
#include "GeoGenerationTypes.h"
#include "GeoRunContext.h"

struct FGeoMaskArtifact
{
    FString MaskPath;    // mask.tif  (RGBA: road / building / vegetation / water)
};

struct FGeoMaskConfig
{
    FString OutputPath;
    FString RefTifPath;    // reference raster for size matching
    double  ResolutionM = 30.0;
    double  RoadWidthM  = 10.0;
};

class GEOTERRAIN_API FGeoMaskGenerator
{
public:
    TGeoResult<FGeoMaskArtifact> Generate(const FGeoBounds&    Bounds,
                                           const FGeoMaskConfig& Config,
                                           const FString&        OsmDataPath,
                                           FGeoRunContext&       Context);
};
