#pragma once

#include "GeoBounds.h"
#include "TerrainPipeline.h"

#include <QWidget>
#include <QTabWidget>
#include <QLineEdit>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QSpinBox>
#include <QProgressBar>
#include <QPushButton>
#include <QTextEdit>
#include <QLabel>
#include <QGroupBox>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QScrollBar>
#include <QNetworkAccessManager>
#include <QNetworkReply>

#include <memory>
#include <QVector>

class MapPanel;

// ---------------------------------------------------------------------------
// GeoTerrainPanel
// Main dockable panel with four tabs: Map | Sources | Parameters | Generate
// ---------------------------------------------------------------------------
class GeoTerrainPanel : public QWidget
{
    Q_OBJECT

public:
    explicit GeoTerrainPanel(QWidget* parent = nullptr);
    ~GeoTerrainPanel() override = default;

protected:
    void showEvent(QShowEvent* event) override;

private slots:
    void onSelectionChanged(const GeoBounds& bounds);
    void onGenerate();
    void onQgisExport();
    void onPipelineProgress(const QString& message, int percent);
    void onPipelineFinished(bool success, const QString& error);
    void onGpkgLayerChanged(int index);
    void onSearchPlace();
    void onChunkFinished(bool ok, const QString& err);
    void onGatherExport();

private:
    void setupUi();
    QWidget* buildMapTab();
    QWidget* buildSourcesTab();
    QWidget* buildParametersTab();
    QWidget* buildGenerateTab();

    void appendLog(const QString& message);
    void setControlsEnabled(bool enabled);
    PipelineConfig buildPipelineConfig() const;

    // --- Widgets ---
    QTabWidget*   tabs_              = nullptr;

    // Map tab
    MapPanel*     map_panel_         = nullptr;
    QLabel*       label_bounds_      = nullptr;
    QPushButton*  btn_clear_sel_     = nullptr;
    QLineEdit*    edit_search_       = nullptr;
    QPushButton*  btn_satellite_     = nullptr;  // toggle satellite/street
    QLabel*       label_layer_info_  = nullptr;  // shows loaded GPKG layer
    QPushButton*  btn_focus_layer_   = nullptr;  // zoom to layer extent
    QPushButton*    btn_sel_bounds_     = nullptr;  // select layer bounding box
    QDoubleSpinBox* spin_pad_deg_        = nullptr;  // padding around layer bounds
    bool            map_satellite_      = true;

    // Cached layer extent for Focus button
    double gpkg_ext_minLat_ =  1e9, gpkg_ext_maxLat_ = -1e9;
    double gpkg_ext_minLon_ =  1e9, gpkg_ext_maxLon_ = -1e9;

    // Sources tab
    QLineEdit*    edit_tms_url_      = nullptr;
    QComboBox*    combo_dem_source_  = nullptr;
    QLineEdit*    edit_api_key_      = nullptr;
    QLineEdit*    edit_local_tiff_   = nullptr;
    QLineEdit*    edit_overpass_url_ = nullptr;

    // GPKG overlay
    QLineEdit*    edit_gpkg_path_    = nullptr;
    QComboBox*    combo_gpkg_layer_  = nullptr;
    QString       gpkg_path_;

    // Parameters tab
    QDoubleSpinBox* spin_resolution_   = nullptr;
    QSpinBox*       spin_zoom_         = nullptr;
    QComboBox*      combo_map_size_    = nullptr;
    QDoubleSpinBox* spin_road_width_   = nullptr;
    QLineEdit*      edit_output_dir_   = nullptr;
    QDoubleSpinBox* spin_tile_km_      = nullptr;  // 0 = no split, >0 = chunk size in km

    // Generate tab
    QPushButton*  btn_generate_      = nullptr;
    QPushButton*  btn_cancel_        = nullptr;
    QPushButton*  btn_qgis_export_   = nullptr;
    QPushButton*  btn_gather_         = nullptr;
    QProgressBar* progress_bar_      = nullptr;
    QTextEdit*    log_text_          = nullptr;

    // --- Pipeline ---
    std::unique_ptr<TerrainPipeline> pipeline_;
    GeoBounds current_bounds_;

    // --- Chunk sequencing ---
    QVector<GeoBounds> chunk_bounds_;
    QVector<QString>   chunk_dirs_;
    int                chunk_current_ = 0;

    // --- Geocoder ---
    QNetworkAccessManager* geocode_nam_ = nullptr;
};
