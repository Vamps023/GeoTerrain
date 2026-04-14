#include "ChunkPlanner.h"

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>

Result<ChunkPlan> ChunkPlanner::buildPlan(const GeoBounds& bounds, double chunk_size_km,
                                          const std::string& base_output_dir, const std::vector<bool>& enabled_mask)
{
    if (!bounds.isValid())
        return Result<ChunkPlan>::fail(1, "Invalid bounds.");

    ChunkPlan plan;

    if (chunk_size_km < 1.0)
    {
        ChunkDefinition chunk;
        chunk.index = 0;
        chunk.bounds = bounds;
        chunk.directory_name = ".";
        plan.rows = 1;
        plan.columns = 1;
        plan.chunks.push_back(chunk);
        plan.enabled_chunks.push_back(chunk);
        return Result<ChunkPlan>::ok(plan);
    }

    const double centre_lat = (bounds.north + bounds.south) * 0.5;
    const double deg_per_km_lat = 1.0 / 111.0;
    const double deg_per_km_lon = 1.0 / (111.0 * std::cos(centre_lat * M_PI / 180.0));
    const double chunk_lat = chunk_size_km * deg_per_km_lat;
    const double chunk_lon = chunk_size_km * deg_per_km_lon;

    plan.rows = std::max(1, static_cast<int>(std::ceil((bounds.north - bounds.south) / chunk_lat)));
    plan.columns = std::max(1, static_cast<int>(std::ceil((bounds.east - bounds.west) / chunk_lon)));

    for (int r = 0; r < plan.rows; ++r)
    {
        for (int c = 0; c < plan.columns; ++c)
        {
            ChunkDefinition chunk;
            chunk.index = plan.chunks.size();
            chunk.row = r;
            chunk.column = c;
            chunk.bounds.south = bounds.south + r * chunk_lat;
            chunk.bounds.north = std::min(bounds.north, chunk.bounds.south + chunk_lat);
            chunk.bounds.west = bounds.west + c * chunk_lon;
            chunk.bounds.east = std::min(bounds.east, chunk.bounds.west + chunk_lon);
            chunk.directory_name = base_output_dir + "/chunk_" + std::to_string(r) + "_" + std::to_string(c);
            plan.chunks.push_back(chunk);
        }
    }

    std::vector<bool> resolved_mask = enabled_mask;
    if (resolved_mask.size() != plan.chunks.size())
        resolved_mask.assign(plan.chunks.size(), true);

    for (int i = 0; i < plan.chunks.size(); ++i)
    {
        if (resolved_mask[i])
            plan.enabled_chunks.push_back(plan.chunks[i]);
        else
            ++plan.skipped_chunks;
    }

    return Result<ChunkPlan>::ok(plan);
}
