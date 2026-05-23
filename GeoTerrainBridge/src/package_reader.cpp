#include "package_reader.h"
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDebug>

PackageReader::PackageReader(const QString& packagePath)
    : packagePath_(packagePath)
{
    QString manifestPath = QDir(packagePath).filePath("manifest.json");
    QFile file(manifestPath);
    
    if (!file.exists()) {
        manifest_.errorMessage = QString("Manifest not found: %1").arg(manifestPath);
        return;
    }
    
    if (!file.open(QIODevice::ReadOnly)) {
        manifest_.errorMessage = QString("Cannot open manifest: %1").arg(file.errorString());
        return;
    }
    
    QByteArray data = file.readAll();
    QJsonDocument doc = QJsonDocument::fromJson(data);
    
    if (doc.isNull() || !doc.isObject()) {
        manifest_.errorMessage = "Invalid JSON in manifest";
        return;
    }
    
    manifest_.isValid = parseManifest(doc.object());
}

bool PackageReader::parseManifest(const QJsonObject& root) {
    // Version check
    manifest_.version = root.value("version").toString();
    if (manifest_.version.isEmpty()) {
        manifest_.errorMessage = "Missing 'version' field";
        return false;
    }
    
    // Support manifest v1.x
    if (!manifest_.version.startsWith("1.")) {
        manifest_.errorMessage = QString("Unsupported manifest version: %1 (expected 1.x)").arg(manifest_.version);
        return false;
    }
    
    manifest_.createdBy = root.value("createdBy").toString();
    manifest_.createdAt = root.value("createdAt").toString();
    manifest_.terrainName = root.value("terrainName").toString();
    manifest_.description = root.value("description").toString();
    manifest_.crs = root.value("crs").toString("EPSG:4326");
    manifest_.exportPreset = root.value("exportPreset").toString();
    
    if (root.contains("bounds")) {
        manifest_.bounds = parseBounds(root.value("bounds").toObject());
    }
    
    if (root.contains("tileGrid")) {
        QJsonObject grid = root.value("tileGrid").toObject();
        manifest_.tileGrid.rows = grid.value("rows").toInt();
        manifest_.tileGrid.cols = grid.value("cols").toInt();
        manifest_.tileGrid.chunkSizeM = grid.value("chunkSizeM").toDouble(1000.0);
        manifest_.tileGrid.heightmapResolution = grid.value("heightmapResolution").toInt(1024);
        manifest_.tileGrid.albedoResolution = grid.value("albedoResolution").toInt(1024);
    }
    
    if (root.contains("tiles") && root.value("tiles").isArray()) {
        QJsonArray tilesArr = root.value("tiles").toArray();
        for (const QJsonValue& val : tilesArr) {
            QJsonObject t = val.toObject();
            TerrainTileInfo tile;
            tile.row = t.value("row").toInt();
            tile.col = t.value("col").toInt();
            tile.bounds = parseBounds(t.value("bounds").toObject());
            tile.worldOffset = parseWorldOffset(t.value("worldOffset").toObject());
            tile.files = parseTileFiles(t.value("files").toObject());
            
            if (t.contains("elevation")) {
                QJsonObject elev = t.value("elevation").toObject();
                tile.minElevation = elev.value("min").toDouble();
                tile.maxElevation = elev.value("max").toDouble();
            }
            
            manifest_.tiles.append(tile);
        }
    }
    
    if (root.contains("sources")) {
        QJsonObject sources = root.value("sources").toObject();
        manifest_.demSource = parseSource(sources.value("dem").toObject());
        manifest_.imagerySource = parseSource(sources.value("imagery").toObject());
        if (sources.contains("osm")) {
            manifest_.osmSource = parseSource(sources.value("osm").toObject());
        }
    }
    
    manifest_.errorMessage.clear();
    return true;
}

TerrainBounds PackageReader::parseBounds(const QJsonObject& obj) {
    TerrainBounds b;
    b.west = obj.value("west").toDouble();
    b.south = obj.value("south").toDouble();
    b.east = obj.value("east").toDouble();
    b.north = obj.value("north").toDouble();
    return b;
}

WorldOffset PackageReader::parseWorldOffset(const QJsonObject& obj) {
    WorldOffset o;
    o.x = obj.value("x").toDouble();
    o.y = obj.value("y").toDouble();
    o.z = obj.value("z").toDouble();
    return o;
}

TileFiles PackageReader::parseTileFiles(const QJsonObject& obj) {
    TileFiles f;
    f.heightmap = obj.value("heightmap").toString();
    f.albedo = obj.value("albedo").toString();
    f.roadMask = obj.value("roadMask").toString();
    f.waterMask = obj.value("waterMask").toString();
    f.vegetationMask = obj.value("vegetationMask").toString();
    f.buildingMask = obj.value("buildingMask").toString();
    f.cliffMask = obj.value("cliffMask").toString();
    f.splat = obj.value("splat").toString();
    return f;
}

DataSourceAttribution PackageReader::parseSource(const QJsonObject& obj) {
    DataSourceAttribution s;
    s.id = obj.value("id").toString();
    s.name = obj.value("name").toString();
    s.attribution = obj.value("attribution").toString();
    return s;
}

bool PackageReader::validateFileExistence() const {
    QDir dir(packagePath_);
    for (const TerrainTileInfo& tile : manifest_.tiles) {
        if (!tile.files.heightmap.isEmpty() && !dir.exists(tile.files.heightmap)) {
            qWarning() << "Missing heightmap:" << tile.files.heightmap;
            return false;
        }
        if (!tile.files.albedo.isEmpty() && !dir.exists(tile.files.albedo)) {
            qWarning() << "Missing albedo:" << tile.files.albedo;
            return false;
        }
    }
    return true;
}

QString PackageReader::resolveTilePath(const QString& relativePath) const {
    return QDir(packagePath_).absoluteFilePath(relativePath);
}
