#pragma once
#include "CoreMinimal.h"
#include "Widgets/SLeafWidget.h"
#include "Brushes/SlateDynamicImageBrush.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

DECLARE_DELEGATE_FourParams(FOnMapBoundsSelected, double, double, double, double);

struct FTileKey
{
    int32 Z, X, Y;
    bool operator==(const FTileKey& O) const { return Z==O.Z && X==O.X && Y==O.Y; }
};
FORCEINLINE uint32 GetTypeHash(const FTileKey& K)
{
    return HashCombine(HashCombine(GetTypeHash(K.Z), GetTypeHash(K.X)), GetTypeHash(K.Y));
}

class SGeoWorldMap : public SLeafWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoWorldMap) {}
        SLATE_EVENT(FOnMapBoundsSelected, OnBoundsSelected)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SGeoWorldMap();

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

    // ── OSM tile helpers ─────────────────────────────────────────────────────
    int32     GetOsmZoom() const;
    FVector2D TileToLocal(int32 TileZ, int32 TileX, int32 TileY, const FGeometry& Geo) const;
    void      RequestVisibleTiles(const FGeometry& Geo) const;
    void      FetchTile(FTileKey Key) const;
    void      OnTileDownloaded(FHttpRequestPtr Req, FHttpResponsePtr Resp, bool bOk, FTileKey Key) const;

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

    // ── Tile cache ───────────────────────────────────────────────────────────
    mutable TMap<FTileKey, TSharedPtr<FSlateDynamicImageBrush>> TileCache;
    mutable TSet<FTileKey> PendingTiles;
    static constexpr int32 kMaxCacheSize = 256;
};
