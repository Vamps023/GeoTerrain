#pragma once

#include <QComboBox>
#include <QDoubleSpinBox>
#include <QLineEdit>
#include <QSpinBox>
#include <QWidget>

class GenerationSettingsSection : public QWidget
{
    Q_OBJECT

public:
    explicit GenerationSettingsSection(QWidget* parent = nullptr);

    QDoubleSpinBox* resolutionSpin() const { return spin_resolution_; }
    QSpinBox* zoomSpin() const { return spin_zoom_; }
    QComboBox* mapSizeCombo() const { return combo_map_size_; }
    QDoubleSpinBox* roadWidthSpin() const { return spin_road_width_; }
    QLineEdit* outputDirEdit() const { return edit_output_dir_; }
    QDoubleSpinBox* chunkSizeSpin() const { return spin_tile_km_; }

private:
    QDoubleSpinBox* spin_resolution_ = nullptr;
    QSpinBox* spin_zoom_ = nullptr;
    QComboBox* combo_map_size_ = nullptr;
    QDoubleSpinBox* spin_road_width_ = nullptr;
    QLineEdit* edit_output_dir_ = nullptr;
    QDoubleSpinBox* spin_tile_km_ = nullptr;
};
