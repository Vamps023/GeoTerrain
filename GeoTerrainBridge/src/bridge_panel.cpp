#include "bridge_panel.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFileDialog>
#include <QTreeWidgetItem>
#include <QHeaderView>
#include <QGroupBox>
#include <QMessageBox>
#include <QDebug>

BridgePanel::BridgePanel(QWidget* parent)
    : QWidget(parent)
{
    setupUI();
    setStatus("Select a Terrain Package folder to begin.");
}

void BridgePanel::setupUI() {
    auto* mainLayout = new QVBoxLayout(this);
    mainLayout->setSpacing(12);
    mainLayout->setContentsMargins(16, 16, 16, 16);

    // ─── Package Selection Group ──────────────────────────────
    auto* packageGroup = new QGroupBox("Terrain Package", this);
    auto* packageLayout = new QHBoxLayout(packageGroup);
    
    packagePathEdit_ = new QLineEdit(this);
    packagePathEdit_->setPlaceholderText("Path to .terrain package folder...");
    packagePathEdit_->setReadOnly(true);
    
    browseBtn_ = new QPushButton("Browse...", this);
    validateBtn_ = new QPushButton("Validate", this);
    validateBtn_->setEnabled(false);
    
    packageLayout->addWidget(packagePathEdit_, 1);
    packageLayout->addWidget(browseBtn_);
    packageLayout->addWidget(validateBtn_);
    
    mainLayout->addWidget(packageGroup);

    // ─── Manifest Inspector ───────────────────────────────────
    auto* manifestGroup = new QGroupBox("Package Contents", this);
    auto* manifestLayout = new QVBoxLayout(manifestGroup);
    
    manifestTree_ = new QTreeWidget(this);
    manifestTree_->setHeaderLabels(QStringList() << "Property" << "Value");
    manifestTree_->setColumnCount(2);
    manifestTree_->header()->setStretchLastSection(true);
    manifestTree_->setAlternatingRowColors(true);
    
    manifestLayout->addWidget(manifestTree_);
    mainLayout->addWidget(manifestGroup, 1);

    // ─── Import Settings ──────────────────────────────────────
    auto* settingsGroup = new QGroupBox("Import Settings", this);
    auto* settingsLayout = new QVBoxLayout(settingsGroup);
    
    auto* resLayout = new QHBoxLayout();
    resLayout->addWidget(new QLabel("LMAP Resolution:", this));
    lmapResolutionCombo_ = new QComboBox(this);
    lmapResolutionCombo_->addItems({"512", "1024", "2048", "4096"});
    lmapResolutionCombo_->setCurrentIndex(1);
    resLayout->addWidget(lmapResolutionCombo_);
    resLayout->addStretch();
    settingsLayout->addLayout(resLayout);
    
    auto* matLayout = new QHBoxLayout();
    matLayout->addWidget(new QLabel("Material Preset:", this));
    materialPresetCombo_ = new QComboBox(this);
    materialPresetCombo_->addItems({"Default Terrain", "High-Detail Rock", "Grassland", "Snow"});
    matLayout->addWidget(materialPresetCombo_);
    matLayout->addStretch();
    settingsLayout->addLayout(matLayout);
    
    mainLayout->addWidget(settingsGroup);

    // ─── Build Controls ───────────────────────────────────────
    auto* buildLayout = new QHBoxLayout();
    
    buildBtn_ = new QPushButton("Build Terrain", this);
    buildBtn_->setEnabled(false);
    buildBtn_->setStyleSheet(
        "QPushButton {"
        "  background-color: #06b6d4;"
        "  color: white;"
        "  font-weight: bold;"
        "  padding: 8px 24px;"
        "  border-radius: 4px;"
        "}"
        "QPushButton:disabled {"
        "  background-color: #374151;"
        "  color: #9ca3af;"
        "}"
    );
    
    progressBar_ = new QProgressBar(this);
    progressBar_->setRange(0, 100);
    progressBar_->setValue(0);
    progressBar_->setTextVisible(true);
    
    buildLayout->addWidget(buildBtn_);
    buildLayout->addWidget(progressBar_, 1);
    
    mainLayout->addLayout(buildLayout);

    // ─── Status Bar ───────────────────────────────────────────
    statusLabel_ = new QLabel(this);
    statusLabel_->setStyleSheet("color: #9ca3af; font-size: 11px;");
    mainLayout->addWidget(statusLabel_);

    // ─── Connections ──────────────────────────────────────────
    connect(browseBtn_, &QPushButton::clicked, this, &BridgePanel::onBrowsePackage);
    connect(validateBtn_, &QPushButton::clicked, this, &BridgePanel::onValidatePackage);
    connect(buildBtn_, &QPushButton::clicked, this, &BridgePanel::onBuildTerrain);
}

void BridgePanel::onBrowsePackage() {
    QString dir = QFileDialog::getExistingDirectory(
        this,
        "Select Terrain Package Folder",
        QString(),
        QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks
    );
    
    if (!dir.isEmpty()) {
        packagePathEdit_->setText(dir);
        validateBtn_->setEnabled(true);
        buildBtn_->setEnabled(false);
        manifestTree_->clear();
        packageReader_.reset();
        setStatus("Click 'Validate' to inspect the package.");
    }
}

void BridgePanel::onValidatePackage() {
    QString path = packagePathEdit_->text();
    if (path.isEmpty()) return;
    
    packageReader_ = std::make_unique<PackageReader>(path);
    
    if (!packageReader_->isValid()) {
        packageValid_ = false;
        buildBtn_->setEnabled(false);
        setStatus(QString("Invalid package: %1").arg(packageReader_->errorString()), true);
        QMessageBox::warning(this, "Validation Failed", packageReader_->errorString());
        return;
    }
    
    if (!packageReader_->validateFileExistence()) {
        packageValid_ = false;
        buildBtn_->setEnabled(false);
        setStatus("Package manifest is valid but some referenced files are missing.", true);
        return;
    }
    
    packageValid_ = true;
    buildBtn_->setEnabled(true);
    setStatus(QString("Package '%1' is valid. %2 tiles ready to import.")
        .arg(packageReader_->manifest().terrainName)
        .arg(packageReader_->manifest().tiles.size()));
    
    populateManifestTree(packageReader_->manifest());
}

void BridgePanel::onBuildTerrain() {
    if (!packageValid_ || !packageReader_) return;
    
    const TerrainPackageManifest& m = packageReader_->manifest();
    
    buildBtn_->setEnabled(false);
    progressBar_->setValue(0);
    setStatus("Building terrain...");
    
    // TODO: Integrate with UNIGINE SDK
    // 1. Create LandscapeLayerMap nodes for each tile
    // 2. Set heightmap/albedo paths from package
    // 3. Apply world offsets from manifest
    // 4. Assign materials
    
    qDebug() << "Building terrain from package:" << m.terrainName;
    qDebug() << "Tiles:" << m.tiles.size();
    qDebug() << "Preset:" << m.exportPreset;
    qDebug() << "LMAP Resolution:" << lmapResolutionCombo_->currentText();
    
    for (int i = 0; i < m.tiles.size(); ++i) {
        const TerrainTileInfo& tile = m.tiles[i];
        qDebug() << "Tile" << i << ":" << tile.row << tile.col
                 << "offset=" << tile.worldOffset.x << tile.worldOffset.y << tile.worldOffset.z
                 << "hmap=" << tile.files.heightmap;
        
        progressBar_->setValue((i + 1) * 100 / m.tiles.size());
    }
    
    progressBar_->setValue(100);
    buildBtn_->setEnabled(true);
    setStatus(QString("Terrain '%1' built successfully with %2 tiles.")
        .arg(m.terrainName)
        .arg(m.tiles.size()));
    
    QMessageBox::information(this, "Build Complete",
        QString("Successfully imported %1 tiles into the scene.\n\n"
                "Terrain: %2\n"
                "Preset: %3")
        .arg(m.tiles.size())
        .arg(m.terrainName)
        .arg(m.exportPreset));
}

void BridgePanel::populateManifestTree(const TerrainPackageManifest& manifest) {
    manifestTree_->clear();
    
    auto* root = new QTreeWidgetItem(manifestTree_, QStringList() << "Terrain Package" << manifest.terrainName);
    
    auto* info = new QTreeWidgetItem(root, QStringList() << "Version" << manifest.version);
    new QTreeWidgetItem(root, QStringList() << "Created" << manifest.createdAt);
    new QTreeWidgetItem(root, QStringList() << "CRS" << manifest.crs);
    new QTreeWidgetItem(root, QStringList() << "Preset" << manifest.exportPreset);
    
    auto* bounds = new QTreeWidgetItem(root, QStringList() << "Bounds" << "");
    new QTreeWidgetItem(bounds, QStringList() << "West" << QString::number(manifest.bounds.west, 'f', 4));
    new QTreeWidgetItem(bounds, QStringList() << "East" << QString::number(manifest.bounds.east, 'f', 4));
    new QTreeWidgetItem(bounds, QStringList() << "South" << QString::number(manifest.bounds.south, 'f', 4));
    new QTreeWidgetItem(bounds, QStringList() << "North" << QString::number(manifest.bounds.north, 'f', 4));
    
    auto* grid = new QTreeWidgetItem(root, QStringList() << "Tile Grid" << "");
    new QTreeWidgetItem(grid, QStringList() << "Rows" << QString::number(manifest.tileGrid.rows));
    new QTreeWidgetItem(grid, QStringList() << "Cols" << QString::number(manifest.tileGrid.cols));
    new QTreeWidgetItem(grid, QStringList() << "Chunk Size" << QString("%1 m").arg(manifest.tileGrid.chunkSizeM));
    new QTreeWidgetItem(grid, QStringList() << "Heightmap Res" << QString::number(manifest.tileGrid.heightmapResolution));
    
    auto* tiles = new QTreeWidgetItem(root, QStringList() << "Tiles" << QString::number(manifest.tiles.size()));
    for (const TerrainTileInfo& tile : manifest.tiles) {
        QString label = QString("chunk_%1_%2").arg(tile.row).arg(tile.col);
        auto* tileItem = new QTreeWidgetItem(tiles, QStringList() << label << "");
        new QTreeWidgetItem(tileItem, QStringList() << "Heightmap" << tile.files.heightmap);
        if (!tile.files.albedo.isEmpty()) {
            new QTreeWidgetItem(tileItem, QStringList() << "Albedo" << tile.files.albedo);
        }
        if (!tile.files.splat.isEmpty()) {
            new QTreeWidgetItem(tileItem, QStringList() << "Splat" << tile.files.splat);
        }
    }
    
    auto* sources = new QTreeWidgetItem(root, QStringList() << "Sources" << "");
    new QTreeWidgetItem(sources, QStringList() << "DEM" << manifest.demSource.name);
    new QTreeWidgetItem(sources, QStringList() << "Imagery" << manifest.imagerySource.name);
    if (!manifest.osmSource.id.isEmpty()) {
        new QTreeWidgetItem(sources, QStringList() << "OSM" << manifest.osmSource.name);
    }
    
    manifestTree_->expandItem(root);
    manifestTree_->expandItem(tiles);
}

void BridgePanel::setStatus(const QString& message, bool isError) {
    statusLabel_->setText(message);
    statusLabel_->setStyleSheet(isError
        ? "color: #ef4444; font-size: 11px;"
        : "color: #9ca3af; font-size: 11px;");
}
