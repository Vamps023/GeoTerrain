#include "GenerationSettingsSection.h"

#include <QDir>
#include <QFileDialog>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QVBoxLayout>

GenerationSettingsSection::GenerationSettingsSection(QWidget* parent)
    : QWidget(parent)
{
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    auto makeGroup = [&](const QString& title)
    {
        auto* grp = new QGroupBox(title, this);
        auto* gl = new QVBoxLayout(grp);
        layout->addWidget(grp);
        return gl;
    };

    auto addRow = [&](QVBoxLayout* gl, const QString& label, QWidget* widget)
    {
        auto* row = new QHBoxLayout();
        auto* lbl = new QLabel(label, this);
        lbl->setFixedWidth(140);
        row->addWidget(lbl);
        row->addWidget(widget);
        gl->addLayout(row);
    };

    auto* raster_gl = makeGroup("Raster Settings");
    spin_resolution_ = new QDoubleSpinBox(this);
    spin_resolution_->setRange(1.0, 1000.0);
    spin_resolution_->setValue(30.0);
    spin_resolution_->setSuffix(" m/px");
    addRow(raster_gl, "Resolution:", spin_resolution_);

    spin_zoom_ = new QSpinBox(this);
    spin_zoom_->setRange(1, 20);
    spin_zoom_->setValue(17);
    addRow(raster_gl, "Tile Zoom:", spin_zoom_);

    combo_map_size_ = new QComboBox(this);
    // Fixed square sizes only: guarantees heightmap + albedo share identical
    // dimensions and bbox, so LandscapeLayerMap tiles align 1:1. The legacy
    // "Native (tile-snapped)" option was removed because it produced
    // mismatched extents between the two rasters.
    combo_map_size_->addItem("1K (1024 x 1024)", 1024);
    combo_map_size_->addItem("2K (2048 x 2048)", 2048);
    combo_map_size_->addItem("3K (3072 x 3072)", 3072);
    combo_map_size_->addItem("4K (4096 x 4096)", 4096);
    combo_map_size_->setCurrentIndex(1);  // default 2K
    addRow(raster_gl, "Map Size:", combo_map_size_);

    auto* mask_gl = makeGroup("Mask Settings");
    spin_road_width_ = new QDoubleSpinBox(this);
    spin_road_width_->setRange(1.0, 200.0);
    spin_road_width_->setValue(10.0);
    spin_road_width_->setSuffix(" m");
    addRow(mask_gl, "Road Width:", spin_road_width_);

    auto* output_gl = makeGroup("Output");
    auto* output_row = new QHBoxLayout();
    edit_output_dir_ = new QLineEdit(QDir::homePath() + "/GeoTerrainExport", this);
    output_row->addWidget(edit_output_dir_);
    auto* browse_dir = new QPushButton("Browse", this);
    output_row->addWidget(browse_dir);
    auto* output_widget = new QWidget(this);
    auto* output_widget_row = new QHBoxLayout(output_widget);
    output_widget_row->setContentsMargins(0, 0, 0, 0);
    auto* output_lbl = new QLabel("Output Dir:", this);
    output_lbl->setFixedWidth(140);
    output_widget_row->addWidget(output_lbl);
    output_widget_row->addLayout(output_row);
    output_gl->addWidget(output_widget);
    connect(browse_dir, &QPushButton::clicked, this, [this]()
    {
        const QString dir = QFileDialog::getExistingDirectory(this, "Select Output Directory", edit_output_dir_->text());
        if (!dir.isEmpty())
            edit_output_dir_->setText(dir);
    });

    layout->addStretch();
}
