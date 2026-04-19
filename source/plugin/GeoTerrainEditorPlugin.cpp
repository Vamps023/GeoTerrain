#include "plugin/GeoTerrainEditorPlugin.h"
#include "ui/GeoTerrainPanel.h"

#include <editor/UnigineWindowManager.h>

#include <QtWidgets/QApplication>
#include <QtWidgets/QMainWindow>
#include <QtWidgets/QMenuBar>
#include <QCoreApplication>

#include <UnigineLog.h>

using namespace UnigineEditor;

GeoTerrainEditorPlugin::GeoTerrainEditorPlugin() = default;
GeoTerrainEditorPlugin::~GeoTerrainEditorPlugin() = default;

bool GeoTerrainEditorPlugin::init()
{
    try
    {
        // Add Qt plugin paths to ensure image format plugins (JPEG, etc.) are found
        // This is critical for satellite tile decoding
        QCoreApplication::addLibraryPath("C:/Qt/Qt5.12.3/5.12.3/msvc2017_64/plugins");
        QCoreApplication::addLibraryPath(QCoreApplication::applicationDirPath() + "/../plugins");
        QCoreApplication::addLibraryPath(QCoreApplication::applicationDirPath() + "/plugins");
        
        geo_terrain_panel_ = std::make_unique<GeoTerrainPanel>();

        setupMenu();
        WindowManager::add(geo_terrain_panel_.get(), WindowManager::AreaType::ROOT_AREA_RIGHT);
        return true;
    }
    catch (const std::exception& e)
    {
        Unigine::Log::error("[GeoTerrain] Failed to initialize plugin: %s\n", e.what());
        return false;
    }
}

void GeoTerrainEditorPlugin::shutdown()
{
    if (vamps_menu_ && geo_terrain_action_)
        vamps_menu_->removeAction(geo_terrain_action_);

    delete geo_terrain_action_;
    geo_terrain_action_ = nullptr;

    if (geo_terrain_panel_)
        WindowManager::remove(geo_terrain_panel_.get());

    geo_terrain_panel_.reset();

    if (owns_menu_ && vamps_menu_)
    {
        delete vamps_menu_;
        vamps_menu_ = nullptr;
        owns_menu_  = false;
    }
}

void GeoTerrainEditorPlugin::setupMenu()
{
    vamps_menu_ = WindowManager::findMenu("VampsPlugin");
    if (!vamps_menu_)
    {
        if (auto* main_window = qobject_cast<QMainWindow*>(QApplication::activeWindow()))
        {
            vamps_menu_ = new QMenu("VampsPlugin", main_window);
            if (main_window->menuBar())
                main_window->menuBar()->addMenu(vamps_menu_);
            owns_menu_ = true;
        }
        else
        {
            vamps_menu_ = new QMenu("VampsPlugin");
            owns_menu_  = true;
        }
    }

    geo_terrain_action_ = new QAction("GeoTerrain Generator", vamps_menu_);
    connect(geo_terrain_action_, &QAction::triggered,
            this, &GeoTerrainEditorPlugin::openGeoTerrainTool);

    if (vamps_menu_)
        vamps_menu_->addAction(geo_terrain_action_);
}

void GeoTerrainEditorPlugin::openGeoTerrainTool()
{
    if (!geo_terrain_panel_)
        return;

    WindowManager::show(geo_terrain_panel_.get());
    WindowManager::activate(geo_terrain_panel_.get());
}
