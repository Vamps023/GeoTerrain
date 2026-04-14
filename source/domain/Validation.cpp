#include "Validation.h"

namespace Validation
{
ValidationReport validateRequest(const GenerationRequest& request)
{
    ValidationReport report;

    if (!request.bounds.isValid())
        report.issues.push_back({ "Selected bounds are invalid." });

    if (request.output.output_dir.empty())
        report.issues.push_back({ "Output directory is required." });

    if (request.sources.tiles.url_template.empty())
        report.issues.push_back({ "Tile URL template is required." });

    if (request.sources.osm.overpass_url.empty())
        report.issues.push_back({ "Overpass URL is required." });

    if (request.sources.dem.source == DEMFetcher::Source::LocalGeoTIFF &&
        request.sources.dem.local_tiff_path.empty())
        report.issues.push_back({ "Local GeoTIFF path is required for Local GeoTIFF DEM source." });

    if (request.raster.resolution_m <= 0.0)
        report.issues.push_back({ "Resolution must be greater than zero." });

    if (request.mask.road_width_m <= 0.0)
        report.issues.push_back({ "Road width must be greater than zero." });

    if (request.chunking.chunk_size_km < 0.0)
        report.issues.push_back({ "Chunk size cannot be negative." });

    report.valid = report.issues.empty();
    return report;
}
}
