#pragma once
#include "CoreMinimal.h"
#include "Widgets/SLeafWidget.h"

// Fired when the user finishes dragging a selection rectangle: (West, South, East, North)
DECLARE_DELEGATE_FourParams(FOnMapBoundsSelected, double, double, double, double);

/**
 * SGeoWorldMap
 *
 * Pure-Slate interactive world-map widget.
 * Draws an equirectangular graticule and lets the user drag-select a
 * geographic bounding box. No CEF, no web browser, no external assets.
 *
 * Usage:
 *   SNew(SGeoWorldMap)
 *   .OnBoundsSelected(FOnMapBoundsSelected::CreateSP(this, &MyClass::HandleBounds))
 */
class SGeoWorldMap : public SLeafWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoWorldMap) {}
        SLATE_EVENT(FOnMapBoundsSelected, OnBoundsSelected)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    // SWidget interface
    virtual int32 OnPaint(
        const FPaintArgs&           Args,
        const FGeometry&            AllottedGeometry,
        const FSlateRect&           MyCullingRect,
        FSlateWindowElementList&    OutDrawElements,
        int32                       LayerId,
        const FWidgetStyle&         InWidgetStyle,
        bool                        bParentEnabled) const override;

    virtual FReply OnMouseButtonDown(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FReply OnMouseMove      (const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FReply OnMouseButtonUp  (const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FCursorReply OnCursorQuery(const FGeometry& MyGeometry, const FPointerEvent& CursorEvent) const override;
    virtual FVector2D ComputeDesiredSize(float LayoutScaleMultiplier) const override;
    virtual bool SupportsKeyboardFocus() const override { return false; }

private:
    // Coordinate conversions (equirectangular projection)
    FVector2D LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const;
    FVector2D LocalToLonLat(FVector2D LocalPos, const FGeometry& Geo) const;

    FOnMapBoundsSelected OnBoundsSelected;

    // Drag state (local-space positions)
    bool      bDragging   = false;
    FVector2D DragStart   = FVector2D::ZeroVector;
    FVector2D DragEnd     = FVector2D::ZeroVector;

    // Last confirmed selection
    bool   bHasSelection = false;
    double SelW = 0, SelS = 0, SelE = 0, SelN = 0;
};
