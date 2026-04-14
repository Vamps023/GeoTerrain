#include "ManifestWriter.h"

#include <json.hpp>

#include <fstream>

using json = nlohmann::json;

namespace
{
std::string toStatusString(JobStatus status)
{
    switch (status)
    {
    case JobStatus::Idle: return "Idle";
    case JobStatus::Running: return "Running";
    case JobStatus::Cancelling: return "Cancelling";
    case JobStatus::Cancelled: return "Cancelled";
    case JobStatus::Succeeded: return "Succeeded";
    case JobStatus::PartiallySucceeded: return "PartiallySucceeded";
    case JobStatus::Failed: return "Failed";
    }
    return "Unknown";
}
}

Result<void> ManifestWriter::writeManifest(const OutputManifest& manifest)
{
    try
    {
        json doc;
        doc["status"] = toStatusString(manifest.status);
        doc["bounds"]["west"] = manifest.bounds.west;
        doc["bounds"]["east"] = manifest.bounds.east;
        doc["bounds"]["south"] = manifest.bounds.south;
        doc["bounds"]["north"] = manifest.bounds.north;
        doc["output_dir"] = manifest.output_dir;
        doc["dem_path"] = manifest.dem_path;
        doc["albedo_path"] = manifest.albedo_path;
        doc["mask_path"] = manifest.mask_path;
        doc["chunk_index"] = manifest.chunk_index;
        doc["generated_files"] = manifest.generated_files;
        doc["warnings"] = manifest.warnings;
        doc["errors"] = manifest.errors;

        std::ofstream ofs(manifest.output_dir + "/manifest.json");
        ofs << doc.dump(4);
        return Result<void>::ok();
    }
    catch (const std::exception& e)
    {
        return Result<void>::fail(1, e.what());
    }
}

Result<void> ManifestWriter::writeMetadata(const OutputManifest& manifest, const GenerationRequest& request)
{
    try
    {
        json meta;
        meta["bounds"]["west"] = manifest.bounds.west;
        meta["bounds"]["east"] = manifest.bounds.east;
        meta["bounds"]["south"] = manifest.bounds.south;
        meta["bounds"]["north"] = manifest.bounds.north;
        meta["epsg"] = 4326;
        meta["dem_source"] = manifest.dem_path;
        meta["albedo_source"] = manifest.albedo_path;
        meta["mask_source"] = manifest.mask_path;
        meta["resolution_m"] = request.raster.resolution_m;
        meta["tile_zoom"] = request.sources.tiles.zoom_level;
        meta["status"] = toStatusString(manifest.status);
        meta["warnings"] = manifest.warnings;

        std::ofstream ofs(manifest.output_dir + "/metadata.json");
        ofs << meta.dump(4);
        return Result<void>::ok();
    }
    catch (const std::exception& e)
    {
        return Result<void>::fail(1, e.what());
    }
}
