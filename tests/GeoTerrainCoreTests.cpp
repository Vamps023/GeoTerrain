#include "application/ChunkPlanner.h"
#include "domain/Validation.h"

#include <stdexcept>

namespace
{
void expect(bool condition, const char* message)
{
    if (!condition)
        throw std::runtime_error(message);
}
}

int main()
{
    GeoBounds bounds;
    bounds.west = 10.0;
    bounds.east = 11.0;
    bounds.south = 20.0;
    bounds.north = 21.0;

    GenerationRequest request;
    request.bounds = bounds;
    request.sources.tiles.url_template = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    request.sources.osm.overpass_url = "https://overpass-api.de/api/interpreter";
    request.output.output_dir = "C:/tmp/geoterrain-tests";

    const auto validation = Validation::validateRequest(request);
    expect(validation.valid, "Expected request validation to succeed.");

    const auto chunk_plan = ChunkPlanner::buildPlan(bounds, 5.0, std::string("C:/tmp/geoterrain-tests"));
    expect(chunk_plan.success, "Expected chunk planning to succeed.");
    expect(!chunk_plan.value.chunks.empty(), "Expected chunk plan to contain chunks.");

    return 0;
}
