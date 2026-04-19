#pragma once

#include "../domain/GenerationTypes.h"
#include "ExportCoordinator.h"
#include "TerrainBuilder.h"

#include <QObject>
#include <QString>

class AsyncJob;
class GeoTerrainPanel;
class GenerationCoordinator;

class GeoTerrainController : public QObject
{
    Q_OBJECT

public:
    explicit GeoTerrainController(GeoTerrainPanel* panel, QObject* parent = nullptr);

private slots:
    void onSelectionChanged(const GeoBounds& bounds);
    void onClearSelection();
    void onPreviewGrid();
    void onSearchPlace();
    void onVectorPathSelected(const QString& path);
    void onVectorLayerChanged(int index);
    void onFocusLayer();
    void onSelectLayerBounds();
    void onMapModeChanged(int mode);
    void onMapTileSourceProblem(const QString& source_name, const QString& detail);
    void onGenerate();
    void onCancel();
    void onExport();
    void onGather();
    void onBuildTerrain();
    void onHeightmapPathChanged(const QString& path);
    void onProgress(int percent);
    void onFinished(int status, const QString& message);
    void onAsyncJobFinished(bool success, int count, const QString& message);

private:
    GenerationRequest buildRequest() const;
    void updateBoundsLabel();
    void centerOnLayerExtent();
    void loadLayer(int index);
    void applyMapMode(int mode, bool use_fallback = false);

    GeoTerrainPanel* panel_ = nullptr;
    GenerationCoordinator* generation_ = nullptr;
    AsyncJob* job_ = nullptr;
    ExportCoordinator export_;
    TerrainBuilder terrain_builder_;
    QString active_job_tag_;
    GeoBounds current_bounds_;
    GeoBounds layer_extent_;
    QString vector_path_;
    int map_mode_ = 1;
    bool using_satellite_fallback_ = false;
};
