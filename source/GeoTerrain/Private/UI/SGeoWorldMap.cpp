#include "UI/SGeoWorldMap.h"
#include "UI/GeoWorldCoastline.h"
#include "Rendering/DrawElements.h"
#include "Styling/CoreStyle.h"
#include "Fonts/SlateFontInfo.h"
#include "Framework/Application/SlateApplication.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/FileHelper.h"
#include "Interfaces/IPluginManager.h"

static const double PI_VAL = 3.14159265358979323846;

// ── Construct / Destruct ──────────────────────────────────────────────────────
void SGeoWorldMap::Construct(const FArguments& InArgs)
{
    OnBoundsSelected = InArgs._OnBoundsSelected;
}

SGeoWorldMap::~SGeoWorldMap()
{
}

void SGeoWorldMap::SetTileUrlTemplate(const FString& InUrlTemplate)
{
    if (TileUrlTemplate != InUrlTemplate)
    {
        TileUrlTemplate = InUrlTemplate;
        TileCache.Empty();
        ActiveDownloads = 0;
        Invalidate(EInvalidateWidgetReason::Paint);
    }
}

FVector2D SGeoWorldMap::ComputeDesiredSize(float) const
{
    return FVector2D(860.f, 480.f);
}

// ── Web Mercator Math ─────────────────────────────────────────────────────────

int32 SGeoWorldMap::Long2TileX(double Lon, int32 z)
{
    return FMath::FloorToInt((Lon + 180.0) / 360.0 * (1 << z));
}

int32 SGeoWorldMap::Lat2TileY(double Lat, int32 z)
{
    double latRad = Lat * PI_VAL / 180.0;
    return FMath::FloorToInt((1.0 - FMath::Loge(FMath::Tan(latRad) + 1.0 / FMath::Cos(latRad)) / PI_VAL) / 2.0 * (1 << z));
}

double SGeoWorldMap::TileX2Long(int32 x, int32 z)
{
    return x / (double)(1 << z) * 360.0 - 180.0;
}

double SGeoWorldMap::TileY2Lat(int32 y, int32 z)
{
    double n = PI_VAL - 2.0 * PI_VAL * y / (double)(1 << z);
    return 180.0 / PI_VAL * FMath::Atan(0.5 * (FMath::Exp(n) - FMath::Exp(-n)));
}

// ── Projection (Web Mercator + zoom/pan) ──────────────────────────────────────
FVector2D SGeoWorldMap::LonLatToLocal(double Lon, double Lat, const FGeometry& Geo) const
{
    FVector2D S = Geo.GetLocalSize();
    float BaseSz = FMath::Min(S.X, S.Y);
    
    double X = (Lon + 180.0) / 360.0 * BaseSz;
    double CLat = FMath::Clamp(Lat, -85.0511, 85.0511);
    double latRad = CLat * PI_VAL / 180.0;
    double Y = (1.0 - FMath::Loge(FMath::Tan(latRad) + 1.0 / FMath::Cos(latRad)) / PI_VAL) / 2.0 * BaseSz;

    FVector2D C = S * 0.5f;
    return FVector2D(
        C.X + (float)((X - BaseSz * 0.5) * Zoom) + PanOffset.X,
        C.Y + (float)((Y - BaseSz * 0.5) * Zoom) + PanOffset.Y
    );
}

void SGeoWorldMap::LocalToLonLat(FVector2D P, const FGeometry& Geo, double& OutLon, double& OutLat) const
{
    FVector2D S = Geo.GetLocalSize();
    float BaseSz = FMath::Min(S.X, S.Y);
    FVector2D C = S * 0.5f;

    double X = (P.X - PanOffset.X - C.X) / Zoom + BaseSz * 0.5;
    double Y = (P.Y - PanOffset.Y - C.Y) / Zoom + BaseSz * 0.5;

    OutLon = (X / BaseSz) * 360.0 - 180.0;
    double n = PI_VAL - 2.0 * PI_VAL * (Y / BaseSz);
    OutLat = 180.0 / PI_VAL * FMath::Atan(0.5 * (FMath::Exp(n) - FMath::Exp(-n)));
    
    OutLon = FMath::Clamp(OutLon, -180.0, 180.0);
    OutLat = FMath::Clamp(OutLat, -85.0511, 85.0511);
}

void SGeoWorldMap::ClampView(const FGeometry& Geo)
{
    FVector2D S = Geo.GetLocalSize();
    float BaseSz = FMath::Min(S.X, S.Y);
    float MaxPanX = BaseSz * Zoom * 0.5f;
    float MaxPanY = BaseSz * Zoom * 0.5f;
    
    PanOffset.X = FMath::Clamp(PanOffset.X, -MaxPanX - S.X*0.5f, MaxPanX + S.X*0.5f);
    PanOffset.Y = FMath::Clamp(PanOffset.Y, -MaxPanY - S.Y*0.5f, MaxPanY + S.Y*0.5f);
}

// ── Native Tile Fetching ──────────────────────────────────────────────────────

void SGeoWorldMap::FetchTile(const FGeoTileKey& Key) const
{
    if (ActiveDownloads >= MaxConcurrentDownloads) return;

    TSharedPtr<FGeoMapTile>& Tile = TileCache.FindOrAdd(Key);
    if (Tile && Tile->bIsLoading) return;
    
    if (!Tile) Tile = MakeShared<FGeoMapTile>();
    Tile->bIsLoading = true;
    Tile->LastUsedTime = FPlatformTime::Seconds();

    FString Url = TileUrlTemplate;
    Url = Url.Replace(TEXT("{z}"), *FString::Printf(TEXT("%d"), Key.Z));
    Url = Url.Replace(TEXT("{x}"), *FString::Printf(TEXT("%d"), Key.X));
    Url = Url.Replace(TEXT("{y}"), *FString::Printf(TEXT("%d"), Key.Y));

    ActiveDownloads++;

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(Url);
    Req->SetVerb(TEXT("GET"));
    Req->OnProcessRequestComplete().BindSP(this, &SGeoWorldMap::OnTileDownloaded, Key);
    Req->ProcessRequest();
}

void SGeoWorldMap::OnTileDownloaded(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bSucceeded, FGeoTileKey Key) const
{
    ActiveDownloads--;
    if (!FSlateApplication::IsInitialized()) return;

    TSharedPtr<FGeoMapTile>* TilePtr = TileCache.Find(Key);
    if (!TilePtr || !(*TilePtr)) return;
    (*TilePtr)->bIsLoading = false;

    if (bSucceeded && Response.IsValid() && Response->GetResponseCode() == 200)
    {
        const TArray<uint8>& Bytes = Response->GetContent();
        IImageWrapperModule& IWM = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
        EImageFormat Fmt = IWM.DetectImageFormat(Bytes.GetData(), Bytes.Num());
        if (Fmt != EImageFormat::Invalid)
        {
            TSharedPtr<IImageWrapper> IW = IWM.CreateImageWrapper(Fmt);
            if (IW.IsValid() && IW->SetCompressed(Bytes.GetData(), Bytes.Num()))
            {
                TArray<uint8> Raw;
                if (IW->GetRaw(ERGBFormat::BGRA, 8, Raw))
                {
                    const int32 W = IW->GetWidth();
                    const int32 H = IW->GetHeight();
                    const FName BrushName(*FString::Printf(TEXT("MapTile_%d_%d_%d"), Key.Z, Key.X, Key.Y));
                    FSlateRenderer* Renderer = FSlateApplication::Get().GetRenderer();
                    if (Renderer)
                    {
                        Renderer->GenerateDynamicImageResource(BrushName, (uint32)W, (uint32)H, Raw);
                        (*TilePtr)->Brush = MakeShared<FSlateDynamicImageBrush>(BrushName, FVector2D(W, H));
                        (*TilePtr)->Brush->DrawAs = ESlateBrushDrawType::Image;
                        const_cast<SGeoWorldMap*>(this)->Invalidate(EInvalidateWidgetReason::Paint);
                    }
                }
            }
        }
    }
}

void SGeoWorldMap::PruneTileCache() const
{
    if (TileCache.Num() <= 200) return;

    TArray<FGeoTileKey> Keys;
    TileCache.GenerateKeyArray(Keys);
    Keys.Sort([&](const FGeoTileKey& A, const FGeoTileKey& B) {
        return TileCache[A]->LastUsedTime < TileCache[B]->LastUsedTime;
    });

    int32 NumToRemove = FMath::Min(50, Keys.Num());
    for (int32 I = 0; I < NumToRemove; ++I)
    {
        TileCache.Remove(Keys[I]);
    }
}

// ── Chunk system ──────────────────────────────────────────────────────────────
void SGeoWorldMap::RebuildChunkPlan()
{
    if (!bHasSelection || ChunkSizeKm < 1.0)
    {
        CurrentPlan = FGeoChunkPlan();
        ChunkEnabledMask.Empty();
        return;
    }
    FGeoBounds Sel; Sel.West=SelW; Sel.South=SelS; Sel.East=SelE; Sel.North=SelN;
    FGeoChunkSettings Settings;
    Settings.ChunkSizeKm  = ChunkSizeKm;
    Settings.EnabledMask  = ChunkEnabledMask;
    CurrentPlan = FGeoChunkPlanner::Plan(Sel, Settings);
    
    if (ChunkEnabledMask.Num() != CurrentPlan.Chunks.Num())
    {
        ChunkEnabledMask.Init(true, CurrentPlan.Chunks.Num());
        Settings.EnabledMask = ChunkEnabledMask;
        CurrentPlan = FGeoChunkPlanner::Plan(Sel, Settings);
    }
}

void SGeoWorldMap::SetChunkSizeKm(double Km)
{
    ChunkSizeKm = Km;
    RebuildChunkPlan();
    Invalidate(EInvalidateWidgetReason::Paint);
}

int32 SGeoWorldMap::HitTestChunk(FVector2D LocalPt, const FGeometry& Geo) const
{
    for (int32 I = 0; I < CurrentPlan.Chunks.Num(); ++I)
    {
        const FGeoChunkDefinition& C = CurrentPlan.Chunks[I];
        FVector2D TL = LonLatToLocal(C.Bounds.West,  C.Bounds.North, Geo);
        FVector2D BR = LonLatToLocal(C.Bounds.East,  C.Bounds.South, Geo);
        if (LocalPt.X >= TL.X && LocalPt.X <= BR.X &&
            LocalPt.Y >= TL.Y && LocalPt.Y <= BR.Y)
            return I;
    }
    return INDEX_NONE;
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

    // ── 1. Background Fill ────────────────────────────────────────────────────
    FSlateDrawElement::MakeBox(Out, L++, G.ToPaintGeometry(),
        White, ESlateDrawEffect::None, FLinearColor(0.04f, 0.07f, 0.14f));

    // ── 2. Native Dynamic Tiles ───────────────────────────────────────────────
    PruneTileCache();

    // Determine Web Mercator Zoom Level
    double MapSizePx = FMath::Min(G.GetLocalSize().X, G.GetLocalSize().Y) * Zoom;
    int32 WebZ = FMath::Clamp(FMath::RoundToInt(FMath::Log2((float)(MapSizePx / 256.0))), 0, 19);

    // Find visible bounds
    double TL_Lon, TL_Lat, BR_Lon, BR_Lat;
    LocalToLonLat(FVector2D(0, 0), G, TL_Lon, TL_Lat);
    LocalToLonLat(G.GetLocalSize(), G, BR_Lon, BR_Lat);

    int32 minX = FMath::Max(0, Long2TileX(TL_Lon, WebZ));
    int32 maxX = FMath::Min((1<<WebZ)-1, Long2TileX(BR_Lon, WebZ));
    int32 minY = FMath::Max(0, Lat2TileY(TL_Lat, WebZ));
    int32 maxY = FMath::Min((1<<WebZ)-1, Lat2TileY(BR_Lat, WebZ));

    if (minY > maxY) Swap(minY, maxY);
    if (minX > maxX) Swap(minX, maxX);

    const double CacheTime = FPlatformTime::Seconds();

    for (int32 Ty = minY; Ty <= maxY; ++Ty)
    {
        for (int32 Tx = minX; Tx <= maxX; ++Tx)
        {
            FGeoTileKey Key{WebZ, Tx, Ty};
            TSharedPtr<FGeoMapTile>* TilePtr = TileCache.Find(Key);
            bool bDrawn = false;

            FVector2D P1 = LonLatToLocal(TileX2Long(Tx, WebZ), TileY2Lat(Ty, WebZ), G);
            FVector2D P2 = LonLatToLocal(TileX2Long(Tx+1, WebZ), TileY2Lat(Ty+1, WebZ), G);
            FVector2D DrawSz((P2.X - P1.X) + 0.5f, (P2.Y - P1.Y) + 0.5f);

            if (TilePtr && (*TilePtr)->Brush.IsValid())
            {
                (*TilePtr)->LastUsedTime = CacheTime;
                FSlateDrawElement::MakeBox(Out, L,
                    G.ToPaintGeometry(DrawSz, FSlateLayoutTransform(P1)),
                    (*TilePtr)->Brush.Get(), ESlateDrawEffect::None, FLinearColor::White);
                bDrawn = true;
            }
            else
            {
                FetchTile(Key);
                
                // Draw checkerboard or fallback background
                FSlateDrawElement::MakeBox(Out, L,
                    G.ToPaintGeometry(DrawSz, FSlateLayoutTransform(P1)),
                    White, ESlateDrawEffect::None, FLinearColor(0.08f, 0.12f, 0.20f));
            }
        }
    }
    ++L;

    // ── 3. Overlay Grid Lines (only when zoomed out) ──────────────────────────
    if (WebZ <= 5)
    {
        const FLinearColor MinC(0.14f, 0.19f, 0.27f, 0.5f);
        TArray<FVector2D> Pts;
        for (int Lat = -80; Lat <= 80; Lat += 20)
        {
            Pts = { LonLatToLocal(-180,Lat,G), LonLatToLocal(180,Lat,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinC, true, 0.4f);
        }
        for (int Lon = -160; Lon < 180; Lon += 20)
        {
            Pts = { LonLatToLocal(Lon, 85,G), LonLatToLocal(Lon,-85,G) };
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Pts,
                ESlateDrawEffect::None, MinC, true, 0.4f);
        }
        ++L;
    }

    // ── 5. Chunk grid over selection ──────────────────────────────────────────
    if (bHasSelection && CurrentPlan.Chunks.Num() > 1)
    {
        for (int32 I = 0; I < CurrentPlan.Chunks.Num(); ++I)
        {
            const FGeoChunkDefinition& C = CurrentPlan.Chunks[I];
            const bool bChunkEnabled = (ChunkEnabledMask.Num() > I) ? ChunkEnabledMask[I] : true;

            FVector2D CTL = LonLatToLocal(C.Bounds.West,  C.Bounds.North, G);
            FVector2D CBR = LonLatToLocal(C.Bounds.East,  C.Bounds.South, G);
            FVector2D CSz = CBR - CTL;
            if (CSz.X < 1.f || CSz.Y < 1.f) continue;

            FLinearColor Fill = bChunkEnabled
                ? FLinearColor(0.1f, 0.5f, 1.0f, 0.13f)
                : FLinearColor(0.7f, 0.1f, 0.1f, 0.35f);
            FSlateDrawElement::MakeBox(Out, L,
                G.ToPaintGeometry(CSz, FSlateLayoutTransform(CTL)),
                White, ESlateDrawEffect::None, Fill);

            FLinearColor Border = bChunkEnabled
                ? FLinearColor(0.3f, 0.75f, 1.0f, 0.7f)
                : FLinearColor(1.0f, 0.3f, 0.3f, 0.6f);
            TArray<FVector2D> Rim={CTL,{CBR.X,CTL.Y},CBR,{CTL.X,CBR.Y},CTL};
            FSlateDrawElement::MakeLines(Out, L, G.ToPaintGeometry(), Rim,
                ESlateDrawEffect::None, Border, true, 1.0f);

            if (CSz.X > 20.f && CSz.Y > 12.f)
            {
                FVector2D LabelPos = CTL + FVector2D(3.f, 2.f);
                FSlateDrawElement::MakeText(Out, L,
                    G.ToPaintGeometry(FVector2D(CSz.X-4.f, 12.f), FSlateLayoutTransform(LabelPos)),
                    FString::Printf(TEXT("%d"), I), SmFont,
                    ESlateDrawEffect::None,
                    bChunkEnabled ? FLinearColor(0.8f,0.95f,1.f,0.9f) : FLinearColor(1.f,0.6f,0.6f,0.8f));
            }
        }
        ++L;

        int32 Enabled = 0;
        for (bool b : ChunkEnabledMask) if (b) ++Enabled;
        FString Summary = FString::Printf(TEXT("%d / %d chunks enabled  (LMB click chunk to toggle)"),
            Enabled, CurrentPlan.Chunks.Num());
        FVector2D SelTL = LonLatToLocal(SelW, SelN, G);
        FVector2D LblPos = SelTL + FVector2D(2.f, -13.f);
        if (LblPos.Y < 2.f) LblPos.Y = LonLatToLocal(SelW, SelS, G).Y + 2.f;
        FSlateDrawElement::MakeText(Out, L++,
            G.ToPaintGeometry(FVector2D(380.f, 12.f), FSlateLayoutTransform(LblPos)),
            Summary, SmFont, ESlateDrawEffect::None, FLinearColor(0.9f, 0.85f, 0.4f, 1.f));
    }

    // ── 6. Confirmed selection ────────────────────────────────────────────────
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
            auto Dot = [&](FVector2D C){
                FSlateDrawElement::MakeBox(Out, L,
                    G.ToPaintGeometry(FVector2D(6,6), FSlateLayoutTransform(C - FVector2D(3,3))),
                    White, ESlateDrawEffect::None, FLinearColor(0.2f,0.78f,1.f,1.f));
            };
            Dot(TL); Dot({BR.X,TL.Y}); Dot(BR); Dot({TL.X,BR.Y});
            ++L;
        }
    }

    // ── 7. Active drag rectangle ──────────────────────────────────────────────
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

    // ── 8. Zoom level indicator ───────────────────────────────────────────────
    {
        FVector2D Sz = G.GetLocalSize();
        FString ZoomStr = FString::Printf(TEXT("WebZoom %d  |  Scroll to zoom  |  RMB drag to pan  |  LMB drag to select"), WebZ);
        FSlateDrawElement::MakeText(Out, L++,
            G.ToPaintGeometry(FVector2D(Sz.X - 8.f, 13.f), FSlateLayoutTransform(FVector2D(4.f, Sz.Y-14.f))),
            ZoomStr, SmFont, ESlateDrawEffect::None, FLinearColor(1.0f,1.0f,1.0f,0.9f));
    }

    return L;
}

// ── Mouse: left-drag selects, right-drag pans ─────────────────────────────────
FReply SGeoWorldMap::OnMouseButtonDown(const FGeometry& G, const FPointerEvent& E)
{
    FVector2D Local = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    if (E.GetEffectingButton() == EKeys::LeftMouseButton)
    {
        if (bHasSelection && CurrentPlan.Chunks.Num() > 1)
        {
            int32 Hit = HitTestChunk(Local, G);
            if (Hit != INDEX_NONE)
            {
                if (ChunkEnabledMask.IsValidIndex(Hit))
                    ChunkEnabledMask[Hit] = !ChunkEnabledMask[Hit];
                FGeoBounds Sel; Sel.West=SelW; Sel.South=SelS; Sel.East=SelE; Sel.North=SelN;
                FGeoChunkSettings S2;
                S2.ChunkSizeKm = ChunkSizeKm;
                S2.EnabledMask = ChunkEnabledMask;
                CurrentPlan = FGeoChunkPlanner::Plan(Sel, S2);
                Invalidate(EInvalidateWidgetReason::Paint);
                return FReply::Handled().SetUserFocus(SharedThis(this));
            }
        }
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
        if (bHasSelection)
        {
            RebuildChunkPlan();
            if (OnBoundsSelected.IsBound())
                OnBoundsSelected.Execute(SelW,SelS,SelE,SelN);
        }
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
    FVector2D Local  = G.AbsoluteToLocal(E.GetScreenSpacePosition());
    FVector2D Centre = G.GetLocalSize() * 0.5f;
    float OldZoom    = Zoom;
    Zoom = FMath::Clamp(Zoom * (E.GetWheelDelta() > 0 ? 1.3f : 0.769f), 1.0f, 4096.0f);

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
