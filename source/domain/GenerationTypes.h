#pragma once

#include "domain/GeoBounds.h"
#include "pipeline/DEMFetcher.h"

#include <string>
#include <vector>

struct DataSourceSettings
{
    DEMFetcher::Config dem;

    struct TileSettings
    {
        std::string url_template;
        int zoom_level = 14;
        int target_size = 0;
    } tiles;

    struct OsmSettings
    {
        std::string overpass_url = "https://overpass-api.de/api/interpreter";
        long timeout_s = 120;
    } osm;
};

struct RasterSettings
{
    double resolution_m = 30.0;
    int target_size = 0;
};

struct MaskSettings
{
    double resolution_m = 30.0;
    double road_width_m = 10.0;
};

struct OutputSettings
{
    std::string output_dir;
    bool run_unigine_export = false;
    std::string qgis_root;
};

struct ChunkSettings
{
    double chunk_size_km = 0.0;
    std::vector<bool> enabled_mask;
};

struct GenerationRequest
{
    GeoBounds bounds;
    DataSourceSettings sources;
    RasterSettings raster;
    MaskSettings mask;
    OutputSettings output;
    ChunkSettings chunking;
};

enum class JobStatus
{
    Idle,
    Running,
    Cancelling,
    Cancelled,
    Succeeded,
    PartiallySucceeded,
    Failed
};

struct ChunkDefinition
{
    int index = 0;
    int row = 0;
    int column = 0;
    GeoBounds bounds;
    std::string directory_name;
};

struct ChunkPlan
{
    int rows = 0;
    int columns = 0;
    std::vector<ChunkDefinition> chunks;
    std::vector<ChunkDefinition> enabled_chunks;
    int skipped_chunks = 0;
};

struct OutputManifest
{
    JobStatus status = JobStatus::Idle;
    GeoBounds bounds;
    std::string output_dir;
    std::string dem_path;
    std::string albedo_path;
    std::string mask_path;
    std::vector<std::string> generated_files;
    std::vector<std::string> warnings;
    std::vector<std::string> errors;
    int chunk_index = -1;
};

struct ValidationIssue
{
    std::string message;
};

struct ValidationReport
{
    bool valid = false;
    std::vector<ValidationIssue> issues;
};
