#include "AsyncJob.h"

#include <QThread>

#include <utility>

namespace
{
class JobWorker : public QObject
{
    Q_OBJECT

public:
    explicit JobWorker(AsyncJob::Work work)
        : work_(std::move(work))
    {
    }

public slots:
    void run()
    {
        AsyncJob::LogFn log = [this](const QString& msg) { emit logMessage(msg); };
        AsyncJob::Outcome outcome;
        try
        {
            outcome = work_(log);
        }
        catch (const std::exception& e)
        {
            outcome.success = false;
            outcome.message = QString("Unhandled exception: %1").arg(e.what());
        }
        catch (...)
        {
            outcome.success = false;
            outcome.message = "Unhandled non-standard exception.";
        }
        emit finished(outcome.success, outcome.count, outcome.message);
    }

signals:
    void logMessage(const QString& message);
    void finished(bool success, int count, const QString& message);

private:
    AsyncJob::Work work_;
};
}

AsyncJob::AsyncJob(QObject* parent)
    : QObject(parent)
{
}

AsyncJob::~AsyncJob()
{
    if (thread_)
    {
        thread_->quit();
        // Bound wait so editor shutdown never hangs; worker stages are
        // cooperative and should complete quickly in practice.
        thread_->wait(5000);
    }
}

bool AsyncJob::isRunning() const
{
    return thread_ && thread_->isRunning();
}

void AsyncJob::start(Work work)
{
    if (isRunning())
        return;

    thread_ = new QThread(this);
    auto* job_worker = new JobWorker(std::move(work));
    worker_ = job_worker;
    job_worker->moveToThread(thread_);

    connect(thread_, &QThread::started, job_worker, &JobWorker::run);
    connect(job_worker, &JobWorker::logMessage, this, &AsyncJob::logMessage);
    connect(job_worker, &JobWorker::finished, this,
        [this](bool success, int count, const QString& message)
        {
            if (thread_)
                thread_->quit();
            emit finished(success, count, message);
            worker_ = nullptr;
            thread_ = nullptr;
        });
    connect(thread_, &QThread::finished, job_worker, &QObject::deleteLater);
    connect(thread_, &QThread::finished, thread_, &QObject::deleteLater);

    thread_->start();
}

#include "AsyncJob.moc"
