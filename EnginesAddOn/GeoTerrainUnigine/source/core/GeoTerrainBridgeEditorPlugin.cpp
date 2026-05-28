#include "GeoTerrainBridgeEditorPlugin.h"

#include "NodeTreeWalker.h"
#include "../landscape/LandscapeSaveManager.h"
#include "../importer/GeoTerrainImporter.h"
#include "../ui/GeoTerrainPanel.h"

#include <editor/UnigineWindowManager.h>

#include <QtWidgets/QApplication>
#include <QtWidgets/QMainWindow>
#include <QtWidgets/QMenuBar>

#include <UnigineLog.h>
#include <UnigineNodes.h>
#include <UnigineWorld.h>

using namespace Unigine;

namespace UnigineEditor
{
GeoTerrainBridgeEditorPlugin::GeoTerrainBridgeEditorPlugin() = default;
GeoTerrainBridgeEditorPlugin::~GeoTerrainBridgeEditorPlugin() = default;

bool GeoTerrainBridgeEditorPlugin::init()
{
    try
    {
        saveManager = std::make_unique<LandscapeSaveManager>(false);
        geoTerrainImporter = std::make_unique<GeoTerrainImporter>(*saveManager);
        geoTerrainPanel = std::make_unique<GeoTerrainPanel>(this);

        setupMenu();
        WindowManager::add(geoTerrainPanel.get(), WindowManager::AreaType::ROOT_AREA_RIGHT);
        return true;
    }
    catch (const std::exception& exception)
    {
        Log::error("[GeoTerrainBridge] Failed to initialize plugin: %s\n", exception.what());
        return false;
    }
}

void GeoTerrainBridgeEditorPlugin::shutdown()
{
    if (geoTerrainImporter)
        geoTerrainImporter->flushPendingSaves();

    if (pluginMenu && geoTerrainAction)
        pluginMenu->removeAction(geoTerrainAction);

    if (geoTerrainAction)
    {
        delete geoTerrainAction;
        geoTerrainAction = nullptr;
    }

    if (geoTerrainPanel)
        WindowManager::remove(geoTerrainPanel.get());

    geoTerrainPanel.reset();
    geoTerrainImporter.reset();
    saveManager.reset();

    if (ownsMenu && pluginMenu)
    {
        delete pluginMenu;
        pluginMenu = nullptr;
        ownsMenu = false;
    }
}

std::vector<ObjectLandscapeTerrainPtr> GeoTerrainBridgeEditorPlugin::getLandscapeTerrains() const
{
    std::vector<ObjectLandscapeTerrainPtr> terrains;
    Vector<NodePtr> rootNodes;
    World::getRootNodes(rootNodes);

    std::unordered_set<int> visitedNodeIds;
    terrains.reserve(rootNodes.size());
    for (const auto& root : rootNodes)
        NodeTreeWalker::collectNodesRecursive<Node::OBJECT_LANDSCAPE_TERRAIN, ObjectLandscapeTerrain>(root, terrains, visitedNodeIds);

    return terrains;
}

std::vector<LandscapeLayerMapPtr> GeoTerrainBridgeEditorPlugin::getLandscapeLayerMaps(
    const ObjectLandscapeTerrainPtr& terrain) const
{
    std::vector<LandscapeLayerMapPtr> layerMaps;
    if (!terrain)
        return layerMaps;

    std::unordered_set<int> visitedNodeIds;
    NodeTreeWalker::collectNodesRecursive<Node::LANDSCAPE_LAYER_MAP, LandscapeLayerMap>(terrain, layerMaps, visitedNodeIds);

    return layerMaps;
}

LandscapeLayerMapPtr GeoTerrainBridgeEditorPlugin::getLandscapeLayerMapById(int nodeId) const
{
    if (nodeId < 0)
        return nullptr;

    auto node = Node::getNode(nodeId);
    return checked_ptr_cast<LandscapeLayerMap>(node);
}

void GeoTerrainBridgeEditorPlugin::setupMenu()
{
    pluginMenu = WindowManager::findMenu("GeoTerrain");
    if (!pluginMenu)
    {
        if (auto* mainWindow = qobject_cast<QMainWindow*>(QApplication::activeWindow()))
        {
            pluginMenu = new QMenu("GeoTerrain", mainWindow);
            if (mainWindow->menuBar())
                mainWindow->menuBar()->addMenu(pluginMenu);
            ownsMenu = true;
        }
        else
        {
            pluginMenu = new QMenu("GeoTerrain");
            ownsMenu = true;
        }
    }

    if (!pluginMenu)
    {
        Log::error("[GeoTerrainBridge] Failed to create menu action: pluginMenu is null\n");
        return;
    }

    geoTerrainAction = new QAction("GeoTerrain Bridge", pluginMenu);
    connect(geoTerrainAction, &QAction::triggered,
            this, &GeoTerrainBridgeEditorPlugin::openGeoTerrainPanel);

    pluginMenu->addAction(geoTerrainAction);
}

void GeoTerrainBridgeEditorPlugin::openGeoTerrainPanel()
{
    if (!geoTerrainPanel)
        return;

    WindowManager::show(geoTerrainPanel.get());
    WindowManager::activate(geoTerrainPanel.get());
}
}
