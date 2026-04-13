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

#include <memory>

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
    void onPipelineProgress(const QString& message, int percent);
    void onPipelineFinished(bool success, const QString& error);

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

    // Sources tab
    QLineEdit*    edit_tms_url_      = nullptr;
    QComboBox*    combo_dem_source_  = nullptr;
    QLineEdit*    edit_api_key_      = nullptr;
    QLineEdit*    edit_local_tiff_   = nullptr;
    QLineEdit*    edit_overpass_url_ = nullptr;

    // Parameters tab
    QDoubleSpinBox* spin_resolution_   = nullptr;
    QSpinBox*       spin_zoom_         = nullptr;
    QComboBox*      combo_epsg_        = nullptr;
    QDoubleSpinBox* spin_road_width_   = nullptr;
    QLineEdit*      edit_output_dir_   = nullptr;

    // Generate tab
    QPushButton*  btn_generate_      = nullptr;
    QPushButton*  btn_cancel_        = nullptr;
    QProgressBar* progress_bar_      = nullptr;
    QTextEdit*    log_text_          = nullptr;

    // --- Pipeline ---
    std::unique_ptr<TerrainPipeline> pipeline_;
    GeoBounds current_bounds_;
};
