#include "MapSelectionSection.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QSizePolicy>
#include <QVBoxLayout>

MapSelectionSection::MapSelectionSection(QWidget* parent)
    : QWidget(parent)
{
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(6, 6, 6, 6);
    layout->setSpacing(4);

    auto* top_row = new QHBoxLayout();
    edit_search_ = new QLineEdit(this);
    edit_search_->setPlaceholderText("Search place... (e.g. Paris, Houston TX)");
    top_row->addWidget(edit_search_, 1);

    auto* btn_search = new QPushButton("Search", this);
    btn_search->setFixedWidth(60);
    top_row->addWidget(btn_search);

    btn_satellite_ = new QPushButton("Street", this);
    btn_satellite_->setFixedWidth(60);
    top_row->addWidget(btn_satellite_);
    layout->addLayout(top_row);

    auto* instr = new QLabel("<b>Shift+drag</b> to select | <b>Drag</b> to pan | <b>Scroll</b> to zoom", this);
    instr->setStyleSheet("color: #888; font-size: 8pt;");
    layout->addWidget(instr);

    map_panel_ = new MapPanel(this);
    map_panel_->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
    layout->addWidget(map_panel_, 1);

    auto* layer_row = new QHBoxLayout();
    label_layer_info_ = new QLabel("No vector layer loaded", this);
    label_layer_info_->setStyleSheet("color:#ffe082; font-size:8pt; padding:2px;");
    layer_row->addWidget(label_layer_info_, 1);

    auto* pad_lbl = new QLabel("Pad:", this);
    pad_lbl->setStyleSheet("color:#aaa; font-size:8pt;");
    layer_row->addWidget(pad_lbl);

    spin_pad_deg_ = new QDoubleSpinBox(this);
    spin_pad_deg_->setRange(0.0, 1.0);
    spin_pad_deg_->setValue(0.01);
    spin_pad_deg_->setSingleStep(0.005);
    spin_pad_deg_->setDecimals(3);
    spin_pad_deg_->setSuffix(" deg");
    spin_pad_deg_->setFixedWidth(84);
    layer_row->addWidget(spin_pad_deg_);

    btn_select_bounds_ = new QPushButton("Select Bounds", this);
    btn_select_bounds_->setEnabled(false);
    layer_row->addWidget(btn_select_bounds_);

    btn_focus_layer_ = new QPushButton("Focus Layer", this);
    btn_focus_layer_->setEnabled(false);
    layer_row->addWidget(btn_focus_layer_);
    layout->addLayout(layer_row);

    auto* bottom_row = new QHBoxLayout();
    label_bounds_ = new QLabel("No area selected", this);
    label_bounds_->setStyleSheet("color: #4fc3f7; font-size: 9pt; padding: 2px;");
    bottom_row->addWidget(label_bounds_, 1);

    auto* btn_preview_grid = new QPushButton("Preview Grid", this);
    bottom_row->addWidget(btn_preview_grid);

    auto* btn_clear_sel = new QPushButton("Clear", this);
    btn_clear_sel->setFixedWidth(55);
    bottom_row->addWidget(btn_clear_sel);
    layout->addLayout(bottom_row);

    connect(btn_search, &QPushButton::clicked, this, &MapSelectionSection::searchRequested);
    connect(edit_search_, &QLineEdit::returnPressed, this, &MapSelectionSection::searchRequested);
    connect(btn_clear_sel, &QPushButton::clicked, this, &MapSelectionSection::clearSelectionRequested);
    connect(btn_preview_grid, &QPushButton::clicked, this, &MapSelectionSection::previewGridRequested);
    connect(btn_focus_layer_, &QPushButton::clicked, this, &MapSelectionSection::focusLayerRequested);
    connect(btn_select_bounds_, &QPushButton::clicked, this, &MapSelectionSection::selectLayerBoundsRequested);
    connect(btn_satellite_, &QPushButton::clicked, this, &MapSelectionSection::satelliteToggleRequested);
}

void MapSelectionSection::setBoundsText(const QString& text)
{
    label_bounds_->setText(text);
}

void MapSelectionSection::setLayerInfo(const QString& text, bool has_extent)
{
    label_layer_info_->setText(text);
    btn_focus_layer_->setEnabled(has_extent);
    btn_select_bounds_->setEnabled(has_extent);
}

double MapSelectionSection::paddingDegrees() const
{
    return spin_pad_deg_ ? spin_pad_deg_->value() : 0.01;
}

QVector<bool> MapSelectionSection::chunkEnabled() const
{
    return map_panel_ ? map_panel_->chunkEnabled() : QVector<bool>();
}
