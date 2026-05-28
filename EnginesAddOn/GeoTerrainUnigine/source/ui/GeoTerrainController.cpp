#include "GeoTerrainController.h"

#include "../core/GeoTerrainBridgeEditorPlugin.h"
#include "../importer/GeoTerrainImporter.h"

#include <UnigineObjects.h>

using namespace Unigine;

GeoTerrainController::GeoTerrainController(UnigineEditor::GeoTerrainBridgeEditorPlugin* plugin)
    : plugin(plugin)
{
}

QVector<GeoTerrainController::TileOption> GeoTerrainController::landscapeTileOptions() const
{
    QVector<TileOption> options;
    options.push_back(TileOption{"All Tiles", -1});
    if (!plugin)
        return options;

    const auto terrains = plugin->getLandscapeTerrains();
    const ObjectLandscapeTerrainPtr terrain = !terrains.empty() ? terrains.front() : Landscape::getActiveTerrain();
    if (!terrain)
        return options;

    const auto layerMaps = plugin->getLandscapeLayerMaps(terrain);
    for (const auto& layerMap : layerMaps)
    {
        if (!layerMap)
            continue;

        QString tileName = QString::fromUtf8(layerMap->getName());
        if (tileName.trimmed().isEmpty())
            tileName = QString("LandscapeLayerMap %1").arg(layerMap->getID());
        options.push_back(TileOption{tileName, layerMap->getID()});
    }

    return options;
}

GeoTerrainController::ImportResult GeoTerrainController::importPackage(const QString& packagePath,
                                                                        int targetTileId,
                                                                        bool importAlbedo,
                                                                        bool importMasks,
                                                                        bool autoCreateTiles,
                                                                        const LogFn& log) const
{
    ImportResult result;
    if (!plugin || !plugin->importer())
    {
        result.error = "ERROR: Plugin is not initialized.";
        return result;
    }

    const TargetContext target = resolveTarget(targetTileId);
    if (!target.error.isEmpty())
    {
        result.error = target.error;
        return result;
    }

    const auto importerResult = plugin->importer()->importPackage(
        packagePath.toStdString(),
        target.terrain,
        target.tile,
        importAlbedo,
        importMasks,
        autoCreateTiles,
        log);

    result.success = importerResult.success;
    result.tilesImported = importerResult.tilesImported;
    result.tilesFailed = importerResult.tilesFailed;
    result.tilesCreated = importerResult.tilesCreated;
    if (!importerResult.error.empty())
        result.error = QString::fromStdString(importerResult.error);

    return result;
}

GeoTerrainController::TargetContext GeoTerrainController::resolveTarget(int targetTileId) const
{
    TargetContext context;
    if (!plugin || !plugin->importer())
    {
        context.error = "ERROR: Plugin is not initialized.";
        return context;
    }

    const auto terrains = plugin->getLandscapeTerrains();
    context.terrain = !terrains.empty() ? terrains.front() : Landscape::getActiveTerrain();
    context.tile = targetTileId >= 0 ? plugin->getLandscapeLayerMapById(targetTileId) : nullptr;
    if (!context.terrain)
        context.error = "ERROR: No landscape selected. Please create or select a Landscape Terrain.";
    return context;
}
