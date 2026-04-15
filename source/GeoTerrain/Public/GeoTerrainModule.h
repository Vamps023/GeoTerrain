#pragma once
#include "Modules/ModuleManager.h"

class FGeoTerrainModule : public IModuleInterface
{
public:
    virtual void StartupModule()  override;
    virtual void ShutdownModule() override;

private:
    void RegisterMenus();
    TSharedRef<SDockTab> SpawnGeoTerrainTab(const FSpawnTabArgs& Args);

    TSharedPtr<class FUICommandList> PluginCommands;
};
