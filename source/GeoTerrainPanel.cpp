#include "GeoTerrainPanel.h"
#include "MapPanel.h"

#include <gdal_priv.h>
#include <ogrsf_frmts.h>

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
#include <QFrame>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QScrollArea>
#include <QShowEvent>
#include <QTimer>
#include <QUrlQuery>
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
    layout->setSpacing(4);

    // --- Row 1: Search bar + Satellite toggle ---
    auto* top_row = new QHBoxLayout();
    top_row->setSpacing(4);

    edit_search_ = new QLineEdit(w);
    edit_search_->setPlaceholderText("Search place... (e.g. Paris, Houston TX)");
    edit_search_->setToolTip("Type a place name and press Enter or click Search");
    top_row->addWidget(edit_search_, 1);

    auto* btn_search = new QPushButton("Search", w);
    btn_search->setFixedWidth(60);
    btn_search->setToolTip("Geocode and pan to place");
    top_row->addWidget(btn_search);

    btn_satellite_ = new QPushButton("Street", w);
    btn_satellite_->setFixedWidth(60);
    btn_satellite_->setToolTip("Toggle between Satellite and Street map");
    btn_satellite_->setStyleSheet(
        "QPushButton { background:#1e6a2e; color:white; font-weight:bold; padding:4px; border-radius:3px; }"
        "QPushButton:hover { background:#27923e; }");
    top_row->addWidget(btn_satellite_);

    layout->addLayout(top_row);

    // --- Row 2: Instructions ---
    auto* instr = new QLabel(
        "<b>Shift+drag</b> to select &nbsp;|&nbsp; "
        "<b>Drag</b> to pan &nbsp;|&nbsp; "
        "<b>Scroll</b> to zoom", w);
    instr->setStyleSheet("color: #888; font-size: 8pt;");
    layout->addWidget(instr);

    // --- Map widget ---
    map_panel_ = new MapPanel(w);
    map_panel_->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
    // Start on satellite
    map_panel_->setTileUrl(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}");
    layout->addWidget(map_panel_, 1);

    // --- Row 3: GPKG Layer info bar ---
    auto* layer_row = new QHBoxLayout();
    layer_row->setSpacing(4);
    label_layer_info_ = new QLabel("No vector layer loaded", w);
    label_layer_info_->setStyleSheet("color:#ffe082; font-size:8pt; padding:2px;");
    layer_row->addWidget(label_layer_info_, 1);
    // Padding control
    auto* pad_lbl = new QLabel("Pad:", w);
    pad_lbl->setStyleSheet("color:#aaa; font-size:8pt;");
    layer_row->addWidget(pad_lbl);
    spin_pad_deg_ = new QDoubleSpinBox(w);
    spin_pad_deg_->setRange(0.0, 1.0);
    spin_pad_deg_->setValue(0.01);
    spin_pad_deg_->setSingleStep(0.005);
    spin_pad_deg_->setDecimals(3);
    spin_pad_deg_->setSuffix("°");
    spin_pad_deg_->setFixedWidth(72);
    spin_pad_deg_->setToolTip("Extra padding added around the layer bounding box (~1km per 0.01°)");
    layer_row->addWidget(spin_pad_deg_);

    btn_sel_bounds_ = new QPushButton("Select Bounds", w);
    auto* btn_sel_bounds = btn_sel_bounds_;
    btn_sel_bounds->setFixedWidth(95);
    btn_sel_bounds->setEnabled(false);
    btn_sel_bounds->setToolTip("Auto-select the bounding box of the loaded layer as the terrain area");
    btn_sel_bounds->setStyleSheet(
        "QPushButton { background:#555; color:white; padding:3px; border-radius:3px; }"
        "QPushButton:enabled { background:#6a1ea8; }"
        "QPushButton:hover:enabled { background:#8a2ecc; }");
    layer_row->addWidget(btn_sel_bounds);

    btn_focus_layer_ = new QPushButton("Focus Layer", w);
    btn_focus_layer_->setFixedWidth(85);
    btn_focus_layer_->setEnabled(false);
    btn_focus_layer_->setToolTip("Zoom map to loaded GPKG/SHP layer extent");
    btn_focus_layer_->setStyleSheet(
        "QPushButton { background:#555; color:white; padding:3px; border-radius:3px; }"
        "QPushButton:enabled { background:#1e5ea8; }"
        "QPushButton:hover:enabled { background:#2474cc; }");
    layer_row->addWidget(btn_focus_layer_);
    layout->addLayout(layer_row);

    // --- Row 4: Bounds + Preview Grid + Clear ---
    auto* bot_row = new QHBoxLayout();
    label_bounds_ = new QLabel("No area selected", w);
    label_bounds_->setStyleSheet("color: #4fc3f7; font-size: 9pt; padding: 2px;");
    bot_row->addWidget(label_bounds_, 1);

    auto* btn_preview_grid = new QPushButton("Preview Grid", w);
    btn_preview_grid->setFixedWidth(90);
    btn_preview_grid->setToolTip(
        "Show chunk grid on map based on Parameters > Chunk Size.\n"
        "Click individual chunks to skip them before generating.");
    btn_preview_grid->setStyleSheet(
        "QPushButton { background:#555; color:white; padding:3px; border-radius:3px; }"
        "QPushButton:hover { background:#2a6a2a; }");
    bot_row->addWidget(btn_preview_grid);

    btn_clear_sel_ = new QPushButton("Clear", w);
    btn_clear_sel_->setFixedWidth(55);
    btn_clear_sel_->setStyleSheet("QPushButton { background:#555; color:white; padding:3px; border-radius:3px; }");
    bot_row->addWidget(btn_clear_sel_);
    layout->addLayout(bot_row);

    // --- Connections ---
    connect(map_panel_, &MapPanel::selectionChanged,
            this,       &GeoTerrainPanel::onSelectionChanged);

    connect(btn_clear_sel_, &QPushButton::clicked, this, [this]()
    {
        map_panel_->clearSelection();
        label_bounds_->setText("No area selected");
        current_bounds_ = GeoBounds{};
    });

    // Satellite / Street toggle
    connect(btn_satellite_, &QPushButton::clicked, this, [this]()
    {
        map_satellite_ = !map_satellite_;
        if (map_satellite_)
        {
            map_panel_->setTileUrl(
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}");
            btn_satellite_->setText("Street");
            btn_satellite_->setStyleSheet(
                "QPushButton { background:#1e6a2e; color:white; font-weight:bold; padding:4px; border-radius:3px; }"
                "QPushButton:hover { background:#27923e; }");
        }
        else
        {
            map_panel_->setTileUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
            btn_satellite_->setText("Satellite");
            btn_satellite_->setStyleSheet(
                "QPushButton { background:#6a4a1e; color:white; font-weight:bold; padding:4px; border-radius:3px; }"
                "QPushButton:hover { background:#8a6228; }");
        }
    });

    // Preview Grid button — computes chunk grid from current bounds + Parameters chunk size
    connect(btn_preview_grid, &QPushButton::clicked, this, [this]()
    {
        if (!map_panel_ || !current_bounds_.isValid()) return;
        const double chunk_km = spin_tile_km_ ? spin_tile_km_->value() : 0.0;
        if (chunk_km < 1.0)
        {
            map_panel_->clearChunkGrid();
            appendLog("[Grid] Chunk size is 0 — set Parameters > Chunk Size first");
            return;
        }
        const GeoBounds& b = current_bounds_;
        const double centre_lat     = (b.north + b.south) * 0.5;
        const double deg_per_km_lat = 1.0 / 111.0;
        const double deg_per_km_lon = 1.0 / (111.0 * std::cos(centre_lat * M_PI / 180.0));
        const double chunk_lat = chunk_km * deg_per_km_lat;
        const double chunk_lon = chunk_km * deg_per_km_lon;
        const int rows = std::max(1, (int)std::ceil((b.north - b.south) / chunk_lat));
        const int cols = std::max(1, (int)std::ceil((b.east  - b.west)  / chunk_lon));

        QVector<GeoBounds> grid;
        for (int r = 0; r < rows; ++r)
            for (int c = 0; c < cols; ++c)
            {
                GeoBounds cb;
                cb.south = b.south + r * chunk_lat;
                cb.north = std::min(b.north, cb.south + chunk_lat);
                cb.west  = b.west  + c * chunk_lon;
                cb.east  = std::min(b.east,  cb.west  + chunk_lon);
                grid << cb;
            }
        map_panel_->setChunkGrid(grid);
        appendLog(QString("[Grid] %1 x %2 = %3 chunks shown — click to skip").arg(rows).arg(cols).arg(grid.size()));
        tabs_->setCurrentIndex(0);  // switch to Map tab
    });

    // Search — Enter or button
    connect(btn_search,   &QPushButton::clicked,  this, &GeoTerrainPanel::onSearchPlace);
    connect(edit_search_, &QLineEdit::returnPressed, this, &GeoTerrainPanel::onSearchPlace);

    // Select Bounds button — sets the map selection rectangle to the layer bounding box
    connect(btn_sel_bounds, &QPushButton::clicked, this, [this]()
    {
        if (gpkg_ext_minLat_ < gpkg_ext_maxLat_ && gpkg_ext_minLon_ < gpkg_ext_maxLon_)
        {
            const double pad = spin_pad_deg_ ? spin_pad_deg_->value() : 0.01;
            GeoBounds b;
            b.north = gpkg_ext_maxLat_ + pad;
            b.south = gpkg_ext_minLat_ - pad;
            b.west  = gpkg_ext_minLon_ - pad;
            b.east  = gpkg_ext_maxLon_ + pad;
            map_panel_->setSelection(b);
            map_panel_->clearChunkGrid();  // clear old grid when bounds change
            map_panel_->centerOn(
                (b.north + b.south) * 0.5,
                (b.west  + b.east)  * 0.5, 13);
        }
    });

    // Focus Layer button
    connect(btn_focus_layer_, &QPushButton::clicked, this, [this]()
    {
        if (gpkg_ext_minLat_ < gpkg_ext_maxLat_ && gpkg_ext_minLon_ < gpkg_ext_maxLon_)
        {
            map_panel_->centerOn(
                (gpkg_ext_minLat_ + gpkg_ext_maxLat_) * 0.5,
                (gpkg_ext_minLon_ + gpkg_ext_maxLon_) * 0.5, 13);
        }
    });

    return w;
}

// ---------------------------------------------------------------------------
QWidget* GeoTerrainPanel::buildSourcesTab()
{
    // Wrap everything in a scroll area so all groups are reachable
    auto* scroll = new QScrollArea();
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);

    auto* w      = new QWidget();
    auto* layout = new QVBoxLayout(w);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);
    scroll->setWidget(w);

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
    combo_dem_source_->addItem("SRTM GL1  ~30m  (global)",           0);
    combo_dem_source_->addItem("SRTM GL3  ~90m  (global)",           1);
    combo_dem_source_->addItem("ALOS AW3D30  ~30m  (global)",        2);
    combo_dem_source_->addItem("Copernicus GLO-30  ~30m  (global)",  3);
    combo_dem_source_->addItem("NASADEM  ~30m  (global)",            4);
    combo_dem_source_->addItem("USGS 3DEP  ~10m  (USA only)",        5);
    combo_dem_source_->addItem("Local GeoTIFF file",                 6);
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
            this, [lrow_w](int idx) { lrow_w->setVisible(idx == 6); });
    lrow_w->setVisible(false);

    // --- TMS ---
    auto* tms_gl = makeGroup("TMS Imagery");

    // Preset selector — sorted by quality (best first)
    auto* preset_combo = new QComboBox(w);
    preset_combo->addItem("ESRI Clarity  ~0.3m  (best quality)",
        QString("https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"));
    preset_combo->addItem("ESRI World Imagery  ~0.3-1m",
        QString("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"));
    preset_combo->addItem("Google Satellite  ~0.3m  (urban)",
        QString("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"));
    preset_combo->addItem("Google Hybrid  (satellite+roads)",
        QString("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"));
    preset_combo->addItem("Bing Aerial  ~0.3m",
        QString("https://ecn.t0.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1"));
    preset_combo->addItem("OpenStreetMap  (street map)",
        QString("https://tile.openstreetmap.org/{z}/{x}/{y}.png"));
    preset_combo->addItem("Custom URL...", QString());
    preset_combo->setToolTip("Select a tile source — ESRI Clarity and Google give ~0.3m at zoom 19-20");
    addRow(tms_gl, "Preset:", preset_combo);

    edit_tms_url_ = new QLineEdit(
        "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", w);
    edit_tms_url_->setToolTip("XYZ tile URL — use {z}/{x}/{y} or {z}/{y}/{x} depending on the server.");
    addRow(tms_gl, "TMS URL:", edit_tms_url_);

    connect(preset_combo, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, [this, preset_combo](int idx)
    {
        const QString url = preset_combo->itemData(idx).toString();
        if (!url.isEmpty())
            edit_tms_url_->setText(url);
    });

    // --- OSM ---
    auto* osm_gl = makeGroup("OSM / Overpass");
    edit_overpass_url_ = new QLineEdit("https://overpass-api.de/api/interpreter", w);
    addRow(osm_gl, "Overpass URL:", edit_overpass_url_);

    // --- Vector Overlay (GeoPackage / Shapefile) ---
    auto* gpkg_gl = makeGroup("Vector Overlay (.gpkg / .shp)");

    // Path row: text field + Browse button
    auto* gpkg_path_row = new QHBoxLayout();
    edit_gpkg_path_ = new QLineEdit(w);
    edit_gpkg_path_->setPlaceholderText("Browse for a .gpkg or .shp file...");
    edit_gpkg_path_->setReadOnly(true);
    edit_gpkg_path_->setAcceptDrops(false);
    auto* gpkg_browse_btn = new QPushButton("Browse", w);
    gpkg_browse_btn->setFixedWidth(70);
    auto* gpkg_clear_btn  = new QPushButton("Clear",  w);
    gpkg_clear_btn->setFixedWidth(55);
    gpkg_path_row->addWidget(edit_gpkg_path_);
    gpkg_path_row->addWidget(gpkg_browse_btn);
    gpkg_path_row->addWidget(gpkg_clear_btn);
    gpkg_gl->addLayout(gpkg_path_row);

    // Layer selector
    combo_gpkg_layer_ = new QComboBox(w);
    combo_gpkg_layer_->addItem("-- select a file first --");
    combo_gpkg_layer_->setEnabled(false);
    addRow(gpkg_gl, "Layer:", combo_gpkg_layer_);

    // Load GPKG layers helper — populates combo from file using GDAL
    auto loadGpkgLayers = [this](const QString& path)
    {
        gpkg_path_ = path;
        edit_gpkg_path_->setText(path);
        combo_gpkg_layer_->clear();
        combo_gpkg_layer_->setEnabled(false);
        if (map_panel_) map_panel_->clearOverlay();

        GDALAllRegister();
        GDALDataset* ds = static_cast<GDALDataset*>(
            GDALOpenEx(path.toUtf8().constData(), GDAL_OF_VECTOR | GDAL_OF_READONLY,
                       nullptr, nullptr, nullptr));
        if (!ds)
        {
            combo_gpkg_layer_->addItem("-- failed to open file --");
            return;
        }
        const int n = ds->GetLayerCount();
        combo_gpkg_layer_->blockSignals(true);
        for (int i = 0; i < n; ++i)
        {
            OGRLayer* lyr = ds->GetLayer(i);
            if (lyr) combo_gpkg_layer_->addItem(QString::fromUtf8(lyr->GetName()), i);
        }
        combo_gpkg_layer_->blockSignals(false);
        GDALClose(ds);
        combo_gpkg_layer_->setEnabled(n > 0);
        if (n > 0) onGpkgLayerChanged(0);
    };

    connect(gpkg_browse_btn, &QPushButton::clicked, w, [this, loadGpkgLayers]()
    {
        const QString path = QFileDialog::getOpenFileName(
            this, "Select Vector File", QString(),
            "Vector Files (*.gpkg *.shp);;GeoPackage (*.gpkg);;Shapefile (*.shp)");
        if (!path.isEmpty()) loadGpkgLayers(path);
    });

    connect(gpkg_clear_btn, &QPushButton::clicked, w, [this]()
    {
        gpkg_path_.clear();
        edit_gpkg_path_->clear();
        combo_gpkg_layer_->clear();
        combo_gpkg_layer_->addItem("-- select a file first --");
        combo_gpkg_layer_->setEnabled(false);
        if (map_panel_) map_panel_->clearOverlay();
    });

    connect(combo_gpkg_layer_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &GeoTerrainPanel::onGpkgLayerChanged);

    // Accept file drops on the path field
    edit_gpkg_path_->installEventFilter(w);
    w->setAcceptDrops(true);

    layout->addStretch();
    return scroll;
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
    spin_zoom_->setRange(1, 20);
    spin_zoom_->setValue(17);
    spin_zoom_->setToolTip(
        "TMS tile zoom level.\n"
        "Zoom 14 = ~10m/px  |  16 = ~2.5m/px\n"
        "Zoom 17 = ~1.2m/px  |  18 = ~0.6m/px\n"
        "Zoom 19 = ~0.3m/px  |  20 = ~0.15m/px (very large!)");
    addRow(raster_gl, "Tile Zoom:", spin_zoom_);

    // Live GSD label — updates as zoom changes
    auto* gsd_lbl = new QLabel(w);
    gsd_lbl->setStyleSheet("color:#ffe082; font-size:9pt; padding-left:4px;");
    auto updateGsd = [gsd_lbl](int z)
    {
        // Approx GSD at equator: 156543 / 2^z metres per pixel
        const double gsd = 156543.0 / (1 << z);
        QString s;
        if      (gsd >= 1000) s = QString::number(gsd/1000.0, 'f', 1) + " km/px";
        else if (gsd >= 1.0)  s = QString::number(gsd,        'f', 1) + " m/px";
        else                  s = QString::number(gsd*100.0,  'f', 0) + " cm/px";
        gsd_lbl->setText("≈ " + s + " at equator");
    };
    updateGsd(spin_zoom_->value());
    connect(spin_zoom_, QOverload<int>::of(&QSpinBox::valueChanged), w, updateGsd);
    addRow(raster_gl, "Approx GSD:", gsd_lbl);

    // Zoom quality presets
    auto* zoom_preset = new QComboBox(w);
    zoom_preset->addItem("Low    ~10 m/px  (zoom 14)",  14);
    zoom_preset->addItem("Medium  ~2.5 m/px  (zoom 16)", 16);
    zoom_preset->addItem("High    ~1.2 m/px  (zoom 17)", 17);
    zoom_preset->addItem("Ultra   ~0.6 m/px  (zoom 18)", 18);
    zoom_preset->addItem("Max     ~0.3 m/px  (zoom 19)", 19);
    zoom_preset->setCurrentIndex(2);  // default High
    zoom_preset->setToolTip("Quick zoom preset — sets the zoom spinner above");
    connect(zoom_preset, QOverload<int>::of(&QComboBox::currentIndexChanged),
            w, [this, zoom_preset](int idx)
    { spin_zoom_->setValue(zoom_preset->itemData(idx).toInt()); });
    addRow(raster_gl, "Quality Preset:", zoom_preset);

    combo_map_size_ = new QComboBox(w);
    combo_map_size_->addItem("Native (tile-snapped)", 0);
    combo_map_size_->addItem("1K  (1024 x 1024)",    1024);
    combo_map_size_->addItem("2K  (2048 x 2048)",    2048);
    combo_map_size_->addItem("3K  (3072 x 3072)",    3072);
    combo_map_size_->addItem("4K  (4096 x 4096)",    4096);
    combo_map_size_->setCurrentIndex(2);  // default 2K
    combo_map_size_->setToolTip("Resample all outputs (albedo, heightmap, mask) to this square size");
    addRow(raster_gl, "Map Size:", combo_map_size_);

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

    // --- Tile Split ---
    auto* split_gl = makeGroup("Area Splitting (large areas)");

    spin_tile_km_ = new QDoubleSpinBox(w);
    spin_tile_km_->setRange(0.0, 500.0);
    spin_tile_km_->setValue(0.0);
    spin_tile_km_->setSingleStep(5.0);
    spin_tile_km_->setDecimals(1);
    spin_tile_km_->setSuffix(" km");
    spin_tile_km_->setSpecialValueText("Disabled (single area)");
    spin_tile_km_->setToolTip(
        "Split the selected area into chunks of this size.\n"
        "Each chunk is generated separately into its own subfolder.\n"
        "Set to 0 to disable splitting (single area).\n"
        "Example: 5 km splits a 50km route into ~10 tiles.");
    addRow(split_gl, "Chunk Size:", spin_tile_km_);

    auto* split_info = new QLabel(
        "Each chunk is exported to <output>/chunk_R_C/\n"
        "where R=row, C=column in the grid.", w);
    split_info->setStyleSheet("color:#888; font-size:8pt; padding:2px;");
    split_info->setWordWrap(true);
    split_gl->addWidget(split_info);

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

    btn_gather_ = new QPushButton("Gather All Chunks into One Folder", w);
    btn_gather_->setToolTip(
        "Copies every chunk's UnigineExport files into a single GatheredExport/ folder,\n"
        "prefixing each file with its chunk name  (e.g. chunk_0_0_heightmap.tif).");
    btn_gather_->setStyleSheet(
        "QPushButton { background-color: #1a4a6a; color: #80d8ff; padding: 7px; "
        "font-weight: bold; border-radius: 4px; border: 1px solid #4fc3f7; }"
        "QPushButton:hover { background-color: #1e5f88; }"
        "QPushButton:disabled { background-color: #3a3a3a; color: #777; }");
    btn_gather_->setEnabled(false);
    connect(btn_gather_, &QPushButton::clicked, this, &GeoTerrainPanel::onGatherExport);
    qgis_layout->addWidget(btn_gather_);

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

    const double chunk_km = spin_tile_km_ ? spin_tile_km_->value() : 0.0;

    if (chunk_km < 1.0)
    {
        // --- Single area (no split) ---
        const PipelineConfig cfg = buildPipelineConfig();
        log_text_->clear();
        progress_bar_->setValue(0);
        appendLog("Starting pipeline...");
        appendLog(QString("Bounds: N=%1 S=%2 W=%3 E=%4")
                  .arg(cfg.bounds.north, 0, 'f', 5).arg(cfg.bounds.south, 0, 'f', 5)
                  .arg(cfg.bounds.west,  0, 'f', 5).arg(cfg.bounds.east,  0, 'f', 5));
        appendLog("Output: " + QString::fromStdString(cfg.output_dir));
        setControlsEnabled(false);
        tabs_->setCurrentIndex(3);
        pipeline_->start(cfg);
        return;
    }

    // --- Split into chunks ---
    // ~111 km per degree latitude; longitude varies with cos(lat)
    const GeoBounds& b       = current_bounds_;
    const double centre_lat  = (b.north + b.south) * 0.5;
    const double deg_per_km_lat = 1.0 / 111.0;
    const double deg_per_km_lon = 1.0 / (111.0 * std::cos(centre_lat * M_PI / 180.0));

    const double chunk_lat = chunk_km * deg_per_km_lat;
    const double chunk_lon = chunk_km * deg_per_km_lon;

    const int rows = std::max(1, (int)std::ceil((b.north - b.south) / chunk_lat));
    const int cols = std::max(1, (int)std::ceil((b.east  - b.west)  / chunk_lon));

    log_text_->clear();
    progress_bar_->setValue(0);
    const QString base_dir = edit_output_dir_ ? edit_output_dir_->text()
                                              : QDir::homePath() + "/GeoTerrainExport";

    // Build full chunk grid
    QVector<GeoBounds> all_chunks;
    QVector<QString>   all_dirs;
    for (int r = 0; r < rows; ++r)
        for (int c = 0; c < cols; ++c)
        {
            GeoBounds cb;
            cb.south = b.south + r * chunk_lat;
            cb.north = std::min(b.north, cb.south + chunk_lat);
            cb.west  = b.west  + c * chunk_lon;
            cb.east  = std::min(b.east,  cb.west  + chunk_lon);
            all_chunks << cb;
            all_dirs   << QString("%1/chunk_%2_%3").arg(base_dir).arg(r).arg(c);
        }

    // Get enabled mask from map panel (if grid was shown)
    QVector<bool> enabled = map_panel_ ? map_panel_->chunkEnabled() : QVector<bool>();
    if (enabled.size() != all_chunks.size())
        enabled.fill(true, all_chunks.size());  // default all on if no grid shown

    // Filter to only enabled chunks
    chunk_bounds_.clear();
    chunk_dirs_.clear();
    chunk_current_ = 0;
    int skipped = 0;
    for (int i = 0; i < all_chunks.size(); ++i)
    {
        if (enabled[i]) { chunk_bounds_ << all_chunks[i]; chunk_dirs_ << all_dirs[i]; }
        else ++skipped;
    }

    appendLog(QString("=== Split mode: %1 km chunks -> %2 x %3 grid = %4 tiles (%5 skipped) ===")
              .arg(chunk_km).arg(rows).arg(cols).arg(chunk_bounds_.size()).arg(skipped));
    tabs_->setCurrentIndex(3);

    setControlsEnabled(false);

    // Switch finished signal to chunk handler
    disconnect(pipeline_.get(), &TerrainPipeline::finished,
               this, &GeoTerrainPanel::onPipelineFinished);
    connect(pipeline_.get(), &TerrainPipeline::finished,
            this, &GeoTerrainPanel::onChunkFinished);

    // Kick off first chunk (singleShot with no args — use lambda)
    QTimer::singleShot(0, this, [this]() { onChunkFinished(true, QString()); });
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onChunkFinished(bool /*ok*/, const QString& err)
{
    if (!err.isEmpty())
        appendLog("[WARN] Chunk failed: " + err);

    if (chunk_current_ >= chunk_bounds_.size())
    {
        // All done — restore normal connection
        disconnect(pipeline_.get(), &TerrainPipeline::finished,
                   this, &GeoTerrainPanel::onChunkFinished);
        connect(pipeline_.get(), &TerrainPipeline::finished,
                this, &GeoTerrainPanel::onPipelineFinished);
        appendLog(QString("=== All %1 chunks complete ===").arg(chunk_bounds_.size()));
        appendLog("    Each folder: heightmap.tif  albedo.tif  mask.tif");
        progress_bar_->setValue(100);
        if (btn_qgis_export_) btn_qgis_export_->setEnabled(true);
        setControlsEnabled(true);
        return;
    }

    const int       idx = chunk_current_++;
    const GeoBounds cb  = chunk_bounds_[idx];
    const QString   dir = chunk_dirs_[idx];
    QDir().mkpath(dir);

    PipelineConfig cfg    = buildPipelineConfig();
    cfg.bounds            = cb;
    cfg.output_dir        = dir.toStdString();
    cfg.dem.output_path   = cfg.output_dir + "/heightmap.tif";
    cfg.tiles.output_path = cfg.output_dir + "/albedo.tif";
    cfg.mask.output_path  = cfg.output_dir + "/mask.tif";

    appendLog(QString("--- Chunk %1/%2  [%3] ---")
              .arg(idx + 1).arg(chunk_bounds_.size()).arg(QFileInfo(dir).fileName()));
    appendLog(QString("    N=%1  S=%2  W=%3  E=%4")
              .arg(cb.north, 0, 'f', 5).arg(cb.south, 0, 'f', 5)
              .arg(cb.west,  0, 'f', 5).arg(cb.east,  0, 'f', 5));
    progress_bar_->setValue(int(100.0 * idx / chunk_bounds_.size()));

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
    case 3:  cfg.dem.source = DEMFetcher::Source::OpenTopography_COP30;   break;
    case 4:  cfg.dem.source = DEMFetcher::Source::OpenTopography_NASADEM; break;
    case 5:  cfg.dem.source = DEMFetcher::Source::OpenTopography_3DEP10m; break;
    case 6:  cfg.dem.source = DEMFetcher::Source::LocalGeoTIFF;           break;
    default: cfg.dem.source = DEMFetcher::Source::OpenTopography_SRTM30m; break;
    }
    cfg.dem.api_key         = edit_api_key_     ? edit_api_key_->text().toStdString()     : "";
    cfg.dem.local_tiff_path = edit_local_tiff_  ? edit_local_tiff_->text().toStdString()  : "";
    cfg.dem.output_path     = cfg.output_dir + "/heightmap.tif";
    cfg.dem.resolution_m    = spin_resolution_  ? spin_resolution_->value()  : 30.0;

    // Tiles
    cfg.tiles.url_template  = edit_tms_url_     ? edit_tms_url_->text().toStdString()
                                                 : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    cfg.tiles.zoom_level    = spin_zoom_        ? spin_zoom_->value() : 14;
    cfg.tiles.target_size   = combo_map_size_   ? combo_map_size_->currentData().toInt() : 0;
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
    const QString qgis_root      = "C:/Users/snare.ext/Documents/Sogeclair Rail Simulation/Track Editor/cots/qgis";
    const QString gdal_translate  = qgis_root + "/bin/gdal_translate.exe";
    const QString ogr2ogr         = qgis_root + "/bin/ogr2ogr.exe";

    if (!QFileInfo::exists(gdal_translate))
    {
        QMessageBox::critical(this, "QGIS Export",
            "gdal_translate.exe not found at:\n" + gdal_translate);
        return;
    }

    const QString base_out = edit_output_dir_ ? edit_output_dir_->text()
                                              : QDir::homePath() + "/GeoTerrainExport";

    // QGIS GDAL environment
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("GDAL_DATA", qgis_root + "/share/gdal");
    env.insert("PROJ_DATA", qgis_root + "/share/proj");
    env.insert("PATH",      qgis_root + "/bin;" + env.value("PATH"));

    auto runProc = [&](const QString& prog, const QStringList& args, const QString& label) -> bool
    {
        QProcess proc;
        proc.setProgram(prog);
        proc.setArguments(args);
        proc.setProcessEnvironment(env);
        proc.start();
        proc.waitForFinished(120000);
        if (proc.exitCode() == 0) { appendLog("[OK] " + label); return true; }
        appendLog("[FAIL] " + label + ": " +
                  QString::fromUtf8(proc.readAllStandardError()).trimmed());
        return false;
    };

    // --- Per-directory export helper ---
    // src_dir: folder containing raw outputs (heightmap.tif, albedo.tif, ...)
    // dst_dir: where to write the QGIS-converted copies
    // Returns number of files converted
    auto exportDir = [&](const QString& src_dir, const QString& dst_dir) -> int
    {
        QDir().mkpath(dst_dir);
        appendLog("  → " + dst_dir);
        int n = 0;

        // GeoTIFFs
        const QStringList tifs = { "heightmap.tif", "albedo.tif", "mask.tif",
                                   "vegetation_mask.tif", "mask_preview.tif" };
        for (const QString& fname : tifs)
        {
            const QString src = src_dir + "/" + fname;
            const QString dst = dst_dir + "/" + fname;
            if (!QFileInfo::exists(src)) continue;
            QStringList args;
            args << "-of" << "GTiff" << "-a_srs" << "EPSG:4326"
                 << "-co" << "COMPRESS=LZW" << "-co" << "TILED=YES"
                 << src << dst;
            if (runProc(gdal_translate, args, fname)) n++;
        }

        // Shapefiles
        if (QFileInfo::exists(ogr2ogr))
        {
            const QStringList shps = { "roads", "railways", "buildings", "vegetation", "water" };
            for (const QString& layer : shps)
            {
                const QString src = src_dir + "/" + layer + ".shp";
                const QString dst = dst_dir + "/" + layer + ".shp";
                if (!QFileInfo::exists(src)) continue;
                for (const QString& ext : { ".shp", ".shx", ".dbf", ".prj", ".cpg" })
                    QFile::remove(dst_dir + "/" + layer + ext);
                QStringList args;
                args << "-f" << "ESRI Shapefile"
                     << "-a_srs" << "EPSG:4326"
                     << "-lco" << "ENCODING=UTF-8"
                     << "-lco" << "RESIZE=NO"
                     << "-overwrite" << dst << src;
                if (runProc(ogr2ogr, args, layer + ".shp")) n++;
            }
        }
        return n;
    };

    // --- Collect directories to process ---
    // 1. Base output dir itself (single-area runs)
    // 2. All chunk_R_C subfolders (split runs)
    QStringList src_dirs;
    src_dirs << base_out;

    QDir base_qdir(base_out);
    const QStringList chunk_dirs = base_qdir.entryList(
        QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString& cd : chunk_dirs)
        src_dirs << base_out + "/" + cd;

    appendLog(QString("=== Unigine Export: processing %1 director(ies) ===").arg(src_dirs.size()));

    int total_ok = 0;
    for (const QString& src_dir : src_dirs)
    {
        const bool is_chunk = src_dir != base_out;
        const QString label = is_chunk ? QFileInfo(src_dir).fileName() : "base";
        appendLog("--- " + label + " ---");
        const QString dst_dir = src_dir + "/UnigineExport";
        total_ok += exportDir(src_dir, dst_dir);
    }

    if (total_ok > 0)
    {
        const bool has_chunks = src_dirs.size() > 1;
        const QString msg = has_chunks
            ? QString("%1 file(s) exported across %2 chunk folders.\nEach chunk → chunk_R_C/UnigineExport/\n\nUse 'Gather All Chunks' to merge into one folder.")
              .arg(total_ok).arg(src_dirs.size())
            : QString("%1 file(s) exported to:\n%2/UnigineExport/").arg(total_ok).arg(base_out);
        appendLog("=== Unigine Export done: " + QString::number(total_ok) + " file(s) ===");
        if (btn_gather_ && has_chunks) btn_gather_->setEnabled(true);
        QMessageBox::information(this, "Unigine Export Complete", msg);
    }
    else
    {
        appendLog("=== Unigine Export failed — no files written ===");
    }
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onGatherExport()
{
    const QString base_out = edit_output_dir_ ? edit_output_dir_->text()
                                              : QDir::homePath() + "/GeoTerrainExport";

    const QString gather_dir = base_out + "/GatheredExport";
    QDir().mkpath(gather_dir);

    QDir base_qdir(base_out);
    const QStringList chunk_names = base_qdir.entryList(
        QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);

    if (chunk_names.isEmpty())
    {
        appendLog("[Gather] No chunk_* folders found in " + base_out);
        return;
    }

    appendLog("=== Gather: collecting into " + gather_dir + " ===");

    int total = 0, skipped = 0;
    for (const QString& chunk_name : chunk_names)
    {
        const QString src_export = base_out + "/" + chunk_name + "/UnigineExport";
        if (!QDir(src_export).exists())
        {
            appendLog("[Gather] No UnigineExport/ in " + chunk_name + " — skipping");
            ++skipped;
            continue;
        }

        const QStringList files = QDir(src_export).entryList(QDir::Files, QDir::Name);
        for (const QString& fname : files)
        {
            const QString src  = src_export + "/" + fname;
            const QString dst  = gather_dir + "/" + chunk_name + "_" + fname;

            // Remove stale destination so QFile::copy succeeds
            QFile::remove(dst);
            if (QFile::copy(src, dst))
            {
                ++total;
            }
            else
            {
                appendLog("[Gather] WARN: failed to copy " + fname + " from " + chunk_name);
            }
        }
        appendLog("  [" + chunk_name + "] " + QString::number(files.size()) + " file(s) gathered");
    }

    appendLog(QString("=== Gather complete: %1 file(s) from %2 chunk(s) (%3 skipped) ===")
              .arg(total).arg(chunk_names.size() - skipped).arg(skipped));

    if (total > 0)
    {
        QMessageBox::information(this, "Gather Complete",
            QString("%1 file(s) gathered into:\n%2\n\nNaming: chunk_R_C_filename.tif")
            .arg(total).arg(gather_dir));
    }
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onSearchPlace()
{
    if (!edit_search_ || !map_panel_) return;
    const QString query = edit_search_->text().trimmed();
    if (query.isEmpty()) return;

    if (!geocode_nam_)
        geocode_nam_ = new QNetworkAccessManager(this);

    QUrl url("https://nominatim.openstreetmap.org/search");
    QUrlQuery q;
    q.addQueryItem("q",      query);
    q.addQueryItem("format", "json");
    q.addQueryItem("limit",  "1");
    url.setQuery(q);

    QNetworkRequest req(url);
    req.setRawHeader("User-Agent", "GeoTerrainEditorPlugin/1.0");

    QNetworkReply* reply = geocode_nam_->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, query]()
    {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError)
        {
            appendLog("[Search] Network error: " + reply->errorString());
            return;
        }
        const QByteArray data = reply->readAll();
        const QJsonDocument doc = QJsonDocument::fromJson(data);
        if (!doc.isArray() || doc.array().isEmpty())
        {
            appendLog("[Search] No results for: " + query);
            return;
        }
        const QJsonObject obj = doc.array().first().toObject();
        const double lat = obj["lat"].toString().toDouble();
        const double lon = obj["lon"].toString().toDouble();
        const QString name = obj["display_name"].toString();
        appendLog("[Search] Found: " + name);
        map_panel_->centerOn(lat, lon, 13);
    });
}

// ---------------------------------------------------------------------------
void GeoTerrainPanel::onGpkgLayerChanged(int index)
{
    if (!map_panel_ || gpkg_path_.isEmpty()) return;
    if (!combo_gpkg_layer_ || index < 0 || index >= combo_gpkg_layer_->count()) return;

    const int layer_idx = combo_gpkg_layer_->itemData(index).toInt();

    GDALAllRegister();
    GDALDataset* ds = static_cast<GDALDataset*>(
        GDALOpenEx(gpkg_path_.toUtf8().constData(),
                   GDAL_OF_VECTOR | GDAL_OF_READONLY, nullptr, nullptr, nullptr));
    if (!ds) return;

    OGRLayer* lyr = ds->GetLayer(layer_idx);
    if (!lyr) { GDALClose(ds); return; }

    // Always reproject to EPSG:4326
    OGRSpatialReference wgs84;
    wgs84.importFromEPSG(4326);
    wgs84.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
    const OGRSpatialReference* src_srs_const = lyr->GetSpatialRef();
    OGRCoordinateTransformation* ct = nullptr;
    if (src_srs_const)
    {
        OGRSpatialReference src_copy;
        src_copy.CopyGeogCSFrom(src_srs_const);
        src_copy = *src_srs_const;
        src_copy.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);
        ct = OGRCreateCoordinateTransformation(&src_copy, &wgs84);
    }

    OverlayLayer overlay;
    overlay.name  = combo_gpkg_layer_->currentText();
    overlay.color = QColor(255, 165, 0);  // orange

    lyr->ResetReading();
    constexpr int MAX_FEATURES = 50000;
    int feat_count = 0;

    // Recursive helper — reads X/Y after transform (guaranteed lon/lat)
    std::function<void(OGRGeometry*)> extractGeom = [&](OGRGeometry* geom)
    {
        if (!geom) return;
        const OGRwkbGeometryType gt = wkbFlatten(geom->getGeometryType());

        if (gt == wkbLineString || gt == wkbLinearRing)
        {
            OGRLineString* ls = static_cast<OGRLineString*>(geom);
            const int np = ls->getNumPoints();
            if (np < 2) return;
            OverlayRing ring;
            ring.closed = (gt == wkbLinearRing);
            ring.points.reserve(np);
            for (int i = 0; i < np; ++i)
            {
                const double x = ls->getX(i), y = ls->getY(i);
                // Sanity check — valid lon/lat range
                if (x < -180.0 || x > 180.0 || y < -90.0 || y > 90.0) return;
                ring.points << QPointF(x, y);
            }
            if (ring.points.size() >= 2)
                overlay.rings << ring;
        }
        else if (gt == wkbPolygon)
        {
            OGRPolygon* poly = static_cast<OGRPolygon*>(geom);
            if (OGRLinearRing* ext = poly->getExteriorRing())
            {
                const int np = ext->getNumPoints();
                OverlayRing ring;
                ring.closed = true;
                ring.points.reserve(np);
                bool valid = true;
                for (int i = 0; i < np; ++i)
                {
                    const double x = ext->getX(i), y = ext->getY(i);
                    if (x < -180.0 || x > 180.0 || y < -90.0 || y > 90.0)
                        { valid = false; break; }
                    ring.points << QPointF(x, y);
                }
                if (valid && ring.points.size() >= 2)
                    overlay.rings << ring;
            }
        }
        else if (gt == wkbMultiLineString || gt == wkbMultiPolygon ||
                 gt == wkbGeometryCollection)
        {
            OGRGeometryCollection* col = static_cast<OGRGeometryCollection*>(geom);
            for (int i = 0; i < col->getNumGeometries(); ++i)
                extractGeom(col->getGeometryRef(i));
        }
    };

    OGRFeature* feat;
    while ((feat = lyr->GetNextFeature()) != nullptr && feat_count < MAX_FEATURES)
    {
        OGRGeometry* geom = feat->GetGeometryRef();
        if (geom)
        {
            // Clone so transform doesn't mutate the feature's geometry
            OGRGeometry* clone = geom->clone();
            if (ct) clone->transform(ct);
            extractGeom(clone);
            OGRGeometryFactory::destroyGeometry(clone);
        }
        OGRFeature::DestroyFeature(feat);
        ++feat_count;
    }

    if (ct) OCTDestroyCoordinateTransformation(ct);
    GDALClose(ds);

    map_panel_->setOverlayLayers({ overlay });
    appendLog(QString("[GPKG] Layer '%1' loaded: %2 features, %3 rings")
              .arg(overlay.name).arg(feat_count).arg(overlay.rings.size()));

    // Cache extent and update map tab layer bar
    gpkg_ext_minLat_ =  1e9; gpkg_ext_maxLat_ = -1e9;
    gpkg_ext_minLon_ =  1e9; gpkg_ext_maxLon_ = -1e9;
    for (const OverlayRing& r : overlay.rings)
        for (const QPointF& pt : r.points)
        {
            gpkg_ext_minLon_ = std::min(gpkg_ext_minLon_, pt.x());
            gpkg_ext_maxLon_ = std::max(gpkg_ext_maxLon_, pt.x());
            gpkg_ext_minLat_ = std::min(gpkg_ext_minLat_, pt.y());
            gpkg_ext_maxLat_ = std::max(gpkg_ext_maxLat_, pt.y());
        }

    if (label_layer_info_)
        label_layer_info_->setText(QString("Layer: %1  (%2 features)")
                                   .arg(overlay.name).arg(feat_count));
    if (btn_focus_layer_)
        btn_focus_layer_->setEnabled(gpkg_ext_minLat_ < gpkg_ext_maxLat_);
    if (btn_sel_bounds_)
        btn_sel_bounds_->setEnabled(gpkg_ext_minLat_ < gpkg_ext_maxLat_);

    // Auto-centre map on layer extent
    if (gpkg_ext_minLat_ < gpkg_ext_maxLat_)
        map_panel_->centerOn(
            (gpkg_ext_minLat_ + gpkg_ext_maxLat_) * 0.5,
            (gpkg_ext_minLon_ + gpkg_ext_maxLon_) * 0.5, 13);
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
