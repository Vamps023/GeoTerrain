#pragma once

#include "GeoBounds.h"

#include <functional>
#include <string>
#include <vector>

// Downloads OSM vector data via Overpass API and converts it into
// raw in-memory geometry lists ready for rasterization.
class OSMParser
{
public:
    struct Way
    {
        enum class Tag { Road, Railway, Building, Vegetation, Water, Unknown };
        Tag         tag      = Tag::Unknown;
        std::string subtype;   // e.g. "residential", "rail", "yes", "forest"
        std::string name;      // OSM name tag if present
        std::vector<std::pair<double, double>> nodes; // (lat, lon) pairs
    };

    struct ParseResult
    {
        std::vector<Way> ways;
        bool             success = false;
        std::string      error;
    };

    struct Config
    {
        std::string overpass_url = "https://overpass-api.de/api/interpreter";
        long        timeout_s    = 120;
    };

    using ProgressCallback = std::function<void(const std::string& message, int percent)>;

    // Synchronous fetch + parse — call from worker thread.
    ParseResult fetch(const GeoBounds& bounds,
                      const Config&    config,
                      ProgressCallback progress_cb);

private:
    ParseResult parseJson(const std::string& json_str,
                           ProgressCallback   progress_cb);

    static Way::Tag classifyTags(const std::string& highway,
                                  const std::string& building,
                                  const std::string& landuse,
                                  const std::string& natural_tag,
                                  const std::string& leisure,
                                  const std::string& railway,
                                  const std::string& waterway,
                                  std::string&       out_subtype);
};
