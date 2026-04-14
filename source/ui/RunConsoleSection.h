#pragma once

#include <QProgressBar>
#include <QPushButton>
#include <QTextEdit>
#include <QWidget>

class RunConsoleSection : public QWidget
{
    Q_OBJECT

public:
    explicit RunConsoleSection(QWidget* parent = nullptr);

    void appendLog(const QString& message);
    void clearLog();
    void setProgress(int value);
    void setRunning(bool running);
    void setExportEnabled(bool enabled);
    void setGatherEnabled(bool enabled);
    void setSandwormEnabled(bool enabled);

signals:
    void generateRequested();
    void cancelRequested();
    void exportRequested();
    void gatherRequested();
    void sandwormRequested();

private:
    QPushButton* btn_generate_  = nullptr;
    QPushButton* btn_cancel_    = nullptr;
    QPushButton* btn_export_    = nullptr;
    QPushButton* btn_gather_    = nullptr;
    QPushButton* btn_sandworm_  = nullptr;
    QProgressBar* progress_bar_ = nullptr;
    QTextEdit* log_text_ = nullptr;
};
