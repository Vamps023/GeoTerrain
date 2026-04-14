#include "OSMParser.h"

#include <json.hpp>

#include <curl/curl.h>

#include <algorithm>
#include <sstream>
#include <unordered_map>

using json = nlohmann::json;

namespace
{
void report(RunContext& context, const std::string& message, int percent)
{
    if (context.progress)
        context.progress(message, percent);
}

Result<OSMParser::ParseResult> cancelledOsm()
{
    return Result<OSMParser::ParseResult>::fail(999, "Cancelled.");
}

size_t curlWriteStr(void* ptr, size_t size, size_t nmemb, void* udata)
{
    auto* s = reinterpret_cast<std::string*>(udata);
    s->append(reinterpret_cast<char*>(ptr), size * nmemb);
    return size * nmemb;
}

std::string httpPost(const std::string& url, const std::string& post_data, long timeout_s, long* http_code_out)
{
    std::string response;
    CURL* c = curl_easy_init();
    if (!c)
        return response;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, post_data.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, static_cast<long>(post_data.size()));
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, curlWriteStr);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, timeout_s);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "GeoTerrainEditorPlugin/1.0");
    curl_easy_perform(c);
    if (http_code_out)
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, http_code_out);
    curl_easy_cleanup(c);
    return response;
}
}

Result<OSMParser::ParseResult> OSMParser::fetch(const GeoBounds& bounds, const Config& config, RunContext& context)
{
    if (context.isCancelled())
        return cancelledOsm();
    if (!bounds.isValid())
        return Result<ParseResult>::fail(1, "Invalid bounding box.");

    const double dLat = bounds.north - bounds.south;
    const double dLon = bounds.east - bounds.west;
    if (dLat > 0.05 || dLon > 0.05)
        report(context, "WARNING: Selected area is large and OSM query may timeout.", 5);

    std::ostringstream query;
    query << "[out:json][timeout:60];\n"
          << "(\n"
          << "  way[\"highway\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"railway\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"building\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"waterway\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"natural\"~\"water|wood|scrub|heath|grassland\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"landuse\"~\"forest|grass|meadow|park|recreation_ground|village_green|reservoir|basin\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"leisure\"~\"park|garden|nature_reserve\"](" << bounds.toOverpassBBox() << ");\n"
          << ");\n"
          << "(._;>;);\n"
          << "out body;";

    CURL* enc = curl_easy_init();
    char* encoded_query = curl_easy_escape(enc, query.str().c_str(), static_cast<int>(query.str().size()));
    const std::string body = std::string("data=") + encoded_query;
    curl_free(encoded_query);
    curl_easy_cleanup(enc);

    const std::vector<std::string> servers = {
        config.overpass_url,
        "https://overpass.kumi.systems/api/interpreter",
        "http://overpass-api.de/api/interpreter",
    };

    long http_code = 0;
    std::string response;
    for (size_t i = 0; i < servers.size(); ++i)
    {
        if (context.isCancelled())
            return cancelledOsm();
        report(context, "Querying Overpass [" + std::to_string(i + 1) + "/" +
            std::to_string(servers.size()) + "]: " + servers[i], 10);
        response = httpPost(servers[i], body, config.timeout_s, &http_code);
        report(context, "Overpass HTTP " + std::to_string(http_code) + " - " +
            std::to_string(response.size() / 1024) + " KB", 30);

        const bool is_html = response.find("<html") != std::string::npos;
        const bool is_error = response.find("\"error\"") != std::string::npos;
        if (!response.empty() && !is_html && !is_error)
            break;
        response.clear();
    }

    if (response.empty())
        return Result<ParseResult>::fail(2, "All Overpass mirrors returned an empty or invalid response.");

    report(context, "Parsing OSM JSON (" + std::to_string(response.size() / 1024) + " KB)...", 50);
    return parseJson(response, context);
}

Result<OSMParser::ParseResult> OSMParser::parseJson(const std::string& json_str, RunContext& context)
{
    ParseResult result;
    result.success = false;

    json doc;
    try
    {
        doc = json::parse(json_str);
    }
    catch (const std::exception& e)
    {
        return Result<ParseResult>::fail(3, std::string("JSON parse error: ") + e.what());
    }

    if (!doc.contains("elements"))
        return Result<ParseResult>::fail(4, "No 'elements' key in Overpass response.");

    const auto& elements = doc["elements"];
    std::unordered_map<long long, std::pair<double, double>> node_map;
    for (const auto& el : elements)
    {
        if (el.value("type", "") == "node")
            node_map[el.value("id", 0LL)] = { el.value("lat", 0.0), el.value("lon", 0.0) };
    }

    for (const auto& el : elements)
    {
        if (context.isCancelled())
            return cancelledOsm();
        if (el.value("type", "") != "way")
            continue;

        const auto& tags = el.value("tags", json::object());
        const std::string highway = tags.value("highway", "");
        const std::string building = tags.value("building", "");
        const std::string landuse = tags.value("landuse", "");
        const std::string natural = tags.value("natural", "");
        const std::string leisure = tags.value("leisure", "");
        const std::string railway = tags.value("railway", "");
        const std::string waterway = tags.value("waterway", "");

        std::string subtype;
        Way::Tag tag = classifyTags(highway, building, landuse, natural, leisure, railway, waterway, subtype);
        if (tag == Way::Tag::Unknown)
            continue;

        Way way;
        way.tag = tag;
        way.subtype = subtype;
        way.name = tags.value("name", "");

        if (el.contains("geometry") && el["geometry"].is_array())
        {
            for (const auto& pt : el["geometry"])
            {
                if (pt.contains("lat") && pt.contains("lon"))
                    way.nodes.push_back({ pt["lat"].get<double>(), pt["lon"].get<double>() });
            }
        }
        else if (el.contains("nodes"))
        {
            for (const auto& nid_json : el["nodes"])
            {
                const long long nid = nid_json.get<long long>();
                auto it = node_map.find(nid);
                if (it != node_map.end())
                    way.nodes.push_back(it->second);
            }
        }

        if (!way.nodes.empty())
            result.ways.push_back(std::move(way));
    }

    report(context, "Parsed " + std::to_string(result.ways.size()) + " OSM ways", 90);
    result.success = true;
    return Result<ParseResult>::ok(result);
}

OSMParser::Way::Tag OSMParser::classifyTags(const std::string& highway, const std::string& building,
                                            const std::string& landuse, const std::string& natural_tag,
                                            const std::string& leisure, const std::string& railway,
                                            const std::string& waterway, std::string& out_subtype)
{
    if (!railway.empty())
    {
        out_subtype = railway;
        return Way::Tag::Railway;
    }
    if (!highway.empty())
    {
        out_subtype = highway;
        return Way::Tag::Road;
    }
    if (!building.empty())
    {
        out_subtype = building;
        return Way::Tag::Building;
    }
    if (!waterway.empty() || natural_tag == "water" || landuse == "reservoir" || landuse == "basin")
    {
        out_subtype = !waterway.empty() ? waterway : (!natural_tag.empty() ? natural_tag : landuse);
        return Way::Tag::Water;
    }
    if (!landuse.empty() || !natural_tag.empty() || !leisure.empty())
    {
        out_subtype = !landuse.empty() ? landuse : (!natural_tag.empty() ? natural_tag : leisure);
        return Way::Tag::Vegetation;
    }
    return Way::Tag::Unknown;
}
