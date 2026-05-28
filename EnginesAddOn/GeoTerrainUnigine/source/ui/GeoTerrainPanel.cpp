#include "GeoTerrainPanel.h"

#include "GeoTerrainController.h"
#include "../core/GeoTerrainBridgeEditorPlugin.h"
#include "../importer/GeoTerrainImporter.h"

#include <QtGui/QPalette>
#include <QApplication>
#include <QFileDialog>
#include <QHBoxLayout>
#include <QLabel>
#include <QStyle>
#include <QTimer>
#include <algorithm>

using namespace Unigine;

GeoTerrainPanel::GeoTerrainPanel(UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin)
    : QWidget()
    , plugin(plugin)
    , controller(std::make_unique<GeoTerrainController>(plugin))
{
    setupUi();
    refreshLandscapeTileOptions(false);

    setWindowTitle("GeoTerrain Bridge");
    resize(400, 600);

    QPalette darkPalette;
    darkPalette.setColor(QPalette::Window, QColor(45, 45, 45));
    darkPalette.setColor(QPalette::WindowText, Qt::white);
    darkPalette.setColor(QPalette::Base, QColor(35, 35, 35));
    darkPalette.setColor(QPalette::AlternateBase, QColor(45, 45, 45));
    darkPalette.setColor(QPalette::ToolTipBase, Qt::white);
    darkPalette.setColor(QPalette::ToolTipText, Qt::white);
    darkPalette.setColor(QPalette::Text, Qt::white);
    darkPalette.setColor(QPalette::Button, QColor(60, 60, 60));
    darkPalette.setColor(QPalette::ButtonText, Qt::white);
    darkPalette.setColor(QPalette::BrightText, Qt::red);
    darkPalette.setColor(QPalette::Link, QColor(42, 130, 218));
    darkPalette.setColor(QPalette::Highlight, QColor(42, 130, 218));
    darkPalette.setColor(QPalette::HighlightedText, Qt::black);
    setPalette(darkPalette);
}

void GeoTerrainPanel::setupUi()
{
    auto* mainLayout = new QVBoxLayout(this);
    mainLayout->setSpacing(10);
    mainLayout->setContentsMargins(15, 15, 15, 15);

    auto* header = new QLabel("GeoTerrain Bridge", this);
    QFont headerFont = header->font();
    headerFont.setBold(true);
    headerFont.setPointSize(14);
    header->setFont(headerFont);
    mainLayout->addWidget(header);

    auto* packageGroup = new QGroupBox("Package Path", this);
    auto* packageLayout = new QHBoxLayout(packageGroup);
    editPackagePath = new QLineEdit(this);
    editPackagePath->setPlaceholderText("Select GeoTerrain package folder...");
    packageLayout->addWidget(editPackagePath);
    buttonBrowse = new QPushButton("Browse...", this);
    connect(buttonBrowse, &QPushButton::clicked, this, &GeoTerrainPanel::onBrowsePackage);
    packageLayout->addWidget(buttonBrowse);
    mainLayout->addWidget(packageGroup);

    auto* landscapeGroup = new QGroupBox("Landscape Target", this);
    auto* landscapeLayout = new QVBoxLayout(landscapeGroup);
    auto* tileRow = new QHBoxLayout();
    tileRow->addWidget(new QLabel("Tile:", this));
    comboLandscapeTile = new QComboBox(this);
    comboLandscapeTile->setToolTip("Choose a specific LandscapeLayerMap tile, or leave it on All Tiles to match by name.");
    tileRow->addWidget(comboLandscapeTile, 1);
    buttonRefreshTiles = new QPushButton(this);
    buttonRefreshTiles->setIcon(QApplication::style()->standardIcon(QStyle::SP_BrowserReload));
    buttonRefreshTiles->setToolTip("Refresh landscape tiles");
    buttonRefreshTiles->setMaximumWidth(32);
    connect(buttonRefreshTiles, &QPushButton::clicked, this, &GeoTerrainPanel::onRefreshTiles);
    tileRow->addWidget(buttonRefreshTiles);
    landscapeLayout->addLayout(tileRow);
    mainLayout->addWidget(landscapeGroup);

    auto* optionsGroup = new QGroupBox("Import Options", this);
    auto* optionsLayout = new QVBoxLayout(optionsGroup);
    checkImportAlbedo = new QCheckBox("Import Albedo (satellite imagery)", this);
    checkImportAlbedo->setChecked(true);
    optionsLayout->addWidget(checkImportAlbedo);
    checkImportMasks = new QCheckBox("Import Masks (road/water/vegetation/building/cliff)", this);
    checkImportMasks->setChecked(false);
    checkImportMasks->setEnabled(false); // Masks not yet implemented
    optionsLayout->addWidget(checkImportMasks);

    checkAutoCreateTiles = new QCheckBox("Auto-create missing tiles", this);
    checkAutoCreateTiles->setChecked(true);
    checkAutoCreateTiles->setToolTip(
        "If enabled, missing LandscapeLayerMap tiles will be created automatically.\n"
        "Note: For best results, create LandscapeLayerMap tiles in the editor first.\n"
        "Auto-created tiles may have resolution issues.");
    optionsLayout->addWidget(checkAutoCreateTiles);

    mainLayout->addWidget(optionsGroup);

    auto* actionsGroup = new QGroupBox("Actions", this);
    auto* actionsLayout = new QVBoxLayout(actionsGroup);

    buttonImport = new QPushButton("Import GeoTerrain Package", this);
    buttonImport->setStyleSheet(
        "QPushButton { background-color: #2a7f2a; color: white; padding: 10px; font-weight: bold; }");
    connect(buttonImport, &QPushButton::clicked, this, &GeoTerrainPanel::onImportPackage);
    actionsLayout->addWidget(buttonImport);

    mainLayout->addWidget(actionsGroup);

    progressBar = new QProgressBar(this);
    progressBar->setRange(0, 100);
    progressBar->setValue(0);
    mainLayout->addWidget(progressBar);

    mainLayout->addWidget(new QLabel("Status:", this));
    statusText = new QTextEdit(this);
    statusText->setMaximumHeight(200);
    statusText->setReadOnly(true);
    statusText->setPlainText("Ready. Select a GeoTerrain package folder and click Import.");
    mainLayout->addWidget(statusText);

    mainLayout->addStretch();

    progressTimer = new QTimer(this);
    progressTimer->setInterval(200);
    connect(progressTimer, &QTimer::timeout, this, &GeoTerrainPanel::updateProgressBar);
    progressTimer->start();
}

void GeoTerrainPanel::showEvent(QShowEvent* event)
{
    refreshLandscapeTileOptions(true);
    QWidget::showEvent(event);
}

void GeoTerrainPanel::onBrowsePackage()
{
    const QString dir = QFileDialog::getExistingDirectory(this,
                                                          "Select GeoTerrain Package Folder",
                                                          QString(),
                                                          QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks);
    if (!dir.isEmpty() && editPackagePath)
        editPackagePath->setText(dir);
}

void GeoTerrainPanel::onRefreshTiles()
{
    refreshLandscapeTileOptions(true);
    appendLog("Landscape tiles refreshed.");
}

void GeoTerrainPanel::onImportPackage()
{
    if (!editPackagePath || editPackagePath->text().isEmpty())
    {
        appendLog("ERROR: No package folder selected.");
        return;
    }

    refreshLandscapeTileOptions(true);
    appendLog("=== Import GeoTerrain Package ===");
    progressBar->setValue(0);

    const QString packagePath = editPackagePath->text();
    const bool importAlbedo = checkImportAlbedo ? checkImportAlbedo->isChecked() : false;
    const bool importMasks = checkImportMasks ? checkImportMasks->isChecked() : false;
    const bool autoCreateTiles = checkAutoCreateTiles ? checkAutoCreateTiles->isChecked() : true;

    const GeoTerrainController::ImportResult result = controller->importPackage(
        packagePath,
        currentLandscapeTileId(),
        importAlbedo,
        importMasks,
        autoCreateTiles,
        [this](const std::string& message)
        {
            appendLog(QString::fromStdString(message));
        });

    if (!result.error.isEmpty())
    {
        appendLog(result.error);
        progressBar->setValue(0);
        return;
    }

    appendLog(QString("Created %1 tile(s), Imported %2 tile(s), %3 failed.").arg(result.tilesCreated).arg(result.tilesImported).arg(result.tilesFailed));

    if (plugin && plugin->importer() && plugin->importer()->isBusy())
    {
        operationCountAtStart = static_cast<int>(plugin->importer()->pendingOperationCount());
        progressBar->setValue(0);
        appendLog("=== Import queued — watch progress bar ===");
    }
    else
    {
        progressBar->setValue(100);
        appendLog("=== Import Complete ===");
    }
}

void GeoTerrainPanel::updateProgressBar()
{
    if (!plugin || !plugin->importer() || !progressBar)
        return;

    const GeoTerrainImporter* importer = plugin->importer();
    if (!importer->isBusy())
    {
        progressBar->setValue(100);
        return;
    }

    if (operationCountAtStart <= 0)
        return;

    const int remaining = static_cast<int>(importer->pendingOperationCount());
    const int done = operationCountAtStart - remaining;
    const int percent = (operationCountAtStart > 0)
                            ? static_cast<int>(done * 100.0f / operationCountAtStart)
                            : 100;
    progressBar->setValue(qBound(0, percent, 99)); // stay < 100 until fully done
}

void GeoTerrainPanel::appendLog(const QString& message)
{
    if (!statusText)
        return;

    statusText->append(message);
    if (auto* scrollBar = statusText->verticalScrollBar())
        scrollBar->setValue(scrollBar->maximum());

    Log::message("%s\n", message.toUtf8().constData());
}

void GeoTerrainPanel::refreshLandscapeTileOptions(bool preserveSelection)
{
    if (!comboLandscapeTile || !controller)
        return;

    const QVariant previousSelection = preserveSelection ? comboLandscapeTile->currentData() : QVariant();

    comboLandscapeTile->blockSignals(true);
    comboLandscapeTile->clear();
    const QVector<GeoTerrainController::TileOption> options = controller->landscapeTileOptions();
    for (const GeoTerrainController::TileOption& option : options)
        comboLandscapeTile->addItem(option.label, option.nodeId);

    int selectionIndex = 0;
    if (previousSelection.isValid())
    {
        const int previousIndex = comboLandscapeTile->findData(previousSelection);
        if (previousIndex >= 0)
            selectionIndex = previousIndex;
    }
    comboLandscapeTile->setCurrentIndex(selectionIndex);
    comboLandscapeTile->blockSignals(false);
}

int GeoTerrainPanel::currentLandscapeTileId() const
{
    if (!comboLandscapeTile)
        return -1;

    bool ok = false;
    const int tileId = comboLandscapeTile->currentData().toInt(&ok);
    return ok ? tileId : -1;
}
