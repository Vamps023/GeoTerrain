#include "GeoTerrainModule.h"
#include "UI/SGeoTerrainPanel.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"
#include "ToolMenus.h"
#include "LevelEditor.h"

static const FName GeoTerrainTabName("GeoTerrain");

void FGeoTerrainModule::StartupModule()
{
    UToolMenus::RegisterStartupCallback(
        FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FGeoTerrainModule::RegisterMenus));

    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        GeoTerrainTabName,
        FOnSpawnTab::CreateRaw(this, &FGeoTerrainModule::SpawnGeoTerrainTab))
        .SetDisplayName(NSLOCTEXT("GeoTerrain", "TabTitle", "GeoTerrain Generator"))
        .SetMenuType(ETabSpawnerMenuType::Hidden);
}

void FGeoTerrainModule::ShutdownModule()
{
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(GeoTerrainTabName);
}

void FGeoTerrainModule::RegisterMenus()
{
    FToolMenuOwnerScoped OwnerScoped(this);
    UToolMenu* Menu = UToolMenus::Get()->ExtendMenu("LevelEditor.MainMenu.Window");
    FToolMenuSection& Section = Menu->FindOrAddSection("WindowLayout");
    Section.AddMenuEntryWithCommandList(
        FUIAction(FExecuteAction::CreateLambda([]{
            FGlobalTabmanager::Get()->TryInvokeTab(FTabId(GeoTerrainTabName));
        })),
        NAME_None,
        NSLOCTEXT("GeoTerrain", "OpenPanel", "GeoTerrain Generator"),
        NSLOCTEXT("GeoTerrain", "OpenPanelTip", "Open the GeoTerrain real-world terrain generator"),
        FSlateIcon()
    );
}

TSharedRef<SDockTab> FGeoTerrainModule::SpawnGeoTerrainTab(const FSpawnTabArgs& Args)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            SNew(SGeoTerrainPanel)
        ];
}

IMPLEMENT_MODULE(FGeoTerrainModule, GeoTerrain)
