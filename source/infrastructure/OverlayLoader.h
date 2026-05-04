#pragma once

#include "domain/GeoBounds.h"
#include "domain/Result.h"

#include <QColor>
#include <QPointF>
#include <QString>
#include <QVector>

struct OverlayRing
{
    QVector<QPointF> points;
    bool closed = false;
};

struct OverlayLayer
{
    QString name;
    QColor color = QColor(255, 165, 0);
    QVector<OverlayRing> rings;
};

struct OverlayLoadResult
{
    OverlayLayer overlay;
    int feature_count = 0;
    GeoBounds extent;
};

class OverlayLoader
{
public:
    Result<QStringList> listLayers(const QString& path) const;
    Result<OverlayLoadResult> loadLayer(const QString& path, int layer_index, const QString& layer_name) const;
};
