#pragma once

#include "../domain/GenerationTypes.h"
#include "../domain/Result.h"

#include <string>

namespace ChunkPlanner
{
Result<ChunkPlan> buildPlan(const GeoBounds& bounds, double chunk_size_km, const std::string& base_output_dir,
                            const std::vector<bool>& enabled_mask = {});
}
