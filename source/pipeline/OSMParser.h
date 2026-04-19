#pragma once

#include "domain/GeoBounds.h"
#include "domain/Result.h"
#include "infrastructure/RunContext.h"

#include <string>
#include <vector>

class OSMParser
{
public:
    struct Way
    {
        enum class Tag { Road, Railway, Building, Vegetation, Water, Unknown };
        Tag tag = Tag::Unknown;
        std::string subtype;
        std::string name;
        std::vector<std::pair<double, double>> nodes;
    };

    struct ParseResult
    {
        std::vector<Way> ways;
        bool success = false;
        std::string error;
    };

    struct Config
    {
        std::string overpass_url = "https://overpass-api.de/api/interpreter";
        long timeout_s = 120;
    };

    Result<ParseResult> fetch(const GeoBounds& bounds,
                              const Config&    config,
                              RunContext&      context);

private:
    Result<ParseResult> parseJson(const std::string& json_str, RunContext& context);

    static Way::Tag classifyTags(const std::string& highway,
                                 const std::string& building,
                                 const std::string& landuse,
                                 const std::string& natural_tag,
                                 const std::string& leisure,
                                 const std::string& railway,
                                 const std::string& waterway,
                                 std::string&       out_subtype);
};
