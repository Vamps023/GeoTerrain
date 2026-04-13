#pragma once

#include "GeoBounds.h"
#include "DEMFetcher.h"
#include "TileDownloader.h"
#include "OSMParser.h"
#include "MaskGenerator.h"

#include <QObject>
#include <QString>
#include <QThread>

#include <atomic>
#include <functional>
#include <memory>
#include <string>

// ---------------------------------------------------------------------------
// Pipeline configuration collected from all panels
struct PipelineConfig
{
    // Bounds
    GeoBounds bounds;

    // Output
    std::string output_dir;   // directory where heightmap/albedo/mask are written

    // DEM
    DEMFetcher::Config dem;

    // Tiles
    TileDownloader::Config tiles;

    // OSM
    OSMParser::Config osm;

    // Masks
    MaskGenerator::Config mask;
};

// ---------------------------------------------------------------------------
// Worker QObject that runs the pipeline on a QThread
class PipelineWorker : public QObject
{
    Q_OBJECT

public:
    explicit PipelineWorker(const PipelineConfig& config);

public slots:
    void run();

signals:
    void progress(const QString& message, int percent);
    void finished(bool success, const QString& error);

private:
    PipelineConfig config_;
};

// ---------------------------------------------------------------------------
// TerrainPipeline — public API used by GeoTerrainPanel
// Owns the worker + thread, emits Qt signals for UI updates.
class TerrainPipeline : public QObject
{
    Q_OBJECT

public:
    explicit TerrainPipeline(QObject* parent = nullptr);
    ~TerrainPipeline() override;

    bool isRunning() const;
    void start(const PipelineConfig& config);
    void cancel();

signals:
    void progress(const QString& message, int percent);
    void finished(bool success, const QString& error);

private:
    QThread*       thread_ = nullptr;
    PipelineWorker* worker_ = nullptr;
};
