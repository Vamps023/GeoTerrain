#pragma once

#include "../domain/GenerationTypes.h"

#include <QObject>
#include <memory>

class QThread;

class GenerationCoordinator : public QObject
{
    Q_OBJECT

public:
    explicit GenerationCoordinator(QObject* parent = nullptr);
    ~GenerationCoordinator() override;

    bool isRunning() const;
    void start(const GenerationRequest& request);
    void cancel();

signals:
    void logMessage(const QString& message);
    void progressChanged(int percent);
    void statusChanged(int status);
    void finished(int status, const QString& message);

private:
    QThread* thread_ = nullptr;
    QObject* worker_ = nullptr;
};
