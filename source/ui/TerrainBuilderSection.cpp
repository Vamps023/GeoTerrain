#include "ui/TerrainBuilderSection.h"

#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QVBoxLayout>

namespace
{
QHBoxLayout* makeBrowseRow(QLineEdit* edit, QPushButton* browse)
{
    auto* row = new QHBoxLayout();
    row->setContentsMargins(0, 0, 0, 0);
    row->setSpacing(4);
    row->addWidget(edit, 1);
    row->addWidget(browse);
    return row;
}
}

TerrainBuilderSection::TerrainBuilderSection(QWidget* parent)
    : QWidget(parent)
{
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    auto* hint = new QLabel(
        "Build a native UNIGINE LandscapeTerrain from a heightmap and "
        "albedo TIFF. Files are decoded via GDAL and written to an .lmap, "
        "then a LandscapeLayerMap + ObjectLandscapeTerrain is spawned in "
        "the active world.",
        this);
    hint->setWordWrap(true);
    hint->setStyleSheet("color: #9aa4ad;");
    layout->addWidget(hint);

    // ---- Inputs ---------------------------------------------------------
    auto* inputs_grp = new QGroupBox("Inputs", this);
    auto* inputs_form = new QFormLayout(inputs_grp);
    inputs_form->setContentsMargins(8, 8, 8, 8);

    edit_heightmap_ = new QLineEdit(this);
    edit_heightmap_->setPlaceholderText("heightmap.tif (16-bit/32-bit grayscale)");
    auto* btn_heightmap = new QPushButton("Browse…", this);
    inputs_form->addRow("Heightmap:", makeBrowseRow(edit_heightmap_, btn_heightmap));

    edit_albedo_ = new QLineEdit(this);
    edit_albedo_->setPlaceholderText("albedo.tif (RGB/RGBA)");
    auto* btn_albedo = new QPushButton("Browse…", this);
    inputs_form->addRow("Albedo:", makeBrowseRow(edit_albedo_, btn_albedo));

    layout->addWidget(inputs_grp);

    // ---- Output ---------------------------------------------------------
    auto* output_grp = new QGroupBox("Output", this);
    auto* output_form = new QFormLayout(output_grp);
    output_form->setContentsMargins(8, 8, 8, 8);

    edit_output_ = new QLineEdit(this);
    edit_output_->setPlaceholderText("terrain.lmap (under the UNIGINE project data/)");
    auto* btn_output = new QPushButton("Browse…", this);
    output_form->addRow(".lmap file:", makeBrowseRow(edit_output_, btn_output));

    layout->addWidget(output_grp);

    // ---- Scale ----------------------------------------------------------
    auto* scale_grp = new QGroupBox("Real-world scale", this);
    auto* scale_form = new QFormLayout(scale_grp);
    scale_form->setContentsMargins(8, 8, 8, 8);

    spin_world_size_ = new QDoubleSpinBox(this);
    spin_world_size_->setRange(1.0, 1'000'000.0);
    spin_world_size_->setDecimals(2);
    spin_world_size_->setSingleStep(100.0);
    spin_world_size_->setValue(4096.0);
    spin_world_size_->setSuffix(" m");
    scale_form->addRow("World size (square):", spin_world_size_);

    spin_height_min_ = new QDoubleSpinBox(this);
    spin_height_min_->setRange(-12'000.0, 12'000.0);
    spin_height_min_->setDecimals(2);
    spin_height_min_->setValue(0.0);
    spin_height_min_->setSuffix(" m");
    scale_form->addRow("Elevation min:", spin_height_min_);

    spin_height_max_ = new QDoubleSpinBox(this);
    spin_height_max_->setRange(-12'000.0, 12'000.0);
    spin_height_max_->setDecimals(2);
    spin_height_max_->setValue(1000.0);
    spin_height_max_->setSuffix(" m");
    scale_form->addRow("Elevation max:", spin_height_max_);

    spin_tile_resolution_ = new QSpinBox(this);
    spin_tile_resolution_->setRange(256, 4096);
    spin_tile_resolution_->setSingleStep(256);
    spin_tile_resolution_->setValue(1024);
    spin_tile_resolution_->setSuffix(" px");
    spin_tile_resolution_->setToolTip(
        "Per-tile texel resolution stored in the .lmap. Source images are "
        "downscaled/tiled to fit.");
    scale_form->addRow("Tile resolution:", spin_tile_resolution_);

    layout->addWidget(scale_grp);

    // ---- Action ---------------------------------------------------------
    btn_build_ = new QPushButton("Generate Terrain", this);
    btn_build_->setStyleSheet(
        "QPushButton:enabled { background:#2e7d32; color:white; font-weight:bold; padding:6px; border-radius:3px; }"
        "QPushButton:enabled:hover { background:#388e3c; }");
    layout->addWidget(btn_build_);

    layout->addStretch(1);

    // ---- Wiring ---------------------------------------------------------
    connect(btn_heightmap, &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseHeightmap);
    connect(btn_albedo,    &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseAlbedo);
    connect(btn_output,    &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseOutput);
    connect(btn_build_,    &QPushButton::clicked, this, &TerrainBuilderSection::buildTerrainRequested);
}

QString TerrainBuilderSection::heightmapPath() const   { return edit_heightmap_->text().trimmed(); }
QString TerrainBuilderSection::albedoPath() const      { return edit_albedo_->text().trimmed(); }
QString TerrainBuilderSection::outputLmapPath() const  { return edit_output_->text().trimmed(); }
double  TerrainBuilderSection::worldSizeMeters() const { return spin_world_size_->value(); }
double  TerrainBuilderSection::heightMinMeters() const { return spin_height_min_->value(); }
double  TerrainBuilderSection::heightMaxMeters() const { return spin_height_max_->value(); }
int     TerrainBuilderSection::tileResolution() const  { return spin_tile_resolution_->value(); }

void TerrainBuilderSection::setHeightmapPath(const QString& path)  { edit_heightmap_->setText(path); }
void TerrainBuilderSection::setAlbedoPath(const QString& path)     { edit_albedo_->setText(path); }
void TerrainBuilderSection::setOutputLmapPath(const QString& path) { edit_output_->setText(path); }
void TerrainBuilderSection::setBuildEnabled(bool enabled)          { btn_build_->setEnabled(enabled); }

void TerrainBuilderSection::onBrowseHeightmap()
{
    const QString dir = QFileInfo(edit_heightmap_->text()).absolutePath();
    const QString path = QFileDialog::getOpenFileName(this, "Select heightmap TIFF", dir,
        "GeoTIFF / TIFF (*.tif *.tiff);;All files (*)");
    if (!path.isEmpty())
        edit_heightmap_->setText(path);
}

void TerrainBuilderSection::onBrowseAlbedo()
{
    const QString dir = QFileInfo(edit_albedo_->text()).absolutePath();
    const QString path = QFileDialog::getOpenFileName(this, "Select albedo TIFF", dir,
        "GeoTIFF / TIFF (*.tif *.tiff);;All files (*)");
    if (!path.isEmpty())
        edit_albedo_->setText(path);
}

void TerrainBuilderSection::onBrowseOutput()
{
    const QString dir = QFileInfo(edit_output_->text()).absolutePath();
    const QString path = QFileDialog::getSaveFileName(this, "Output .lmap", dir,
        "UNIGINE Landscape Map (*.lmap);;All files (*)");
    if (!path.isEmpty())
        edit_output_->setText(path);
}
