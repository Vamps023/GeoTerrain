#pragma once

#include "domain/GeoBounds.h"
#include "domain/Result.h"
#include "infrastructure/RunContext.h"

#include <string>

struct DemArtifact
{
    std::string output_path;
};

class DEMFetcher
{
public:
    enum class Source
    {
        OpenTopography_SRTM30m,
        OpenTopography_SRTM90m,
        OpenTopography_AW3D30,
        OpenTopography_COP30,
        OpenTopography_NASADEM,
        OpenTopography_3DEP10m,
        LocalGeoTIFF
    };

    struct Config
    {
        Source source = Source::OpenTopography_SRTM30m;
        std::string api_key;
        std::string local_tiff_path;
        std::string output_path;
        std::string ref_tif_path;
        double resolution_m = 30.0;
        // If > 0, the output heightmap is resampled to exactly
        // target_size x target_size so it shares dimensions with the albedo
        // and slots into a square LandscapeLayerMap tile without stretching.
        int target_size = 0;
    };

    Result<DemArtifact> fetch(const GeoBounds& bounds,
                              const Config&    config,
                              RunContext&      context);

    // Converts a Float32 GeoTIFF heightmap to Unreal 16-bit RAW (.r16)
    // Normalises elevation range to full 0–65535 range.
    Result<std::string> exportUnrealRaw(const std::string& tif_path,
                                        const std::string& raw_path,
                                        RunContext&        context);

private:
    Result<DemArtifact> fetchFromOpenTopography(const GeoBounds& bounds,
                                                const Config&    config,
                                                RunContext&      context);
    Result<DemArtifact> clipLocalTiff(const GeoBounds& bounds,
                                      const Config&    config,
                                      RunContext&      context);
    Result<DemArtifact> convertToHeightmapTiff(const std::string& src_path,
                                               const std::string& dst_path,
                                               const GeoBounds&   bounds,
                                               const Config&      config,
                                               RunContext&        context);
};
