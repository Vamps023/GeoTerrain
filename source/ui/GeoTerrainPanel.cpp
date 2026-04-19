#include "GeoTerrainPanel.h"

#include "application/GeoTerrainController.h"
#include "ui/GenerationSettingsSection.h"
#include "ui/MapSelectionSection.h"
#include "ui/RunConsoleSection.h"
#include "ui/SourceSettingsSection.h"
#include "ui/TerrainBuilderSection.h"

#include <QLabel>
#include <QPalette>
#include <QVBoxLayout>

GeoTerrainPanel::GeoTerrainPanel(QWidget* parent)
    : QWidget(parent)
{
    setupUi();
    setWindowTitle("GeoTerrain Generator");
    resize(520, 820);

    QPalette pal;
    pal.setColor(QPalette::Window, QColor(45, 45, 45));
    pal.setColor(QPalette::WindowText, Qt::white);
    pal.setColor(QPalette::Base, QColor(35, 35, 35));
    pal.setColor(QPalette::Text, Qt::white);
    pal.setColor(QPalette::Button, QColor(60, 60, 60));
    pal.setColor(QPalette::ButtonText, Qt::white);
    setPalette(pal);
    setAutoFillBackground(true);

    controller_ = std::make_unique<GeoTerrainController>(this, this);
    connect(map_section_->mapPanel(), &MapPanel::selectionChanged, this, &GeoTerrainPanel::selectionChanged);
}

GeoTerrainPanel::~GeoTerrainPanel() = default;

void GeoTerrainPanel::setupUi()
{
    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    auto* header = new QLabel("  GeoTerrain Generator", this);
    header->setFixedHeight(36);
    header->setStyleSheet("background-color: #1a1a2e; color: #4fc3f7; padding-left: 6px; font-weight: bold;");
    root->addWidget(header);

    tabs_ = new QTabWidget(this);
    map_section_ = new MapSelectionSection(this);
    source_section_ = new SourceSettingsSection(this);
    settings_section_ = new GenerationSettingsSection(this);
    console_section_ = new RunConsoleSection(this);
    terrain_section_ = new TerrainBuilderSection(this);

    tabs_->addTab(map_section_, "Map");
    tabs_->addTab(source_section_, "Sources");
    tabs_->addTab(settings_section_, "Parameters");
    tabs_->addTab(console_section_, "Generate");
    tabs_->addTab(terrain_section_, "Terrain");
    root->addWidget(tabs_);
}

void GeoTerrainPanel::setBoundsText(const QString& text)
{
    map_section_->setBoundsText(text);
}

void GeoTerrainPanel::setLayerInfo(const QString& text, bool has_extent)
{
    map_section_->setLayerInfo(text, has_extent);
}

void GeoTerrainPanel::setControlsEnabled(bool enabled)
{
    // Disable non-Generate tabs while a background job is running; the
    // Generate tab keeps its own state via console_section_->setRunning().
    for (int i = 0; i < tabs_->count(); ++i)
    {
        if (tabs_->widget(i) != console_section_)
            tabs_->setTabEnabled(i, enabled);
    }
    console_section_->setRunning(!enabled);
}

void GeoTerrainPanel::appendLog(const QString& message)
{
    console_section_->appendLog(message);
}

void GeoTerrainPanel::clearLog()
{
    console_section_->clearLog();
}

void GeoTerrainPanel::setProgress(int percent)
{
    console_section_->setProgress(percent);
}

void GeoTerrainPanel::setExportEnabled(bool enabled)
{
    console_section_->setExportEnabled(enabled);
}

void GeoTerrainPanel::setGatherEnabled(bool enabled)
{
    console_section_->setGatherEnabled(enabled);
}

void GeoTerrainPanel::showGenerateTab()
{
    tabs_->setCurrentWidget(console_section_);
}
