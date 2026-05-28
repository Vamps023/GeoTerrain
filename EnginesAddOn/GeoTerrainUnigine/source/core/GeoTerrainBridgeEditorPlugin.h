#pragma once

#include <editor/UniginePlugin.h>

#include <QObject>
#include <QAction>
#include <QMenu>

#include <UnigineNode.h>
#include <UnigineObjects.h>

#include <memory>
#include <vector>

class LandscapeSaveManager;
class GeoTerrainImporter;
class GeoTerrainPanel;

namespace UnigineEditor
{
class GeoTerrainBridgeEditorPlugin : public QObject, public Plugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID UNIGINE_EDITOR_PLUGIN_IID FILE "GeoTerrainBridgeEditorPlugin.json")
    Q_INTERFACES(UnigineEditor::Plugin)

public:
    GeoTerrainBridgeEditorPlugin();
    ~GeoTerrainBridgeEditorPlugin() override;

    bool init() override;
    void shutdown() override;

    std::vector<Unigine::ObjectLandscapeTerrainPtr> getLandscapeTerrains() const;
    std::vector<Unigine::LandscapeLayerMapPtr> getLandscapeLayerMaps(
        const Unigine::ObjectLandscapeTerrainPtr& terrain) const;
    Unigine::LandscapeLayerMapPtr getLandscapeLayerMapById(int nodeId) const;
    GeoTerrainImporter* importer() const { return geoTerrainImporter.get(); }

private slots:
    void openGeoTerrainPanel();

private:
    void setupMenu();

    std::unique_ptr<LandscapeSaveManager> saveManager;
    std::unique_ptr<GeoTerrainImporter> geoTerrainImporter;
    std::unique_ptr<GeoTerrainPanel> geoTerrainPanel;

    QMenu* pluginMenu = nullptr;
    QAction* geoTerrainAction = nullptr;
    bool ownsMenu = false;
};
}
