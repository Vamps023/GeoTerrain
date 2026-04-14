#include "GeoTerrainController.h"

#include "../GeoTerrainPanel.h"
#include "../MapPanel.h"
#include "../DEMFetcher.h"
#include "../infrastructure/OverlayLoader.h"
#include "../ui/GenerationSettingsSection.h"
#include "../ui/MapSelectionSection.h"
#include "../ui/RunConsoleSection.h"
#include "../ui/SourceSettingsSection.h"
#include "ChunkPlanner.h"
#include "ExportCoordinator.h"
#include "GenerationCoordinator.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMessageBox>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QUrl>
#include <QUrlQuery>

namespace
{
constexpr int kStreetMode = 0;
constexpr int kSatelliteMode = 1;

QString mapStyleName(int mode, bool use_fallback)
{
    if (mode == kSatelliteMode)
        return use_fallback ? "Satellite (USGS fallback)" : "Satellite";
    return "Street";
}

QString mapStyleUrl(int mode, bool use_fallback)
{
    if (mode == kSatelliteMode)
    {
        return use_fallback
            ? "https://basemap.nationalmap.gov/ArcGIS/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
            : "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    }
    return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
}

QString mapStatusText(int mode, bool use_fallback)
{
    if (mode == kSatelliteMode)
    {
        return use_fallback
            ? "Satellite preview active (fallback source)"
            : "Satellite preview active";
    }
    return "Street preview active";
}
}

GeoTerrainController::GeoTerrainController(GeoTerrainPanel* panel, QObject* parent)
    : QObject(parent)
    , panel_(panel)
    , generation_(new GenerationCoordinator(this))
    , export_(new ExportCoordinator())
{
    auto* map = panel_->mapSection();
    auto* source = panel_->sourceSection();
    auto* console = panel_->consoleSection();

    connect(panel_, &GeoTerrainPanel::selectionChanged, this, &GeoTerrainController::onSelectionChanged);
    connect(map, &MapSelectionSection::clearSelectionRequested, this, &GeoTerrainController::onClearSelection);
    connect(map, &MapSelectionSection::previewGridRequested, this, &GeoTerrainController::onPreviewGrid);
    connect(map, &MapSelectionSection::searchRequested, this, &GeoTerrainController::onSearchPlace);
    connect(map, &MapSelectionSection::focusLayerRequested, this, &GeoTerrainController::onFocusLayer);
    connect(map, &MapSelectionSection::selectLayerBoundsRequested, this, &GeoTerrainController::onSelectLayerBounds);
    connect(map, &MapSelectionSection::mapModeChanged, this, &GeoTerrainController::onMapModeChanged);
    connect(map->mapPanel(), &MapPanel::logMessage, panel_, &GeoTerrainPanel::appendLog);
    connect(map->mapPanel(), &MapPanel::tileSourceProblem,
            this, &GeoTerrainController::onMapTileSourceProblem);

    connect(source, &SourceSettingsSection::vectorPathSelected, this, &GeoTerrainController::onVectorPathSelected);
    connect(source, &SourceSettingsSection::vectorLayerIndexChanged, this, &GeoTerrainController::onVectorLayerChanged);

    connect(console, &RunConsoleSection::generateRequested, this, &GeoTerrainController::onGenerate);
    connect(console, &RunConsoleSection::cancelRequested, this, &GeoTerrainController::onCancel);
    connect(console, &RunConsoleSection::exportRequested, this, &GeoTerrainController::onExport);
    connect(console, &RunConsoleSection::gatherRequested, this, &GeoTerrainController::onGather);

    connect(generation_, &GenerationCoordinator::logMessage, panel_, &GeoTerrainPanel::appendLog);
    connect(generation_, &GenerationCoordinator::progressChanged, this, &GeoTerrainController::onProgress);
    connect(generation_, &GenerationCoordinator::finished, this, &GeoTerrainController::onFinished);

    applyMapMode(kSatelliteMode, false);
}

GenerationRequest GeoTerrainController::buildRequest() const
{
    GenerationRequest request;
    request.bounds = current_bounds_;

    auto* source = panel_->sourceSection();
    auto* settings = panel_->settingsSection();

    const int dem_idx = source->demSourceCombo()->currentIndex();
    switch (dem_idx)
    {
    case 1: request.sources.dem.source = DEMFetcher::Source::OpenTopography_SRTM90m; break;
    case 2: request.sources.dem.source = DEMFetcher::Source::OpenTopography_AW3D30; break;
    case 3: request.sources.dem.source = DEMFetcher::Source::OpenTopography_COP30; break;
    case 4: request.sources.dem.source = DEMFetcher::Source::OpenTopography_NASADEM; break;
    case 5: request.sources.dem.source = DEMFetcher::Source::OpenTopography_3DEP10m; break;
    case 6: request.sources.dem.source = DEMFetcher::Source::LocalGeoTIFF; break;
    default: request.sources.dem.source = DEMFetcher::Source::OpenTopography_SRTM30m; break;
    }
    request.sources.dem.api_key = source->apiKeyEdit()->text().toStdString();
    request.sources.dem.local_tiff_path = source->localTiffEdit()->text().toStdString();
    request.sources.dem.resolution_m = settings->resolutionSpin()->value();
    request.sources.tiles.url_template = source->tmsUrlEdit()->text().toStdString();
    request.sources.tiles.zoom_level = settings->zoomSpin()->value();
    request.sources.tiles.target_size = settings->mapSizeCombo()->currentData().toInt();
    request.sources.osm.overpass_url = source->overpassUrlEdit()->text().toStdString();

    request.raster.resolution_m = settings->resolutionSpin()->value();
    request.raster.target_size = settings->mapSizeCombo()->currentData().toInt();
    request.mask.resolution_m = settings->resolutionSpin()->value();
    request.mask.road_width_m = settings->roadWidthSpin()->value();
    request.output.output_dir = settings->outputDirEdit()->text().toStdString();
    request.chunking.chunk_size_km = settings->chunkSizeSpin()->value();
    {
        const QVector<bool> qt_mask = panel_->mapSection()->chunkEnabled();
        request.chunking.enabled_mask.reserve(qt_mask.size());
        for (bool enabled : qt_mask)
            request.chunking.enabled_mask.push_back(enabled);
    }
    return request;
}

void GeoTerrainController::updateBoundsLabel()
{
    if (!current_bounds_.isValid())
    {
        panel_->setBoundsText("No area selected");
        return;
    }
    panel_->setBoundsText(QString("N:%1  S:%2  W:%3  E:%4")
        .arg(current_bounds_.north, 0, 'f', 5)
        .arg(current_bounds_.south, 0, 'f', 5)
        .arg(current_bounds_.west, 0, 'f', 5)
        .arg(current_bounds_.east, 0, 'f', 5));
}

void GeoTerrainController::centerOnLayerExtent()
{
    if (!layer_extent_.isValid())
        return;
    panel_->mapSection()->mapPanel()->centerOn(
        (layer_extent_.north + layer_extent_.south) * 0.5,
        (layer_extent_.west + layer_extent_.east) * 0.5, 13);
}

void GeoTerrainController::loadLayer(int index)
{
    if (vector_path_.isEmpty() || index < 0)
        return;

    OverlayLoader loader;
    auto result = loader.loadLayer(vector_path_, index,
        panel_->sourceSection()->vectorLayerCombo()->itemText(index));
    if (!result.success)
    {
        panel_->appendLog("[GPKG] " + QString::fromStdString(result.message));
        return;
    }

    layer_extent_ = result.value.extent;
    panel_->mapSection()->mapPanel()->setOverlayLayers({ result.value.overlay });
    panel_->setLayerInfo(QString("Layer: %1 (%2 features)")
        .arg(result.value.overlay.name).arg(result.value.feature_count), layer_extent_.isValid());
    centerOnLayerExtent();
}

void GeoTerrainController::onSelectionChanged(const GeoBounds& bounds)
{
    current_bounds_ = bounds;
    updateBoundsLabel();
}

void GeoTerrainController::onClearSelection()
{
    panel_->mapSection()->mapPanel()->clearSelection();
    current_bounds_ = GeoBounds{};
    panel_->mapSection()->mapPanel()->clearChunkGrid();
    updateBoundsLabel();
}

void GeoTerrainController::onPreviewGrid()
{
    if (!current_bounds_.isValid())
        return;
    auto result = ChunkPlanner::buildPlan(
        current_bounds_,
        panel_->settingsSection()->chunkSizeSpin()->value(),
        panel_->settingsSection()->outputDirEdit()->text().toStdString());
    if (!result.success)
    {
        panel_->appendLog("[Grid] " + QString::fromStdString(result.message));
        return;
    }
    QVector<GeoBounds> chunks;
    for (const auto& chunk : result.value.chunks)
        chunks << chunk.bounds;
    panel_->mapSection()->mapPanel()->setChunkGrid(chunks);
    panel_->appendLog(QString("[Grid] %1 x %2 = %3 chunks shown")
        .arg(result.value.rows).arg(result.value.columns).arg(result.value.chunks.size()));
}

void GeoTerrainController::onSearchPlace()
{
    const QString query = panel_->mapSection()->searchEdit()->text().trimmed();
    if (query.isEmpty())
        return;

    auto* nam = new QNetworkAccessManager(this);
    QUrl url("https://nominatim.openstreetmap.org/search");
    QUrlQuery q;
    q.addQueryItem("q", query);
    q.addQueryItem("format", "json");
    q.addQueryItem("limit", "1");
    url.setQuery(q);

    QNetworkRequest req(url);
    req.setRawHeader("User-Agent", "GeoTerrainEditorPlugin/1.0");

    QNetworkReply* reply = nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, query, nam]()
    {
        reply->deleteLater();
        nam->deleteLater();
        if (reply->error() != QNetworkReply::NoError)
        {
            panel_->appendLog("[Search] Network error: " + reply->errorString());
            return;
        }
        const QJsonDocument doc = QJsonDocument::fromJson(reply->readAll());
        if (!doc.isArray() || doc.array().isEmpty())
        {
            panel_->appendLog("[Search] No results for: " + query);
            return;
        }
        const QJsonObject obj = doc.array().first().toObject();
        const double lat = obj["lat"].toString().toDouble();
        const double lon = obj["lon"].toString().toDouble();
        panel_->appendLog("[Search] Found: " + obj["display_name"].toString());
        panel_->mapSection()->mapPanel()->centerOn(lat, lon, 13);
    });
}

void GeoTerrainController::onVectorPathSelected(const QString& path)
{
    vector_path_ = path;
    panel_->mapSection()->mapPanel()->clearOverlay();
    layer_extent_ = GeoBounds{};

    if (path.isEmpty())
    {
        panel_->sourceSection()->setVectorLayers({});
        panel_->setLayerInfo("No vector layer loaded", false);
        return;
    }

    OverlayLoader loader;
    auto layers = loader.listLayers(path);
    if (!layers.success)
    {
        panel_->appendLog("[GPKG] " + QString::fromStdString(layers.message));
        return;
    }

    panel_->sourceSection()->setVectorLayers(layers.value);
    if (!layers.value.isEmpty())
        loadLayer(0);
}

void GeoTerrainController::onVectorLayerChanged(int index)
{
    loadLayer(index);
}

void GeoTerrainController::onFocusLayer()
{
    centerOnLayerExtent();
}

void GeoTerrainController::onSelectLayerBounds()
{
    if (!layer_extent_.isValid())
        return;
    GeoBounds padded = layer_extent_;
    const double pad = panel_->mapSection()->paddingDegrees();
    padded.north += pad;
    padded.south -= pad;
    padded.west -= pad;
    padded.east += pad;
    panel_->mapSection()->mapPanel()->setSelection(padded);
    current_bounds_ = padded;
    updateBoundsLabel();
}

void GeoTerrainController::onMapModeChanged(int mode)
{
    applyMapMode(mode, false);
}

void GeoTerrainController::onMapTileSourceProblem(const QString& source_name, const QString& detail)
{
    if (map_mode_ == kSatelliteMode && !using_satellite_fallback_)
    {
        panel_->appendLog(QString("[Map] %1 preview failed, switching to the fallback satellite source.")
            .arg(source_name));
        applyMapMode(kSatelliteMode, true);
        return;
    }

    if (map_mode_ == kSatelliteMode)
    {
        panel_->mapSection()->setMapStatus(
            "Satellite preview is unavailable right now. Switch to Street mode or keep working with selection tools.",
            true);
        panel_->appendLog(QString("[Map] Satellite fallback is also having trouble: %1").arg(detail));
        return;
    }

    panel_->mapSection()->setMapStatus(
        QString("%1 preview is having trouble.").arg(source_name),
        true);
}

void GeoTerrainController::onGenerate()
{
    if (generation_->isRunning())
        return;
    if (!current_bounds_.isValid())
    {
        QMessageBox::warning(panel_, "GeoTerrain", "No area selected.");
        return;
    }

    panel_->clearLog();
    panel_->setProgress(0);
    panel_->appendLog("Starting generation...");
    panel_->setControlsEnabled(false);
    panel_->showGenerateTab();
    generation_->start(buildRequest());
}

void GeoTerrainController::onCancel()
{
    generation_->cancel();
}

void GeoTerrainController::onExport()
{
    auto result = export_->exportForUnigine(
        panel_->settingsSection()->outputDirEdit()->text(),
        "C:/Users/snare.ext/Documents/Sogeclair Rail Simulation/Track Editor/cots/qgis",
        [this](const QString& line) { panel_->appendLog(line); });
    if (!result.success)
        panel_->appendLog("[Export] " + QString::fromStdString(result.message));
    else
        panel_->appendLog(QString("[Export] Wrote %1 file(s).").arg(result.value));
}

void GeoTerrainController::onGather()
{
    auto result = export_->gatherChunks(
        panel_->settingsSection()->outputDirEdit()->text(),
        [this](const QString& line) { panel_->appendLog(line); });
    if (!result.success)
        panel_->appendLog("[Gather] " + QString::fromStdString(result.message));
    else
        panel_->appendLog(QString("[Gather] Copied %1 file(s).").arg(result.value));
}

void GeoTerrainController::onProgress(int percent)
{
    panel_->setProgress(percent);
}

void GeoTerrainController::onFinished(int status, const QString& message)
{
    panel_->appendLog(message);
    panel_->setControlsEnabled(true);
    panel_->setExportEnabled(status == static_cast<int>(JobStatus::Succeeded) ||
                             status == static_cast<int>(JobStatus::PartiallySucceeded));
    panel_->setGatherEnabled(panel_->settingsSection()->chunkSizeSpin()->value() >= 1.0);
}

void GeoTerrainController::applyMapMode(int mode, bool use_fallback)
{
    if (mode != kSatelliteMode)
        use_fallback = false;

    map_mode_ = (mode == kStreetMode) ? kStreetMode : kSatelliteMode;
    using_satellite_fallback_ = use_fallback;

    auto* map_section = panel_->mapSection();
    map_section->setMapMode(map_mode_);
    map_section->mapPanel()->setTileUrl(
        mapStyleUrl(map_mode_, using_satellite_fallback_),
        mapStyleName(map_mode_, using_satellite_fallback_));
    map_section->setMapStatus(
        mapStatusText(map_mode_, using_satellite_fallback_),
        using_satellite_fallback_);
}
