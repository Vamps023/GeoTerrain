#include "GeoTerrainPanel.h"
#include "MapPanel.h"

#include <QApplication>
#include <QDir>
#include <QFileDialog>
#include <QFont>
#include <QLabel>
#include <QMessageBox>
#include <QPalette>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>
#include <QShowEvent>
#include <QSizePolicy>
#include <QSplitter>

// ---------------------------------------------------------------------------
static QColor col(int r, int g, int b) { return QColor(r, g, b); }

GeoTerrainPanel::GeoTerrainPanel(QWidget* parent)
    : QWidget(parent)
    , pipeline_(std::make_unique<TerrainPipeline>(this))
{
    setupUi();
    setWindowTitle("GeoTerrain Generator");
    resize(520, 820);

    // Dark palette matching reference plugin
    QPalette pal;
    pal.setColor(QPalette::Window,          col(45,45,45));
    pal.setColor(QPalette::WindowText,      Qt::white);
    pal.setColor(QPalette::Base,            col(35,35,35));
    pal.setColor(QPalette::AlternateBase,   col(45,45,45));
    pal.setColor(QPalette::ToolTipBase,     Qt::white);
    pal.setColor(QPalette::ToolTipText,     Qt::white);
    pal.setColor(QPalette::Text,            Qt::white);
    pal.setColor(QPalette::Button,          col(60,60,60));
    pal.setColor(QPalette::ButtonText,      Qt::white);
    pal.setColor(QPalette::BrightText,      Qt::red);
    pal.setColor(QPalette::Link,            col(42,130,218));
    pal.setColor(QPalette::Highlight,       col(42,130,218));
    pal.setColor(QPalette::HighlightedText, Qt::black);
    setPalette(pal);
    setAutoFillBackground(true);

    connect(pipeline_.get(), &TerrainPipeline::progress,
            this,            &GeoTerrainPanel::onPipelineProgress);
    connect(pipeline_.get(), &TerrainPipeline::finished,
            this,            &GeoTerrainPanel::onPipelineFinished);
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::setupUi()
{
    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    // Header
    auto* header = new QLabel("  GeoTerrain Generator", this);
    QFont hf = header->font();
    hf.setBold(true);
    hf.setPointSize(13);
    header->setFont(hf);
    header->setFixedHeight(36);
    header->setStyleSheet("background-color: #1a1a2e; color: #4fc3f7; padding-left: 6px;");
    root->addWidget(header);

    tabs_ = new QTabWidget(this);
    tabs_->setStyleSheet(
        "QTabBar::tab { min-width: 100px; padding: 6px 12px; background: #3a3a3a; color: #ccc; }"
        "QTabBar::tab:selected { background: #1e88e5; color: white; font-weight: bold; }"
        "QTabWidget::pane { border: 1px solid #555; }");

    tabs_->addTab(buildMapTab(),        "Map");
    tabs_->addTab(buildSourcesTab(),    "Sources");
    tabs_->addTab(buildParametersTab(), "Parameters");
    tabs_->addTab(buildGenerateTab(),   "Generate");

    root->addWidget(tabs_);
}

// ---------------------------------------------------------------------------
QWidget* GeoTerrainPanel::buildMapTab()
{
    auto* w      = new QWidget();
    auto* layout = new QVBoxLayout(w);
    layout->setContentsMargins(6, 6, 6, 6);
    layout->setSpacing(6);

    // Instructions label
    auto* instr = new QLabel(
        "<b>Shift+drag</b> to select area &nbsp;|&nbsp; "
        "<b>Right-drag</b> or <b>drag</b> to pan &nbsp;|&nbsp; "
        "<b>Scroll</b> to zoom", w);
    instr->setWordWrap(true);
    instr->setStyleSheet("color: #aaa; font-size: 9pt;");
    layout->addWidget(instr);

    // TMS URL row
    auto* tms_row = new QHBoxLayout();
    tms_row->addWidget(new QLabel("TMS URL:", w));
    auto* tms_edit = new QLineEdit("https://tile.openstreetmap.org/{z}/{x}/{y}.png", w);
    tms_edit->setToolTip("XYZ tile URL with {z}/{x}/{y} placeholders");
    tms_row->addWidget(tms_edit);
    auto* tms_btn = new QPushButton("Apply", w);
    tms_btn->setFixedWidth(60);
    tms_row->addWidget(tms_btn);
    layout->addLayout(tms_row);

    // Map widget
    map_panel_ = new MapPanel(w);
    map_panel_->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
    layout->addWidget(map_panel_, 1);

    connect(tms_btn, &QPushButton::clicked, this, [this, tms_edit]()
    {
        map_panel_->setTileUrl(tms_edit->text());
    });

    // Bounds display
    label_bounds_ = new QLabel("No area selected", w);
    label_bounds_->setStyleSheet("color: #4fc3f7; font-size: 9pt; padding: 2px;");
    layout->addWidget(label_bounds_);

    // Clear button
    btn_clear_sel_ = new QPushButton("Clear Selection", w);
    btn_clear_sel_->setStyleSheet("QPushButton { background: #555; color: white; padding: 4px; }");
    connect(btn_clear_sel_, &QPushButton::clicked, this, [this]()
    {
        map_panel_->clearSelection();
        label_bounds_->setText("No area selected");
        current_bounds_ = GeoBounds{};
    });
    layout->addWidget(btn_clear_sel_);

    connect(map_panel_, &MapPanel::selectionChanged,
            this,       &GeoTerrainPanel::onSelectionChanged);

    return w;
}

// ---------------------------------------------------------------------------
QWidget* GeoTerrainPanel::buildSourcesTab()
{
    auto* w      = new QWidget();
    auto* layout = new QVBoxLayout(w);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    auto makeGroup = [&](const QString& title) -> QVBoxLayout*
    {
        auto* grp = new QGroupBox(title, w);
        grp->setStyleSheet("QGroupBox { color: #4fc3f7; font-weight: bold; "
                           "border: 1px solid #555; margin-top: 6px; padding-top: 4px; }");
        auto* gl = new QVBoxLayout(grp);
        layout->addWidget(grp);
        return gl;
    };

    auto addRow = [&](QVBoxLayout* gl, const QString& label, QWidget* widget)
    {
        auto* row = new QHBoxLayout();
        auto* lbl = new QLabel(label, w);
        lbl->setFixedWidth(120);
        row->addWidget(lbl);
        row->addWidget(widget);
        gl->addLayout(row);
    };

    // --- DEM ---
    auto* dem_gl = makeGroup("DEM Source");
    combo_dem_source_ = new QComboBox(w);
    combo_dem_source_->addItem("OpenTopography SRTM 30m", 0);
    combo_dem_source_->addItem("OpenTopography SRTM 90m", 1);
    combo_dem_source_->addItem("OpenTopography AW3D30",   2);
    combo_dem_source_->addItem("Local GeoTIFF file",      3);
    addRow(dem_gl, "DEM Source:", combo_dem_source_);

    edit_api_key_ = new QLineEdit(w);
    edit_api_key_->setPlaceholderText("OpenTopography API key (optional for low-res)");

    // Show/hide toggle instead of Password echo mode (avoids Qt/accessibility crash on paste)
    auto* api_row    = new QHBoxLayout();
    auto* api_label  = new QLabel("API Key:", w);
    api_label->setFixedWidth(120);
    auto* show_btn   = new QPushButton("Show", w);
    show_btn->setFixedWidth(44);
    show_btn->setCheckable(true);
    show_btn->setStyleSheet("QPushButton { background:#555; color:white; padding:2px; }");
    connect(show_btn, &QPushButton::toggled, this, [this, show_btn](bool checked) {
        edit_api_key_->setEchoMode(checked ? QLineEdit::Normal : QLineEdit::Password);
        show_btn->setText(checked ? "Hide" : "Show");
    });
    edit_api_key_->setEchoMode(QLineEdit::Normal);
    api_row->addWidget(api_label);
    api_row->addWidget(edit_api_key_);
    api_row->addWidget(show_btn);
    dem_gl->addLayout(api_row);

    auto* local_row = new QHBoxLayout();
    edit_local_tiff_ = new QLineEdit(w);
    edit_local_tiff_->setPlaceholderText("Path to local GeoTIFF (for Local source)");
    local_row->addWidget(edit_local_tiff_);
    auto* browse_btn = new QPushButton("Browse", w);
    browse_btn->setFixedWidth(60);
    local_row->addWidget(browse_btn);
    auto* local_label = new QLabel("Local File:", w);
    local_label->setFixedWidth(120);
    auto* lrow_w = new QWidget(w);
    auto* lrow_layout = new QHBoxLayout(lrow_w);
    lrow_layout->setContentsMargins(0,0,0,0);
    lrow_layout->addWidget(local_label);
    lrow_layout->addLayout(local_row);
    dem_gl->addWidget(lrow_w);

    connect(browse_btn, &QPushButton::clicked, this, [this]()
    {
        const QString path = QFileDialog::getOpenFileName(
            this, "Select GeoTIFF", QString(), "GeoTIFF (*.tif *.tiff)");
        if (!path.isEmpty())
            edit_local_tiff_->setText(path);
    });

    // Show/hide local row based on selection
    connect(combo_dem_source_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, [lrow_w](int idx) { lrow_w->setVisible(idx == 3); });
    lrow_w->setVisible(false);

    // --- TMS ---
    auto* tms_gl = makeGroup("TMS Imagery");
    edit_tms_url_ = new QLineEdit("https://tile.openstreetmap.org/{z}/{x}/{y}.png", w);
    edit_tms_url_->setToolTip("XYZ tile URL with {z}/{x}/{y} placeholders");
    addRow(tms_gl, "TMS URL:", edit_tms_url_);

    // --- OSM ---
    auto* osm_gl = makeGroup("OSM / Overpass");
    edit_overpass_url_ = new QLineEdit("https://overpass-api.de/api/interpreter", w);
    addRow(osm_gl, "Overpass URL:", edit_overpass_url_);

    layout->addStretch();
    return w;
}

// ---------------------------------------------------------------------------
QWidget* GeoTerrainPanel::buildParametersTab()
{
    auto* w      = new QWidget();
    auto* layout = new QVBoxLayout(w);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    auto makeGroup = [&](const QString& title) -> QVBoxLayout*
    {
        auto* grp = new QGroupBox(title, w);
        grp->setStyleSheet("QGroupBox { color: #4fc3f7; font-weight: bold; "
                           "border: 1px solid #555; margin-top: 6px; padding-top: 4px; }");
        auto* gl = new QVBoxLayout(grp);
        layout->addWidget(grp);
        return gl;
    };

    auto addRow = [&](QVBoxLayout* gl, const QString& label, QWidget* widget)
    {
        auto* row = new QHBoxLayout();
        auto* lbl = new QLabel(label, w);
        lbl->setFixedWidth(140);
        row->addWidget(lbl);
        row->addWidget(widget);
        gl->addLayout(row);
    };

    // --- Raster ---
    auto* raster_gl = makeGroup("Raster Settings");

    spin_resolution_ = new QDoubleSpinBox(w);
    spin_resolution_->setRange(1.0, 1000.0);
    spin_resolution_->setValue(30.0);
    spin_resolution_->setSingleStep(5.0);
    spin_resolution_->setSuffix(" m/px");
    spin_resolution_->setToolTip("Output resolution in metres per pixel");
    addRow(raster_gl, "Resolution:", spin_resolution_);

    spin_zoom_ = new QSpinBox(w);
    spin_zoom_->setRange(1, 19);
    spin_zoom_->setValue(14);
    spin_zoom_->setToolTip("TMS tile zoom level for albedo download");
    addRow(raster_gl, "Tile Zoom:", spin_zoom_);

    auto* crs_lbl = new QLabel(
        "<b>EPSG:4326 – WGS 84</b>  (GeoTIFF, Raw data)", w);
    crs_lbl->setStyleSheet("color:#a5d6a7; font-size:9pt; padding:2px;");
    crs_lbl->setToolTip(
        "Output CRS is fixed as EPSG:4326 WGS84.\n"
        "Compatible with QGIS \"Save Raster Layer as\" (Raw data, EPSG:4326).");
    addRow(raster_gl, "Output CRS:", crs_lbl);

    // --- Mask ---
    auto* mask_gl = makeGroup("Mask Settings");

    spin_road_width_ = new QDoubleSpinBox(w);
    spin_road_width_->setRange(1.0, 200.0);
    spin_road_width_->setValue(10.0);
    spin_road_width_->setSingleStep(1.0);
    spin_road_width_->setSuffix(" m");
    spin_road_width_->setToolTip("Road buffer width for rasterization");
    addRow(mask_gl, "Road Width:", spin_road_width_);

    // --- Output ---
    auto* out_gl = makeGroup("Output");

    auto* dir_row = new QHBoxLayout();
    edit_output_dir_ = new QLineEdit(QDir::homePath() + "/GeoTerrainExport", w);
    dir_row->addWidget(edit_output_dir_);
    auto* dir_btn = new QPushButton("Browse", w);
    dir_btn->setFixedWidth(60);
    dir_row->addWidget(dir_btn);

    auto* dir_lbl = new QLabel("Output Dir:", w);
    dir_lbl->setFixedWidth(140);
    auto* dir_widget = new QWidget(w);
    auto* dir_layout = new QHBoxLayout(dir_widget);
    dir_layout->setContentsMargins(0,0,0,0);
    dir_layout->addWidget(dir_lbl);
    dir_layout->addLayout(dir_row);
    out_gl->addWidget(dir_widget);

    connect(dir_btn, &QPushButton::clicked, this, [this]()
    {
        const QString dir = QFileDialog::getExistingDirectory(
            this, "Select Output Directory", edit_output_dir_->text());
        if (!dir.isEmpty())
            edit_output_dir_->setText(dir);
    });

    layout->addStretch();
    return w;
}

// ---------------------------------------------------------------------------
QWidget* GeoTerrainPanel::buildGenerateTab()
{
    auto* w      = new QWidget();
    auto* layout = new QVBoxLayout(w);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    // Summary
    auto* summary_grp = new QGroupBox("Pipeline Summary", w);
    summary_grp->setStyleSheet("QGroupBox { color: #4fc3f7; font-weight: bold; "
                               "border: 1px solid #555; margin-top: 6px; padding-top: 4px; }");
    auto* sg_layout = new QVBoxLayout(summary_grp);
    auto* summary_lbl = new QLabel(w);
    summary_lbl->setText(
        "<table cellspacing='4' style='color:#cccccc; font-size:9pt;'>"
        "<tr><td colspan='2'><b style='color:#4fc3f7;'>Steps</b></td></tr>"
        "<tr><td>1.</td><td>Fetch DEM heightmap &nbsp;<i>(OpenTopography)</i></td></tr>"
        "<tr><td>2.</td><td>Download TMS albedo tiles</td></tr>"
        "<tr><td>3.</td><td>Fetch OSM vector data</td></tr>"
        "<tr><td>4.</td><td>Rasterize OSM roads / buildings / vegetation</td></tr>"
        "<tr><td>5.</td><td>Write metadata.json</td></tr>"
        "<tr><td colspan='2'>&nbsp;</td></tr>"
        "<tr><td colspan='2'>"
          "<b style='color:#4fc3f7;'>Output</b>&nbsp;&nbsp;"
          "GeoTIFF &nbsp;|&nbsp; <b style='color:#a5d6a7;'>EPSG:4326 WGS 84</b>"
        "</td></tr>"
        "<tr><td colspan='2' style='color:#aaa;'>"
          "heightmap.tif &nbsp;&nbsp; albedo.tif &nbsp;&nbsp; mask.tif &nbsp;&nbsp; metadata.json"
        "</td></tr>"
        "</table>");
    summary_lbl->setTextFormat(Qt::RichText);
    summary_lbl->setContentsMargins(4, 4, 4, 4);
    sg_layout->addWidget(summary_lbl);
    layout->addWidget(summary_grp);

    // Auto QGIS export button
    auto* qgis_grp = new QGroupBox("Export for Unigine (EPSG:4326 GeoTIFF)", w);
    qgis_grp->setStyleSheet("QGroupBox { color: #ffcc80; font-weight: bold; "
                            "border: 1px solid #555; margin-top: 6px; padding-top: 4px; }");
    auto* qgis_layout = new QVBoxLayout(qgis_grp);
    auto* qgis_lbl = new QLabel(w);
    qgis_lbl->setText(
        "<span style='color:#ffe082; font-size:9pt;'>"
        "Runs <b>gdal_translate</b> on all three output files.<br>"
        "Format: <b>GeoTIFF</b> &nbsp;|&nbsp; "
        "CRS: <b style='color:#a5d6a7;'>EPSG:4326 WGS 84</b> &nbsp;|&nbsp; "
        "Mode: <b>Raw data</b><br>"
        "<span style='color:#aaa;'>Saves as &nbsp;"
        "heightmap_unigine.tif &nbsp; albedo_unigine.tif &nbsp; mask_unigine.tif</span>"
        "</span>");
    qgis_lbl->setTextFormat(Qt::RichText);
    qgis_lbl->setContentsMargins(4, 2, 4, 4);
    qgis_layout->addWidget(qgis_lbl);
    btn_qgis_export_ = new QPushButton("Export for Unigine (via QGIS GDAL)", w);
    btn_qgis_export_->setStyleSheet(
        "QPushButton { background-color: #5c4a00; color: #ffe082; padding: 8px; "
        "font-weight: bold; border-radius: 4px; border: 1px solid #ffcc80; }"
        "QPushButton:hover { background-color: #7a6200; }"
        "QPushButton:disabled { background-color: #3a3a3a; color: #777; }");
    btn_qgis_export_->setEnabled(false);
    connect(btn_qgis_export_, &QPushButton::clicked, this, &GeoTerrainPanel::onQgisExport);
    qgis_layout->addWidget(btn_qgis_export_);
    layout->addWidget(qgis_grp);

    // Buttons
    auto* btn_row = new QHBoxLayout();
    btn_generate_ = new QPushButton("Generate Terrain", w);
    btn_generate_->setStyleSheet(
        "QPushButton { background-color: #2a7f2a; color: white; padding: 10px; "
        "font-weight: bold; font-size: 11pt; border-radius: 4px; }"
        "QPushButton:disabled { background-color: #3a3a3a; color: #777; }");
    btn_row->addWidget(btn_generate_);

    btn_cancel_ = new QPushButton("Cancel", w);
    btn_cancel_->setEnabled(false);
    btn_cancel_->setFixedWidth(80);
    btn_cancel_->setStyleSheet(
        "QPushButton { background-color: #8f2a2a; color: white; padding: 10px; border-radius: 4px; }"
        "QPushButton:disabled { background-color: #3a3a3a; color: #777; }");
    btn_row->addWidget(btn_cancel_);
    layout->addLayout(btn_row);

    // Progress
    progress_bar_ = new QProgressBar(w);
    progress_bar_->setRange(0, 100);
    progress_bar_->setValue(0);
    progress_bar_->setStyleSheet(
        "QProgressBar { border: 1px solid #555; border-radius: 3px; text-align: center; color: white; }"
        "QProgressBar::chunk { background-color: #1e88e5; border-radius: 2px; }");
    layout->addWidget(progress_bar_);

    // Log
    auto* log_label = new QLabel("Log:", w);
    log_label->setStyleSheet("color: #aaa;");
    layout->addWidget(log_label);

    log_text_ = new QTextEdit(w);
    log_text_->setReadOnly(true);
    log_text_->setStyleSheet(
        "QTextEdit { background-color: #1a1a1a; color: #aaffaa; font-family: Consolas, monospace; font-size: 9pt; }");
    log_text_->setPlainText("Ready. Select area on Map tab, configure sources, then click Generate.\n");
    layout->addWidget(log_text_, 1);

    connect(btn_generate_, &QPushButton::clicked, this, &GeoTerrainPanel::onGenerate);
    connect(btn_cancel_,   &QPushButton::clicked, this, [this]()
    {
        pipeline_->cancel();
        appendLog("-- Cancelled by user --");
        setControlsEnabled(true);
    });

    return w;
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::showEvent(QShowEvent* event)
{
    QWidget::showEvent(event);
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onSelectionChanged(const GeoBounds& bounds)
{
    current_bounds_ = bounds;
    label_bounds_->setText(
        QString("N:%1  S:%2  W:%3  E:%4")
            .arg(bounds.north, 0, 'f', 5)
            .arg(bounds.south, 0, 'f', 5)
            .arg(bounds.west,  0, 'f', 5)
            .arg(bounds.east,  0, 'f', 5));
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onGenerate()
{
    if (pipeline_->isRunning())
        return;

    if (!current_bounds_.isValid())
    {
        QMessageBox::warning(this, "GeoTerrain",
            "No area selected.\n\nGo to the Map tab, hold Shift and drag to select a region.");
        tabs_->setCurrentIndex(0);
        return;
    }

    const PipelineConfig cfg = buildPipelineConfig();

    log_text_->clear();
    progress_bar_->setValue(0);
    appendLog("Starting pipeline...");
    appendLog(QString("Bounds: N=%1 S=%2 W=%3 E=%4")
              .arg(cfg.bounds.north, 0, 'f', 5)
              .arg(cfg.bounds.south, 0, 'f', 5)
              .arg(cfg.bounds.west,  0, 'f', 5)
              .arg(cfg.bounds.east,  0, 'f', 5));
    appendLog("Output: " + QString::fromStdString(cfg.output_dir));

    setControlsEnabled(false);

    // Switch to Generate tab so user sees progress
    tabs_->setCurrentIndex(3);

    pipeline_->start(cfg);
}

// ---------------------------------------------------------------------------
PipelineConfig GeoTerrainPanel::buildPipelineConfig() const
{
    PipelineConfig cfg;
    cfg.bounds = current_bounds_;

    const QString out_dir = edit_output_dir_ ? edit_output_dir_->text()
                                             : QDir::homePath() + "/GeoTerrainExport";
    cfg.output_dir = out_dir.toStdString();

    // DEM
    const int dem_idx = combo_dem_source_ ? combo_dem_source_->currentIndex() : 0;
    switch (dem_idx)
    {
    case 1:  cfg.dem.source = DEMFetcher::Source::OpenTopography_SRTM90m; break;
    case 2:  cfg.dem.source = DEMFetcher::Source::OpenTopography_AW3D30;  break;
    case 3:  cfg.dem.source = DEMFetcher::Source::LocalGeoTIFF;           break;
    default: cfg.dem.source = DEMFetcher::Source::OpenTopography_SRTM30m; break;
    }
    cfg.dem.api_key         = edit_api_key_     ? edit_api_key_->text().toStdString()     : "";
    cfg.dem.local_tiff_path = edit_local_tiff_  ? edit_local_tiff_->text().toStdString()  : "";
    cfg.dem.output_path     = cfg.output_dir + "/heightmap.tif";
    cfg.dem.resolution_m    = spin_resolution_  ? spin_resolution_->value()  : 30.0;

    // Tiles
    cfg.tiles.url_template  = edit_tms_url_     ? edit_tms_url_->text().toStdString()
                                                 : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    cfg.tiles.zoom_level    = spin_zoom_        ? spin_zoom_->value() : 14;
    cfg.tiles.output_path   = cfg.output_dir + "/albedo.tif";

    // OSM
    cfg.osm.overpass_url    = edit_overpass_url_ ? edit_overpass_url_->text().toStdString()
                                                  : "https://overpass-api.de/api/interpreter";
    cfg.osm.timeout_s       = 120;

    // Mask
    cfg.mask.output_path    = cfg.output_dir + "/mask.tif";
    cfg.mask.resolution_m   = cfg.dem.resolution_m;
    cfg.mask.road_width_m   = spin_road_width_  ? spin_road_width_->value() : 10.0;

    return cfg;
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onPipelineProgress(const QString& message, int percent)
{
    appendLog(message);
    progress_bar_->setValue(percent);
}

void GeoTerrainPanel::onPipelineFinished(bool success, const QString& error)
{
    progress_bar_->setValue(success ? 100 : progress_bar_->value());
    if (success)
    {
        appendLog("=== SUCCESS: Outputs written to " +
                  (edit_output_dir_ ? edit_output_dir_->text() : QString("Export dir")) + " ===");
        if (btn_qgis_export_) btn_qgis_export_->setEnabled(true);
    }
    else
        appendLog("=== FAILED: " + error + " ===");

    setControlsEnabled(true);
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onQgisExport()
{
    const QString gdal_translate =
        "C:/Users/snare.ext/Documents/Sogeclair Rail Simulation/Track Editor/cots/qgis/bin/gdal_translate.exe";

    if (!QFileInfo::exists(gdal_translate))
    {
        QMessageBox::critical(this, "QGIS Export",
            "gdal_translate.exe not found at:\n" + gdal_translate);
        return;
    }

    const QString out_dir = edit_output_dir_ ? edit_output_dir_->text()
                                             : QDir::homePath() + "/GeoTerrainExport";

    const QStringList files = { "heightmap.tif", "albedo.tif", "mask.tif" };
    int ok_count = 0;

    for (const QString& fname : files)
    {
        const QString src  = out_dir + "/" + fname;
        const QString base = fname.left(fname.lastIndexOf('.'));
        const QString dst  = out_dir + "/" + base + "_unigine.tif";

        if (!QFileInfo::exists(src))
        {
            appendLog("[SKIP] " + fname + " not found");
            continue;
        }

        appendLog("Exporting " + fname + " ...");

        // gdal_translate -of GTiff -a_srs EPSG:4326 -co COMPRESS=LZW src dst
        QStringList args;
        args << "-of" << "GTiff"
             << "-a_srs" << "EPSG:4326"
             << "-co" << "COMPRESS=LZW"
             << "-co" << "TILED=YES"
             << src << dst;

        QProcess proc;
        proc.setProgram(gdal_translate);
        proc.setArguments(args);

        // Set QGIS GDAL environment so projections database is found
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        const QString qgis_root = "C:/Users/snare.ext/Documents/Sogeclair Rail Simulation/Track Editor/cots/qgis";
        env.insert("GDAL_DATA",        qgis_root + "/share/gdal");
        env.insert("PROJ_DATA",        qgis_root + "/share/proj");
        env.insert("PATH",             qgis_root + "/bin;" + env.value("PATH"));
        proc.setProcessEnvironment(env);

        proc.start();
        proc.waitForFinished(60000);

        if (proc.exitCode() == 0)
        {
            appendLog("[OK] " + base + "_unigine.tif");
            ok_count++;
        }
        else
        {
            const QString err = proc.readAllStandardError().trimmed();
            appendLog("[FAIL] " + fname + ": " + err);
        }
    }

    if (ok_count > 0)
    {
        appendLog(QString("=== QGIS Export done: %1/3 files written to %2 ===")
                  .arg(ok_count).arg(out_dir));
        QMessageBox::information(this, "QGIS Export Complete",
            QString("%1 file(s) exported to:\n%2\n\nFiles: heightmap_unigine.tif, albedo_unigine.tif, mask_unigine.tif")
            .arg(ok_count).arg(out_dir));
    }
    else
    {
        appendLog("=== QGIS Export failed — no files written ===");
    }
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::appendLog(const QString& message)
{
    if (!log_text_)
        return;
    log_text_->append(message);
    if (auto* sb = log_text_->verticalScrollBar())
        sb->setValue(sb->maximum());
}

void GeoTerrainPanel::setControlsEnabled(bool enabled)
{
    if (btn_generate_) btn_generate_->setEnabled(enabled);
    if (btn_cancel_)   btn_cancel_->setEnabled(!enabled);
    if (tabs_)
    {
        tabs_->setTabEnabled(0, enabled);
        tabs_->setTabEnabled(1, enabled);
        tabs_->setTabEnabled(2, enabled);
    }
}
