#pragma once

#include "GeoBounds.h"
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
    };

    Result<DemArtifact> fetch(const GeoBounds& bounds,
                              const Config&    config,
                              RunContext&      context);

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
