#include "ExportCoordinator.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>

Result<int> ExportCoordinator::exportForUnigine(const QString& base_output_dir, const QString& qgis_root,
                                                std::function<void(const QString&)> log) const
{
    if (base_output_dir.isEmpty())
        return Result<int>::fail(1, "Output directory not set.");

    if (qgis_root.isEmpty())
        return Result<int>::fail(1, "QGIS root path not set.");

    if (!QDir(qgis_root).exists())
        return Result<int>::fail(1, "QGIS root directory does not exist: " + qgis_root.toStdString());

    const QString gdal_translate = qgis_root + "/bin/gdal_translate.exe";
    const QString ogr2ogr = qgis_root + "/bin/ogr2ogr.exe";
    if (!QFileInfo::exists(gdal_translate))
        return Result<int>::fail(1, "gdal_translate.exe not found at: " + gdal_translate.toStdString() +
                                   "\nPlease verify QGIS/OSGeo4W installation.");

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("GDAL_DATA", qgis_root + "/share/gdal");
    env.insert("PROJ_DATA", qgis_root + "/share/proj");
    env.insert("PATH", qgis_root + "/bin;" + env.value("PATH"));

    auto runProc = [&](const QString& prog, const QStringList& args, const QString& label) -> bool
    {
        QProcess proc;
        proc.setProgram(prog);
        proc.setArguments(args);
        proc.setProcessEnvironment(env);
        proc.setWorkingDirectory(base_output_dir);

        if (!proc.start())
        {
            log("[FAIL] " + label + ": Failed to start process");
            return false;
        }

        if (!proc.waitForFinished(180000)) // 3 minute timeout per file
        {
            proc.kill();
            proc.waitForFinished(5000);
            log("[FAIL] " + label + ": Process timed out (3 minutes)");
            return false;
        }

        if (proc.exitCode() == 0)
        {
            log("[OK] " + label);
            return true;
        }

        QString err = QString::fromUtf8(proc.readAllStandardError()).trimmed();
        QString out = QString::fromUtf8(proc.readAllStandardOutput()).trimmed();
        if (err.isEmpty()) err = out;
        if (err.isEmpty()) err = "Exit code: " + QString::number(proc.exitCode());
        log("[FAIL] " + label + ": " + err);
        return false;
    };

    auto exportDir = [&](const QString& src_dir, const QString& dst_dir) -> int
    {
        QDir().mkpath(dst_dir);
        int count = 0;
        const QStringList tifs = { "heightmap.tif", "albedo.tif", "mask.tif", "vegetation_mask.tif", "mask_preview.tif" };
        for (const QString& file : tifs)
        {
            const QString src = src_dir + "/" + file;
            if (!QFileInfo::exists(src))
                continue;
            const QString dst = dst_dir + "/" + file;
            QStringList args;
            args << "-of" << "GTiff" << "-a_srs" << "EPSG:4326"
                 << "-co" << "COMPRESS=LZW" << "-co" << "TILED=YES"
                 << src << dst;
            if (runProc(gdal_translate, args, file))
                ++count;
        }

        if (QFileInfo::exists(ogr2ogr))
        {
            const QStringList shps = { "roads", "railways", "buildings", "vegetation", "water" };
            for (const QString& layer : shps)
            {
                const QString src = src_dir + "/" + layer + ".shp";
                if (!QFileInfo::exists(src))
                    continue;
                const QString dst = dst_dir + "/" + layer + ".shp";
                QStringList args;
                args << "-f" << "ESRI Shapefile" << "-a_srs" << "EPSG:4326"
                     << "-lco" << "ENCODING=UTF-8" << "-overwrite" << dst << src;
                if (runProc(ogr2ogr, args, layer + ".shp"))
                    ++count;
            }
        }
        return count;
    };

    if (!QDir(base_output_dir).exists())
        return Result<int>::fail(1, "Output directory does not exist: " + base_output_dir.toStdString());

    QStringList src_dirs;
    src_dirs << base_output_dir;
    QDir base_dir(base_output_dir);
    const QStringList chunk_dirs = base_dir.entryList(QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString& chunk : chunk_dirs)
        src_dirs << base_output_dir + "/" + chunk;

    int total = 0;
    int dirs_processed = 0;
    for (const QString& src_dir : src_dirs)
    {
        if (!QDir(src_dir).exists())
        {
            log("[WARN] Source directory not found: " + src_dir);
            continue;
        }
        log("[Export] Processing: " + src_dir);
        total += exportDir(src_dir, src_dir + "/UnigineExport");
        ++dirs_processed;
    }

    if (dirs_processed == 0)
        return Result<int>::fail(1, "No source directories found to export.");

    log(QString("[Export] Complete: %1 directories processed, %2 files written").arg(dirs_processed).arg(total));
    return Result<int>::ok(total);
}

Result<int> ExportCoordinator::gatherChunks(const QString& base_output_dir,
                                            std::function<void(const QString&)> log) const
{
    if (base_output_dir.isEmpty())
        return Result<int>::fail(1, "Output directory not set.");

    if (!QDir(base_output_dir).exists())
        return Result<int>::fail(1, "Output directory does not exist: " + base_output_dir.toStdString());

    const QString gather_dir = base_output_dir + "/GatheredExport";
    if (!QDir().mkpath(gather_dir))
        return Result<int>::fail(1, "Failed to create GatheredExport directory: " + gather_dir.toStdString());

    QDir base_dir(base_output_dir);
    const QStringList chunk_names = base_dir.entryList(QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    if (chunk_names.isEmpty())
        return Result<int>::fail(1, "No chunk directories found. Generate terrain first with chunk splitting enabled.");

    int total = 0;
    int chunks_with_files = 0;
    for (const QString& chunk : chunk_names)
    {
        const QString src_export = base_output_dir + "/" + chunk + "/UnigineExport";
        if (!QDir(src_export).exists())
        {
            log("[" + chunk + "] SKIP: No UnigineExport folder found (run Export first)");
            continue;
        }
        const QStringList files = QDir(src_export).entryList(QDir::Files, QDir::Name);
        if (files.isEmpty())
        {
            log("[" + chunk + "] SKIP: No files in UnigineExport folder");
            continue;
        }
        int chunk_count = 0;
        for (const QString& file : files)
        {
            const QString src = src_export + "/" + file;
            const QString dst = gather_dir + "/" + chunk + "_" + file;
            QFile::remove(dst);
            if (QFile::copy(src, dst))
            {
                ++total;
                ++chunk_count;
            }
            else
            {
                log("[" + chunk + "] FAIL: Could not copy " + file);
            }
        }
        log("[" + chunk + "] gathered " + QString::number(chunk_count) + " file(s)");
        if (chunk_count > 0)
            ++chunks_with_files;
    }

    if (chunks_with_files == 0)
        return Result<int>::fail(1, "No files gathered. Run Export for UNIGINE first, then try gathering again.");

    log(QString("[Gather] Complete: %1 chunks, %2 files gathered to %3").arg(chunks_with_files).arg(total).arg(gather_dir));
    return Result<int>::ok(total);
}
