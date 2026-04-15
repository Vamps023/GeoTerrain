#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SSpinBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "GeoGenerationTypes.h"
#include "GeoGenerationCoordinator.h"

// Main Slate panel — replaces GeoTerrainPanel + all ui/ Qt widgets
class SGeoTerrainPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SGeoTerrainPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    // ── UI helpers ────────────────────────────────────────────────────────────
    TSharedRef<SWidget> BuildMapSection();
    TSharedRef<SWidget> BuildSourceSection();
    TSharedRef<SWidget> BuildOutputSection();
    TSharedRef<SWidget> BuildChunkSection();
    TSharedRef<SWidget> BuildConsoleSection();
    TSharedRef<SWidget> BuildButtonRow();

    // ── Button handlers ───────────────────────────────────────────────────────
    FReply OnExportClicked();
    FReply OnCancelClicked();
    FReply OnImportLandscapeClicked();

    bool CanExport()  const;
    bool CanCancel()  const;
    bool CanImport()  const;

    // ── Coordinator callbacks (fired on game thread) ──────────────────────────
    void OnLog     (const FString& Msg, bool bIsError);
    void OnProgress(int32 Percent);
    void OnFinished(EGeoJobStatus Status, const FString& Msg);

    // ── Build request from UI state ───────────────────────────────────────────
    FGeoGenerationRequest BuildRequest();

    // ── State ─────────────────────────────────────────────────────────────────
    TSharedPtr<FGeoGenerationCoordinator> Coordinator;

    // Editable fields
    TSharedPtr<SEditableTextBox> WestEdit, SouthEdit, EastEdit, NorthEdit;
    TSharedPtr<SEditableTextBox> OutputDirEdit;
    TSharedPtr<SEditableTextBox> ApiKeyEdit;
    TSharedPtr<SEditableTextBox> TileUrlEdit;
    TSharedPtr<SSpinBox<int32>>  ZoomSpin;
    TSharedPtr<SSpinBox<float>>  ChunkSizeSpin;
    TSharedPtr<STextBlock>       ConsoleText;
    TSharedPtr<SScrollBox>       ConsoleScroll;
    TSharedPtr<SProgressBar>     ProgressBar;

    FString   LastHeightmapR16;
    FString   LastAlbedoTif;
    float     Progress = 0.0f;
    FString   ConsoleBuffer;
};
