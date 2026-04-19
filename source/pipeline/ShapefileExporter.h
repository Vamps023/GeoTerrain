#pragma once

#include "pipeline/OSMParser.h"
#include "domain/Result.h"
#include "infrastructure/RunContext.h"

#include <string>

struct VectorExportSummary
{
    int total_features = 0;
};

class ShapefileExporter
{
public:
    struct Config
    {
        std::string output_dir;
    };

    Result<VectorExportSummary> exportAll(const OSMParser::ParseResult& osm,
                                         const Config&                 config,
                                         RunContext&                   context);
};
