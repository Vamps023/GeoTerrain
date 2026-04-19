#pragma once

#include "domain/GenerationTypes.h"

#include <QTabWidget>
#include <QWidget>

#include <memory>

class GeoTerrainController;
class MapSelectionSection;
class SourceSettingsSection;
class GenerationSettingsSection;
class RunConsoleSection;
class TerrainBuilderSection;

class GeoTerrainPanel : public QWidget
{
    Q_OBJECT

public:
    explicit GeoTerrainPanel(QWidget* parent = nullptr);
    ~GeoTerrainPanel() override;

    MapSelectionSection* mapSection() const { return map_section_; }
    SourceSettingsSection* sourceSection() const { return source_section_; }
    GenerationSettingsSection* settingsSection() const { return settings_section_; }
    RunConsoleSection* consoleSection() const { return console_section_; }
    TerrainBuilderSection* terrainSection() const { return terrain_section_; }

    void setBoundsText(const QString& text);
    void setLayerInfo(const QString& text, bool has_extent);
    void setControlsEnabled(bool enabled);
    void appendLog(const QString& message);
    void clearLog();
    void setProgress(int percent);
    void setExportEnabled(bool enabled);
    void setGatherEnabled(bool enabled);
    void showGenerateTab();

signals:
    void selectionChanged(const GeoBounds& bounds);

private:
    void setupUi();

    QTabWidget* tabs_ = nullptr;
    MapSelectionSection* map_section_ = nullptr;
    SourceSettingsSection* source_section_ = nullptr;
    GenerationSettingsSection* settings_section_ = nullptr;
    RunConsoleSection* console_section_ = nullptr;
    TerrainBuilderSection* terrain_section_ = nullptr;
    std::unique_ptr<GeoTerrainController> controller_;
};
