using UnrealBuildTool;
using System.IO;

public class GeoTerrain : ModuleRules
{
    public GeoTerrain(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

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
        });

        // GDAL — place OSGeo4W or your GDAL build under ThirdParty/GDAL/
        string GdalRoot = Path.Combine(ModuleDirectory, "..", "..", "ThirdParty", "GDAL");
        if (Directory.Exists(GdalRoot))
        {
            PublicIncludePaths.Add(Path.Combine(GdalRoot, "include"));
            PublicAdditionalLibraries.Add(Path.Combine(GdalRoot, "lib", "gdal_i.lib"));
            RuntimeDependencies.Add(Path.Combine(GdalRoot, "bin", "gdal310.dll"));
        }
    }
}
