#include "RunConsoleSection.h"

#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QScrollBar>
#include <QVBoxLayout>

RunConsoleSection::RunConsoleSection(QWidget* parent)
    : QWidget(parent)
{
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(10, 10, 10, 10);
    layout->setSpacing(8);

    auto* summary_grp = new QGroupBox("Pipeline Summary", this);
    auto* summary_layout = new QVBoxLayout(summary_grp);
    auto* summary_lbl = new QLabel(
        "1. Fetch DEM\n2. Download TMS tiles\n3. Fetch OSM data\n4. Export vectors\n5. Generate masks\n6. Write metadata/manifest",
        this);
    summary_lbl->setWordWrap(true);
    summary_layout->addWidget(summary_lbl);
    layout->addWidget(summary_grp);

    auto* export_grp = new QGroupBox("Export", this);
    auto* export_layout = new QVBoxLayout(export_grp);
    btn_export_ = new QPushButton("Export for Unigine (via QGIS GDAL)", this);
    btn_export_->setEnabled(false);
    export_layout->addWidget(btn_export_);
    btn_gather_ = new QPushButton("Gather All Chunks into One Folder", this);
    btn_gather_->setEnabled(false);
    export_layout->addWidget(btn_gather_);
    layout->addWidget(export_grp);

    auto* button_row = new QHBoxLayout();
    btn_generate_ = new QPushButton("Generate Terrain", this);
    button_row->addWidget(btn_generate_);
    btn_cancel_ = new QPushButton("Cancel", this);
    btn_cancel_->setEnabled(false);
    button_row->addWidget(btn_cancel_);
    layout->addLayout(button_row);

    progress_bar_ = new QProgressBar(this);
    progress_bar_->setRange(0, 100);
    layout->addWidget(progress_bar_);

    auto* log_label = new QLabel("Log:", this);
    layout->addWidget(log_label);
    log_text_ = new QTextEdit(this);
    log_text_->setReadOnly(true);
    log_text_->setPlainText("Ready. Select area on Map tab, configure sources, then click Generate.\n");
    layout->addWidget(log_text_, 1);

    connect(btn_generate_, &QPushButton::clicked, this, &RunConsoleSection::generateRequested);
    connect(btn_cancel_, &QPushButton::clicked, this, &RunConsoleSection::cancelRequested);
    connect(btn_export_, &QPushButton::clicked, this, &RunConsoleSection::exportRequested);
    connect(btn_gather_, &QPushButton::clicked, this, &RunConsoleSection::gatherRequested);
}

void RunConsoleSection::appendLog(const QString& message)
{
    log_text_->append(message);
    if (auto* bar = log_text_->verticalScrollBar())
        bar->setValue(bar->maximum());
}

void RunConsoleSection::clearLog()
{
    log_text_->clear();
}

void RunConsoleSection::setProgress(int value)
{
    progress_bar_->setValue(value);
}

void RunConsoleSection::setRunning(bool running)
{
    btn_generate_->setEnabled(!running);
    btn_cancel_->setEnabled(running);
}

void RunConsoleSection::setExportEnabled(bool enabled)
{
    btn_export_->setEnabled(enabled);
}

void RunConsoleSection::setGatherEnabled(bool enabled)
{
    btn_gather_->setEnabled(enabled);
}
