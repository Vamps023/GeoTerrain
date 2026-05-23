#pragma once

#include <QObject>
#include <UnigineEditor.h>

/**
 * GeoTerrain Bridge for UNIGINE
 * 
 * A lightweight editor plugin that imports Terrain Packages
 * (produced by GeoTerrain Studio) into UNIGINE as LandscapeLayerMap terrain.
 * 
 * No GDAL, no libcurl, no SQLite — just manifest parsing + UNIGINE SDK calls.
 */

class BridgePanel;

class GeoTerrainBridgePlugin : public QObject, public UnigineEditor::Plugin {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID "com.vamps.GeoTerrainBridge" FILE "GeoTerrainBridge.json")
    Q_INTERFACES(UnigineEditor::Plugin)

public:
    explicit GeoTerrainBridgePlugin(QObject* parent = nullptr);
    ~GeoTerrainBridgePlugin() override;

    bool init() override;
    void shutdown() override;
    void update(int ifps) override;

private:
    BridgePanel* panel_ = nullptr;
    QWidget* dockWidget_ = nullptr;
};

// C exports for UNIGINE plugin loader
extern "C" Q_DECL_EXPORT void InitPlugin();
extern "C" Q_DECL_EXPORT void ShutdownPlugin();
extern "C" Q_DECL_EXPORT void UpdatePlugin(int ifps);
extern "C" Q_DECL_EXPORT const char* GetPluginName();
extern "C" Q_DECL_EXPORT const char* GetPluginVersion();
