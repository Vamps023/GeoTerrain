#pragma once

#include <QString>
#include <QJsonObject>
#include <QJsonArray>
#include <QVector>
#include <QMap>
#include <QDir>

/**
 * Terrain Package Manifest Reader
 * 
 * Reads and validates the manifest.json from a Terrain Package
 * exported by GeoTerrain Studio. No GDAL or external dependencies.
 */

struct TerrainBounds {
    double west = 0.0;
    double south = 0.0;
    double east = 0.0;
    double north = 0.0;
};

struct WorldOffset {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct TileFiles {
    QString heightmap;
    QString albedo;
    QString roadMask;
    QString waterMask;
    QString vegetationMask;
    QString buildingMask;
    QString cliffMask;
    QString splat;
};

struct TerrainTileInfo {
    int row = 0;
    int col = 0;
    TerrainBounds bounds;
    WorldOffset worldOffset;
    TileFiles files;
    double minElevation = 0.0;
    double maxElevation = 0.0;
};

struct TileGridConfig {
    int rows = 0;
    int cols = 0;
    double chunkSizeM = 1000.0;
    int heightmapResolution = 1024;
    int albedoResolution = 1024;
};

struct DataSourceAttribution {
    QString id;
    QString name;
    QString attribution;
};

struct TerrainPackageManifest {
    QString version;
    QString createdBy;
    QString createdAt;
    QString terrainName;
    QString description;
    TerrainBounds bounds;
    QString crs;
    TileGridConfig tileGrid;
    QVector<TerrainTileInfo> tiles;
    DataSourceAttribution demSource;
    DataSourceAttribution imagerySource;
    DataSourceAttribution osmSource;
    QString exportPreset;
    bool isValid = false;
    QString errorMessage;
};

class PackageReader {
public:
    explicit PackageReader(const QString& packagePath);
    
    bool isValid() const { return manifest_.isValid; }
    const QString& errorString() const { return manifest_.errorMessage; }
    const TerrainPackageManifest& manifest() const { return manifest_; }
    
    // Validation
    bool validateFileExistence() const;
    
    // Utility
    QString resolveTilePath(const QString& relativePath) const;
    QDir packageDir() const { return QDir(packagePath_); }

private:
    QString packagePath_;
    TerrainPackageManifest manifest_;
    
    bool parseManifest(const QJsonObject& root);
    TerrainBounds parseBounds(const QJsonObject& obj);
    WorldOffset parseWorldOffset(const QJsonObject& obj);
    TileFiles parseTileFiles(const QJsonObject& obj);
    DataSourceAttribution parseSource(const QJsonObject& obj);
};
