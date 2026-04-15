using UnrealBuildTool;
using System.IO;

public class GeoTerrain : ModuleRules
{
    public GeoTerrain(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

        // Suppress C4668/C4067 from UE engine headers with VS2022 17.10+
        bEnableUndefinedIdentifierWarnings = false;
        bEnableExceptions = false;

        PublicIncludePaths.AddRange(new string[] {
            Path.Combine(ModuleDirectory, "Public")
        });

        PrivateIncludePaths.AddRange(new string[] {
            Path.Combine(ModuleDirectory, "Private")
        });

        // UE core editor modules
        PublicDependencyModuleNames.AddRange(new string[] {
            "Core",
            "CoreUObject",
            "Engine",
            "Slate",
            "SlateCore",
            "EditorStyle",
            "LandscapeEditor",
            "Landscape",
            "HTTP",
            "Json",
            "JsonUtilities",
            "UnrealEd",
            "ToolMenus",
            "InputCore",
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "Projects",
            "AppFramework",
            "PropertyEditor",
            "EditorFramework",
            "WebBrowser",
        });

        // GDAL — place OSGeo4W or your GDAL build under ThirdParty/GDAL/
        string GdalRoot = Path.Combine(ModuleDirectory, "..", "..", "ThirdParty", "GDAL");
        if (Directory.Exists(GdalRoot))
        {
            // Use ExternalIncludePaths so UBT treats as system headers (no /W4 applied)
            PublicSystemIncludePaths.Add(Path.Combine(GdalRoot, "include"));
            PublicAdditionalLibraries.Add(Path.Combine(GdalRoot, "lib", "gdal_i.lib"));
            RuntimeDependencies.Add(Path.Combine(GdalRoot, "bin", "gdal312.dll"));
            // Delay-load: defer DLL resolution until first GDAL call (after StartupModule sets search path)
            PublicDelayLoadDLLs.Add("gdal312.dll");
        }
    }
}
