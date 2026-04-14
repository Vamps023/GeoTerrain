#include "MapSelectionSection.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QSignalBlocker>
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
    edit_search_->setPlaceholderText("Search place or city");
    top_row->addWidget(edit_search_, 1);

    auto* btn_search = new QPushButton("Go", this);
    btn_search->setFixedWidth(48);
    top_row->addWidget(btn_search);

    auto* map_label = new QLabel("Map:", this);
    top_row->addWidget(map_label);

    combo_map_mode_ = new QComboBox(this);
    combo_map_mode_->addItem("Street");
    combo_map_mode_->addItem("Satellite");
    combo_map_mode_->setCurrentIndex(1);
    combo_map_mode_->setFixedWidth(110);
    top_row->addWidget(combo_map_mode_);
    layout->addLayout(top_row);

    auto* helper_row = new QHBoxLayout();
    auto* instr = new QLabel("1. Search or pan   2. Shift-drag to select   3. Generate assets", this);
    instr->setStyleSheet("color: #9aa4ad; font-size: 8pt;");
    helper_row->addWidget(instr, 1);

    label_map_status_ = new QLabel("Satellite preview active", this);
    label_map_status_->setStyleSheet("color: #9ad27f; font-size: 8pt; padding: 2px 0;");
    helper_row->addWidget(label_map_status_);
    layout->addLayout(helper_row);

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

    btn_select_bounds_ = new QPushButton("Use Layer Extent", this);
    btn_select_bounds_->setEnabled(false);
    layer_row->addWidget(btn_select_bounds_);

    btn_focus_layer_ = new QPushButton("Focus Layer", this);
    btn_focus_layer_->setEnabled(false);
    layer_row->addWidget(btn_focus_layer_);
    layout->addLayout(layer_row);

    auto* bottom_row = new QHBoxLayout();
    label_bounds_ = new QLabel("No area selected yet", this);
    label_bounds_->setStyleSheet("color: #4fc3f7; font-size: 9pt; padding: 2px;");
    bottom_row->addWidget(label_bounds_, 1);

    auto* btn_preview_grid = new QPushButton("Preview Chunks", this);
    bottom_row->addWidget(btn_preview_grid);

    auto* btn_clear_sel = new QPushButton("Clear Area", this);
    bottom_row->addWidget(btn_clear_sel);
    layout->addLayout(bottom_row);

    connect(btn_search, &QPushButton::clicked, this, &MapSelectionSection::searchRequested);
    connect(edit_search_, &QLineEdit::returnPressed, this, &MapSelectionSection::searchRequested);
    connect(btn_clear_sel, &QPushButton::clicked, this, &MapSelectionSection::clearSelectionRequested);
    connect(btn_preview_grid, &QPushButton::clicked, this, &MapSelectionSection::previewGridRequested);
    connect(btn_focus_layer_, &QPushButton::clicked, this, &MapSelectionSection::focusLayerRequested);
    connect(btn_select_bounds_, &QPushButton::clicked, this, &MapSelectionSection::selectLayerBoundsRequested);
    connect(combo_map_mode_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &MapSelectionSection::mapModeChanged);
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

void MapSelectionSection::setMapStatus(const QString& text, bool warning)
{
    if (!label_map_status_)
        return;

    label_map_status_->setText(text);
    label_map_status_->setStyleSheet(QString("color: %1; font-size: 8pt; padding: 2px 0;")
        .arg(warning ? "#ffcc80" : "#9ad27f"));
}

void MapSelectionSection::setMapMode(int mode)
{
    if (!combo_map_mode_)
        return;

    const QSignalBlocker blocker(combo_map_mode_);
    combo_map_mode_->setCurrentIndex(mode);
}

double MapSelectionSection::paddingDegrees() const
{
    return spin_pad_deg_ ? spin_pad_deg_->value() : 0.01;
}

QVector<bool> MapSelectionSection::chunkEnabled() const
{
    return map_panel_ ? map_panel_->chunkEnabled() : QVector<bool>();
}
