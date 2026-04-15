#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

DECLARE_DELEGATE_FourParams(FOnBoundsSelected, double /*West*/, double /*South*/, double /*East*/, double /*North*/);

// Embedded Leaflet map — user draws a rectangle, delegate fires with WGS84 bounds
class SGeoMapPicker : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoMapPicker) {}
        SLATE_EVENT(FOnBoundsSelected, OnBoundsSelected)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    void OnUrlChanged(const FText& NewUrl);

    FOnBoundsSelected OnBoundsSelected;
    TSharedPtr<class SWebBrowser> Browser;

    // Called from JS via UE URL scheme: geotb://bounds?w=...&s=...&e=...&n=...
    bool HandleBrowserUrlChanged(const FText& Url);
};
