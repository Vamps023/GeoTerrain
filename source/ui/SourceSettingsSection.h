#pragma once

#include <QComboBox>
#include <QLineEdit>
#include <QWidget>

class SourceSettingsSection : public QWidget
{
    Q_OBJECT

public:
    explicit SourceSettingsSection(QWidget* parent = nullptr);

    QComboBox* demSourceCombo() const { return combo_dem_source_; }
    QLineEdit* apiKeyEdit() const { return edit_api_key_; }
    QLineEdit* localTiffEdit() const { return edit_local_tiff_; }
    QLineEdit* tmsUrlEdit() const { return edit_tms_url_; }
    QLineEdit* overpassUrlEdit() const { return edit_overpass_url_; }
    QLineEdit* vectorPathEdit() const { return edit_gpkg_path_; }
    QComboBox* vectorLayerCombo() const { return combo_gpkg_layer_; }

    void setVectorLayers(const QStringList& layers);

signals:
    void vectorPathSelected(const QString& path);
    void vectorLayerIndexChanged(int index);

private:
    QComboBox* combo_dem_source_ = nullptr;
    QLineEdit* edit_api_key_ = nullptr;
    QLineEdit* edit_local_tiff_ = nullptr;
    QLineEdit* edit_tms_url_ = nullptr;
    QLineEdit* edit_overpass_url_ = nullptr;
    QLineEdit* edit_gpkg_path_ = nullptr;
    QComboBox* combo_gpkg_layer_ = nullptr;
};
