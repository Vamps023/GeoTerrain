#include "UI/SGeoTerrainPanel.h"
#include "GeoLandscapeImporter.h"

#include "Misc/Paths.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SSpinBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Styling/AppStyle.h"

void SGeoTerrainPanel::Construct(const FArguments& InArgs)
{
    // DEM source options
    DemSourceOptions.Add(MakeShared<FString>(TEXT("SRTM 30m")));
    DemSourceOptions.Add(MakeShared<FString>(TEXT("SRTM 90m")));
    DemSourceOptions.Add(MakeShared<FString>(TEXT("AW3D 30m")));
    DemSourceOptions.Add(MakeShared<FString>(TEXT("Copernicus 30m")));
    DemSourceOptions.Add(MakeShared<FString>(TEXT("NASADEM")));
    DemSourceOptions.Add(MakeShared<FString>(TEXT("3DEP 10m")));
    SelectedDemSource = DemSourceOptions[0];

    Coordinator = MakeShared<FGeoGenerationCoordinator>();
    Coordinator->OnLogMessage.AddSP(this, &SGeoTerrainPanel::OnLog);
    Coordinator->OnProgress.AddSP(this, &SGeoTerrainPanel::OnProgress);
    Coordinator->OnFinished.AddSP(this, &SGeoTerrainPanel::OnFinished);

    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ BuildMapSection() ]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
        [ BuildWorldMapSection() ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ BuildSourceSection() ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ BuildOutputSection() ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ BuildChunkSection() ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [ BuildButtonRow() ]
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SAssignNew(ProgressBar, SProgressBar)
            .Percent_Lambda([this]() -> TOptional<float> { return Progress; })
        ]
        + SVerticalBox::Slot().FillHeight(1.0f).Padding(4)
        [ BuildConsoleSection() ]
    ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildMapSection()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(6)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center)
                [
                    SNew(STextBlock).Text(FText::FromString("Bounding Box (WGS84)"))
                        .Font(FAppStyle::GetFontStyle("BoldFont"))
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SNew(SButton)
                    .Text_Lambda([this]{ return FText::FromString(bMapVisible ? TEXT("Hide Map") : TEXT("Pick on Map")); })
                    .OnClicked(FOnClicked::CreateSP(this, &SGeoTerrainPanel::OnToggleMapClicked))
                ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 4)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("West")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(WestEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("South")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(SouthEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("East")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(EastEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("North")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(NorthEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
            ]
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildWorldMapSection()
{
    return SAssignNew(WorldMapBox, SBox)
        .Visibility(EVisibility::Collapsed)
        .HeightOverride(420.f)
        [
            SNew(SGeoWorldMap)
            .OnBoundsSelected(FOnMapBoundsSelected::CreateSP(this, &SGeoTerrainPanel::OnBoundsSelectedFromMap))
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildSourceSection()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(6)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(STextBlock).Text(FText::FromString("Data Sources")).Font(FAppStyle::GetFontStyle("BoldFont")) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0,2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(FText::FromString("DEM Source:")).MinDesiredWidth(160) ]
                + SHorizontalBox::Slot().FillWidth(1)
                [
                    SAssignNew(DemSourceCombo, SComboBox<TSharedPtr<FString>>)
                    .OptionsSource(&DemSourceOptions)
                    .OnSelectionChanged_Lambda([this](TSharedPtr<FString> New, ESelectInfo::Type){ SelectedDemSource = New; })
                    .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item){
                        return SNew(STextBlock).Text(FText::FromString(*Item));
                    })
                    [
                        SNew(STextBlock).Text_Lambda([this]{
                            return FText::FromString(SelectedDemSource.IsValid() ? **SelectedDemSource : TEXT(""));
                        })
                    ]
                ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0,2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(FText::FromString("OpenTopography API Key:")).MinDesiredWidth(160) ]
                + SHorizontalBox::Slot().FillWidth(1)
                [ SAssignNew(ApiKeyEdit, SEditableTextBox).HintText(FText::FromString("paste key here")) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0,2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(FText::FromString("Tile URL Template:")).MinDesiredWidth(160) ]
                + SHorizontalBox::Slot().FillWidth(1)
                [ SAssignNew(TileUrlEdit, SEditableTextBox)
                  .Text(FText::FromString("https://tile.openstreetmap.org/{z}/{x}/{y}.png")) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0,2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(FText::FromString("Zoom Level:")).MinDesiredWidth(160) ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SAssignNew(ZoomSpin, SSpinBox<int32>)
                    .MinValue(1).MaxValue(20).Value(14).Delta(1)
                ]
            ]
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildOutputSection()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(6)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [ SNew(STextBlock).Text(FText::FromString("Output")).Font(FAppStyle::GetFontStyle("BoldFont")) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0,2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [ SNew(STextBlock).Text(FText::FromString("Output Directory:")).MinDesiredWidth(120) ]
                + SHorizontalBox::Slot().FillWidth(1)
                [ SAssignNew(OutputDirEdit, SEditableTextBox)
                  .Text(FText::FromString(FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("GeoTerrainExport")))) ]
            ]
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildChunkSection()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(6)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
            [ SNew(STextBlock).Text(FText::FromString("Chunk Size (km, 0 = single):")).MinDesiredWidth(180) ]
            + SHorizontalBox::Slot().AutoWidth()
            [
                SAssignNew(ChunkSizeSpin, SSpinBox<float>)
                .MinValue(0.0f).MaxValue(100.0f).Value(0.0f).Delta(0.5f)
            ]
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildButtonRow()
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().Padding(4, 0)
        [
            SNew(SButton)
            .Text(FText::FromString("Export Terrain"))
            .IsEnabled_Lambda([this]{ return CanExport(); })
            .OnClicked(FOnClicked::CreateSP(this, &SGeoTerrainPanel::OnExportClicked))
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(4, 0)
        [
            SNew(SButton)
            .Text(FText::FromString("Cancel"))
            .IsEnabled_Lambda([this]{ return CanCancel(); })
            .OnClicked(FOnClicked::CreateSP(this, &SGeoTerrainPanel::OnCancelClicked))
        ]
        + SHorizontalBox::Slot().AutoWidth().Padding(4, 0)
        [
            SNew(SButton)
            .Text(FText::FromString("Import Landscape"))
            .IsEnabled_Lambda([this]{ return CanImport(); })
            .OnClicked(FOnClicked::CreateSP(this, &SGeoTerrainPanel::OnImportLandscapeClicked))
        ];
}

TSharedRef<SWidget> SGeoTerrainPanel::BuildConsoleSection()
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(4)
        [
            SAssignNew(ConsoleScroll, SScrollBox)
            + SScrollBox::Slot()
            [
                SAssignNew(ConsoleText, STextBlock)
                .AutoWrapText(true)
                .Text(FText::FromString("Ready."))
            ]
        ];
}

FReply SGeoTerrainPanel::OnExportClicked()
{
    FGeoGenerationRequest Req = BuildRequest();
    if (!Req.Bounds.IsValid())
    {
        OnLog(TEXT("[Error] Invalid bounds. East must be > West, North must be > South."), true);
        return FReply::Handled();
    }
    if (Req.Output.OutputDir.IsEmpty())
    {
        OnLog(TEXT("[Error] Output directory not set."), true);
        return FReply::Handled();
    }
    Coordinator->Run(Req);
    return FReply::Handled();
}

FReply SGeoTerrainPanel::OnCancelClicked()
{
    Coordinator->Cancel();
    return FReply::Handled();
}

FReply SGeoTerrainPanel::OnToggleMapClicked()
{
    bMapVisible = !bMapVisible;
    if (WorldMapBox.IsValid())
        WorldMapBox->SetVisibility(bMapVisible ? EVisibility::Visible : EVisibility::Collapsed);
    return FReply::Handled();
}

void SGeoTerrainPanel::OnBoundsSelectedFromMap(double W, double S, double E, double N)
{
    if (WestEdit.IsValid())  WestEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), W)));
    if (SouthEdit.IsValid()) SouthEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), S)));
    if (EastEdit.IsValid())  EastEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), E)));
    if (NorthEdit.IsValid()) NorthEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), N)));
    // Auto-hide map after selection
    bMapVisible = false;
    if (WorldMapBox.IsValid())
        WorldMapBox->SetVisibility(EVisibility::Collapsed);
    OnLog(FString::Printf(TEXT("[Map] Bounds set: W=%.5f S=%.5f E=%.5f N=%.5f"), W, S, E, N), false);
}

FReply SGeoTerrainPanel::OnImportLandscapeClicked()
{
    FGeoLandscapeImporter Importer;
    FGeoLandscapeImporter::FImportParams Params;
    Params.HeightmapR16Path = LastHeightmapR16;
    Params.AlbedoTifPath    = LastAlbedoTif;

    // Pass current bounds for geo-scale calculation
    Params.Bounds.West  = FCString::Atod(*WestEdit->GetText().ToString());
    Params.Bounds.South = FCString::Atod(*SouthEdit->GetText().ToString());
    Params.Bounds.East  = FCString::Atod(*EastEdit->GetText().ToString());
    Params.Bounds.North = FCString::Atod(*NorthEdit->GetText().ToString());

    auto Result = Importer.Import(Params);
    if (!Result.bSuccess)
        OnLog(FString::Printf(TEXT("[Import] FAILED: %s"), *Result.Message), true);
    else
        OnLog(TEXT("[Import] Landscape created successfully."), false);

    return FReply::Handled();
}

bool SGeoTerrainPanel::CanExport()  const
{
    if (Coordinator->IsRunning()) return false;
    double W = FCString::Atod(*WestEdit->GetText().ToString());
    double S = FCString::Atod(*SouthEdit->GetText().ToString());
    double E = FCString::Atod(*EastEdit->GetText().ToString());
    double N = FCString::Atod(*NorthEdit->GetText().ToString());
    return E > W && N > S;
}
bool SGeoTerrainPanel::CanCancel()  const { return  Coordinator->IsRunning(); }
bool SGeoTerrainPanel::CanImport()  const { return !LastHeightmapR16.IsEmpty() && !Coordinator->IsRunning(); }

void SGeoTerrainPanel::OnLog(const FString& Msg, bool /*bIsError*/)
{
    ConsoleBuffer += Msg + TEXT("\n");
    if (ConsoleText.IsValid())
        ConsoleText->SetText(FText::FromString(ConsoleBuffer));
    if (ConsoleScroll.IsValid())
        ConsoleScroll->ScrollToEnd();
}

void SGeoTerrainPanel::OnProgress(int32 Percent)
{
    Progress = Percent / 100.0f;
}

void SGeoTerrainPanel::OnFinished(EGeoJobStatus Status, const FString& Msg)
{
    Progress = (Status == EGeoJobStatus::Succeeded || Status == EGeoJobStatus::PartiallySucceeded)
               ? 1.0f : 0.0f;
    OnLog(Msg, Status == EGeoJobStatus::Failed);

    // Populate artifact paths so Import Landscape becomes available
    if (Status == EGeoJobStatus::Succeeded || Status == EGeoJobStatus::PartiallySucceeded)
    {
        LastHeightmapR16 = Coordinator->LastDemR16Path;
        LastAlbedoTif    = Coordinator->LastAlbedoPath;
    }
}

FGeoGenerationRequest SGeoTerrainPanel::BuildRequest()
{
    FGeoGenerationRequest Req;
    Req.Bounds.West  = FCString::Atod(*WestEdit->GetText().ToString());
    Req.Bounds.South = FCString::Atod(*SouthEdit->GetText().ToString());
    Req.Bounds.East  = FCString::Atod(*EastEdit->GetText().ToString());
    Req.Bounds.North = FCString::Atod(*NorthEdit->GetText().ToString());

    // DEM source
    static const TMap<FString, EGeoTerrainDemSource> kSourceMap = {
        { TEXT("SRTM 30m"),       EGeoTerrainDemSource::OpenTopography_SRTM30m },
        { TEXT("SRTM 90m"),       EGeoTerrainDemSource::OpenTopography_SRTM90m },
        { TEXT("AW3D 30m"),       EGeoTerrainDemSource::OpenTopography_AW3D30 },
        { TEXT("Copernicus 30m"), EGeoTerrainDemSource::OpenTopography_COP30 },
        { TEXT("NASADEM"),        EGeoTerrainDemSource::OpenTopography_NASADEM },
        { TEXT("3DEP 10m"),       EGeoTerrainDemSource::OpenTopography_3DEP10m },
    };
    if (SelectedDemSource.IsValid())
    {
        if (const EGeoTerrainDemSource* Found = kSourceMap.Find(**SelectedDemSource))
            Req.Sources.Dem.Source = *Found;
    }
    Req.Sources.Dem.ApiKey        = ApiKeyEdit->GetText().ToString();

    Req.Sources.Tiles.UrlTemplate = TileUrlEdit->GetText().ToString();
    Req.Sources.Tiles.ZoomLevel   = ZoomSpin->GetValue();

    Req.Output.OutputDir          = OutputDirEdit->GetText().ToString();
    Req.Output.bExportUnrealRaw   = true;

    Req.Chunking.ChunkSizeKm      = ChunkSizeSpin->GetValue();
    return Req;
}
