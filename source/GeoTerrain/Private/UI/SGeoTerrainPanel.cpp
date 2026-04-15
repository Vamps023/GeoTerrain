#include "UI/SGeoTerrainPanel.h"
#include "GeoLandscapeImporter.h"

#include "Misc/Paths.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SSpinBox.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSplitter.h"
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
    DemSourceOptions.Add(MakeShared<FString>(TEXT("Local GeoTIFF")));
    SelectedDemSource = DemSourceOptions[0];

    Coordinator = MakeShared<FGeoGenerationCoordinator>();
    Coordinator->OnLogMessage.AddSP(this, &SGeoTerrainPanel::OnLog);
    Coordinator->OnProgress.AddSP(this, &SGeoTerrainPanel::OnProgress);
    Coordinator->OnFinished.AddSP(this, &SGeoTerrainPanel::OnFinished);

    ChildSlot
    [
        SNew(SSplitter)
        .Orientation(Orient_Horizontal)
        .ResizeMode(ESplitterResizeMode::Fill)

        // ── LEFT: interactive world map ───────────────────────────────────────
        + SSplitter::Slot()
        .Value(0.55f)
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
            .Padding(0)
            [
                SNew(SGeoWorldMap)
                .OnBoundsSelected(FOnMapBoundsSelected::CreateSP(
                    this, &SGeoTerrainPanel::OnBoundsSelectedFromMap))
            ]
        ]

        // ── RIGHT: settings + progress + console ─────────────────────────────
        + SSplitter::Slot()
        .Value(0.45f)
        [
            SNew(SVerticalBox)

            // Bounding box coordinate readout
            + SVerticalBox::Slot().AutoHeight().Padding(4, 4, 4, 2)
            [ BuildMapSection() ]

            // Settings scroll area (source, output, chunk)
            + SVerticalBox::Slot().FillHeight(1.0f).Padding(4, 2)
            [
                SNew(SScrollBox)
                + SScrollBox::Slot()
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                    [ BuildSourceSection() ]
                    + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                    [ BuildOutputSection() ]
                    + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
                    [ BuildChunkSection() ]
                ]
            ]

            // Buttons
            + SVerticalBox::Slot().AutoHeight().Padding(4, 2)
            [ BuildButtonRow() ]

            // Progress bar
            + SVerticalBox::Slot().AutoHeight().Padding(4, 2)
            [
                SAssignNew(ProgressBar, SProgressBar)
                .Percent_Lambda([this]() -> TOptional<float> { return Progress; })
            ]

            // Console log
            + SVerticalBox::Slot().FillHeight(0.35f).Padding(4, 2, 4, 4)
            [ BuildConsoleSection() ]
        ]
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
                SNew(STextBlock)
                .Text(FText::FromString("Bounding Box (WGS84)"))
                .Font(FAppStyle::GetFontStyle("BoldFont"))
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 6, 0, 0)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("West")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(WestEdit,  SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("South")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(SouthEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("East")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(EastEdit,  SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
                + SHorizontalBox::Slot().FillWidth(1).Padding(2)
                [ SNew(SVerticalBox)
                  + SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString("North")) ]
                  + SVerticalBox::Slot().AutoHeight()[ SAssignNew(NorthEdit, SEditableTextBox).Text(FText::FromString("0.0")) ]
                ]
            ]
        ];
}


TSharedRef<SWidget> SGeoTerrainPanel::BuildSourceSection()
{
    // ── DEM sub-section ───────────────────────────────────────────────────────
    TSharedRef<SWidget> DemSection =
        SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.DarkGroupBorder"))
        .Padding(FMargin(8, 6))
        [
            SNew(SVerticalBox)

            // Header
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(STextBlock)
                .Text(FText::FromString("Elevation (DEM)"))
                .Font(FAppStyle::GetFontStyle("BoldFont"))
            ]

            // Source combo
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString("Source:"))
                    .MinDesiredWidth(140)
                ]
                + SHorizontalBox::Slot().FillWidth(1)
                [
                    SAssignNew(DemSourceCombo, SComboBox<TSharedPtr<FString>>)
                    .OptionsSource(&DemSourceOptions)
                    .OnSelectionChanged_Lambda([this](TSharedPtr<FString> New, ESelectInfo::Type)
                    {
                        OnDemSourceChanged(New);
                    })
                    .OnGenerateWidget_Lambda([](TSharedPtr<FString> Item)
                    {
                        return SNew(STextBlock)
                            .Text(FText::FromString(*Item))
                            .Margin(FMargin(4, 2));
                    })
                    [
                        SNew(STextBlock)
                        .Text_Lambda([this]
                        {
                            return FText::FromString(
                                SelectedDemSource.IsValid() ? **SelectedDemSource : TEXT(""));
                        })
                    ]
                ]
            ]

            // Info row (resolution / coverage)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SBox).MinDesiredWidth(140) ]
                + SHorizontalBox::Slot().FillWidth(1)
                [
                    SAssignNew(DemInfoLabel, STextBlock)
                    .Text_Lambda([this]{ return GetDemInfoText(); })
                    .ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.8f, 1.0f)))
                ]
            ]

            // API Key (hidden when LocalGeoTIFF selected)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SBox)
                .Visibility_Lambda([this]
                {
                    return GetLocalTiffVisibility() == EVisibility::Visible
                        ? EVisibility::Collapsed : EVisibility::Visible;
                })
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString("API Key:"))
                        .MinDesiredWidth(140)
                        .ToolTipText(FText::FromString(
                            "Free key from https://opentopography.org\n"
                            "My Account > API Access Tokens"))
                    ]
                    + SHorizontalBox::Slot().FillWidth(1)
                    [
                        SAssignNew(ApiKeyEdit, SEditableTextBox)
                        .HintText(FText::FromString("opentopography.org → My Account → API Key"))
                    ]
                ]
            ]

            // Local GeoTIFF path (only when LocalGeoTIFF selected)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SAssignNew(LocalTiffBox, SBox)
                .Visibility_Lambda([this]{ return GetLocalTiffVisibility(); })
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString("GeoTIFF Path:"))
                        .MinDesiredWidth(140)
                    ]
                    + SHorizontalBox::Slot().FillWidth(1)
                    [
                        SAssignNew(LocalTiffEdit, SEditableTextBox)
                        .HintText(FText::FromString("C:/path/to/dem.tif"))
                    ]
                ]
            ]

            // Resolution override
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString("Resolution (m):"))
                    .MinDesiredWidth(140)
                    .ToolTipText(FText::FromString(
                        "Output heightmap resolution in metres per pixel.\n"
                        "Lower = more detail, larger file."))
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SAssignNew(ResolutionSpin, SSpinBox<float>)
                    .MinValue(1.0f).MaxValue(1000.0f).Value(30.0f).Delta(1.0f)
                    .MinDesiredWidth(80)
                ]
            ]
        ];

    // ── Satellite tile sub-section ────────────────────────────────────────────
    TSharedRef<SWidget> TileSection =
        SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.DarkGroupBorder"))
        .Padding(FMargin(8, 6))
        [
            SNew(SVerticalBox)

            // Header
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(STextBlock)
                .Text(FText::FromString("Satellite Imagery (Albedo)"))
                .Font(FAppStyle::GetFontStyle("BoldFont"))
            ]

            // Tile URL
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString("Tile URL ({z}/{x}/{y}):"))
                    .MinDesiredWidth(160)
                    .ToolTipText(FText::FromString(
                        "XYZ/TMS tile URL template.\n"
                        "Examples:\n"
                        "  https://tile.openstreetmap.org/{z}/{x}/{y}.png\n"
                        "  https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}\n"
                        "  https://server.arcgisonline.com/ArcGIS/rest/services/\n"
                        "    World_Imagery/MapServer/tile/{z}/{y}/{x}"))
                ]
                + SHorizontalBox::Slot().FillWidth(1)
                [
                    SAssignNew(TileUrlEdit, SEditableTextBox)
                    .Text(FText::FromString(
                        "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"))
                ]
            ]

            // Zoom level
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                [
                    SNew(STextBlock)
                    .Text(FText::FromString("Zoom Level:"))
                    .MinDesiredWidth(160)
                    .ToolTipText(FText::FromString(
                        "Tile zoom level. Higher = more detail, many more tiles.\n"
                        "  12 = ~38m/px  |  14 = ~10m/px  |  17 = ~1.2m/px"))
                ]
                + SHorizontalBox::Slot().AutoWidth()
                [
                    SAssignNew(ZoomSpin, SSpinBox<int32>)
                    .MinValue(1).MaxValue(20).Value(14).Delta(1)
                    .MinDesiredWidth(60)
                ]
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8, 0, 0, 0)
                [
                    SNew(STextBlock)
                    .Text_Lambda([this]
                    {
                        static const TMap<int32,FString> kDesc = {
                            {10,TEXT("~152m/px")},{11,TEXT("~76m/px")},{12,TEXT("~38m/px")},
                            {13,TEXT("~19m/px")},{14,TEXT("~10m/px")},{15,TEXT("~5m/px")},
                            {16,TEXT("~2.4m/px")},{17,TEXT("~1.2m/px")},{18,TEXT("~0.6m/px")}
                        };
                        int32 Z = ZoomSpin.IsValid() ? ZoomSpin->GetValue() : 14;
                        const FString* D = kDesc.Find(Z);
                        return FText::FromString(D ? *D : TEXT(""));
                    })
                    .ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.8f, 1.0f)))
                ]
            ]
        ];

    return SNew(SBorder)
        .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
        .Padding(6)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(STextBlock)
                .Text(FText::FromString("Data Sources"))
                .Font(FAppStyle::GetFontStyle("BoldFont"))
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2)
            [ DemSection ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 4)
            [ TileSection ]
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


void SGeoTerrainPanel::OnBoundsSelectedFromMap(double W, double S, double E, double N)
{
    if (WestEdit.IsValid())  WestEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), W)));
    if (SouthEdit.IsValid()) SouthEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), S)));
    if (EastEdit.IsValid())  EastEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), E)));
    if (NorthEdit.IsValid()) NorthEdit->SetText(FText::FromString(FString::Printf(TEXT("%.6f"), N)));
    OnLog(FString::Printf(TEXT("[Map] Bounds: W=%.5f S=%.5f E=%.5f N=%.5f"), W, S, E, N), false);
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

void SGeoTerrainPanel::OnDemSourceChanged(TSharedPtr<FString> NewSource)
{
    SelectedDemSource = NewSource;
    // Update resolution hint to match dataset native resolution
    if (NewSource.IsValid() && ResolutionSpin.IsValid())
    {
        const FString& S = **NewSource;
        if (S.Equals(TEXT("SRTM 90m")))
            ResolutionSpin->SetValue(90.f);
        else if (S.Equals(TEXT("3DEP 10m")))
            ResolutionSpin->SetValue(10.f);
        else if (!S.Equals(TEXT("Local GeoTIFF")))
            ResolutionSpin->SetValue(30.f);
    }
}

FText SGeoTerrainPanel::GetDemInfoText() const
{
    static const TMap<FString, FString> kInfo = {
        { TEXT("SRTM 30m"),       TEXT("~30m res | Global | NASA SRTM GL1")              },
        { TEXT("SRTM 90m"),       TEXT("~90m res | Global | NASA SRTM GL3 (faster DL)") },
        { TEXT("AW3D 30m"),       TEXT("~30m res | Global | JAXA ALOS AW3D30")          },
        { TEXT("Copernicus 30m"), TEXT("~30m res | Global | ESA COP-DEM (best quality)")},
        { TEXT("NASADEM"),        TEXT("~30m res | Global | Reprocessed SRTM + ICESat") },
        { TEXT("3DEP 10m"),       TEXT("~10m res | USA only | USGS 3DEP")               },
        { TEXT("Local GeoTIFF"),  TEXT("Use a locally clipped GeoTIFF file")            },
    };
    if (!SelectedDemSource.IsValid()) return FText::GetEmpty();
    const FString* Info = kInfo.Find(**SelectedDemSource);
    return FText::FromString(Info ? *Info : TEXT(""));
}

EVisibility SGeoTerrainPanel::GetLocalTiffVisibility() const
{
    if (!SelectedDemSource.IsValid()) return EVisibility::Collapsed;
    const FString& Sel = **SelectedDemSource;
    return Sel.Equals(TEXT("Local GeoTIFF")) ? EVisibility::Visible : EVisibility::Collapsed;
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
        { TEXT("AW3D 30m"),       EGeoTerrainDemSource::OpenTopography_AW3D30  },
        { TEXT("Copernicus 30m"), EGeoTerrainDemSource::OpenTopography_COP30   },
        { TEXT("NASADEM"),        EGeoTerrainDemSource::OpenTopography_NASADEM  },
        { TEXT("3DEP 10m"),       EGeoTerrainDemSource::OpenTopography_3DEP10m },
        { TEXT("Local GeoTIFF"),  EGeoTerrainDemSource::LocalGeoTIFF           },
    };
    if (SelectedDemSource.IsValid())
    {
        if (const EGeoTerrainDemSource* Found = kSourceMap.Find(**SelectedDemSource))
            Req.Sources.Dem.Source = *Found;
    }
    Req.Sources.Dem.ApiKey        = ApiKeyEdit.IsValid() ? ApiKeyEdit->GetText().ToString() : TEXT("");
    Req.Sources.Dem.LocalTiffPath = LocalTiffEdit.IsValid() ? LocalTiffEdit->GetText().ToString() : TEXT("");
    Req.Sources.Dem.ResolutionM   = ResolutionSpin.IsValid() ? (double)ResolutionSpin->GetValue() : 30.0;

    Req.Sources.Tiles.UrlTemplate = TileUrlEdit->GetText().ToString();
    Req.Sources.Tiles.ZoomLevel   = ZoomSpin->GetValue();

    Req.Output.OutputDir          = OutputDirEdit->GetText().ToString();
    Req.Output.bExportUnrealRaw   = true;

    Req.Chunking.ChunkSizeKm      = ChunkSizeSpin->GetValue();
    return Req;
}
