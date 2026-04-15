#pragma once
#include "CoreMinimal.h"
#include "Widgets/SLeafWidget.h"

DECLARE_DELEGATE_FourParams(FOnMapBoundsSelected, double, double, double, double);

class SGeoWorldMap : public SLeafWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoWorldMap) {}
        SLATE_EVENT(FOnMapBoundsSelected, OnBoundsSelected)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

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
    // ── Projection (accounts for pan/zoom) ───────────────────────────────────
    FVector2D LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const;
    void      LocalToLonLat(FVector2D P, const FGeometry& Geo, double& OutLon, double& OutLat) const;

    // Clamp view so we don't scroll off the map
    void ClampView(const FGeometry& Geo);

    FOnMapBoundsSelected OnBoundsSelected;

    // ── View state (zoom + pan) ───────────────────────────────────────────────
    float     Zoom        = 1.0f;      // 1 = whole world fits
    FVector2D PanOffset   = FVector2D::ZeroVector; // local pixels offset

    // Right-drag pan
    bool      bPanning    = false;
    FVector2D PanStart    = FVector2D::ZeroVector;
    FVector2D PanAtStart  = FVector2D::ZeroVector;

    // Left-drag selection
    bool      bDragging   = false;
    FVector2D DragStart   = FVector2D::ZeroVector;
    FVector2D DragEnd     = FVector2D::ZeroVector;

    // Confirmed selection
    bool   bHasSelection = false;
    double SelW=0, SelS=0, SelE=0, SelN=0;
};
