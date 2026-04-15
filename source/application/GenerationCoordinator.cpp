#include "GenerationCoordinator.h"

#include "../DEMFetcher.h"
#include "../MaskGenerator.h"
#include "../OSMParser.h"
#include "../ShapefileExporter.h"
#include "../TileDownloader.h"
#include "../domain\Validation.h"
#include "../infrastructure/ManifestWriter.h"
#include "../infrastructure/RunContext.h"
#include "ChunkPlanner.h"

#include <QDir>
#include <QThread>

#include <algorithm>
#include <atomic>

namespace
{
class GenerationWorker : public QObject
{
    Q_OBJECT

public:
    explicit GenerationWorker(const GenerationRequest& request)
        : request_(request)
    {
    }

public slots:
    void run()
    {
        emit statusChanged(static_cast<int>(JobStatus::Running));

        const ValidationReport validation = Validation::validateRequest(request_);
        if (!validation.valid)
        {
            QStringList issues;
            for (const auto& issue : validation.issues)
                issues << QString::fromStdString(issue.message);
            emit finished(static_cast<int>(JobStatus::Failed), issues.join("\n"));
            return;
        }

        const QString base_dir = QString::fromStdString(request_.output.output_dir);
        QDir().mkpath(base_dir);

        auto plan_result = ChunkPlanner::buildPlan(
            request_.bounds, request_.chunking.chunk_size_km, base_dir.toStdString(), request_.chunking.enabled_mask);
        if (!plan_result.success)
        {
            emit finished(static_cast<int>(JobStatus::Failed), QString::fromStdString(plan_result.message));
            return;
        }

        const ChunkPlan plan = plan_result.value;
        int failures = 0;
        for (int i = 0; i < plan.enabled_chunks.size(); ++i)
        {
            if (cancelled_.load())
            {
                emit finished(static_cast<int>(JobStatus::Cancelled), "Cancelled.");
                return;
            }

            const ChunkDefinition chunk = plan.enabled_chunks[i];
            const QString output_dir = request_.chunking.chunk_size_km < 1.0 ? base_dir : QString::fromStdString(chunk.directory_name);
            QDir().mkpath(output_dir);

            auto emit_log = [&](const std::string& text) { emit logMessage(QString::fromStdString(text)); };
            auto emit_progress = [&](const std::string& text, int pct)
            {
                emit logMessage(QString::fromStdString(text));
                const int chunk_count = std::max(1, static_cast<int>(plan.enabled_chunks.size()));
                const int overall = static_cast<int>(((i * 100.0) + pct) / chunk_count);
                emit progressChanged(overall);
            };

            RunContext context;
            context.cancel_flag = &cancelled_;
            context.progress = emit_progress;
            context.warning = [&](const std::string& text) { emit_log("[WARN] " + text); };

            GenerationRequest chunk_request = request_;
            chunk_request.bounds = chunk.bounds;

            TileDownloader::Config tile_cfg;
            tile_cfg.url_template = request_.sources.tiles.url_template;
            tile_cfg.zoom_level = request_.sources.tiles.zoom_level;
            tile_cfg.target_size = request_.sources.tiles.target_size;
            tile_cfg.output_path = (output_dir + "/albedo.tif").toStdString();

            DEMFetcher::Config dem_cfg = request_.sources.dem;
            dem_cfg.output_path = (output_dir + "/heightmap.tif").toStdString();

            OSMParser::Config osm_cfg;
            osm_cfg.overpass_url = request_.sources.osm.overpass_url;
            osm_cfg.timeout_s = request_.sources.osm.timeout_s;

            MaskGenerator::Config mask_cfg;
            mask_cfg.output_path = (output_dir + "/mask.tif").toStdString();
            mask_cfg.ref_tif_path = tile_cfg.output_path;
            mask_cfg.resolution_m = request_.mask.resolution_m;
            mask_cfg.road_width_m = request_.mask.road_width_m;

            OutputManifest manifest;
            manifest.status = JobStatus::Running;
            manifest.bounds = chunk.bounds;
            manifest.output_dir = output_dir.toStdString();
            manifest.chunk_index = chunk.index;

            TileDownloader tile_downloader;
            auto tile_result = tile_downloader.download(chunk.bounds, tile_cfg, context);
            if (!tile_result.success)
            {
                manifest.status = tile_result.error_code == 999 ? JobStatus::Cancelled : JobStatus::Failed;
                manifest.errors.push_back(tile_result.message);
                ManifestWriter::writeManifest(manifest);
                if (tile_result.error_code == 999)
                {
                    emit finished(static_cast<int>(JobStatus::Cancelled), "Cancelled.");
                    return;
                }
                ++failures;
                emit logMessage("[FAIL] Tile stage failed for chunk " + QString::number(chunk.index + 1));
                continue;
            }
            manifest.albedo_path = tile_result.value.output_path;
            manifest.generated_files.push_back(tile_result.value.output_path);

            DEMFetcher dem_fetcher;
            auto dem_result = dem_fetcher.fetch(chunk.bounds, dem_cfg, context);
            if (!dem_result.success)
            {
                manifest.status = dem_result.error_code == 999 ? JobStatus::Cancelled : JobStatus::Failed;
                manifest.errors.push_back(dem_result.message);
                ManifestWriter::writeManifest(manifest);
                if (dem_result.error_code == 999)
                {
                    emit finished(static_cast<int>(JobStatus::Cancelled), "Cancelled.");
                    return;
                }
                ++failures;
                emit logMessage("[FAIL] DEM stage failed for chunk " + QString::number(chunk.index + 1));
                continue;
            }
            manifest.dem_path = dem_result.value.output_path;
            manifest.generated_files.push_back(dem_result.value.output_path);

            // Also export Unreal-compatible 16-bit RAW alongside the GeoTIFF
            const std::string raw_path = (output_dir + "/heightmap.r16").toStdString();
            DEMFetcher raw_exporter;
            auto raw_result = raw_exporter.exportUnrealRaw(dem_result.value.output_path, raw_path, context);
            if (raw_result.success)
            {
                manifest.generated_files.push_back(raw_result.value);
                emit logMessage("[Export] Unreal RAW: " + QString::fromStdString(raw_result.value));
            }
            else
                emit logMessage("[WARN] RAW export skipped: " + QString::fromStdString(raw_result.message));

            OSMParser osm_parser;
            auto osm_result = osm_parser.fetch(chunk.bounds, osm_cfg, context);
            if (!osm_result.success)
            {
                manifest.warnings.push_back(osm_result.message);
                emit logMessage("[WARN] OSM fetch failed for chunk " + QString::number(chunk.index + 1) +
                                ": " + QString::fromStdString(osm_result.message));
            }

            if (osm_result.success)
            {
                ShapefileExporter exporter;
                ShapefileExporter::Config exporter_cfg;
                exporter_cfg.output_dir = output_dir.toStdString();
                auto export_result = exporter.exportAll(osm_result.value, exporter_cfg, context);
                if (!export_result.success && export_result.error_code == 999)
                {
                    emit finished(static_cast<int>(JobStatus::Cancelled), "Cancelled.");
                    return;
                }
            }

            MaskGenerator mask_generator;
            auto mask_result = mask_generator.generate(
                chunk.bounds,
                osm_result.success ? osm_result.value : OSMParser::ParseResult{},
                mask_cfg,
                context);
            if (!mask_result.success)
            {
                manifest.status = mask_result.error_code == 999 ? JobStatus::Cancelled : JobStatus::Failed;
                manifest.errors.push_back(mask_result.message);
                ManifestWriter::writeManifest(manifest);
                if (mask_result.error_code == 999)
                {
                    emit finished(static_cast<int>(JobStatus::Cancelled), "Cancelled.");
                    return;
                }
                ++failures;
                emit logMessage("[FAIL] Mask stage failed for chunk " + QString::number(chunk.index + 1));
                continue;
            }

            manifest.mask_path = mask_result.value.output_path;
            manifest.generated_files.push_back(mask_result.value.output_path);
            manifest.status = JobStatus::Succeeded;
            ManifestWriter::writeManifest(manifest);
            ManifestWriter::writeMetadata(manifest, chunk_request);
        }

        const JobStatus final_status = failures > 0 ? JobStatus::PartiallySucceeded : JobStatus::Succeeded;
        emit statusChanged(static_cast<int>(final_status));
        emit progressChanged(100);
        emit finished(static_cast<int>(final_status),
                      failures > 0 ? QString("Generation completed with %1 failed chunk(s).").arg(failures)
                                   : QString("Generation completed successfully."));
    }

    void cancel()
    {
        cancelled_.store(true);
        emit statusChanged(static_cast<int>(JobStatus::Cancelling));
    }

signals:
    void logMessage(const QString& message);
    void progressChanged(int percent);
    void statusChanged(int status);
    void finished(int status, const QString& message);

private:
    GenerationRequest request_;
    std::atomic_bool cancelled_ = false;
};
}

GenerationCoordinator::GenerationCoordinator(QObject* parent)
    : QObject(parent)
{
}

GenerationCoordinator::~GenerationCoordinator()
{
    cancel();
}

bool GenerationCoordinator::isRunning() const
{
    return thread_ && thread_->isRunning();
}

void GenerationCoordinator::start(const GenerationRequest& request)
{
    if (isRunning())
        return;

    thread_ = new QThread(this);
    auto* generation_worker = new GenerationWorker(request);
    worker_ = generation_worker;
    generation_worker->moveToThread(thread_);

    connect(thread_, &QThread::started, generation_worker, &GenerationWorker::run);
    connect(generation_worker, &GenerationWorker::logMessage, this, &GenerationCoordinator::logMessage);
    connect(generation_worker, &GenerationWorker::progressChanged, this, &GenerationCoordinator::progressChanged);
    connect(generation_worker, &GenerationWorker::statusChanged, this, &GenerationCoordinator::statusChanged);
    connect(generation_worker, &GenerationWorker::finished, this, [this](int status, const QString& message)
    {
        if (thread_)
            thread_->quit();
        emit finished(status, message);
        worker_ = nullptr;
        thread_ = nullptr;
    });
    connect(thread_, &QThread::finished, generation_worker, &QObject::deleteLater);
    connect(thread_, &QThread::finished, thread_, &QObject::deleteLater);

    thread_->start();
}

void GenerationCoordinator::cancel()
{
    if (worker_)
        QMetaObject::invokeMethod(worker_, "cancel", Qt::QueuedConnection);
}

#include "GenerationCoordinator.moc"
