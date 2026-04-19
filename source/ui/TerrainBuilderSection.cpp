#include "ui/TerrainBuilderSection.h"

#include <QDebug>
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
        "Pick a heightmap and albedo TIFF, choose where to save the .lmap, "
        "and press Generate. World size, elevation range and tile resolution "
        "are auto-computed from the heightmap's GeoTIFF metadata.",
        this);
    hint->setWordWrap(true);
    hint->setStyleSheet("color: #9aa4ad;");
    layout->addWidget(hint);

    // ---- Inputs ---------------------------------------------------------
    auto* inputs_grp = new QGroupBox("Inputs", this);
    auto* inputs_form = new QFormLayout(inputs_grp);
    inputs_form->setContentsMargins(8, 8, 8, 8);

    edit_heightmap_ = new QLineEdit(this);
    edit_heightmap_->setPlaceholderText("heightmap.tif (16-bit/32-bit grayscale GeoTIFF)");
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

    // ---- Auto-computed info --------------------------------------------
    auto* info_grp = new QGroupBox("Auto-computed scale (from heightmap)", this);
    auto* info_layout = new QVBoxLayout(info_grp);
    info_layout->setContentsMargins(8, 8, 8, 8);
    label_auto_params_ = new QLabel("Select a heightmap to compute parameters…", this);
    label_auto_params_->setWordWrap(true);
    label_auto_params_->setStyleSheet("color:#9ad27f; font-family:monospace;");
    info_layout->addWidget(label_auto_params_);
    layout->addWidget(info_grp);

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

    connect(edit_heightmap_, &QLineEdit::textChanged,
            this, &TerrainBuilderSection::heightmapPathChanged);
}

QString TerrainBuilderSection::heightmapPath() const
{
    if (!edit_heightmap_) return QString();
    return edit_heightmap_->text().trimmed();
}
QString TerrainBuilderSection::albedoPath() const
{
    if (!edit_albedo_) return QString();
    return edit_albedo_->text().trimmed();
}
QString TerrainBuilderSection::outputLmapPath() const
{
    if (!edit_output_) return QString();
    return edit_output_->text().trimmed();
}

void TerrainBuilderSection::setHeightmapPath(const QString& path)
{
    if (edit_heightmap_) edit_heightmap_->setText(path);
}
void TerrainBuilderSection::setAlbedoPath(const QString& path)
{
    if (edit_albedo_) edit_albedo_->setText(path);
}
void TerrainBuilderSection::setOutputLmapPath(const QString& path)
{
    if (edit_output_) edit_output_->setText(path);
}
void TerrainBuilderSection::setBuildEnabled(bool enabled)
{
    if (btn_build_) btn_build_->setEnabled(enabled);
}
void TerrainBuilderSection::setAutoParamsText(const QString& text)
{
    if (label_auto_params_) label_auto_params_->setText(text);
}

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
