#pragma once

#include "../domain/GenerationTypes.h"

#include <QObject>

class GeoTerrainPanel;
class GenerationCoordinator;
class ExportCoordinator;

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
    void onGenerate();
    void onCancel();
    void onExport();
    void onGather();
    void onProgress(int percent);
    void onFinished(int status, const QString& message);

private:
    GenerationRequest buildRequest() const;
    void updateBoundsLabel();
    void centerOnLayerExtent();
    void loadLayer(int index);

    GeoTerrainPanel* panel_ = nullptr;
    GenerationCoordinator* generation_ = nullptr;
    ExportCoordinator* export_ = nullptr;
    GeoBounds current_bounds_;
    GeoBounds layer_extent_;
    QString vector_path_;
    bool satellite_mode_ = true;
};
