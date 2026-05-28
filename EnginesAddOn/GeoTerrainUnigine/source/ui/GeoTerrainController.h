#pragma once

#include <QSet>
#include <QString>
#include <QVector>

#include <UnigineObjects.h>

#include <functional>
#include <string>
#include <vector>

namespace UnigineEditor
{
class GeoTerrainBridgeEditorPlugin;
}

// Controller that mediates between the GeoTerrainPanel (UI) and the
// GeoTerrainImporter (business logic). All non-trivial operations and
// data transformations live here so the panel remains a thin view layer.
class GeoTerrainController
{
public:
    using LogFn = std::function<void(const std::string&)>;

    struct TileOption
    {
        QString label;
        int nodeId = -1;
    };

    struct ImportResult
    {
        bool success = false;
        int tilesImported = 0;
        int tilesFailed = 0;
        int tilesCreated = 0;
        QString error;
    };

    explicit GeoTerrainController(UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin);

    // Returns landscape tile options for the dropdown ("All Tiles" + per-tile entries).
    QVector<TileOption> landscapeTileOptions() const;

    // Imports a GeoTerrain package into the landscape.
    ImportResult importPackage(const QString& packagePath,
                                int targetTileId,
                                bool importAlbedo,
                                bool importMasks,
                                bool autoCreateTiles,
                                const LogFn& log) const;

private:
    struct TargetContext
    {
        Unigine::ObjectLandscapeTerrainPtr terrain;
        Unigine::LandscapeLayerMapPtr tile;
        QString error;
    };

    TargetContext resolveTarget(int targetTileId) const;

    UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin = nullptr;
};
