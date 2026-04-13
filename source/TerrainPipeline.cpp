#include "TerrainPipeline.h"

#include <json.hpp>

#include <QDir>
#include <QFile>
#include <QTextStream>

#include <fstream>
#include <sstream>

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// PipelineWorker
// ---------------------------------------------------------------------------
PipelineWorker::PipelineWorker(const PipelineConfig& config)
    : config_(config)
{
}

void PipelineWorker::run()
{
    auto cb = [this](const std::string& msg, int pct)
    {
        emit progress(QString::fromStdString(msg), pct);
    };

    // Ensure output directory exists
    QDir().mkpath(QString::fromStdString(config_.output_dir));

    // --- Step 1: DEM ---
    emit progress("=== Step 1/4: Fetching DEM heightmap ===", 0);
    DEMFetcher dem_fetcher;
    const bool dem_ok = dem_fetcher.fetch(config_.bounds, config_.dem, cb);
    if (!dem_ok)
    {
        emit finished(false, "DEM fetch failed. Check API key and network.");
        return;
    }

    // --- Step 2: TMS tiles ---
    emit progress("=== Step 2/4: Downloading TMS albedo tiles ===", 25);
    TileDownloader tile_dl;
    const bool tiles_ok = tile_dl.download(config_.bounds, config_.tiles, cb);
    if (!tiles_ok)
    {
        emit finished(false, "Tile download failed. Check TMS URL and network.");
        return;
    }

    // --- Step 3: OSM data ---
    emit progress("=== Step 3/4: Fetching OSM vector data ===", 50);
    OSMParser osm_parser;
    const OSMParser::ParseResult osm_result = osm_parser.fetch(config_.bounds, config_.osm, cb);

    if (!osm_result.success)
        emit progress("WARNING: OSM fetch failed: " + QString::fromStdString(osm_result.error), 70);
    else
        emit progress("OSM: " + QString::number(osm_result.ways.size()) + " ways parsed", 70);

    // --- Step 4: Mask generation ---
    emit progress("=== Step 4/4: Generating masks ===", 75);
    MaskGenerator mask_gen;
    const bool mask_ok = mask_gen.generate(config_.bounds, osm_result, config_.mask, cb);
    if (!mask_ok)
    {
        emit finished(false, "Mask generation failed.");
        return;
    }

    // --- Write metadata.json ---
    const std::string meta_path = config_.output_dir + "/metadata.json";
    try
    {
        json meta;
        meta["bounds"]["west"]  = config_.bounds.west;
        meta["bounds"]["east"]  = config_.bounds.east;
        meta["bounds"]["south"] = config_.bounds.south;
        meta["bounds"]["north"] = config_.bounds.north;
        meta["epsg"]            = 4326;
        meta["dem_source"]      = config_.dem.output_path;
        meta["albedo_source"]   = config_.tiles.output_path;
        meta["mask_source"]     = config_.mask.output_path;
        meta["resolution_m"]    = config_.dem.resolution_m;
        meta["tile_zoom"]       = config_.tiles.zoom_level;

        std::ofstream ofs(meta_path);
        ofs << meta.dump(4);
    }
    catch (...) {}

    emit progress("=== Pipeline complete! ===", 100);
    emit finished(true, "");
}

// ---------------------------------------------------------------------------
// TerrainPipeline
// ---------------------------------------------------------------------------
TerrainPipeline::TerrainPipeline(QObject* parent)
    : QObject(parent)
{
}

TerrainPipeline::~TerrainPipeline()
{
    cancel();
}

bool TerrainPipeline::isRunning() const
{
    return thread_ && thread_->isRunning();
}

void TerrainPipeline::start(const PipelineConfig& config)
{
    if (isRunning())
        return;

    thread_ = new QThread(this);
    worker_ = new PipelineWorker(config);
    worker_->moveToThread(thread_);

    connect(thread_, &QThread::started,   worker_,  &PipelineWorker::run);
    connect(worker_, &PipelineWorker::progress, this, &TerrainPipeline::progress);
    connect(worker_, &PipelineWorker::finished,
            this, [this](bool ok, const QString& err)
            {
                emit finished(ok, err);
                thread_->quit();
            });
    connect(thread_, &QThread::finished,  worker_,  &QObject::deleteLater);
    connect(thread_, &QThread::finished,  thread_,  &QObject::deleteLater);

    thread_ = thread_; // already assigned
    thread_->start();
}

void TerrainPipeline::cancel()
{
    if (thread_ && thread_->isRunning())
    {
        thread_->requestInterruption();
        thread_->quit();
        thread_->wait(5000);
    }
    thread_ = nullptr;
    worker_ = nullptr;
}
