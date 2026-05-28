#pragma once

#include "../landscape/LandscapeSaveManager.h"
#include "../terrain/BrushMaterialFactory.h"

#include <UnigineEvent.h>
#include <UnigineImage.h>
#include <UnigineObjects.h>

#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

// Imports GeoTerrain Studio packages into Unigine Landscape Terrain.
// Supports heightmap (PNG/GeoTIFF) and albedo (PNG) import per tile.
// Can create new LandscapeLayerMap tiles or overwrite existing ones.
// Uses async GPU dispatch via Landscape::asyncTextureDraw.
class GeoTerrainImporter
{
public:
    using LogFn = std::function<void(const std::string&)>;

    struct ImportResult
    {
        bool success = false;
        int tilesImported = 0;
        int tilesFailed = 0;
        int tilesCreated = 0;
        std::string error;
    };

    struct TileManifest
    {
        int row = 0;
        int col = 0;
        std::string heightmapFile;
        std::string albedoFile;
        std::string maskFiles[5]; // road, water, vegetation, building, cliff
        float elevationMin = 0.0f;
        float elevationMax = 100.0f;
        float worldOffsetX = 0.0f;
        float worldOffsetY = 0.0f;
        float worldOffsetZ = 0.0f;
    };

    struct PackageManifest
    {
        std::vector<TileManifest> tiles;
        float chunkSizeM = 4000.0f;
        bool valid = false;
        std::string effectivePath; // Resolved package path (may differ from input if subfolder was selected)
    };

    explicit GeoTerrainImporter(LandscapeSaveManager& saveManager);
    ~GeoTerrainImporter();

    // Parses a GeoTerrain package manifest.json (root or tile subfolders).
    [[nodiscard]] static PackageManifest parsePackageManifest(const std::string& packagePath);

    // Imports a full GeoTerrain package into the active landscape terrain.
    // If targetTerrain is null, uses Landscape::getActiveTerrain().
    // If targetTile is null, matches tiles by row/col name, or creates new tiles when autoCreate=true.
    [[nodiscard]] ImportResult importPackage(const std::string& packagePath,
                                              const Unigine::ObjectLandscapeTerrainPtr& targetTerrain,
                                              const Unigine::LandscapeLayerMapPtr& targetTile,
                                              bool importAlbedo,
                                              bool importMasks,
                                              bool autoCreateTiles,
                                              const LogFn& log);

    // Imports a single tile's heightmap into the given LandscapeLayerMap.
    [[nodiscard]] bool importTileHeightmap(const Unigine::LandscapeLayerMapPtr& tile,
                                            const std::string& heightmapPath,
                                            float elevationMin,
                                            float elevationMax,
                                            const LogFn& log);

    // Imports a single tile's albedo into the given LandscapeLayerMap.
    [[nodiscard]] bool importTileAlbedo(const Unigine::LandscapeLayerMapPtr& tile,
                                         const std::string& albedoPath,
                                         const LogFn& log);

    // Creates a new LandscapeLayerMap tile under the given terrain using
    // LandscapeMapFileCreator to generate a proper .lmap file.
    // Returns nullptr if the .lmap file could not be created.
    [[nodiscard]] static Unigine::LandscapeLayerMapPtr createTile(
        const Unigine::ObjectLandscapeTerrainPtr& terrain,
        const std::string& name,
        const Unigine::Math::ivec2& resolution,
        const Unigine::Math::Vec2& size,
        const Unigine::Math::dvec3& worldPos,
        const std::string& dataPath);

    // Returns true while async texture-draw operations are still in flight.
    [[nodiscard]] bool isBusy() const;
    // Returns the number of queued but not yet dispatched brush operations.
    [[nodiscard]] size_t pendingOperationCount() const;
    // Forces an immediate flush of all pending landscape saves.
    void flushPendingSaves();

private:
    struct BrushOperationData
    {
        Unigine::MaterialPtr brushMaterial;
        Unigine::ImagePtr heightImage;
        Unigine::ImagePtr alphaImage;
        Unigine::ImagePtr albedoImage;
        bool modifyHeights = false;
        bool modifyAlbedo = false;
        Unigine::Math::ivec2 drawCoord = Unigine::Math::ivec2_zero;
        Unigine::Math::ivec2 drawSize = Unigine::Math::ivec2_zero;
    };

    static constexpr bool kDebugHotPathLogs = false;

    [[nodiscard]] bool beginActionTransaction();
    void finishActionScheduling();
    void endTransactionsIfIdle();

    [[nodiscard]] bool setTerrainHeight(const Unigine::LandscapeLayerMapPtr& tile,
                                        const Unigine::ImagePtr& heightImage);
    [[nodiscard]] bool setTerrainAlbedo(const Unigine::LandscapeLayerMapPtr& tile,
                                        const Unigine::ImagePtr& albedoImage);
    [[nodiscard]] bool applyHeightOverwrite(const Unigine::LandscapeTexturesPtr& buffer,
                                            const Unigine::MaterialPtr& brushMaterial,
                                            const Unigine::TexturePtr& heightTexture,
                                            const Unigine::TexturePtr& alphaTexture);
    [[nodiscard]] bool applyAlbedoOverwrite(const Unigine::LandscapeTexturesPtr& buffer,
                                            const Unigine::MaterialPtr& brushMaterial,
                                            const Unigine::TexturePtr& albedoTexture);

    void onTextureDraw(const Unigine::UGUID& guid, int operationId,
                       const Unigine::LandscapeTexturesPtr& buffer,
                       const Unigine::Math::ivec2& coord,
                       int dataMask);

    [[nodiscard]] static Unigine::ImagePtr loadHeightmapImage(const std::string& path,
                                                               float elevationMin,
                                                               float elevationMax);
    [[nodiscard]] static Unigine::ImagePtr createSolidAlphaImage(const Unigine::Math::ivec2& resolution, float alpha);

    LandscapeSaveManager& saveManager;
    std::unordered_map<int, BrushOperationData> pendingOperations;

    Unigine::EventConnection textureDrawConnection;
    int pendingTransactionCommits = 0;
    bool inProgress = false;
};
