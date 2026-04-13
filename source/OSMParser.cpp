#include "OSMParser.h"

#include <json.hpp>

#include <curl/curl.h>

#include <sstream>
#include <vector>
#include <unordered_map>

using json = nlohmann::json;

// ---------------------------------------------------------------------------
static size_t curlWriteStr(void* ptr, size_t size, size_t nmemb, void* udata)
{
    auto* s = reinterpret_cast<std::string*>(udata);
    s->append(reinterpret_cast<char*>(ptr), size * nmemb);
    return size * nmemb;
}

static std::string httpPost(const std::string& url,
                             const std::string& post_data,
                             long               timeout_s = 120,
                             long*              http_code_out = nullptr)
{
    std::string response;
    CURL* c = curl_easy_init();
    if (!c) return response;

    curl_easy_setopt(c, CURLOPT_URL,            url.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDS,     post_data.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE,  (long)post_data.size());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION,  curlWriteStr);
    curl_easy_setopt(c, CURLOPT_WRITEDATA,      &response);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT,        timeout_s);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(c, CURLOPT_USERAGENT,      "GeoTerrainEditorPlugin/1.0");
    curl_easy_perform(c);
    if (http_code_out)
        curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, http_code_out);
    curl_easy_cleanup(c);
    return response;
}

// ---------------------------------------------------------------------------
OSMParser::ParseResult OSMParser::fetch(const GeoBounds& bounds,
                                         const Config&    config,
                                         ProgressCallback progress_cb)
{
    if (!bounds.isValid())
    {
        ParseResult res;
        res.error   = "Invalid bounding box";
        return res;
    }

    if (progress_cb) progress_cb("Building Overpass query...", 5);

    // Overpass QL query — fetch all ways with highway/building/landuse tags
    std::ostringstream query;
    query << "[out:json][timeout:" << config.timeout_s << "];\n"
          << "(\n"
          << "  way[\"highway\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"building\"](" << bounds.toOverpassBBox() << ");\n"
          << "  way[\"landuse\"~\"forest|grass|meadow|park|recreation_ground|village_green\"]("
                                    << bounds.toOverpassBBox() << ");\n"
          << "  way[\"natural\"~\"wood|scrub|heath|grassland\"]("
                                    << bounds.toOverpassBBox() << ");\n"
          << "  way[\"leisure\"~\"park|garden|nature_reserve\"]("
                                    << bounds.toOverpassBBox() << ");\n"
          << ");\n"
          << "(._;>;);\n"
          << "out body;";

    if (progress_cb) progress_cb("Querying Overpass API...", 10);

    // URL-encode the query string for the POST body
    CURL* enc = curl_easy_init();
    char* encoded_query = curl_easy_escape(enc, query.str().c_str(),
                                           (int)query.str().size());
    const std::string body = std::string("data=") + encoded_query;
    curl_free(encoded_query);
    curl_easy_cleanup(enc);

    long http_code = 0;
    const std::string response = httpPost(config.overpass_url, body,
                                          config.timeout_s, &http_code);

    if (progress_cb)
        progress_cb("Overpass HTTP " + std::to_string(http_code) +
                    " — " + std::to_string(response.size() / 1024) + " KB", 30);

    if (response.empty())
    {
        ParseResult res;
        res.error = "Empty response from Overpass API (HTTP " +
                    std::to_string(http_code) + ")";
        return res;
    }

    // Check for Overpass error response
    if (response.find("\"error\"") != std::string::npos ||
        response.find("<html") != std::string::npos)
    {
        ParseResult res;
        res.error = "Overpass error: " +
                    response.substr(0, std::min(response.size(), (size_t)300));
        return res;
    }

    if (progress_cb) progress_cb("Parsing OSM JSON (" + std::to_string(response.size() / 1024) + " KB)...", 50);
    return parseJson(response, progress_cb);
}

// ---------------------------------------------------------------------------
OSMParser::ParseResult OSMParser::parseJson(const std::string& json_str,
                                             ProgressCallback   progress_cb)
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
        result.error = std::string("JSON parse error: ") + e.what();
        return result;
    }

    if (!doc.contains("elements"))
    {
        result.error = "No 'elements' key in Overpass response";
        return result;
    }

    // Build node id -> (lat,lon) lookup
    std::unordered_map<long long, std::pair<double,double>> node_map;
    const auto& elements = doc["elements"];

    for (const auto& el : elements)
    {
        const std::string type = el.value("type", "");
        if (type == "node")
        {
            const long long id  = el.value("id", 0LL);
            const double    lat = el.value("lat", 0.0);
            const double    lon = el.value("lon", 0.0);
            node_map[id] = { lat, lon };
        }
    }

    for (const auto& el : elements)
    {
        const std::string type = el.value("type", "");
        if (type != "way")
            continue;

        const auto& tags     = el.value("tags", json::object());
        const auto& node_ids = el.value("nodes", json::array());

        const std::string highway  = tags.value("highway",  "");
        const std::string building = tags.value("building", "");
        const std::string landuse  = tags.value("landuse",  "");
        const std::string natural  = tags.value("natural",  "");
        const std::string leisure  = tags.value("leisure",  "");

        Way::Tag tag = classifyTags(highway, building, landuse, natural, leisure);
        if (tag == Way::Tag::Unknown)
            continue;

        Way way;
        way.tag = tag;
        way.nodes.reserve(node_ids.size());

        for (const auto& nid_json : node_ids)
        {
            const long long nid = nid_json.get<long long>();
            auto it = node_map.find(nid);
            if (it != node_map.end())
                way.nodes.push_back(it->second);
        }

        if (!way.nodes.empty())
            result.ways.push_back(std::move(way));
    }

    if (progress_cb)
        progress_cb("Parsed " + std::to_string(result.ways.size()) + " OSM ways", 90);

    result.success = true;
    return result;
}

// ---------------------------------------------------------------------------
OSMParser::Way::Tag OSMParser::classifyTags(const std::string& highway,
                                             const std::string& building,
                                             const std::string& landuse,
                                             const std::string& natural_tag,
                                             const std::string& leisure)
{
    if (!highway.empty())
        return Way::Tag::Road;

    if (!building.empty())
        return Way::Tag::Building;

    if (!landuse.empty() || !natural_tag.empty() || !leisure.empty())
        return Way::Tag::Vegetation;

    return Way::Tag::Unknown;
}
