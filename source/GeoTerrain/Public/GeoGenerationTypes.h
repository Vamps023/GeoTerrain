#pragma once
#include "CoreMinimal.h"
#include "GeoBounds.h"

// ── DEM source ────────────────────────────────────────────────────────────────
UENUM(BlueprintType)
enum class EGeoTerrainDemSource : uint8
{
    OpenTopography_SRTM30m  UMETA(DisplayName = "SRTM 30m"),
    OpenTopography_SRTM90m  UMETA(DisplayName = "SRTM 90m"),
    OpenTopography_AW3D30   UMETA(DisplayName = "AW3D 30m"),
    OpenTopography_COP30    UMETA(DisplayName = "Copernicus 30m"),
    OpenTopography_NASADEM  UMETA(DisplayName = "NASADEM"),
    OpenTopography_3DEP10m  UMETA(DisplayName = "3DEP 10m"),
    LocalGeoTIFF            UMETA(DisplayName = "Local GeoTIFF"),
};

struct FGeoTerrainDemConfig
{
    EGeoTerrainDemSource Source       = EGeoTerrainDemSource::OpenTopography_SRTM30m;
    FString              ApiKey;
    FString              LocalTiffPath;
    FString              OutputPath;
    FString              RefTifPath;
    double               ResolutionM  = 30.0;
};

struct FGeoTileSettings
{
    FString UrlTemplate;
    int32   ZoomLevel  = 14;
    int32   TargetSize = 0;
    FString OutputPath;          // output albedo.tif path (set by coordinator)
};

struct FGeoOsmSettings
{
    FString OverpassUrl = TEXT("https://overpass-api.de/api/interpreter");
    int64   TimeoutS    = 120;
};

struct FGeoDataSourceSettings
{
    FGeoTerrainDemConfig Dem;
    FGeoTileSettings     Tiles;
    FGeoOsmSettings      Osm;
};

struct FGeoMaskSettings
{
    double ResolutionM = 30.0;
    double RoadWidthM  = 10.0;
};

struct FGeoOutputSettings
{
    FString OutputDir;
    bool    bExportUnrealRaw = true;   // always true on this branch
};

struct FGeoChunkSettings
{
    double      ChunkSizeKm = 0.0;
    TArray<bool> EnabledMask;
};

struct FGeoGenerationRequest
{
    FGeoBounds            Bounds;
    FGeoDataSourceSettings Sources;
    FGeoMaskSettings       Mask;
    FGeoOutputSettings     Output;
    FGeoChunkSettings      Chunking;
};

// ── Job state ─────────────────────────────────────────────────────────────────
UENUM(BlueprintType)
enum class EGeoJobStatus : uint8
{
    Idle,
    Running,
    Cancelling,
    Cancelled,
    Succeeded,
    PartiallySucceeded,
    Failed,
};

// ── Chunk definition ──────────────────────────────────────────────────────────
struct FGeoChunkDefinition
{
    int32      Index     = 0;
    int32      Row       = 0;
    int32      Column    = 0;
    FGeoBounds Bounds;
    FString    DirectoryName;
};

struct FGeoChunkPlan
{
    int32                       Rows    = 0;
    int32                       Columns = 0;
    TArray<FGeoChunkDefinition> Chunks;
    TArray<FGeoChunkDefinition> EnabledChunks;
    int32                       SkippedChunks = 0;
};

// ── Output manifest ───────────────────────────────────────────────────────────
struct FGeoOutputManifest
{
    EGeoJobStatus   Status      = EGeoJobStatus::Idle;
    FGeoBounds      Bounds;
    FString         OutputDir;
    FString         DemPath;
    FString         AlbedoPath;
    FString         MaskPath;
    FString         UnrealRawPath;   // heightmap.r16
    TArray<FString> GeneratedFiles;
    TArray<FString> Warnings;
    TArray<FString> Errors;
    int32           ChunkIndex  = -1;
};
