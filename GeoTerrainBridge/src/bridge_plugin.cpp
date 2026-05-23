#include "bridge_plugin.h"
#include "bridge_panel.h"
#include <QDockWidget>
#include <QMainWindow>
#include <QMenuBar>
#include <QAction>
#include <QDebug>

// ─── Plugin Singleton ─────────────────────────────────────────
static GeoTerrainBridgePlugin* g_plugin = nullptr;

GeoTerrainBridgePlugin::GeoTerrainBridgePlugin(QObject* parent)
    : QObject(parent)
{
    g_plugin = this;
}

GeoTerrainBridgePlugin::~GeoTerrainBridgePlugin() {
    g_plugin = nullptr;
}

bool GeoTerrainBridgePlugin::init() {
    qDebug() << "[GeoTerrainBridge] Initializing...";
    
    // Find UNIGINE Editor main window
    QMainWindow* mainWindow = nullptr;
    for (QWidget* w : QApplication::topLevelWidgets()) {
        if (QMainWindow* mw = qobject_cast<QMainWindow*>(w)) {
            mainWindow = mw;
            break;
        }
    }
    
    if (!mainWindow) {
        qWarning() << "[GeoTerrainBridge] Could not find UNIGINE Editor main window";
        return false;
    }
    
    // Create dock widget
    panel_ = new BridgePanel();
    dockWidget_ = new QDockWidget("GeoTerrain Bridge", mainWindow);
    dockWidget_->setWidget(panel_);
    dockWidget_->setAllowedAreas(Qt::LeftDockWidgetArea | Qt::RightDockWidgetArea);
    dockWidget_->setFeatures(QDockWidget::DockWidgetClosable | QDockWidget::DockWidgetMovable);
    
    mainWindow->addDockWidget(Qt::RightDockWidgetArea, dockWidget_);
    
    // Add menu item
    QMenuBar* menuBar = mainWindow->menuBar();
    QMenu* vampsMenu = nullptr;
    
    for (QAction* action : menuBar->actions()) {
        if (action->text().contains("Vamps", Qt::CaseInsensitive)) {
            vampsMenu = action->menu();
            break;
        }
    }
    
    if (!vampsMenu) {
        vampsMenu = menuBar->addMenu("VampsPlugin");
    }
    
    QAction* bridgeAction = vampsMenu->addAction("GeoTerrain Bridge");
    connect(bridgeAction, &QAction::triggered, [this]() {
        dockWidget_->show();
        dockWidget_->raise();
    });
    
    qDebug() << "[GeoTerrainBridge] Initialized successfully.";
    return true;
}

void GeoTerrainBridgePlugin::shutdown() {
    qDebug() << "[GeoTerrainBridge] Shutting down...";
    
    if (dockWidget_) {
        dockWidget_->close();
        delete dockWidget_;
        dockWidget_ = nullptr;
    }
    panel_ = nullptr;
}

void GeoTerrainBridgePlugin::update(int ifps) {
    // Per-frame update if needed
    Q_UNUSED(ifps)
}

// ─── C Exports ────────────────────────────────────────────────

void InitPlugin() {
    if (!g_plugin) {
        g_plugin = new GeoTerrainBridgePlugin();
    }
    g_plugin->init();
}

void ShutdownPlugin() {
    if (g_plugin) {
        g_plugin->shutdown();
        delete g_plugin;
        g_plugin = nullptr;
    }
}

void UpdatePlugin(int ifps) {
    if (g_plugin) {
        g_plugin->update(ifps);
    }
}

const char* GetPluginName() {
    return "GeoTerrain Bridge";
}

const char* GetPluginVersion() {
    return "2.0.0";
}
