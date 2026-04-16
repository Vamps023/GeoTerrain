#pragma once

#include "CoreMinimal.h"
#include "GeoResult.h"

class ALandscape;
class UMaterialInterface;
class UWorld;

// ─────────────────────────────────────────────────────────────────────────────
//  FGeoR16BatchImporter
//
//  Scans a folder for files named  tile_x{X}_y{Y}.r16,  loads each as a
//  16-bit RAW heightmap (little-endian, no header), detects the resolution
//  from the file size ("Fit to Data"), and spawns one ALandscape per tile
//  at the correct world-space position so all tiles align seamlessly.
//
//  Intended use-case: import heightmap grids exported by external tools
//  (e.g. World Machine, World Creator, Gaea, or Sandworm) that write tiles
//  with the standard tile_x{X}_y{Y}.r16 naming convention.
//
//  Thread safety: All public methods MUST be called on the game thread.
// ─────────────────────────────────────────────────────────────────────────────
class GEOTERRAIN_API FGeoR16BatchImporter
{
public:
    // ── Import settings ───────────────────────────────────────────────────────
    struct FBatchImportSettings
    {
        /** Folder to scan for tile_x*_y*.r16 files. */
        FString FolderPath;

        /**
         * Uniform XY scale (cm/quad).  Default 100 = 1 m per landscape quad.
         * Adjust to match the real-world ground sample distance of your tiles.
         */
        float ScaleXY = 100.0f;

        /**
         * Z (height) scale.
         *   UE maps the full uint16 range [0, 65535] to [-256 * ZScale, 256 * ZScale] cm.
         *   "Fit to Data" formula: ZScale = ElevRangeM * 100.0 / 512.0
         *   Default 100  →  ±25 600 cm  (±256 m) full-range height.
         */
        float ScaleZ = 100.0f;

        /**
         * Quads per landscape sub-section side.
         * Standard value = 63; always keep at 63 unless you have a reason to change it.
         */
        int32 QuadsPerSection = 63;

        /**
         * Number of sub-sections per component.
         * 1 = one 63-quad sub-section per component (simplest, fewest draw calls per comp).
         * 2 = four 63-quad sub-sections per component (allows finer LOD transitions).
         */
        int32 SectionsPerComponent = 1;

        /**
         * Optional landscape material to assign to every created ALandscape.
         * Leave null to use the editor default (grey grid).
         */
        UMaterialInterface* LandscapeMaterial = nullptr;

        /**
         * Base actor label prefix.  Tile labels will be  <Prefix>_X<x>_Y<y>.
         */
        FString LandscapeNamePrefix = TEXT("Landscape_Tile");

        /**
         * If true, flip the heightmap data along the Y axis before import.
         * Required when the source tool writes tiles top-row-first but UE
         * expects bottom-row-first (or vice versa).
         */
        bool bFlipY = false;
    };

    // ── Per-tile record (returned to caller for logging / diagnostics) ────────
    struct FTileImportResult
    {
        int32   TileX     = 0;
        int32   TileY     = 0;
        int32   Resolution = 0;
        FString FilePath;
        bool    bSuccess  = false;
        FString ErrorMessage;
        ALandscape* Landscape = nullptr;     // valid only on success
    };

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Scan FolderPath for tile_x*_y*.r16 files and import each one as a
     * separate ALandscape into the current editor world.
     *
     * Returns one FTileImportResult per discovered file.
     * Progress is reported through the optional OnProgress delegate:
     *   OnProgress(tilesProcessed, tilesTotal)
     */
    TArray<FTileImportResult> ImportFolder(
        const FBatchImportSettings&                              Settings,
        TFunction<void(int32 /*done*/, int32 /*total*/)> OnProgress = nullptr);

    /**
     * Load a single .r16 file into a uint16 array and derive the square
     * resolution from the file size.
     *
     * Returns false if the file cannot be read or its size does not map to a
     * perfect square number of uint16 pixels.
     */
    static bool LoadHeightmap(const FString& FilePath,
                              TArray<uint16>& OutData,
                              int32& OutResolution);

    /**
     * Create one ALandscape for the supplied height data.
     * TileX / TileY are grid indices; the world position is derived from them
     * via CalculateTileLocation().
     */
    ALandscape* CreateLandscapeTile(
        UWorld*                  World,
        const TArray<uint16>&    HeightData,
        int32                    Resolution,
        int32                    TileX,
        int32                    TileY,
        const FBatchImportSettings& Settings);

    /**
     * Calculate the world-space origin (bottom-left corner) of a tile in cm.
     *
     *   TileWorldSize = (Resolution - 1) * ScaleXY
     *   Location      = (TileX * TileWorldSize,  TileY * TileWorldSize,  0)
     *
     * This ensures adjacent tiles share their edge vertices without a gap.
     */
    static FVector CalculateTileLocation(int32 TileX, int32 TileY,
                                         int32 Resolution, float ScaleXY);

    // ── Utility ───────────────────────────────────────────────────────────────

    /**
     * Snap an arbitrary pixel count to the nearest valid UE landscape side
     * dimension: 127, 253, 505, 1009, 2017, 4033, 8129.
     */
    static int32 NearestValidResolution(int32 Raw);

    /**
     * Parse TileX / TileY from a filename that matches tile_x{X}_y{Y}.r16.
     * Returns false if the pattern is not found.
     */
    static bool ParseTileCoordinates(const FString& Filename,
                                     int32& OutTileX, int32& OutTileY);

private:
    /** Collect all .r16 files matching the tile naming convention in a folder. */
    static TArray<FString> ScanFolder(const FString& FolderPath);

    /** Flip height data along the Y axis in-place. */
    static void FlipHeightmapY(TArray<uint16>& Data, int32 Width, int32 Height);
};
