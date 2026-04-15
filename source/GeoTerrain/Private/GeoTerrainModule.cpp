#include "GeoTerrainModule.h"
#include "UI/SGeoTerrainPanel.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"
#include "ToolMenus.h"
#include "LevelEditor.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"
#include "HAL/FileManager.h"

#include <gdal_priv.h>
#include <cpl_conv.h>

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <Windows.h>
#include "Windows/HideWindowsPlatformTypes.h"
#endif

static const FName GeoTerrainTabName("GeoTerrain");

void FGeoTerrainModule::StartupModule()
{
    // Add plugin Binaries/Win64 to DLL search path so gdal312.dll and its deps are found
    const FString BinDir = FPaths::ConvertRelativePathToFull(
        FPaths::ProjectPluginsDir() / TEXT("GeoTerrain/Binaries/Win64"));
#if PLATFORM_WINDOWS
    SetDllDirectoryW(*BinDir);
    // Explicitly load gdal312.dll from our folder before GDALAllRegister()
    FString GdalDllPath = BinDir / TEXT("gdal312.dll");
    HMODULE hGdal = LoadLibraryW(*GdalDllPath);
    if (!hGdal)
    {
        UE_LOG(LogTemp, Error, TEXT("GeoTerrain: Failed to load gdal312.dll from %s (error %d)"), *GdalDllPath, GetLastError());
    }
#endif

    // Point GDAL/PROJ at data bundled alongside the plugin DLL
    const FString GdalData = BinDir / TEXT("gdal-data");
    const FString ProjData = BinDir / TEXT("proj-data");
    CPLSetConfigOption("GDAL_DATA",  TCHAR_TO_UTF8(*GdalData));
    CPLSetConfigOption("PROJ_DATA",  TCHAR_TO_UTF8(*ProjData));
    GDALAllRegister();

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
    Section.AddMenuEntry(
        "GeoTerrainOpen",
        NSLOCTEXT("GeoTerrain", "OpenPanel", "GeoTerrain Generator"),
        NSLOCTEXT("GeoTerrain", "OpenPanelTip", "Open the GeoTerrain real-world terrain generator"),
        FSlateIcon(),
        FUIAction(FExecuteAction::CreateLambda([]{
            FGlobalTabmanager::Get()->TryInvokeTab(FTabId(GeoTerrainTabName));
        }))
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
