#include "ui/TerrainBuilderSection.h"

#include <QCheckBox>
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

    // ---- Mode toggle ----------------------------------------------------
    auto* mode_check = new QCheckBox("Multi-tile mode (folder input)", this);
    mode_check->setStyleSheet("color:#9aa4ad; font-weight:bold;");
    layout->addWidget(mode_check);

    // ---- Single-tile widget ---------------------------------------------
    single_tile_widget_ = new QWidget(this);
    auto* st_layout = new QVBoxLayout(single_tile_widget_);
    st_layout->setContentsMargins(0, 0, 0, 0);
    st_layout->setSpacing(6);

    auto* hint = new QLabel(
        "Pick a heightmap and albedo TIFF, choose where to save the .lmap, "
        "and press Generate. World size, elevation range and tile resolution "
        "are auto-computed from the heightmap's GeoTIFF metadata.",
        single_tile_widget_);
    hint->setWordWrap(true);
    hint->setStyleSheet("color: #9aa4ad;");
    st_layout->addWidget(hint);

    auto* st_inputs_grp = new QGroupBox("Inputs", single_tile_widget_);
    auto* st_inputs_form = new QFormLayout(st_inputs_grp);
    st_inputs_form->setContentsMargins(8, 8, 8, 8);

    edit_heightmap_ = new QLineEdit(single_tile_widget_);
    edit_heightmap_->setPlaceholderText("heightmap.tif (16-bit/32-bit grayscale GeoTIFF)");
    auto* btn_heightmap = new QPushButton("Browse…", single_tile_widget_);
    st_inputs_form->addRow("Heightmap:", makeBrowseRow(edit_heightmap_, btn_heightmap));

    edit_albedo_ = new QLineEdit(single_tile_widget_);
    edit_albedo_->setPlaceholderText("albedo.tif (RGB/RGBA)");
    auto* btn_albedo = new QPushButton("Browse…", single_tile_widget_);
    st_inputs_form->addRow("Albedo:", makeBrowseRow(edit_albedo_, btn_albedo));
    st_layout->addWidget(st_inputs_grp);

    auto* st_out_grp = new QGroupBox("Output", single_tile_widget_);
    auto* st_out_form = new QFormLayout(st_out_grp);
    st_out_form->setContentsMargins(8, 8, 8, 8);
    edit_output_ = new QLineEdit(single_tile_widget_);
    edit_output_->setPlaceholderText("terrain.lmap (under the UNIGINE project data/)");
    auto* btn_output = new QPushButton("Browse…", single_tile_widget_);
    st_out_form->addRow(".lmap file:", makeBrowseRow(edit_output_, btn_output));
    st_layout->addWidget(st_out_grp);

    layout->addWidget(single_tile_widget_);

    // ---- Multi-tile widget ----------------------------------------------
    multi_tile_widget_ = new QWidget(this);
    multi_tile_widget_->setVisible(false);
    auto* mt_layout = new QVBoxLayout(multi_tile_widget_);
    mt_layout->setContentsMargins(0, 0, 0, 0);
    mt_layout->setSpacing(6);

    auto* mt_hint = new QLabel(
        "Point to the heightmap/ and albedo/ folders from Gather. "
        "Files must be named chunk_N_heightmap.tif / chunk_N_albedo.tif. "
        "Each chunk becomes one aligned LandscapeLayerMap in the world.",
        multi_tile_widget_);
    mt_hint->setWordWrap(true);
    mt_hint->setStyleSheet("color: #9aa4ad;");
    mt_layout->addWidget(mt_hint);

    auto* mt_inputs_grp = new QGroupBox("Folder Inputs", multi_tile_widget_);
    auto* mt_inputs_form = new QFormLayout(mt_inputs_grp);
    mt_inputs_form->setContentsMargins(8, 8, 8, 8);

    edit_heightmap_folder_ = new QLineEdit(multi_tile_widget_);
    edit_heightmap_folder_->setPlaceholderText("GatheredExport/heightmap/");
    auto* btn_hm_folder = new QPushButton("Browse…", multi_tile_widget_);
    mt_inputs_form->addRow("Heightmap folder:", makeBrowseRow(edit_heightmap_folder_, btn_hm_folder));

    edit_albedo_folder_ = new QLineEdit(multi_tile_widget_);
    edit_albedo_folder_->setPlaceholderText("GatheredExport/albedo/");
    auto* btn_alb_folder = new QPushButton("Browse…", multi_tile_widget_);
    mt_inputs_form->addRow("Albedo folder:", makeBrowseRow(edit_albedo_folder_, btn_alb_folder));
    mt_layout->addWidget(mt_inputs_grp);

    auto* mt_out_grp = new QGroupBox("Output", multi_tile_widget_);
    auto* mt_out_form = new QFormLayout(mt_out_grp);
    mt_out_form->setContentsMargins(8, 8, 8, 8);
    edit_output_folder_ = new QLineEdit(multi_tile_widget_);
    edit_output_folder_->setPlaceholderText("data/ folder for .lmap files");
    auto* btn_out_folder = new QPushButton("Browse…", multi_tile_widget_);
    mt_out_form->addRow(".lmap folder:", makeBrowseRow(edit_output_folder_, btn_out_folder));
    mt_layout->addWidget(mt_out_grp);

    layout->addWidget(multi_tile_widget_);

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
    connect(btn_heightmap,  &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseHeightmap);
    connect(btn_albedo,     &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseAlbedo);
    connect(btn_output,     &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseOutput);
    connect(btn_hm_folder,  &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseHeightmapFolder);
    connect(btn_alb_folder, &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseAlbedoFolder);
    connect(btn_out_folder, &QPushButton::clicked, this, &TerrainBuilderSection::onBrowseOutputFolder);
    connect(btn_build_,     &QPushButton::clicked, this, &TerrainBuilderSection::buildTerrainRequested);
    connect(mode_check,     &QCheckBox::toggled,   this, &TerrainBuilderSection::onModeToggled);

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

// ---- Accessors ----------------------------------------------------------
QString TerrainBuilderSection::heightmapFolderPath() const
{
    if (!edit_heightmap_folder_) return QString();
    return edit_heightmap_folder_->text().trimmed();
}
QString TerrainBuilderSection::albedoFolderPath() const
{
    if (!edit_albedo_folder_) return QString();
    return edit_albedo_folder_->text().trimmed();
}
QString TerrainBuilderSection::outputLmapFolderPath() const
{
    if (!edit_output_folder_) return QString();
    return edit_output_folder_->text().trimmed();
}
bool TerrainBuilderSection::isMultiTileMode() const
{
    return multi_tile_widget_ && multi_tile_widget_->isVisible();
}

// ---- Browse slots -------------------------------------------------------
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

void TerrainBuilderSection::onBrowseHeightmapFolder()
{
    const QString dir = QFileDialog::getExistingDirectory(this, "Select heightmap folder",
        edit_heightmap_folder_->text());
    if (!dir.isEmpty())
        edit_heightmap_folder_->setText(dir);
}

void TerrainBuilderSection::onBrowseAlbedoFolder()
{
    const QString dir = QFileDialog::getExistingDirectory(this, "Select albedo folder",
        edit_albedo_folder_->text());
    if (!dir.isEmpty())
        edit_albedo_folder_->setText(dir);
}

void TerrainBuilderSection::onBrowseOutputFolder()
{
    const QString dir = QFileDialog::getExistingDirectory(this, "Select output .lmap folder",
        edit_output_folder_->text());
    if (!dir.isEmpty())
        edit_output_folder_->setText(dir);
}

void TerrainBuilderSection::onModeToggled(bool multi_tile)
{
    if (single_tile_widget_) single_tile_widget_->setVisible(!multi_tile);
    if (multi_tile_widget_)  multi_tile_widget_->setVisible(multi_tile);
}
