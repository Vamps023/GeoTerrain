#include "UI/SGeoWorldMap.h"
#include "Rendering/DrawElements.h"
#include "Styling/CoreStyle.h"
#include "Fonts/SlateFontInfo.h"

// ─────────────────────────────────────────────────────────────────────────────
void SGeoWorldMap::Construct(const FArguments& InArgs)
{
    OnBoundsSelected = InArgs._OnBoundsSelected;
}

FVector2D SGeoWorldMap::ComputeDesiredSize(float) const
{
    return FVector2D(860.f, 420.f);
}

// ── Projection helpers ────────────────────────────────────────────────────────
FVector2D SGeoWorldMap::LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const
{
    FVector2D S = Geo.GetLocalSize();
    return FVector2D(
        (float)((Lon + 180.0) / 360.0 * S.X),
        (float)((90.0  - Lat) / 180.0 * S.Y)
    );
}

FVector2D SGeoWorldMap::LocalToLonLat(FVector2D P, const FGeometry& Geo) const
{
    FVector2D S = Geo.GetLocalSize();
    return FVector2D(
        (float)FMath::Clamp(P.X / S.X * 360.0 - 180.0, -180.0, 180.0),
        (float)FMath::Clamp(90.0 - P.Y / S.Y * 180.0,  -90.0,   90.0)
    );
}

// ── Paint ─────────────────────────────────────────────────────────────────────
int32 SGeoWorldMap::OnPaint(
    const FPaintArgs& Args, const FGeometry& AllottedGeometry,
    const FSlateRect& MyCullingRect, FSlateWindowElementList& OutDrawElements,
    int32 LayerId, const FWidgetStyle& InWidgetStyle, bool bParentEnabled) const
{
    const FSlateBrush* White     = FCoreStyle::Get().GetBrush("WhiteBrush");
    const FSlateFontInfo SmFont  = FCoreStyle::GetDefaultFontStyle("Regular", 8);
    const FSlateFontInfo BldFont = FCoreStyle::GetDefaultFontStyle("Bold", 9);

    // ── 1. Ocean background ───────────────────────────────────────────────────
    FSlateDrawElement::MakeBox(OutDrawElements, LayerId++,
        AllottedGeometry.ToPaintGeometry(),
        White, ESlateDrawEffect::None, FLinearColor(0.04f, 0.07f, 0.13f));

    // ── 2. Minor grid – 10° steps ─────────────────────────────────────────────
    {
        const FLinearColor MinCol(0.16f, 0.21f, 0.28f);
        TArray<FVector2D> Pts;
        for (int Lat = -80; Lat <= 80; Lat += 10)
        {
            if (Lat % 30 == 0) continue;
            Pts = { LonLatToLocal(-180, Lat, AllottedGeometry),
                    LonLatToLocal( 180, Lat, AllottedGeometry) };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinCol, true, 0.5f);
        }
        for (int Lon = -170; Lon < 180; Lon += 10)
        {
            if (Lon % 30 == 0) continue;
            Pts = { LonLatToLocal(Lon,  90, AllottedGeometry),
                    LonLatToLocal(Lon, -90, AllottedGeometry) };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinCol, true, 0.5f);
        }
        ++LayerId;
    }

    // ── 3. Major grid – 30° steps ─────────────────────────────────────────────
    {
        const FLinearColor MajCol(0.26f, 0.35f, 0.46f);
        TArray<FVector2D> Pts;
        for (int Lat = -90; Lat <= 90; Lat += 30)
        {
            const bool bEq = (Lat == 0);
            Pts = { LonLatToLocal(-180, Lat, AllottedGeometry),
                    LonLatToLocal( 180, Lat, AllottedGeometry) };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(), Pts, ESlateDrawEffect::None,
                bEq ? FLinearColor(0.35f, 0.55f, 0.40f) : MajCol,
                true, bEq ? 1.2f : 0.8f);
        }
        for (int Lon = -180; Lon <= 180; Lon += 30)
        {
            const bool bPm = (Lon == 0);
            Pts = { LonLatToLocal(Lon,  90, AllottedGeometry),
                    LonLatToLocal(Lon, -90, AllottedGeometry) };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(), Pts, ESlateDrawEffect::None,
                bPm ? FLinearColor(0.35f, 0.55f, 0.40f) : MajCol,
                true, bPm ? 1.2f : 0.8f);
        }
        ++LayerId;
    }

    // ── 4. Coordinate labels ──────────────────────────────────────────────────
    {
        const FLinearColor LblCol(0.58f, 0.70f, 0.84f);
        for (int Lat = -60; Lat <= 60; Lat += 30)
        {
            if (Lat == 0) continue;
            FVector2D P = LonLatToLocal(4, Lat, AllottedGeometry) + FVector2D(2.f, -8.f);
            FSlateDrawElement::MakeText(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(FVector2D(36.f, 12.f), FSlateLayoutTransform(P)),
                FString::Printf(TEXT("%d\u00b0"), Lat), SmFont, ESlateDrawEffect::None, LblCol);
        }
        for (int Lon = -150; Lon <= 150; Lon += 30)
        {
            FVector2D P = LonLatToLocal(Lon, -3, AllottedGeometry) + FVector2D(-16.f, 2.f);
            FSlateDrawElement::MakeText(OutDrawElements, LayerId,
                AllottedGeometry.ToPaintGeometry(FVector2D(42.f, 12.f), FSlateLayoutTransform(P)),
                FString::Printf(TEXT("%d\u00b0"), Lon), SmFont, ESlateDrawEffect::None, LblCol);
        }
        // Axis labels
        FVector2D EqL = LonLatToLocal(-178, 0, AllottedGeometry) + FVector2D(2.f, -8.f);
        FSlateDrawElement::MakeText(OutDrawElements, LayerId,
            AllottedGeometry.ToPaintGeometry(FVector2D(30.f, 12.f), FSlateLayoutTransform(EqL)),
            TEXT("0\u00b0"), SmFont, ESlateDrawEffect::None, FLinearColor(0.45f, 0.7f, 0.5f));
        ++LayerId;
    }

    // ── 5. Confirmed selection (blue fill + border) ───────────────────────────
    if (bHasSelection)
    {
        FVector2D TL = LonLatToLocal(SelW, SelN, AllottedGeometry);
        FVector2D BR = LonLatToLocal(SelE, SelS, AllottedGeometry);
        FVector2D Sz = BR - TL;
        if (Sz.X > 1.f && Sz.Y > 1.f)
        {
            FSlateDrawElement::MakeBox(OutDrawElements, LayerId++,
                AllottedGeometry.ToPaintGeometry(Sz, FSlateLayoutTransform(TL)),
                White, ESlateDrawEffect::None, FLinearColor(0.12f, 0.52f, 1.f, 0.18f));
            TArray<FVector2D> Rim = { TL, {BR.X,TL.Y}, BR, {TL.X,BR.Y}, TL };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId++,
                AllottedGeometry.ToPaintGeometry(), Rim,
                ESlateDrawEffect::None, FLinearColor(0.2f, 0.75f, 1.f, 0.9f), true, 1.5f);
        }
    }

    // ── 6. Drag rectangle (yellow) + live coords ──────────────────────────────
    if (bDragging)
    {
        FVector2D TL(FMath::Min(DragStart.X, DragEnd.X), FMath::Min(DragStart.Y, DragEnd.Y));
        FVector2D BR(FMath::Max(DragStart.X, DragEnd.X), FMath::Max(DragStart.Y, DragEnd.Y));
        FVector2D Sz = BR - TL;

        if (Sz.X > 2.f && Sz.Y > 2.f)
        {
            FSlateDrawElement::MakeBox(OutDrawElements, LayerId++,
                AllottedGeometry.ToPaintGeometry(Sz, FSlateLayoutTransform(TL)),
                White, ESlateDrawEffect::None, FLinearColor(1.f, 0.78f, 0.08f, 0.14f));
            TArray<FVector2D> Rim = { TL, {BR.X,TL.Y}, BR, {TL.X,BR.Y}, TL };
            FSlateDrawElement::MakeLines(OutDrawElements, LayerId++,
                AllottedGeometry.ToPaintGeometry(), Rim,
                ESlateDrawEffect::None, FLinearColor(1.f, 0.82f, 0.1f), true, 1.5f);
        }

        // Live coordinate readout
        FVector2D SLL = LocalToLonLat(DragStart, AllottedGeometry);
        FVector2D ELL = LocalToLonLat(DragEnd,   AllottedGeometry);
        double W2 = FMath::Min((double)SLL.X,(double)ELL.X);
        double E2 = FMath::Max((double)SLL.X,(double)ELL.X);
        double S2 = FMath::Min((double)SLL.Y,(double)ELL.Y);
        double N2 = FMath::Max((double)SLL.Y,(double)ELL.Y);

        FString Coord = FString::Printf(TEXT("W: %.2f   S: %.2f   E: %.2f   N: %.2f"), W2, S2, E2, N2);
        FVector2D LP  = TL + FVector2D(4.f, -16.f);
        if (LP.Y < 2.f) LP.Y = BR.Y + 3.f;
        FSlateDrawElement::MakeText(OutDrawElements, LayerId++,
            AllottedGeometry.ToPaintGeometry(FVector2D(300.f, 14.f), FSlateLayoutTransform(LP)),
            Coord, BldFont, ESlateDrawEffect::None, FLinearColor(1.f, 0.88f, 0.1f));
    }

    // ── 7. Hint when nothing selected ────────────────────────────────────────
    if (!bDragging && !bHasSelection)
    {
        FVector2D S = AllottedGeometry.GetLocalSize();
        FVector2D HP((S.X - 280.f) * 0.5f, S.Y - 18.f);
        FSlateDrawElement::MakeText(OutDrawElements, LayerId++,
            AllottedGeometry.ToPaintGeometry(FVector2D(280.f, 14.f), FSlateLayoutTransform(HP)),
            TEXT("Click and drag to select terrain bounds"),
            SmFont, ESlateDrawEffect::None, FLinearColor(0.5f, 0.6f, 0.7f, 0.8f));
    }

    return LayerId;
}

// ── Mouse events ──────────────────────────────────────────────────────────────
FReply SGeoWorldMap::OnMouseButtonDown(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (MouseEvent.GetEffectingButton() == EKeys::LeftMouseButton)
    {
        bDragging = true;
        DragStart = MyGeometry.AbsoluteToLocal(MouseEvent.GetScreenSpacePosition());
        DragEnd   = DragStart;
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().CaptureMouse(SharedThis(this));
    }
    return FReply::Unhandled();
}

FReply SGeoWorldMap::OnMouseMove(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (bDragging)
    {
        DragEnd = MyGeometry.AbsoluteToLocal(MouseEvent.GetScreenSpacePosition());
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled();
    }
    return FReply::Unhandled();
}

FReply SGeoWorldMap::OnMouseButtonUp(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (MouseEvent.GetEffectingButton() == EKeys::LeftMouseButton && bDragging)
    {
        bDragging = false;
        DragEnd = MyGeometry.AbsoluteToLocal(MouseEvent.GetScreenSpacePosition());

        FVector2D SLL = LocalToLonLat(DragStart, MyGeometry);
        FVector2D ELL = LocalToLonLat(DragEnd,   MyGeometry);

        SelW = FMath::Min((double)SLL.X, (double)ELL.X);
        SelE = FMath::Max((double)SLL.X, (double)ELL.X);
        SelS = FMath::Min((double)SLL.Y, (double)ELL.Y);
        SelN = FMath::Max((double)SLL.Y, (double)ELL.Y);

        bHasSelection = (SelE - SelW > 0.01 && SelN - SelS > 0.01);
        if (bHasSelection && OnBoundsSelected.IsBound())
            OnBoundsSelected.Execute(SelW, SelS, SelE, SelN);

        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().ReleaseMouseCapture();
    }
    return FReply::Unhandled();
}

FCursorReply SGeoWorldMap::OnCursorQuery(const FGeometry&, const FPointerEvent&) const
{
    return FCursorReply::Cursor(EMouseCursor::Crosshairs);
}
