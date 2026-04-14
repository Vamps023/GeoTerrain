#pragma once

#include "GeoBounds.h"
#include "OSMParser.h"
#include "domain/Result.h"
#include "infrastructure/RunContext.h"

#include <string>

struct MaskArtifact
{
    std::string output_path;
};

class MaskGenerator
{
public:
    struct Config
    {
        std::string output_path;
        std::string ref_tif_path;
        double resolution_m = 30.0;
        double road_width_m = 10.0;
    };

    Result<MaskArtifact> generate(const GeoBounds&              bounds,
                                  const OSMParser::ParseResult& osm,
                                  const Config&                 config,
                                  RunContext&                   context);

private:
    void rasterizePolygon(std::vector<uint8_t>& buf, int width, int height,
                          const GeoBounds& bounds,
                          const std::vector<std::pair<double, double>>& ring,
                          uint8_t value);
    void rasterizeLine(std::vector<uint8_t>& buf, int width, int height,
                       const GeoBounds& bounds,
                       const std::vector<std::pair<double, double>>& pts,
                       int radius_px, uint8_t value);
    static void latLonToPixel(double lat, double lon,
                              const GeoBounds& bounds,
                              int width, int height,
                              int& px, int& py);
};
