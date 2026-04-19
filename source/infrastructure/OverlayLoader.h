#pragma once

#include "ui/MapPanel.h"
#include "domain/Result.h"

#include <QString>

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
