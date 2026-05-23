#pragma once

#include <QWidget>
#include <QPushButton>
#include <QLineEdit>
#include <QTreeWidget>
#include <QProgressBar>
#include <QLabel>
#include <QComboBox>
#include <memory>
#include "package_reader.h"

class BridgePanel : public QWidget {
    Q_OBJECT

public:
    explicit BridgePanel(QWidget* parent = nullptr);

private slots:
    void onBrowsePackage();
    void onBuildTerrain();
    void onValidatePackage();

private:
    void setupUI();
    void populateManifestTree(const TerrainPackageManifest& manifest);
    void setStatus(const QString& message, bool isError = false);

    // UI Elements
    QLineEdit* packagePathEdit_ = nullptr;
    QPushButton* browseBtn_ = nullptr;
    QPushButton* validateBtn_ = nullptr;
    QPushButton* buildBtn_ = nullptr;
    QTreeWidget* manifestTree_ = nullptr;
    QProgressBar* progressBar_ = nullptr;
    QLabel* statusLabel_ = nullptr;
    QComboBox* lmapResolutionCombo_ = nullptr;
    QComboBox* materialPresetCombo_ = nullptr;

    // State
    std::unique_ptr<PackageReader> packageReader_;
    bool packageValid_ = false;
};
