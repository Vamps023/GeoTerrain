#pragma once

#include "ui/MapPanel.h"

#include <QComboBox>
#include <QDoubleSpinBox>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QWidget>

class MapSelectionSection : public QWidget
{
    Q_OBJECT

public:
    explicit MapSelectionSection(QWidget* parent = nullptr);

    MapPanel* mapPanel() const { return map_panel_; }
    void setBoundsText(const QString& text);
    void setLayerInfo(const QString& text, bool has_extent);
    void setMapStatus(const QString& text, bool warning = false);
    void setMapMode(int mode);

    QLineEdit* searchEdit() const { return edit_search_; }
    double paddingDegrees() const;
    double chunkSizeKm() const;
    QDoubleSpinBox* chunkSizeSpin() const { return spin_chunk_km_; }
    QVector<bool> chunkEnabled() const;

signals:
    void searchRequested();
    void clearSelectionRequested();
    void previewGridRequested();
    void focusLayerRequested();
    void selectLayerBoundsRequested();
    void mapModeChanged(int mode);

private:
    MapPanel* map_panel_ = nullptr;
    QLabel* label_bounds_ = nullptr;
    QLabel* label_layer_info_ = nullptr;
    QLabel* label_map_status_ = nullptr;
    QLineEdit* edit_search_ = nullptr;
    QComboBox* combo_map_mode_ = nullptr;
    QPushButton* btn_focus_layer_ = nullptr;
    QPushButton* btn_select_bounds_ = nullptr;
    QDoubleSpinBox* spin_pad_deg_ = nullptr;
    QDoubleSpinBox* spin_chunk_km_ = nullptr;
};
