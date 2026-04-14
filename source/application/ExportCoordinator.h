#pragma once

#include "../domain/Result.h"

#include <QString>
#include <functional>

class ExportCoordinator
{
public:
    Result<int> exportForUnigine(const QString& base_output_dir, const QString& qgis_root,
                                 std::function<void(const QString&)> log) const;
    Result<int> gatherChunks(const QString& base_output_dir,
                             std::function<void(const QString&)> log) const;
};
