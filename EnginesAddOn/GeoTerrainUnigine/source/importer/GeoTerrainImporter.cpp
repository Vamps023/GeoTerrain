#include "GeoTerrainImporter.h"

#include <UnigineFileSystem.h>
#include <UnigineLog.h>
#include <UnigineWorld.h>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

using namespace Unigine;
using namespace Unigine::Math;

namespace
{
void logMessage(const GeoTerrainImporter::LogFn& log, const std::string& message)
{
    if (log)
        log(message);
}

std::string joinPath(const std::string& a, const std::string& b)
{
    if (a.empty())
        return b;
    if (b.empty())
        return a;
    const char last = a.back();
    if (last == '/' || last == '\\')
        return a + b;
    return a + "/" + b;
}

bool fileExists(const std::string& path)
{
    std::ifstream f(path);
    return f.good();
}

// Minimal JSON string extraction helpers (no external library)
std::string trim(const std::string& s)
{
    size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start]))) ++start;
    size_t end = s.size();
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) --end;
    return s.substr(start, end - start);
}

std::string extractStringValue(const std::string& json, const std::string& key)
{
    size_t pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos)
        return "";
    pos = json.find(':', pos + key.size() + 2);
    if (pos == std::string::npos)
        return "";
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size())
        return "";
    if (json[pos] == '"')
    {
        size_t end = json.find('"', pos + 1);
        if (end == std::string::npos)
            return "";
        return json.substr(pos + 1, end - pos - 1);
    }
    // Number or literal
    size_t end = pos;
    while (end < json.size() && json[end] != ',' && json[end] != '}' && json[end] != ']')
        ++end;
    return trim(json.substr(pos, end - pos));
}

float extractFloatValue(const std::string& json, const std::string& key, float defaultValue)
{
    std::string val = extractStringValue(json, key);
    if (val.empty())
        return defaultValue;
    try
    {
        return std::stof(val);
    }
    catch (...)
    {
        return defaultValue;
    }
}

int extractIntValue(const std::string& json, const std::string& key, int defaultValue)
{
    std::string val = extractStringValue(json, key);
    if (val.empty())
        return defaultValue;
    try
    {
        return std::stoi(val);
    }
    catch (...)
    {
        return defaultValue;
    }
}

// Find the JSON object starting after a key like "files": { ... }
std::string extractObject(const std::string& json, const std::string& key)
{
    size_t pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos)
        return "";
    pos = json.find('{', pos + key.size() + 2);
    if (pos == std::string::npos)
        return "";

    int depth = 1;
    size_t end = pos + 1;
    while (end < json.size() && depth > 0)
    {
        if (json[end] == '{')
            ++depth;
        else if (json[end] == '}')
            --depth;
        else if (json[end] == '"')
        {
            ++end;
            while (end < json.size() && json[end] != '"')
            {
                if (json[end] == '\\' && end + 1 < json.size())
                    ++end;
                ++end;
            }
        }
        ++end;
    }
    return json.substr(pos, end - pos);
}

// Extract a value from an inline object string (assumes simple keys, no nesting)
std::string extractInlineValue(const std::string& obj, const std::string& key)
{
    return extractStringValue(obj, key);
}

// Read entire file into string
std::string readFileToString(const std::string& path)
{
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return "";
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Parse a single tile manifest JSON string into a TileManifest
GeoTerrainImporter::TileManifest parseTileManifestJson(const std::string& json, const std::string& relativePath)
{
    GeoTerrainImporter::TileManifest tile;
    tile.row = extractIntValue(json, "row", 0);
    tile.col = extractIntValue(json, "col", 0);

    std::string filesObj = extractObject(json, "files");
    if (!filesObj.empty())
    {
        tile.heightmapFile = extractInlineValue(filesObj, "heightmap");
        tile.albedoFile = extractInlineValue(filesObj, "albedo");
        tile.maskFiles[0] = extractInlineValue(filesObj, "roadMask");
        tile.maskFiles[1] = extractInlineValue(filesObj, "waterMask");
        tile.maskFiles[2] = extractInlineValue(filesObj, "vegetationMask");
        tile.maskFiles[3] = extractInlineValue(filesObj, "buildingMask");
        tile.maskFiles[4] = extractInlineValue(filesObj, "cliffMask");
    }

    // Prepend relative path to files if this is a subfolder manifest
    if (!relativePath.empty())
    {
        if (!tile.heightmapFile.empty())
            tile.heightmapFile = joinPath(relativePath, tile.heightmapFile);
        if (!tile.albedoFile.empty())
            tile.albedoFile = joinPath(relativePath, tile.albedoFile);
        for (int i = 0; i < 5; ++i)
        {
            if (!tile.maskFiles[i].empty())
                tile.maskFiles[i] = joinPath(relativePath, tile.maskFiles[i]);
        }
    }

    std::string elevObj = extractObject(json, "elevation");
    if (!elevObj.empty())
    {
        tile.elevationMin = extractFloatValue(elevObj, "min", 0.0f);
        tile.elevationMax = extractFloatValue(elevObj, "max", 100.0f);
    }

    std::string woObj = extractObject(json, "worldOffset");
    if (!woObj.empty())
    {
        tile.worldOffsetX = extractFloatValue(woObj, "x", 0.0f);
        tile.worldOffsetY = extractFloatValue(woObj, "y", 0.0f);
        tile.worldOffsetZ = extractFloatValue(woObj, "z", 0.0f);
    }

    return tile;
}

// Parse tiles array from a root manifest JSON string
void parseTilesArray(const std::string& json, GeoTerrainImporter::PackageManifest& manifest)
{
    size_t tilesPos = json.find("\"tiles\"");
    if (tilesPos == std::string::npos)
        return;

    size_t arrStart = json.find('[', tilesPos);
    if (arrStart == std::string::npos)
        return;

    int arrayDepth = 1;
    int objectDepth = 0;
    size_t i = arrStart + 1;
    size_t objStart = std::string::npos;
    while (i < json.size() && arrayDepth > 0)
    {
        if (json[i] == '[')
        {
            ++arrayDepth;
        }
        else if (json[i] == ']')
        {
            --arrayDepth;
        }
        else if (json[i] == '{')
        {
            ++objectDepth;
            if (objectDepth == 1 && arrayDepth == 1)
                objStart = i;
        }
        else if (json[i] == '}')
        {
            if (objectDepth == 1 && arrayDepth == 1 && objStart != std::string::npos)
            {
                std::string tileJson = json.substr(objStart, i - objStart + 1);
                manifest.tiles.push_back(parseTileManifestJson(tileJson, ""));
                objStart = std::string::npos;
            }
            --objectDepth;
        }
        else if (json[i] == '"')
        {
            ++i;
            while (i < json.size() && json[i] != '"')
            {
                if (json[i] == '\\' && i + 1 < json.size())
                    ++i;
                ++i;
            }
        }
        ++i;
    }
}

// Scan for tile subfolders like tile_0_0, tile_0_1, etc.
// Returns list of (subfolder_name, manifest_json_string)
std::vector<std::pair<std::string, std::string>> scanTileSubfolders(const std::string& packagePath)
{
    std::vector<std::pair<std::string, std::string>> results;

    // Use Windows FindFirstFile/FindNextFile via Shell command
    // Since we can't easily list directories in portable C++ without filesystem,
    // we use a simple approach: try common tile patterns
    for (int row = 0; row < 100; ++row)
    {
        for (int col = 0; col < 100; ++col)
        {
            std::string folderName = "tile_" + std::to_string(row) + "_" + std::to_string(col);
            std::string manifestPath = joinPath(packagePath, joinPath(folderName, "manifest.json"));
            if (fileExists(manifestPath))
            {
                std::string json = readFileToString(manifestPath);
                if (!json.empty())
                    results.push_back({folderName, json});
            }
            else
            {
                // If tile_0_0 doesn't exist, don't scan the whole grid
                if (row == 0 && col == 0)
                {
                    // Try a few more then give up
                    continue;
                }
                else if (col == 0)
                {
                    // No more rows
                    break;
                }
            }
        }
        // Stop if we didn't find anything in row 0
        if (row == 0 && results.empty())
            break;
        // Stop if first column of this row doesn't exist
        std::string firstColManifest = joinPath(packagePath, joinPath("tile_" + std::to_string(row) + "_0", "manifest.json"));
        if (!fileExists(firstColManifest))
            break;
    }

    return results;
}
}

GeoTerrainImporter::GeoTerrainImporter(LandscapeSaveManager& saveManager)
    : saveManager(saveManager)
{
    Landscape::getEventTextureDraw().connect(textureDrawConnection,
        [this](const UGUID& guid, int operationId, const LandscapeTexturesPtr& buffer,
               const ivec2& coord, int dataMask)
        {
            onTextureDraw(guid, operationId, buffer, coord, dataMask);
        });
}

GeoTerrainImporter::~GeoTerrainImporter()
{
    textureDrawConnection.disconnect();

    pendingOperations.clear();
    pendingTransactionCommits = 0;
    inProgress = false;
}

GeoTerrainImporter::PackageManifest GeoTerrainImporter::parsePackageManifest(const std::string& packagePath)
{
    PackageManifest manifest;
    manifest.valid = false;

    // Detect if user selected a tile subfolder instead of the root package folder.
    // If the selected folder contains a manifest.json and looks like a single tile,
    // try to use the parent folder instead.
    std::string effectivePath = packagePath;
    const std::string selectedManifestPath = joinPath(packagePath, "manifest.json");
    if (fileExists(selectedManifestPath))
    {
        const std::string selectedJson = readFileToString(selectedManifestPath);
        if (!selectedJson.empty())
        {
            // Check if this looks like a single-tile subfolder manifest
            // (has exactly 1 tile with matching folder name)
            std::string tileGridObj = extractObject(selectedJson, "tileGrid");
            int rows = extractIntValue(tileGridObj, "rows", 1);
            int cols = extractIntValue(tileGridObj, "cols", 1);
            if (rows == 1 && cols == 1)
            {
                // Check if parent folder has other tile subfolders
                size_t lastSlash = packagePath.find_last_of("/\\");
                if (lastSlash != std::string::npos)
                {
                    std::string parentPath = packagePath.substr(0, lastSlash);
                    std::string folderName = packagePath.substr(lastSlash + 1);
                    // If folder name looks like tile_0_0, use parent
                    if (folderName.find("tile_") == 0)
                    {
                        // Check if parent has other tile folders
                        std::string siblingManifest = joinPath(parentPath, joinPath(folderName, "manifest.json"));
                        if (fileExists(siblingManifest))
                        {
                            effectivePath = parentPath;
                        }
                    }
                }
            }
        }
    }

    // Strategy 1: Try root manifest.json (single-tile or multi-tile with root manifest)
    const std::string rootManifestPath = joinPath(effectivePath, "manifest.json");
    if (fileExists(rootManifestPath))
    {
        const std::string json = readFileToString(rootManifestPath);
        if (!json.empty())
        {
            manifest.chunkSizeM = extractFloatValue(json, "chunkSizeM", 4000.0f);

            std::string tileGridObj = extractObject(json, "tileGrid");
            if (!tileGridObj.empty())
            {
                manifest.chunkSizeM = extractFloatValue(tileGridObj, "chunkSizeM", manifest.chunkSizeM);
            }

            parseTilesArray(json, manifest);

            if (!manifest.tiles.empty())
                manifest.valid = true;
        }
    }

    // Strategy 2: If no root manifest or no tiles found, scan tile subfolders
    if (!manifest.valid || manifest.tiles.empty())
    {
        auto tileSubfolders = scanTileSubfolders(effectivePath);
        if (!tileSubfolders.empty())
        {
            // Use chunkSizeM from first tile's manifest if available
            if (manifest.chunkSizeM <= 0)
            {
                std::string tileGridObj = extractObject(tileSubfolders[0].second, "tileGrid");
                if (!tileGridObj.empty())
                    manifest.chunkSizeM = extractFloatValue(tileGridObj, "chunkSizeM", 4000.0f);
                else
                    manifest.chunkSizeM = 4000.0f;
            }

            for (const auto& [folderName, json] : tileSubfolders)
            {
                TileManifest tile = parseTileManifestJson(json, folderName);
                manifest.tiles.push_back(tile);
            }

            if (!manifest.tiles.empty())
                manifest.valid = true;
        }
    }

    manifest.effectivePath = effectivePath;
    return manifest;
}

LandscapeLayerMapPtr GeoTerrainImporter::createTile(const ObjectLandscapeTerrainPtr& terrain,
                                                     const std::string& name,
                                                     const ivec2& resolution,
                                                     const Vec2& size,
                                                     const dvec3& worldPos,
                                                     const std::string& dataPath)
{
    if (!terrain)
    {
        Log::error("[GeoTerrainImporter] createTile: null terrain.\n");
        return nullptr;
    }

    // Use LandscapeMapFileCreator to generate a proper .lmap file.
    // This is the only way to create a LandscapeLayerMap with valid resolution.
    std::string lmapPath = joinPath(dataPath, name + ".lmap");

    LandscapeMapFileCreatorPtr creator = LandscapeMapFileCreator::create();
    if (!creator)
    {
        Log::error("[GeoTerrainImporter] createTile: failed to create LandscapeMapFileCreator.\n");
        return nullptr;
    }

    creator->setResolution(resolution);
    creator->setGrid(ivec2(1, 1));
    creator->setPath(lmapPath.c_str());

    // We need to fill the initial data via the create event.
    // For a blank tile, we create solid images.
    EventConnection createConnection;
    creator->getEventCreate().connect(createConnection,
        [resolution](const LandscapeMapFileCreatorPtr&, const LandscapeImagesPtr& images, int, int)
        {
            if (!images)
                return;
            // Fill height with 0
            ImagePtr height = images->getHeight();
            if (height)
            {
                for (int y = 0; y < resolution.y; ++y)
                {
                    for (int x = 0; x < resolution.x; ++x)
                    {
                        height->set2D(x, y, Image::Pixel(0.0f, 0.0f, 0.0f, 1.0f));
                    }
                }
            }
            // Fill albedo with gray
            ImagePtr albedo = images->getAlbedo();
            if (albedo)
            {
                for (int y = 0; y < resolution.y; ++y)
                {
                    for (int x = 0; x < resolution.x; ++x)
                    {
                        albedo->set2D(x, y, Image::Pixel(128, 128, 128, 255));
                    }
                }
            }
        });

    if (!creator->run(true, true))
    {
        Log::error("[GeoTerrainImporter] createTile: LandscapeMapFileCreator::run() failed for '%s'.\n", lmapPath.c_str());
        return nullptr;
    }

    // Now create the LandscapeLayerMap node and point it to the .lmap file
    LandscapeLayerMapPtr tile = LandscapeLayerMap::create();
    if (!tile)
    {
        Log::error("[GeoTerrainImporter] createTile: failed to create LandscapeLayerMap node.\n");
        return nullptr;
    }

    tile->setName(name.c_str());
    tile->setPath(lmapPath.c_str());
    tile->setSize(size);

    dmat4 transform = dmat4_identity;
    transform.setTranslate(worldPos);
    tile->setWorldTransform(transform);

    terrain->addChild(tile);

    Log::message("[GeoTerrainImporter] Created tile '%s' (%dx%d) at (%.1f, %.1f, %.1f) -> %s\n",
                 name.c_str(), resolution.x, resolution.y,
                 worldPos.x, worldPos.y, worldPos.z,
                 lmapPath.c_str());

    return tile;
}

GeoTerrainImporter::ImportResult GeoTerrainImporter::importPackage(const std::string& packagePath,
                                                                    const ObjectLandscapeTerrainPtr& targetTerrain,
                                                                    const LandscapeLayerMapPtr& targetTile,
                                                                    bool importAlbedo,
                                                                    bool importMasks,
                                                                    bool autoCreateTiles,
                                                                    const LogFn& log)
{
    UNIGINE_UNUSED(importMasks);

    ImportResult result;
    if (packagePath.empty())
    {
        result.error = "ERROR: Package path is empty.";
        return result;
    }

    const PackageManifest manifest = parsePackageManifest(packagePath);
    if (!manifest.valid || manifest.tiles.empty())
    {
        result.error = "ERROR: Failed to parse package manifest or no tiles found.";
        return result;
    }

    // Use the resolved effective path for file lookups
    const std::string effectivePackagePath = manifest.effectivePath.empty() ? packagePath : manifest.effectivePath;

    ObjectLandscapeTerrainPtr terrain = targetTerrain ? targetTerrain : Landscape::getActiveTerrain();
    if (!terrain)
    {
        result.error = "ERROR: No active landscape terrain. Please select or create a Landscape Terrain.";
        return result;
    }

    logMessage(log, "Importing GeoTerrain package: " + effectivePackagePath);
    logMessage(log, "Tiles found: " + std::to_string(manifest.tiles.size()));
    if (autoCreateTiles)
        logMessage(log, "Auto-create tiles enabled: missing tiles will be created.");

    (void)beginActionTransaction();
    bool queuedAnyOperation = false;

    for (const auto& tileManifest : manifest.tiles)
    {
        LandscapeLayerMapPtr tile = targetTile;
        if (!tile)
        {
            const std::string expectedName = "tile_" + std::to_string(tileManifest.row) + "_" + std::to_string(tileManifest.col);
            for (int childIndex = 0; childIndex < terrain->getNumChildren(); ++childIndex)
            {
                LandscapeLayerMapPtr child = checked_ptr_cast<LandscapeLayerMap>(terrain->getChild(childIndex));
                if (child)
                {
                    const std::string childName = child->getName();
                    if (childName == expectedName || childName.find(expectedName) != std::string::npos)
                    {
                        tile = child;
                        break;
                    }
                }
            }
        }

        // If no existing tile and auto-create is enabled, create one
        if (!tile && autoCreateTiles)
        {
            // Determine tile resolution from the heightmap image
            ivec2 resolution(1024, 1024); // default fallback

            if (!tileManifest.heightmapFile.empty())
            {
                const std::string heightmapPath = joinPath(effectivePackagePath, tileManifest.heightmapFile);
                ImagePtr probe = Image::create();
                if (probe->load(heightmapPath.c_str()))
                {
                    resolution = ivec2(probe->getWidth(), probe->getHeight());
                }
            }

            // World position: center of tile based on row/col * chunkSize
            const double wx = tileManifest.worldOffsetX + (tileManifest.col * manifest.chunkSizeM);
            const double wz = tileManifest.worldOffsetZ + (tileManifest.row * manifest.chunkSizeM);
            const dvec3 worldPos(wx, 0.0, wz);

            const Vec2 size(manifest.chunkSizeM, manifest.chunkSizeM);
            const std::string tileName = "tile_" + std::to_string(tileManifest.row) + "_" + std::to_string(tileManifest.col);

            // Use the package folder as the data path for .lmap files
            tile = createTile(terrain, tileName, resolution, size, worldPos, effectivePackagePath);
            if (tile)
            {
                ++result.tilesCreated;
                logMessage(log, "Created new tile: " + tileName);
            }
            else
            {
                logMessage(log, "ERROR: Failed to create tile " + tileName);
                ++result.tilesFailed;
                continue;
            }
        }

        if (!tile)
        {
            logMessage(log, "WARNING: No matching tile found for " + std::to_string(tileManifest.row) + "_" + std::to_string(tileManifest.col) + " -- skipping.");
            ++result.tilesFailed;
            continue;
        }

        logMessage(log, "Processing tile: " + std::string(tile->getName()));

        if (!tileManifest.heightmapFile.empty())
        {
            const std::string heightmapPath = joinPath(effectivePackagePath, tileManifest.heightmapFile);
            if (fileExists(heightmapPath))
            {
                if (importTileHeightmap(tile, heightmapPath, tileManifest.elevationMin, tileManifest.elevationMax, log))
                {
                    ++result.tilesImported;
                    queuedAnyOperation = true;
                }
                else
                {
                    logMessage(log, "ERROR: Failed to import heightmap for tile.");
                    ++result.tilesFailed;
                }
            }
            else
            {
                logMessage(log, "WARNING: Heightmap file not found: " + heightmapPath);
                ++result.tilesFailed;
            }
        }

        if (importAlbedo && !tileManifest.albedoFile.empty())
        {
            const std::string albedoPath = joinPath(effectivePackagePath, tileManifest.albedoFile);
            if (fileExists(albedoPath))
            {
                if (!importTileAlbedo(tile, albedoPath, log))
                {
                    logMessage(log, "WARNING: Failed to import albedo for tile.");
                }
            }
            else
            {
                logMessage(log, "WARNING: Albedo file not found: " + albedoPath);
            }
        }
    }

    finishActionScheduling();
    result.success = queuedAnyOperation || result.tilesImported > 0 || result.tilesCreated > 0;
    if (!result.success)
        result.error = "WARNING: No terrain operations were queued.";

    logMessage(log, "Import complete. Created: " + std::to_string(result.tilesCreated) +
                     ", Imported: " + std::to_string(result.tilesImported) +
                     ", Failed: " + std::to_string(result.tilesFailed));
    return result;
}

bool GeoTerrainImporter::importTileHeightmap(const LandscapeLayerMapPtr& tile,
                                              const std::string& heightmapPath,
                                              float elevationMin,
                                              float elevationMax,
                                              const LogFn& log)
{
    if (!tile)
    {
        logMessage(log, "ERROR: importTileHeightmap: null tile.");
        return false;
    }

    const ImagePtr heightImage = loadHeightmapImage(heightmapPath, elevationMin, elevationMax);
    if (!heightImage)
    {
        logMessage(log, "ERROR: Failed to load heightmap: " + heightmapPath);
        return false;
    }

    return setTerrainHeight(tile, heightImage);
}

bool GeoTerrainImporter::importTileAlbedo(const LandscapeLayerMapPtr& tile,
                                           const std::string& albedoPath,
                                           const LogFn& log)
{
    if (!tile)
    {
        logMessage(log, "ERROR: importTileAlbedo: null tile.");
        return false;
    }

    ImagePtr albedoImage = Image::create();
    if (!albedoImage->load(albedoPath.c_str()))
    {
        logMessage(log, "ERROR: Failed to load albedo image: " + albedoPath);
        return false;
    }

    return setTerrainAlbedo(tile, albedoImage);
}

bool GeoTerrainImporter::isBusy() const
{
    return inProgress || !pendingOperations.empty();
}

size_t GeoTerrainImporter::pendingOperationCount() const
{
    return pendingOperations.size();
}

void GeoTerrainImporter::flushPendingSaves()
{
    saveManager.forceFlush();
}

bool GeoTerrainImporter::beginActionTransaction()
{
    saveManager.beginTransaction();
    return true;
}

void GeoTerrainImporter::finishActionScheduling()
{
    if (pendingOperations.empty())
    {
        saveManager.endTransaction();
        return;
    }

    ++pendingTransactionCommits;
    inProgress = true;
}

void GeoTerrainImporter::endTransactionsIfIdle()
{
    if (!pendingOperations.empty())
        return;

    while (pendingTransactionCommits > 0)
    {
        saveManager.endTransaction();
        --pendingTransactionCommits;
    }

    inProgress = false;
}

bool GeoTerrainImporter::setTerrainHeight(const LandscapeLayerMapPtr& tile, const ImagePtr& heightImage)
{
    if (!tile || !heightImage)
    {
        Log::error("[GeoTerrainImporter] setTerrainHeight: null tile or height image.\n");
        return false;
    }

    const ivec2 tileResolution = tile->getResolution();
    if (tileResolution.x <= 0 || tileResolution.y <= 0)
    {
        Log::error("[GeoTerrainImporter] setTerrainHeight: tile '%s' has invalid resolution (%dx%d). "
                   "Please create LandscapeLayerMap tiles in the editor before importing.\n",
                   tile->getName(), tileResolution.x, tileResolution.y);
        return false;
    }

    ImagePtr preparedImage = heightImage;
    if (preparedImage->getFormat() != Image::FORMAT_RGBA32F)
    {
        if (!preparedImage->convertToFormat(Image::FORMAT_RGBA32F))
        {
            Log::error("[GeoTerrainImporter] setTerrainHeight: failed to convert image to RGBA32F.\n");
            return false;
        }
    }

    if (preparedImage->getWidth() != tileResolution.x || preparedImage->getHeight() != tileResolution.y)
    {
        Log::message("[GeoTerrainImporter] Resizing height image from %dx%d to tile resolution %dx%d.\n",
                     preparedImage->getWidth(), preparedImage->getHeight(),
                     tileResolution.x, tileResolution.y);
        if (!preparedImage->resize(tileResolution.x, tileResolution.y))
        {
            Log::error("[GeoTerrainImporter] setTerrainHeight: failed to resize height image to %dx%d.\n",
                       tileResolution.x, tileResolution.y);
            return false;
        }
    }

    auto alphaImage = createSolidAlphaImage(tileResolution, 1.0f);
    if (!alphaImage)
    {
        Log::error("[GeoTerrainImporter] setTerrainHeight: failed to create alpha image.\n");
        return false;
    }

    const MaterialPtr overwriteMaterial = BrushMaterialFactory::loadInheritedMaterial(
        "geoterrain_brush_r32f_overwrite.basebrush", "terrain height overwrite");
    if (!overwriteMaterial)
    {
        Log::error("[GeoTerrainImporter] setTerrainHeight: failed to load height overwrite material.\n");
        return false;
    }

    BrushOperationData operation;
    operation.brushMaterial = overwriteMaterial;
    operation.heightImage = preparedImage;
    operation.alphaImage = alphaImage;
    operation.modifyHeights = true;
    operation.drawCoord = ivec2_zero;
    operation.drawSize = tileResolution;

    const int operationId = Landscape::generateOperationID();
    pendingOperations[operationId] = operation;
    Landscape::asyncTextureDraw(operationId,
                                tile->getGUID(),
                                ivec2_zero,
                                tileResolution,
                                Landscape::FLAGS_FILE_DATA_HEIGHT | Landscape::FLAGS_FILE_DATA_OPACITY_HEIGHT);
    return true;
}

bool GeoTerrainImporter::setTerrainAlbedo(const LandscapeLayerMapPtr& tile, const ImagePtr& albedoImage)
{
    if (!tile || !albedoImage)
    {
        Log::error("[GeoTerrainImporter] setTerrainAlbedo: null tile or albedo image.\n");
        return false;
    }

    const ivec2 tileResolution = tile->getResolution();
    if (tileResolution.x <= 0 || tileResolution.y <= 0)
    {
        Log::error("[GeoTerrainImporter] setTerrainAlbedo: tile '%s' has invalid resolution (%dx%d). "
                   "Please create LandscapeLayerMap tiles in the editor before importing.\n",
                   tile->getName(), tileResolution.x, tileResolution.y);
        return false;
    }

    ImagePtr preparedImage = albedoImage;
    if (preparedImage->getFormat() != Image::FORMAT_RGBA8)
    {
        if (!preparedImage->convertToFormat(Image::FORMAT_RGBA8))
        {
            Log::error("[GeoTerrainImporter] setTerrainAlbedo: failed to convert image to RGBA8.\n");
            return false;
        }
    }

    if (preparedImage->getWidth() != tileResolution.x || preparedImage->getHeight() != tileResolution.y)
    {
        Log::message("[GeoTerrainImporter] Resizing albedo image from %dx%d to tile resolution %dx%d.\n",
                     preparedImage->getWidth(), preparedImage->getHeight(),
                     tileResolution.x, tileResolution.y);
        if (!preparedImage->resize(tileResolution.x, tileResolution.y))
        {
            Log::error("[GeoTerrainImporter] setTerrainAlbedo: failed to resize albedo image to %dx%d.\n",
                       tileResolution.x, tileResolution.y);
            return false;
        }
    }

    const MaterialPtr overwriteMaterial = BrushMaterialFactory::loadInheritedMaterial(
        "geoterrain_brush_albedo_overwrite.basebrush", "terrain albedo overwrite");
    if (!overwriteMaterial)
    {
        Log::error("[GeoTerrainImporter] setTerrainAlbedo: failed to load albedo overwrite material.\n");
        return false;
    }

    BrushOperationData operation;
    operation.brushMaterial = overwriteMaterial;
    operation.albedoImage = preparedImage;
    operation.modifyAlbedo = true;
    operation.drawCoord = ivec2_zero;
    operation.drawSize = tileResolution;

    const int operationId = Landscape::generateOperationID();
    pendingOperations[operationId] = operation;
    Landscape::asyncTextureDraw(operationId,
                                tile->getGUID(),
                                ivec2_zero,
                                tileResolution,
                                Landscape::FLAGS_FILE_DATA_ALBEDO);
    return true;
}

bool GeoTerrainImporter::applyHeightOverwrite(const LandscapeTexturesPtr& buffer,
                                               const MaterialPtr& brushMaterial,
                                               const TexturePtr& heightTexture,
                                               const TexturePtr& alphaTexture)
{
    if (!buffer || !brushMaterial || !heightTexture || !alphaTexture)
    {
        Log::error("[GeoTerrainImporter] applyHeightOverwrite: null buffer, material, height texture, or alpha texture.\n");
        return false;
    }

    brushMaterial->setTexture("terrain_height", buffer->getHeight());
    brushMaterial->setTexture("terrain_opacity_height", buffer->getOpacityHeight());
    brushMaterial->setTexture("new_height", heightTexture);
    brushMaterial->setTexture("new_alpha", alphaTexture);
    brushMaterial->runExpression("brush", buffer->getResolution().x, buffer->getResolution().y);
    BrushMaterialFactory::clearTerrainTextures(brushMaterial);
    brushMaterial->setTexture("new_height", nullptr);
    brushMaterial->setTexture("new_alpha", nullptr);
    return true;
}

bool GeoTerrainImporter::applyAlbedoOverwrite(const LandscapeTexturesPtr& buffer,
                                               const MaterialPtr& brushMaterial,
                                               const TexturePtr& albedoTexture)
{
    if (!buffer || !brushMaterial || !albedoTexture)
    {
        Log::error("[GeoTerrainImporter] applyAlbedoOverwrite: null buffer, material, or albedo texture.\n");
        return false;
    }

    brushMaterial->setTexture("terrain_albedo", buffer->getAlbedo());
    brushMaterial->setTexture("new_albedo", albedoTexture);
    brushMaterial->runExpression("brush", buffer->getResolution().x, buffer->getResolution().y);
    BrushMaterialFactory::clearTerrainTextures(brushMaterial);
    brushMaterial->setTexture("new_albedo", nullptr);
    return true;
}

void GeoTerrainImporter::onTextureDraw(const UGUID& guid, int operationId,
                                        const LandscapeTexturesPtr& buffer,
                                        const ivec2& coord,
                                        int dataMask)
{
    UNIGINE_UNUSED(coord);
    UNIGINE_UNUSED(dataMask);

    auto operationIt = pendingOperations.find(operationId);
    if (operationIt == pendingOperations.end())
        return;

    const BrushOperationData operation = operationIt->second;
    pendingOperations.erase(operationIt);

    bool applied = false;
    if (operation.heightImage && operation.alphaImage)
    {
        TexturePtr heightTexture = Texture::create();
        TexturePtr alphaTexture = Texture::create();
        if (heightTexture && alphaTexture &&
            heightTexture->create(operation.heightImage) &&
            alphaTexture->create(operation.alphaImage))
        {
            applied = applyHeightOverwrite(buffer, operation.brushMaterial, heightTexture, alphaTexture);
        }
    }
    else if (operation.albedoImage)
    {
        TexturePtr albedoTexture = Texture::create();
        if (albedoTexture && albedoTexture->create(operation.albedoImage))
        {
            applied = applyAlbedoOverwrite(buffer, operation.brushMaterial, albedoTexture);
        }
    }

    if (applied)
        saveManager.markDirty(guid);

    endTransactionsIfIdle();
}

ImagePtr GeoTerrainImporter::loadHeightmapImage(const std::string& path, float elevationMin, float elevationMax)
{
    ImagePtr sourceImage = Image::create();
    if (!sourceImage->load(path.c_str()))
    {
        Log::error("[GeoTerrainImporter] Failed to load image: %s\n", path.c_str());
        return nullptr;
    }

    // Check if the file extension suggests GeoTIFF
    bool isGeoTiff = false;
    size_t dotPos = path.find_last_of('.');
    if (dotPos != std::string::npos)
    {
        std::string ext = path.substr(dotPos + 1);
        std::transform(ext.begin(), ext.end(), ext.begin(),
                       [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
        isGeoTiff = (ext == "tif" || ext == "tiff");
    }

    if (isGeoTiff)
    {
        Log::warning("[GeoTerrainImporter] GeoTIFF files are not fully supported. "
                     "Please export with PNG heightmap format for best compatibility.\n");
        // Try to read as best we can, but values may be incorrect
    }

    if (sourceImage->getFormat() != Image::FORMAT_RGBA32F)
    {
        if (!sourceImage->convertToFormat(Image::FORMAT_RGBA32F))
        {
            Log::error("[GeoTerrainImporter] Failed to convert image to RGBA32F: %s\n", path.c_str());
            return nullptr;
        }
    }

    const int width = sourceImage->getWidth();
    const int height = sourceImage->getHeight();
    const float elevationRange = std::max(0.001f, elevationMax - elevationMin);

    // Analyze pixel value range to determine if normalized or raw
    float minPixel = 1e30f;
    float maxPixel = -1e30f;
    for (int y = 0; y < height; ++y)
    {
        for (int x = 0; x < width; ++x)
        {
            Image::Pixel pixel;
            sourceImage->get2D(x, y, pixel);
            minPixel = std::min(minPixel, pixel.f.r);
            maxPixel = std::max(maxPixel, pixel.f.r);
        }
    }

    // Heuristic: if values are extremely large/small or match expected elevation range, treat as raw
    const bool isRawElevation = isGeoTiff ||
                                (maxPixel > 10000.0f) ||
                                (minPixel < -1000.0f) ||
                                (maxPixel > elevationMax * 0.5f && maxPixel <= elevationMax * 1.5f && maxPixel > 10.0f);

    Log::message("[GeoTerrainImporter] Heightmap '%s': %dx%d, min=%.2f max=%.2f, treating as %s\n",
                 path.c_str(), width, height, minPixel, maxPixel,
                 isRawElevation ? "raw elevation (meters)" : "normalized (0-1)");

    ImagePtr result = Image::create();
    result->create2D(width, height, Image::FORMAT_RGBA32F);

    for (int y = 0; y < height; ++y)
    {
        for (int x = 0; x < width; ++x)
        {
            Image::Pixel pixel;
            sourceImage->get2D(x, y, pixel);

            float worldHeight;
            if (isRawElevation)
            {
                worldHeight = pixel.f.r;
            }
            else
            {
                const float normalizedHeight = pixel.f.r;
                worldHeight = normalizedHeight * elevationRange + elevationMin;
            }

            pixel.f.r = worldHeight;
            pixel.f.g = worldHeight;
            pixel.f.b = worldHeight;
            pixel.f.a = 1.0f;

            result->set2D(x, y, pixel);
        }
    }

    return result;
}

ImagePtr GeoTerrainImporter::createSolidAlphaImage(const ivec2& resolution, float alpha)
{
    ImagePtr image = Image::create();
    image->create2D(resolution.x, resolution.y, Image::FORMAT_RGBA32F);

    Image::Pixel pixel;
    pixel.f.r = alpha;
    pixel.f.g = alpha;
    pixel.f.b = alpha;
    pixel.f.a = alpha;

    for (int x = 0; x < resolution.x; ++x)
    {
        for (int y = 0; y < resolution.y; ++y)
            image->set2D(x, y, pixel);
    }

    return image;
}
