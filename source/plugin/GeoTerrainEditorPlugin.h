#pragma once

#include <editor/UniginePlugin.h>

#include <QObject>
#include <QAction>
#include <QMenu>

#include <memory>

class GeoTerrainPanel;

namespace UnigineEditor
{
class GeoTerrainEditorPlugin : public QObject, public Plugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID UNIGINE_EDITOR_PLUGIN_IID FILE "GeoTerrainEditorPlugin.json")
    Q_INTERFACES(UnigineEditor::Plugin)

public:
    GeoTerrainEditorPlugin();
    ~GeoTerrainEditorPlugin() override;

    bool init() override;
    void shutdown() override;

private slots:
    void openGeoTerrainTool();

private:
    void setupMenu();

    std::unique_ptr<GeoTerrainPanel> geo_terrain_panel_;

    QMenu*   vamps_menu_          = nullptr;
    QAction* geo_terrain_action_  = nullptr;
    bool     owns_menu_           = false;
};
} // namespace UnigineEditor
