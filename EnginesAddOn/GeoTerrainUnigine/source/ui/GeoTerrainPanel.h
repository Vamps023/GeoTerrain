#pragma once

#include <QCheckBox>
#include <QComboBox>
#include <QGroupBox>
#include <QLineEdit>
#include <QProgressBar>
#include <QPushButton>
#include <QScrollBar>
#include <QShowEvent>
#include <QTextEdit>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

#include <memory>

namespace UnigineEditor
{
class GeoTerrainBridgeEditorPlugin;
}
class GeoTerrainController;

class GeoTerrainPanel : public QWidget
{
    Q_OBJECT

public:
    explicit GeoTerrainPanel(UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin);
    ~GeoTerrainPanel() override = default;

protected:
    void showEvent(QShowEvent* event) override;

private slots:
    void onBrowsePackage();
    void onImportPackage();
    void onRefreshTiles();
    void updateProgressBar();

private:
    void setupUi();
    void appendLog(const QString& message);
    void refreshLandscapeTileOptions(bool preserveSelection = true);
    int currentLandscapeTileId() const;

    UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin = nullptr;
    std::unique_ptr<GeoTerrainController> controller;

    QLineEdit* editPackagePath = nullptr;
    QPushButton* buttonBrowse = nullptr;
    QPushButton* buttonRefreshTiles = nullptr;
    QComboBox* comboLandscapeTile = nullptr;
    QCheckBox* checkImportAlbedo = nullptr;
    QCheckBox* checkImportMasks = nullptr;
    QCheckBox* checkAutoCreateTiles = nullptr;
    QPushButton* buttonImport = nullptr;
    QProgressBar* progressBar = nullptr;
    QTextEdit* statusText = nullptr;
    QTimer* progressTimer = nullptr;
    int operationCountAtStart = 0;
};
