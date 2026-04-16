// GeoR16BatchImporter.cpp
// Imports a folder of tile_x{X}_y{Y}.r16 heightmap files as separate
// ALandscape actors positioned so they tile seamlessly in the UE editor world.

#include "GeoR16BatchImporter.h"

#include "Landscape.h"
#include "LandscapeProxy.h"
#include "LandscapeInfo.h"
#include "LandscapeDataAccess.h"

#include "Editor.h"

#include "HAL/FileManager.h"
#include "Misc/Paths.h"

// ─────────────────────────────────────────────────────────────────────────────
//  Valid UE landscape vertex-count side lengths.
//  Each is of the form  (2^n * ComponentsPerSide * QuadsPerSection) + 1
//  where QuadsPerSection == 63 (standard).
//
//  127  = 2 components of 63 quads   (63 * 2  + 1)
//  253  = 4 components of 63 quads   (63 * 4  + 1)
//  505  = 8 components of 63 quads   (63 * 8  + 1)
// 1009  = 16 components of 63 quads  (63 * 16 + 1)
// 2017  = 32 components of 63 quads  (63 * 32 + 1)
// 4033  = 64 components of 63 quads  (63 * 64 + 1)
// 8129  = 128 components of 63 quads (63 * 128 + 1)
// ─────────────────────────────────────────────────────────────────────────────
static constexpr int32 kValidResolutions[] = { 127, 253, 505, 1009, 2017, 4033, 8129 };

// ─────────────────────────────────────────────────────────────────────────────
//  NearestValidResolution
// ─────────────────────────────────────────────────────────────────────────────
int32 FGeoR16BatchImporter::NearestValidResolution(int32 Raw)
{
    int32 Best     = kValidResolutions[0];
    int32 BestDiff = FMath::Abs(Raw - Best);
    for (int32 V : kValidResolutions)
    {
        const int32 Diff = FMath::Abs(Raw - V);
        if (Diff < BestDiff)
        {
            BestDiff = Diff;
            Best     = V;
        }
    }
    return Best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ParseTileCoordinates
//  Matches  tile_x{X}_y{Y}.r16  (case-insensitive for X/Y prefix).
//  Returns false when the expected pattern is absent.
// ─────────────────────────────────────────────────────────────────────────────
bool FGeoR16BatchImporter::ParseTileCoordinates(const FString& Filename,
                                                int32& OutTileX,
                                                int32& OutTileY)
{
    // Operate on the base name without extension.
    const FString Base = FPaths::GetBaseFilename(Filename).ToLower();

    // Find "_x" and "_y" markers.
    const int32 XPos = Base.Find(TEXT("_x"), ESearchCase::CaseSensitive);
    const int32 YPos = Base.Find(TEXT("_y"), ESearchCase::CaseSensitive);

    if (XPos == INDEX_NONE || YPos == INDEX_NONE || YPos <= XPos)
        return false;

    // Extract the numeric substring after "_x", up to (but not including) "_y".
    const FString XStr = Base.Mid(XPos + 2, YPos - XPos - 2);
    // Extract the numeric substring after "_y" to the end.
    const FString YStr = Base.Mid(YPos + 2);

    if (XStr.IsEmpty() || YStr.IsEmpty())
        return false;

    OutTileX = FCString::Atoi(*XStr);
    OutTileY = FCString::Atoi(*YStr);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ScanFolder — collect .r16 files matching tile_x*_y*.r16
// ─────────────────────────────────────────────────────────────────────────────
TArray<FString> FGeoR16BatchImporter::ScanFolder(const FString& FolderPath)
{
    TArray<FString> All;
    IFileManager::Get().FindFiles(All, *(FolderPath / TEXT("*.r16")), /*bFiles*/ true, /*bDirs*/ false);

    TArray<FString> Matched;
    for (const FString& Name : All)
    {
        int32 Dummy1, Dummy2;
        if (ParseTileCoordinates(Name, Dummy1, Dummy2))
            Matched.Add(FPaths::Combine(FolderPath, Name));
    }

    // Stable sort so tiles are processed in reading order (row-major).
    Matched.Sort([](const FString& A, const FString& B)
    {
        int32 AX, AY, BX, BY;
        ParseTileCoordinates(FPaths::GetBaseFilename(A), AX, AY);
        ParseTileCoordinates(FPaths::GetBaseFilename(B), BX, BY);
        return (AY != BY) ? (AY < BY) : (AX < BX);
    });

    return Matched;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FlipHeightmapY — reverse the row order in-place
// ─────────────────────────────────────────────────────────────────────────────
void FGeoR16BatchImporter::FlipHeightmapY(TArray<uint16>& Data, int32 Width, int32 Height)
{
    for (int32 Row = 0; Row < Height / 2; ++Row)
    {
        const int32 MirrorRow = Height - 1 - Row;
        uint16* RowA = Data.GetData() + Row       * Width;
        uint16* RowB = Data.GetData() + MirrorRow * Width;
        for (int32 Col = 0; Col < Width; ++Col)
        {
            uint16 Tmp = RowA[Col];
            RowA[Col]  = RowB[Col];
            RowB[Col]  = Tmp;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LoadHeightmap
//  Reads the file as raw little-endian uint16 data and infers the square
//  resolution from the file byte count.
// ─────────────────────────────────────────────────────────────────────────────
bool FGeoR16BatchImporter::LoadHeightmap(const FString& FilePath,
                                          TArray<uint16>& OutData,
                                          int32& OutResolution)
{
    TUniquePtr<FArchive> Ar(IFileManager::Get().CreateFileReader(*FilePath));
    if (!Ar)
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: Cannot open '%s'"), *FilePath);
        return false;
    }

    const int64 FileSizeBytes = Ar->TotalSize();
    if (FileSizeBytes <= 0 || (FileSizeBytes % sizeof(uint16)) != 0)
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: '%s' has odd byte count (%lld) — not a valid .r16"),
               *FilePath, FileSizeBytes);
        return false;
    }

    const int64 NumPixels = FileSizeBytes / sizeof(uint16);
    const int32 Side      = FMath::RoundToInt(FMath::Sqrt((double)NumPixels));

    // Verify it's a perfect square (allow ±1 pixel for floating-point rounding).
    if (FMath::Abs((int64)Side * Side - NumPixels) > 1)
    {
        UE_LOG(LogTemp, Error,
               TEXT("FGeoR16BatchImporter: '%s' pixel count %lld is not a perfect square."),
               *FilePath, NumPixels);
        return false;
    }

    OutResolution = Side;
    OutData.SetNumUninitialized(Side * Side);
    Ar->Serialize(OutData.GetData(), FileSizeBytes);

    if (Ar->IsError())
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: Read error for '%s'"), *FilePath);
        return false;
    }

    UE_LOG(LogTemp, Log, TEXT("FGeoR16BatchImporter: Loaded '%s' — %dx%d px (%lld bytes)"),
           *FilePath, Side, Side, FileSizeBytes);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CalculateTileLocation
//
//  TileWorldSize  = (Resolution - 1) * ScaleXY          [cm]
//  TileOrigin     = (TileX * TileWorldSize,
//                    TileY * TileWorldSize,
//                    0.0)
//
//  Tiles share their boundary vertices because both neighbours include the
//  same edge row/column; the spacing between their origins is exactly
//  (Resolution - 1) * ScaleXY which equals the number of quads × ScaleXY.
// ─────────────────────────────────────────────────────────────────────────────
FVector FGeoR16BatchImporter::CalculateTileLocation(int32 TileX, int32 TileY,
                                                     int32 Resolution, float ScaleXY)
{
    const float TileWorldSize = static_cast<float>(Resolution - 1) * ScaleXY;
    return FVector(
        static_cast<float>(TileX) * TileWorldSize,
        static_cast<float>(TileY) * TileWorldSize,
        0.0f
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  CreateLandscapeTile
//
//  UE5.3+ Landscape Import API contract:
//    1.  SpawnActor creates the shell actor (no components yet).
//    2.  SetActorScale3D BEFORE Import() — the import path bakes scale into
//        normal / LOD calculations.
//    3.  Generate a FGuid and pass it to both the HeightmapImportData map
//        and to Import().  Do NOT call SetLandscapeGuid() separately; the
//        Import() function registers the GUID internally and calling the setter
//        again resets it, causing the assertion
//          "ensure(LandscapeGuid.IsValid())" in Landscape.cpp to fire.
//    4.  SectionsPerComponent × QuadsPerSection drives the component count.
//        NumComponents = (Resolution - 1) / (SectionsPerComponent * QuadsPerSection)
//        This must divide evenly; if not, the resolution was not snapped first.
// ─────────────────────────────────────────────────────────────────────────────
ALandscape* FGeoR16BatchImporter::CreateLandscapeTile(
    UWorld*                     World,
    const TArray<uint16>&       HeightData,
    int32                       Resolution,
    int32                       TileX,
    int32                       TileY,
    const FBatchImportSettings& Settings)
{
    check(World);
    check(HeightData.Num() == Resolution * Resolution);

    // ── 1. Snap resolution to a valid UE landscape size ──────────────────────
    const int32 UEResolution = NearestValidResolution(Resolution);
    if (UEResolution != Resolution)
    {
        UE_LOG(LogTemp, Warning,
               TEXT("FGeoR16BatchImporter: tile (%d,%d) resolution %d snapped to %d"),
               TileX, TileY, Resolution, UEResolution);
    }

    // Resample (nearest-neighbour) if the detected resolution differs from the UE-valid one.
    TArray<uint16> FinalData;
    if (Resolution != UEResolution)
    {
        FinalData.SetNumUninitialized(UEResolution * UEResolution);
        const int32 SrcW = Resolution;
        const int32 SrcH = Resolution;
        for (int32 DY = 0; DY < UEResolution; ++DY)
        {
            const int32 SY = FMath::Clamp(
                FMath::RoundToInt((float)DY / (UEResolution - 1) * (SrcH - 1)),
                0, SrcH - 1);
            for (int32 DX = 0; DX < UEResolution; ++DX)
            {
                const int32 SX = FMath::Clamp(
                    FMath::RoundToInt((float)DX / (UEResolution - 1) * (SrcW - 1)),
                    0, SrcW - 1);
                FinalData[DY * UEResolution + DX] = HeightData[SY * SrcW + SX];
            }
        }
    }
    else
    {
        FinalData = HeightData;  // already the right size
    }

    // ── 2. Component layout parameters ───────────────────────────────────────
    const int32 QuadsPerSection      = Settings.QuadsPerSection;
    const int32 SectionsPerComponent = Settings.SectionsPerComponent;
    // Total quads along one edge of the landscape
    const int32 TotalQuads           = UEResolution - 1;
    // Quads per component = QuadsPerSection * SectionsPerComponent
    const int32 QuadsPerComponent    = QuadsPerSection * SectionsPerComponent;

    if (TotalQuads % QuadsPerComponent != 0)
    {
        UE_LOG(LogTemp, Error,
               TEXT("FGeoR16BatchImporter: tile (%d,%d) resolution %d does not divide evenly "
                    "by QuadsPerComponent=%d. Skipping."),
               TileX, TileY, UEResolution, QuadsPerComponent);
        return nullptr;
    }

    // ── 3. World position ─────────────────────────────────────────────────────
    const FVector TileLocation = CalculateTileLocation(TileX, TileY,
                                                        UEResolution, Settings.ScaleXY);

    // ── 4. Spawn the landscape shell actor ───────────────────────────────────
    FActorSpawnParameters SpawnParams;
    SpawnParams.Name         = MakeUniqueObjectName(World->GetCurrentLevel(),
                                                     ALandscape::StaticClass());
    SpawnParams.NameMode     = FActorSpawnParameters::ESpawnActorNameMode::Requested;
    SpawnParams.bNoFail      = true;
    SpawnParams.ObjectFlags  = RF_Transactional;

    ALandscape* Landscape = World->SpawnActor<ALandscape>(
        ALandscape::StaticClass(),
        TileLocation,
        FRotator::ZeroRotator,
        SpawnParams);

    if (!Landscape)
    {
        UE_LOG(LogTemp, Error,
               TEXT("FGeoR16BatchImporter: SpawnActor<ALandscape> failed for tile (%d,%d)"),
               TileX, TileY);
        return nullptr;
    }

    // ── 5. Actor label ────────────────────────────────────────────────────────
    const FString Label = FString::Printf(TEXT("%s_X%d_Y%d"),
                                           *Settings.LandscapeNamePrefix,
                                           TileX, TileY);
    Landscape->SetActorLabel(Label);

    // ── 6. Scale ──────────────────────────────────────────────────────────────
    //  XY: cm per quad (= cm per pixel for a 1:1 tile).
    //  Z:  controls the height range (see FImportParams::ComputedZScale comments
    //      in GeoLandscapeImporter.h for the full formula explanation).
    Landscape->SetActorScale3D(FVector(Settings.ScaleXY, Settings.ScaleXY, Settings.ScaleZ));

    // ── 7. Material ───────────────────────────────────────────────────────────
    if (Settings.LandscapeMaterial)
        Landscape->LandscapeMaterial = Settings.LandscapeMaterial;

    // ── 8. Build the height data import map ──────────────────────────────────
    //  Key = a fresh GUID that acts as the internal landscape identity.
    //  This GUID is passed directly to ALandscape::Import(); do NOT also call
    //  SetLandscapeGuid() — that resets the internal GUID after Import() has
    //  already registered it, triggering the ensure() assertion in UE5.3.
    const FGuid LandscapeGuid = FGuid::NewGuid();

    TMap<FGuid, TArray<uint16>> HeightmapData;
    HeightmapData.Add(LandscapeGuid, FinalData);

    // Layer info map (no paintable layers required for height-only import).
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> LayerInfoMap;
    LayerInfoMap.Add(LandscapeGuid, TArray<FLandscapeImportLayerInfo>());

    // ── 9. Import ─────────────────────────────────────────────────────────────
    //  ALandscape::Import() signature (UE 5.x):
    //    Import(
    //      InGuid,
    //      InMinX, InMinY,   ← always 0,0 for a fresh landscape
    //      InMaxX, InMaxY,   ← TotalQuads, TotalQuads
    //      InNumSubsections, ← SectionsPerComponent
    //      InSubsectionSizeQuads, ← QuadsPerSection
    //      InImportHeightData,
    //      InHeightmapFileName,  ← optional hint, pass nullptr
    //      InImportMaterialLayerInfos,
    //      InImportMaterialLayerType
    //    )
    Landscape->Import(
        LandscapeGuid,
        0, 0,
        TotalQuads, TotalQuads,
        SectionsPerComponent,
        QuadsPerSection,
        HeightmapData,
        nullptr,               // no file-path hint needed
        LayerInfoMap,
        ELandscapeImportAlphamapType::Additive);

    Landscape->StaticLightingResolution = 1.0f;
    Landscape->MarkPackageDirty();

    UE_LOG(LogTemp, Log,
           TEXT("FGeoR16BatchImporter: Created landscape '%s' at (%.0f, %.0f, %.0f) — %dx%d quads"),
           *Label,
           TileLocation.X, TileLocation.Y, TileLocation.Z,
           TotalQuads, TotalQuads);

    return Landscape;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ImportFolder — main entry point
// ─────────────────────────────────────────────────────────────────────────────
TArray<FGeoR16BatchImporter::FTileImportResult> FGeoR16BatchImporter::ImportFolder(
    const FBatchImportSettings&                    Settings,
    TFunction<void(int32 /*done*/, int32 /*total*/)> OnProgress)
{
    TArray<FTileImportResult> Results;

    // ── Validate prerequisites ────────────────────────────────────────────────
    if (!GEditor)
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: GEditor is null — must run inside the editor."));
        return Results;
    }
    if (Settings.FolderPath.IsEmpty())
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: FolderPath is empty."));
        return Results;
    }
    if (!IFileManager::Get().DirectoryExists(*Settings.FolderPath))
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: Folder does not exist: '%s'"), *Settings.FolderPath);
        return Results;
    }

    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
    {
        UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: No editor world available."));
        return Results;
    }

    // ── Scan for tile files ───────────────────────────────────────────────────
    const TArray<FString> TileFiles = ScanFolder(Settings.FolderPath);
    if (TileFiles.IsEmpty())
    {
        UE_LOG(LogTemp, Warning,
               TEXT("FGeoR16BatchImporter: No tile_x*_y*.r16 files found in '%s'"),
               *Settings.FolderPath);
        return Results;
    }

    UE_LOG(LogTemp, Log, TEXT("FGeoR16BatchImporter: Found %d tile file(s) in '%s'"),
           TileFiles.Num(), *Settings.FolderPath);

    const int32 TotalTiles = TileFiles.Num();

    // ── Process each tile ─────────────────────────────────────────────────────
    for (int32 i = 0; i < TotalTiles; ++i)
    {
        const FString& FilePath = TileFiles[i];
        const FString  Filename = FPaths::GetCleanFilename(FilePath);

        FTileImportResult Result;
        Result.FilePath = FilePath;

        // Parse tile indices from filename
        if (!ParseTileCoordinates(Filename, Result.TileX, Result.TileY))
        {
            Result.bSuccess      = false;
            Result.ErrorMessage  = FString::Printf(
                TEXT("Could not parse tile coordinates from filename '%s'"), *Filename);
            UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: %s"), *Result.ErrorMessage);
            Results.Add(Result);
            continue;
        }

        UE_LOG(LogTemp, Log, TEXT("FGeoR16BatchImporter: [%d/%d] Processing tile (%d,%d) — '%s'"),
               i + 1, TotalTiles, Result.TileX, Result.TileY, *Filename);

        // Load height data
        TArray<uint16> HeightData;
        int32 Resolution = 0;
        if (!LoadHeightmap(FilePath, HeightData, Resolution))
        {
            Result.bSuccess     = false;
            Result.ErrorMessage = FString::Printf(TEXT("Failed to load heightmap: '%s'"), *FilePath);
            Results.Add(Result);
            continue;
        }
        Result.Resolution = Resolution;

        // Optional Y-flip
        if (Settings.bFlipY)
            FlipHeightmapY(HeightData, Resolution, Resolution);

        // Validate resolution is close to a supported UE landscape size
        const int32 NearestValid = NearestValidResolution(Resolution);
        if (FMath::Abs(NearestValid - Resolution) > 4)
        {
            // More than 4 pixels away from any valid size — warn but still proceed
            UE_LOG(LogTemp, Warning,
                   TEXT("FGeoR16BatchImporter: tile (%d,%d) resolution %d is far from any valid "
                        "UE landscape size (nearest: %d). The heightmap will be resampled."),
                   Result.TileX, Result.TileY, Resolution, NearestValid);
        }

        // Create the landscape
        ALandscape* Landscape = CreateLandscapeTile(
            World, HeightData, Resolution,
            Result.TileX, Result.TileY, Settings);

        if (!Landscape)
        {
            Result.bSuccess     = false;
            Result.ErrorMessage = FString::Printf(
                TEXT("CreateLandscapeTile failed for tile (%d,%d)"),
                Result.TileX, Result.TileY);
            UE_LOG(LogTemp, Error, TEXT("FGeoR16BatchImporter: %s"), *Result.ErrorMessage);
        }
        else
        {
            Result.bSuccess   = true;
            Result.Landscape  = Landscape;
        }

        Results.Add(Result);

        // Fire progress callback
        if (OnProgress)
            OnProgress(i + 1, TotalTiles);
    }

    // ── Summary log ──────────────────────────────────────────────────────────
    int32 SuccessCount = 0, FailCount = 0;
    for (const FTileImportResult& R : Results)
        R.bSuccess ? ++SuccessCount : ++FailCount;

    UE_LOG(LogTemp, Log,
           TEXT("FGeoR16BatchImporter: Import complete — %d succeeded, %d failed (total %d tiles)."),
           SuccessCount, FailCount, TotalTiles);

    return Results;
}
