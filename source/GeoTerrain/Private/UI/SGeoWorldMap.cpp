#include "UI/SGeoWorldMap.h"
#include "UI/GeoWorldCoastline.h"
#include "Rendering/DrawElements.h"
#include "Styling/CoreStyle.h"
#include "Fonts/SlateFontInfo.h"
#include "Framework/Application/SlateApplication.h"
#include "Brushes/SlateImageBrush.h"
#include "Misc/FileHelper.h"
#include "Interfaces/IPluginManager.h"

// ── Construct / Destruct ──────────────────────────────────────────────────────
void SGeoWorldMap::Construct(const FArguments& InArgs)
{
    OnBoundsSelected = InArgs._OnBoundsSelected;
    LoadWorldMap();
}

SGeoWorldMap::~SGeoWorldMap()
{
    WorldMapBrush.Reset();
}

void SGeoWorldMap::LoadWorldMap()
{
    if (!FSlateApplication::IsInitialized()) return;

    TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("GeoTerrain"));
    FString Dir = Plugin.IsValid()
        ? Plugin->GetBaseDir() / TEXT("Resources")
        : FPaths::ProjectPluginsDir() / TEXT("GeoTerrain/Resources");
    FString Path = Dir / TEXT("worldmap.png");

    if (!FPaths::FileExists(Path)) return;

    WorldMapBrush = MakeUnique<FSlateImageBrush>(Path, FVector2D(2048.f, 1024.f));
    bMapLoaded = true;
}

FVector2D SGeoWorldMap::ComputeDesiredSize(float) const
{
    return FVector2D(860.f, 480.f);
}

// ── Projection (equirectangular + zoom/pan) ───────────────────────────────────
FVector2D SGeoWorldMap::LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const
{
    FVector2D S = Geo.GetLocalSize();
    // Base equirectangular
    float X = (float)((Lon + 180.0) / 360.0 * S.X);
    float Y = (float)((90.0 - Lat)  / 180.0 * S.Y);
    // Apply zoom (scale around centre)
    FVector2D C = S * 0.5f;
    X = C.X + (X - C.X) * Zoom + PanOffset.X;
    Y = C.Y + (Y - C.Y) * Zoom + PanOffset.Y;
    return FVector2D(X, Y);
}

void SGeoWorldMap::LocalToLonLat(FVector2D P, const FGeometry& Geo, double& OutLon, double& OutLat) const
{
    FVector2D S = Geo.GetLocalSize();
    FVector2D C = S * 0.5f;
    // Invert zoom/pan
    float NX = (P.X - PanOffset.X - C.X) / Zoom + C.X;
    float NY = (P.Y - PanOffset.Y - C.Y) / Zoom + C.Y;
    OutLon = FMath::Clamp((double)(NX / S.X * 360.0 - 180.0), -180.0, 180.0);
    OutLat = FMath::Clamp((double)(90.0 - NY / S.Y * 180.0),   -90.0,  90.0);
}

void SGeoWorldMap::ClampView(const FGeometry& Geo)
{
    FVector2D S = Geo.GetLocalSize();
    // Prevent panning further than half a zoomed map width/height
    float MaxPanX = S.X * (Zoom - 1.0f) * 0.5f;
    float MaxPanY = S.Y * (Zoom - 1.0f) * 0.5f;
    PanOffset.X = FMath::Clamp(PanOffset.X, -MaxPanX, MaxPanX);
    PanOffset.Y = FMath::Clamp(PanOffset.Y, -MaxPanY, MaxPanY);
}

// ── Paint ─────────────────────────────────────────────────────────────────────
int32 SGeoWorldMap::OnPaint(
    const FPaintArgs& Args, const FGeometry& G,
    const FSlateRect& Cull, FSlateWindowElementList& Out,
    int32 L, const FWidgetStyle& Style, bool bEnabled) const
{
    const FSlateBrush*   White   = FCoreStyle::Get().GetBrush("WhiteBrush");
    const FSlateFontInfo SmFont  = FCoreStyle::GetDefaultFontStyle("Regular", 7);
    const FSlateFontInfo BldFont = FCoreStyle::GetDefaultFontStyle("Bold", 8);

    // Retry map load if it failed during Construct (Slate not ready then)
    if (!bMapLoaded)
        const_cast<SGeoWorldMap*>(this)->LoadWorldMap();

    // ── 1. Ocean background ───────────────────────────────────────────────────
    FSlateDrawElement::MakeBox(Out, L++, G.ToPaintGeometry(),
        White, ESlateDrawEffect::None, FLinearColor(0.04f, 0.07f, 0.14f));

    // ── 2. Bundled world map image ──────────────────────────────────────────────
    if (WorldMapBrush.IsValid())
    {
        // The image is equirectangular: lon -180..180, lat 90..-90
        // Map the full image to where (-180,90) -> (180,-90) sits in local space
        FVector2D ImgTL = LonLatToLocal(-180.0,  90.0, G);
        FVector2D ImgBR = LonLatToLocal( 180.0, -90.0, G);
        FVector2D ImgSz = ImgBR - ImgTL;
        if (ImgSz.X > 0.f && ImgSz.Y > 0.f)
        {
            FSlateDrawElement::MakeBox(Out, L,
                G.ToPaintGeometry(ImgSz, FSlateLayoutTransform(ImgTL)),
                WorldMapBrush.Get(), ESlateDrawEffect::None, FLinearColor::White);
        }
    }
    ++L;

    // ── 3. Minor grid lines (10°) ─────────────────────────────────────────────
    {
        const FLinearColor MinC(0.14f, 0.19f, 0.27f);
        TArray<FVector2D> Pts;
        for (int Lat = -80; Lat <= 80; Lat += 10)
        {
            if (Lat % 30 == 0) continue;
            Pts = { LonLatToLocal(-180,Lat,G), LonLatToLocal(180,Lat,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinC, true, 0.4f);
        }
        for (int Lon = -170; Lon < 180; Lon += 10)
        {
            if (Lon % 30 == 0) continue;
            Pts = { LonLatToLocal(Lon, 90,G), LonLatToLocal(Lon,-90,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinC, true, 0.4f);
        }
        ++L;
    }

    // ── 4. Major grid lines (30°) + equator/prime meridian ───────────────────
    {
        const FLinearColor MajC(0.22f, 0.32f, 0.44f);
        TArray<FVector2D> Pts;
        for (int Lat = -90; Lat <= 90; Lat += 30)
        {
            bool bEq = (Lat == 0);
            Pts = { LonLatToLocal(-180,Lat,G), LonLatToLocal(180,Lat,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None,
                bEq ? FLinearColor(0.3f,0.55f,0.38f,0.9f) : MajC,
                true, bEq ? 1.0f : 0.6f);
        }
        for (int Lon = -180; Lon <= 180; Lon += 30)
        {
            bool bPm = (Lon == 0);
            Pts = { LonLatToLocal(Lon,90,G), LonLatToLocal(Lon,-90,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None,
                bPm ? FLinearColor(0.3f,0.55f,0.38f,0.9f) : MajC,
                true, bPm ? 1.0f : 0.6f);
        }
        ++L;
    }

    // ── 5. World coastline ────────────────────────────────────────────────────
    {
        const FLinearColor LandC(0.52f, 0.60f, 0.44f);
        TArray<FVector2D> Ring;
        Ring.Reserve(128);
        for (int i = 0; ; ++i)
        {
            const FCoastPt& P = kCoastline[i];
            if (P.X > 997.f)                 // 998 sentinel = end of all data
            {
                if (Ring.Num() >= 2)
                    FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(),
                        Ring, ESlateDrawEffect::None, LandC, true, 1.1f);
                break;
            }
            if (P.X > 990.f)                 // 999 sentinel = end of this ring
            {
                if (Ring.Num() >= 2)
                    FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(),
                        Ring, ESlateDrawEffect::None, LandC, true, 1.1f);
                Ring.Reset();
                continue;
            }
            Ring.Add(LonLatToLocal(P.X, P.Y, G));
        }
        ++L;
    }

    // ── 6. Coordinate labels ─────────────────────────────────────────────────
    {
        const FLinearColor LblC(0.55f, 0.68f, 0.82f, 0.85f);
        // Only draw labels that are within the visible widget area
        FVector2D Sz = G.GetLocalSize();
        for (int Lat = -60; Lat <= 60; Lat += 30)
        {
            if (Lat == 0) continue;
            FVector2D P = LonLatToLocal(2, Lat, G) + FVector2D(2.f, -8.f);
            if (P.X < 0 || P.X > Sz.X || P.Y < 0 || P.Y > Sz.Y) continue;
            FSlateDrawElement::MakeText(Out, L,
                G.ToPaintGeometry(FVector2D(36.f,12.f), FSlateLayoutTransform(P)),
                FString::Printf(TEXT("%d°"), Lat), SmFont,
                ESlateDrawEffect::None, LblC);
        }
        for (int Lon = -150; Lon <= 150; Lon += 30)
        {
            FVector2D P = LonLatToLocal(Lon, -2, G) + FVector2D(-14.f, 2.f);
            if (P.X < 0 || P.X > Sz.X || P.Y < 0 || P.Y > Sz.Y) continue;
            FSlateDrawElement::MakeText(Out, L,
                G.ToPaintGeometry(FVector2D(42.f,12.f), FSlateLayoutTransform(P)),
                FString::Printf(TEXT("%d°"), Lon), SmFont,
                ESlateDrawEffect::None, LblC);
        }
        ++L;
    }

    // ── 7. Confirmed selection ────────────────────────────────────────────────
    if (bHasSelection)
    {
        FVector2D TL = LonLatToLocal(SelW, SelN, G);
        FVector2D BR = LonLatToLocal(SelE, SelS, G);
        FVector2D Sz = BR - TL;
        if (Sz.X > 1.f && Sz.Y > 1.f)
        {
            FSlateDrawElement::MakeBox(Out, L++,
                G.ToPaintGeometry(Sz, FSlateLayoutTransform(TL)),
                White, ESlateDrawEffect::None, FLinearColor(0.1f,0.5f,1.f,0.18f));
            TArray<FVector2D> Rim={TL,{BR.X,TL.Y},BR,{TL.X,BR.Y},TL};
            FSlateDrawElement::MakeLines(Out, L++, G.ToPaintGeometry(), Rim,
                ESlateDrawEffect::None, FLinearColor(0.2f,0.78f,1.f,0.95f), true, 1.8f);
            // Corner handles
            auto Dot = [&](FVector2D C){
                FSlateDrawElement::MakeBox(Out, L,
                    G.ToPaintGeometry(FVector2D(6,6), FSlateLayoutTransform(C - FVector2D(3,3))),
                    White, ESlateDrawEffect::None, FLinearColor(0.2f,0.78f,1.f,1.f));
            };
            Dot(TL); Dot({BR.X,TL.Y}); Dot(BR); Dot({TL.X,BR.Y});
            ++L;
        }
    }

    // ── 8. Active drag rectangle ──────────────────────────────────────────────
    if (bDragging)
    {
        FVector2D TL(FMath::Min(DragStart.X,DragEnd.X), FMath::Min(DragStart.Y,DragEnd.Y));
        FVector2D BR(FMath::Max(DragStart.X,DragEnd.X), FMath::Max(DragStart.Y,DragEnd.Y));
        FVector2D Sz = BR - TL;
        if (Sz.X > 2.f && Sz.Y > 2.f)
        {
            FSlateDrawElement::MakeBox(Out, L++,
                G.ToPaintGeometry(Sz, FSlateLayoutTransform(TL)),
                White, ESlateDrawEffect::None, FLinearColor(1.f,0.78f,0.08f,0.12f));
            TArray<FVector2D> Rim={TL,{BR.X,TL.Y},BR,{TL.X,BR.Y},TL};
            FSlateDrawElement::MakeLines(Out, L++, G.ToPaintGeometry(), Rim,
                ESlateDrawEffect::None, FLinearColor(1.f,0.85f,0.1f,1.f), true, 1.5f);
        }
        // Live coord label
        double W2,S2,E2,N2;
        LocalToLonLat(DragStart,G,W2,N2);
        LocalToLonLat(DragEnd,  G,E2,S2);
        if (W2>E2) Swap(W2,E2);
        if (S2>N2) Swap(S2,N2);
        FString Coord = FString::Printf(TEXT("W%.2f  S%.2f  E%.2f  N%.2f"), W2,S2,E2,N2);
        FVector2D LP = TL + FVector2D(4.f,-15.f);
        if (LP.Y < 4.f) LP.Y = BR.Y + 4.f;
        FSlateDrawElement::MakeText(Out, L++,
            G.ToPaintGeometry(FVector2D(310.f,14.f), FSlateLayoutTransform(LP)),
            Coord, BldFont, ESlateDrawEffect::None, FLinearColor(1.f,0.9f,0.1f,1.f));
    }

    // ── 9. Zoom level indicator ───────────────────────────────────────────────
    {
        FVector2D Sz = G.GetLocalSize();
        FString ZoomStr = FString::Printf(TEXT("Zoom %.1fx  |  Scroll to zoom  |  RMB drag to pan  |  LMB drag to select"), Zoom);
        FSlateDrawElement::MakeText(Out, L++,
            G.ToPaintGeometry(FVector2D(Sz.X - 8.f, 13.f), FSlateLayoutTransform(FVector2D(4.f, Sz.Y-14.f))),
            ZoomStr, SmFont, ESlateDrawEffect::None, FLinearColor(0.45f,0.55f,0.65f,0.7f));
    }

    return L;
}

// ── Mouse: left-drag selects, right-drag pans ─────────────────────────────────
FReply SGeoWorldMap::OnMouseButtonDown(const FGeometry& G, const FPointerEvent& E)
{
    FVector2D Local = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    if (E.GetEffectingButton() == EKeys::LeftMouseButton)
    {
        bDragging = true;
        DragStart = DragEnd = Local;
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().CaptureMouse(SharedThis(this)).SetUserFocus(SharedThis(this));
    }
    if (E.GetEffectingButton() == EKeys::RightMouseButton)
    {
        bPanning   = true;
        PanStart   = Local;
        PanAtStart = PanOffset;
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().CaptureMouse(SharedThis(this)).SetUserFocus(SharedThis(this));
    }
    return FReply::Handled().SetUserFocus(SharedThis(this));
}

FReply SGeoWorldMap::OnMouseMove(const FGeometry& G, const FPointerEvent& E)
{
    FVector2D Local = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    if (bDragging)
    {
        DragEnd = Local;
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled();
    }
    if (bPanning)
    {
        PanOffset = PanAtStart + (Local - PanStart);
        ClampView(G);
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled();
    }
    return FReply::Handled();
}

FReply SGeoWorldMap::OnMouseButtonUp(const FGeometry& G, const FPointerEvent& E)
{
    FVector2D Local = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    if (E.GetEffectingButton() == EKeys::LeftMouseButton && bDragging)
    {
        bDragging = false;
        DragEnd   = Local;
        double W2,S2,E2,N2;
        LocalToLonLat(DragStart,G,W2,N2);
        LocalToLonLat(DragEnd,  G,E2,S2);
        if (W2>E2) Swap(W2,E2);
        if (S2>N2) Swap(S2,N2);
        SelW=W2; SelE=E2; SelS=S2; SelN=N2;
        bHasSelection = (SelE-SelW > 0.01 && SelN-SelS > 0.01);
        if (bHasSelection && OnBoundsSelected.IsBound())
            OnBoundsSelected.Execute(SelW,SelS,SelE,SelN);
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().ReleaseMouseCapture();
    }
    if (E.GetEffectingButton() == EKeys::RightMouseButton && bPanning)
    {
        bPanning = false;
        Invalidate(EInvalidateWidgetReason::Paint);
        return FReply::Handled().ReleaseMouseCapture();
    }
    return FReply::Unhandled();
}

FReply SGeoWorldMap::OnMouseWheel(const FGeometry& G, const FPointerEvent& E)
{
    // Zoom toward the mouse cursor position
    FVector2D Local  = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    FVector2D Centre = G.GetLocalSize() * 0.5f;
    float OldZoom    = Zoom;
    Zoom = FMath::Clamp(Zoom * (E.GetWheelDelta() > 0 ? 1.25f : 0.8f), 1.0f, 32.0f);

    // Keep the geographic point under the cursor fixed during zoom
    float Scale = Zoom / OldZoom;
    PanOffset   = (PanOffset - (Local - Centre)) * Scale + (Local - Centre);
    ClampView(G);

    Invalidate(EInvalidateWidgetReason::Paint);
    return FReply::Handled();
}

void SGeoWorldMap::OnMouseEnter(const FGeometry& G, const FPointerEvent& E)
{
    FSlateApplication::Get().SetKeyboardFocus(SharedThis(this), EFocusCause::Mouse);
}

void SGeoWorldMap::OnMouseLeave(const FPointerEvent& E)
{
    if (bPanning)  { bPanning  = false; }
    if (bDragging) { bDragging = false; }
    Invalidate(EInvalidateWidgetReason::Paint);
}

FCursorReply SGeoWorldMap::OnCursorQuery(const FGeometry&, const FPointerEvent&) const
{
    if (bPanning)  return FCursorReply::Cursor(EMouseCursor::GrabHandClosed);
    if (bDragging) return FCursorReply::Cursor(EMouseCursor::Crosshairs);
    return FCursorReply::Cursor(EMouseCursor::Crosshairs);
}
