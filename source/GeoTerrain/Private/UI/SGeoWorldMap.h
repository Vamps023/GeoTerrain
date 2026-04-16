#pragma once
#include "CoreMinimal.h"
#include "Widgets/SLeafWidget.h"
#include "Brushes/SlateDynamicImageBrush.h"
#include "GeoChunkPlanner.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

struct FGeoTileKey
{
    int32 Z, X, Y;
    bool operator==(const FGeoTileKey& O) const { return Z == O.Z && X == O.X && Y == O.Y; }
    friend uint32 GetTypeHash(const FGeoTileKey& K) { return HashCombine(HashCombine(K.Z, K.X), K.Y); }
};

struct FGeoMapTile
{
    TSharedPtr<FSlateDynamicImageBrush> Brush;
    bool   bIsLoading = false;
    double LastUsedTime = 0.0;
};

DECLARE_DELEGATE_FourParams(FOnMapBoundsSelected, double, double, double, double);

class SGeoWorldMap : public SLeafWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoWorldMap) {}
        SLATE_EVENT(FOnMapBoundsSelected, OnBoundsSelected)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SGeoWorldMap();

    // Set the template URL for XYZ tiles (e.g., https://tile.openstreetmap.org/{z}/{x}/{y}.png)
    void SetTileUrlTemplate(const FString& UrlTemplate);

    // ── Chunk API ─────────────────────────────────────────────────────────────
    void           SetChunkSizeKm(double Km);     // call when spin changes
    const TArray<bool>& GetEnabledMask() const { return ChunkEnabledMask; }
    int32          GetChunkCount()  const { return CurrentPlan.Chunks.Num(); }
    int32          GetEnabledCount() const { return CurrentPlan.EnabledChunks.Num(); }

    virtual int32 OnPaint(
        const FPaintArgs&, const FGeometry&, const FSlateRect&,
        FSlateWindowElementList&, int32, const FWidgetStyle&, bool) const override;

    virtual FReply OnMouseButtonDown(const FGeometry&, const FPointerEvent&) override;
    virtual FReply OnMouseMove      (const FGeometry&, const FPointerEvent&) override;
    virtual FReply OnMouseButtonUp  (const FGeometry&, const FPointerEvent&) override;
    virtual FReply OnMouseWheel     (const FGeometry&, const FPointerEvent&) override;
    virtual void   OnMouseEnter     (const FGeometry&, const FPointerEvent&) override;
    virtual void   OnMouseLeave     (const FPointerEvent&) override;
    virtual FCursorReply OnCursorQuery(const FGeometry&, const FPointerEvent&) const override;
    virtual FVector2D ComputeDesiredSize(float) const override;
    virtual bool SupportsKeyboardFocus() const override { return true; }

private:
    // ── Projection ───────────────────────────────────────────────────────────
    FVector2D LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const;
    void      LocalToLonLat(FVector2D P, const FGeometry& Geo, double& OutLon, double& OutLat) const;
    void      ClampView(const FGeometry& Geo);

    FOnMapBoundsSelected OnBoundsSelected;

    // ── View state ───────────────────────────────────────────────────────────
    float     Zoom      = 1.0f;
    FVector2D PanOffset = FVector2D::ZeroVector;

    bool      bPanning   = false;
    FVector2D PanStart   = FVector2D::ZeroVector;
    FVector2D PanAtStart = FVector2D::ZeroVector;

    bool      bDragging  = false;
    FVector2D DragStart  = FVector2D::ZeroVector;
    FVector2D DragEnd    = FVector2D::ZeroVector;

    bool   bHasSelection = false;
    double SelW=0, SelS=0, SelE=0, SelN=0;

    // ── Chunk grid ───────────────────────────────────────────────────────────
    double           ChunkSizeKm = 0.0;
    FGeoChunkPlan    CurrentPlan;
    TArray<bool>     ChunkEnabledMask;
    void             RebuildChunkPlan();
    int32            HitTestChunk(FVector2D LocalPt, const FGeometry& Geo) const;

    // ── Native Tile Rendering ──────────────────────────────────────────────────
    FString TileUrlTemplate = TEXT("https://a.tile.openstreetmap.org/{z}/{x}/{y}.png");
    mutable TMap<FGeoTileKey, TSharedPtr<FGeoMapTile>> TileCache;
    int32 MaxConcurrentDownloads = 6;
    mutable int32 ActiveDownloads = 0;

    void FetchTile(const FGeoTileKey& Key) const;
    void OnTileDownloaded(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bSucceeded, FGeoTileKey Key) const;
    void PruneTileCache() const;
    
    // Web-Mercator math
    static int32 Long2TileX(double Lon, int32 z);
    static int32 Lat2TileY(double Lat, int32 z);
    static double TileX2Long(int32 x, int32 z);
    static double TileY2Lat(int32 y, int32 z);
};
