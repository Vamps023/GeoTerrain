#include "SourceSettingsSection.h"

#include <QFileDialog>
#include <QFrame>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QScrollArea>
#include <QVBoxLayout>

SourceSettingsSection::SourceSettingsSection(QWidget* parent)
    : QWidget(parent)
{
    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(0, 0, 0, 0);

    auto* scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    root->addWidget(scroll);

    auto* inner = new QWidget(scroll);
    auto* layout = new QVBoxLayout(inner);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);
    scroll->setWidget(inner);

    auto makeGroup = [&](const QString& title)
    {
        auto* grp = new QGroupBox(title, inner);
        auto* gl = new QVBoxLayout(grp);
        layout->addWidget(grp);
        return gl;
    };

    auto addRow = [&](QVBoxLayout* gl, const QString& label, QWidget* widget)
    {
        auto* row = new QHBoxLayout();
        auto* lbl = new QLabel(label, inner);
        lbl->setFixedWidth(120);
        row->addWidget(lbl);
        row->addWidget(widget);
        gl->addLayout(row);
    };

    auto* dem_gl = makeGroup("DEM Source");
    combo_dem_source_ = new QComboBox(inner);
    combo_dem_source_->addItem("SRTM GL1 ~30m (global)", 0);
    combo_dem_source_->addItem("SRTM GL3 ~90m (global)", 1);
    combo_dem_source_->addItem("ALOS AW3D30 ~30m (global)", 2);
    combo_dem_source_->addItem("Copernicus GLO-30 ~30m (global)", 3);
    combo_dem_source_->addItem("NASADEM ~30m (global)", 4);
    combo_dem_source_->addItem("USGS 3DEP ~10m (USA only)", 5);
    combo_dem_source_->addItem("Local GeoTIFF file", 6);
    addRow(dem_gl, "DEM Source:", combo_dem_source_);

    edit_api_key_ = new QLineEdit(inner);
    addRow(dem_gl, "API Key:", edit_api_key_);

    auto* local_row = new QHBoxLayout();
    edit_local_tiff_ = new QLineEdit(inner);
    local_row->addWidget(edit_local_tiff_);
    auto* browse_local = new QPushButton("Browse", inner);
    local_row->addWidget(browse_local);
    auto* local_widget = new QWidget(inner);
    auto* local_widget_row = new QHBoxLayout(local_widget);
    local_widget_row->setContentsMargins(0, 0, 0, 0);
    auto* local_lbl = new QLabel("Local File:", inner);
    local_lbl->setFixedWidth(120);
    local_widget_row->addWidget(local_lbl);
    local_widget_row->addLayout(local_row);
    dem_gl->addWidget(local_widget);
    local_widget->setVisible(false);

    connect(combo_dem_source_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            local_widget, [local_widget](int index) { local_widget->setVisible(index == 6); });
    connect(browse_local, &QPushButton::clicked, this, [this]()
    {
        const QString path = QFileDialog::getOpenFileName(this, "Select GeoTIFF", QString(), "GeoTIFF (*.tif *.tiff)");
        if (!path.isEmpty())
            edit_local_tiff_->setText(path);
    });

    auto* tms_gl = makeGroup("TMS Imagery");
    edit_tms_url_ = new QLineEdit(
        "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        inner);
    addRow(tms_gl, "TMS URL:", edit_tms_url_);

    auto* osm_gl = makeGroup("OSM / Overpass");
    edit_overpass_url_ = new QLineEdit("https://overpass-api.de/api/interpreter", inner);
    addRow(osm_gl, "Overpass URL:", edit_overpass_url_);

    auto* vector_gl = makeGroup("Vector Overlay (.gpkg / .shp)");
    auto* vector_path_row = new QHBoxLayout();
    edit_gpkg_path_ = new QLineEdit(inner);
    edit_gpkg_path_->setReadOnly(true);
    vector_path_row->addWidget(edit_gpkg_path_);
    auto* browse_vector = new QPushButton("Browse", inner);
    auto* clear_vector = new QPushButton("Clear", inner);
    vector_path_row->addWidget(browse_vector);
    vector_path_row->addWidget(clear_vector);
    vector_gl->addLayout(vector_path_row);

    combo_gpkg_layer_ = new QComboBox(inner);
    combo_gpkg_layer_->addItem("-- select a file first --");
    combo_gpkg_layer_->setEnabled(false);
    addRow(vector_gl, "Layer:", combo_gpkg_layer_);

    connect(browse_vector, &QPushButton::clicked, this, [this]()
    {
        const QString path = QFileDialog::getOpenFileName(
            this, "Select Vector File", QString(),
            "Vector Files (*.gpkg *.shp);;GeoPackage (*.gpkg);;Shapefile (*.shp)");
        if (!path.isEmpty())
        {
            edit_gpkg_path_->setText(path);
            emit vectorPathSelected(path);
        }
    });
    connect(clear_vector, &QPushButton::clicked, this, [this]()
    {
        edit_gpkg_path_->clear();
        setVectorLayers({});
        emit vectorPathSelected(QString());
    });
    connect(combo_gpkg_layer_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &SourceSettingsSection::vectorLayerIndexChanged);

    layout->addStretch();
}

void SourceSettingsSection::setVectorLayers(const QStringList& layers)
{
    combo_gpkg_layer_->clear();
    if (layers.isEmpty())
    {
        combo_gpkg_layer_->addItem("-- select a file first --");
        combo_gpkg_layer_->setEnabled(false);
        return;
    }

    combo_gpkg_layer_->addItems(layers);
    combo_gpkg_layer_->setEnabled(true);
}
