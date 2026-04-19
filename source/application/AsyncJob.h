#pragma once

#include <QObject>
#include <QString>

#include <functional>

class QThread;

// ---------------------------------------------------------------------------
// Generic background-job runner.
//
// Wraps any synchronous "log-and-return" operation into a QThread worker that
// emits progress on the UI thread via Qt::AutoConnection. The callable runs
// on a dedicated worker thread; the provided logger forwards each line
// through the logMessage() signal, so callers can safely wire it directly
// to a QWidget slot (cross-thread delivery is queued).
//
// Only one job may run at a time per AsyncJob instance. Re-entrant start()
// calls while a job is in flight are ignored.
class AsyncJob : public QObject
{
    Q_OBJECT

public:
    using LogFn = std::function<void(const QString&)>;

    struct Outcome
    {
        bool success = false;
        int count = 0;
        QString message;
    };

    using Work = std::function<Outcome(LogFn)>;

    explicit AsyncJob(QObject* parent = nullptr);
    ~AsyncJob() override;

    bool isRunning() const;
    void start(Work work);

signals:
    void logMessage(const QString& message);
    void finished(bool success, int count, const QString& message);

private:
    QThread* thread_ = nullptr;
    QObject* worker_ = nullptr;
};
