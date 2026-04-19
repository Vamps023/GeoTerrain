#pragma once

#include "domain/GeoBounds.h"
#include "domain/Result.h"
#include "infrastructure/RunContext.h"

#include <string>
#include <vector>

struct RasterArtifact
{
    std::string output_path;
};

class TileDownloader
{
public:
    struct Config
    {
        std::string url_template;
        int zoom_level = 14;
        int target_size = 0;
        std::string output_path;
    };

    Result<RasterArtifact> download(const GeoBounds& bounds,
                                    const Config&    config,
                                    RunContext&      context);

private:
    std::vector<uint8_t> fetchTile(int z, int x, int y, const std::string& url_template);
};
