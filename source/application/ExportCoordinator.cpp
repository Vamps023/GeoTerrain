#include "ExportCoordinator.h"

#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>

namespace
{
    // Process timeouts (milliseconds)
    constexpr int kStartTimeoutMs    = 10'000;     // 10 s to launch child process
    constexpr int kRunTimeoutMs      = 180'000;    // 3 min per file
    constexpr int kKillWaitMs        = 5'000;      // 5 s for forced kill to complete
    constexpr int kEventPumpSliceMs  = 50;         // UI responsiveness granularity

    // Raster assets exported per source directory (in order)
    const QStringList kRasterAssets = {
        "heightmap.tif",
        "albedo.tif",
        "mask.tif",
        "vegetation_mask.tif",
        "mask_preview.tif"
    };

    // Vector layers exported per source directory
    const QStringList kVectorLayers = {
        "roads", "railways", "buildings", "vegetation", "water"
    };

    // Wait for a QProcess to finish while keeping the Qt event loop alive so
    // the editor UI (log text, progress, cancel buttons) stays responsive.
    // Returns true if the process finished within timeout_ms, false on timeout.
    bool waitForFinishedPumping(QProcess& proc, int timeout_ms)
    {
        QElapsedTimer timer;
        timer.start();
        while (proc.state() != QProcess::NotRunning)
        {
            if (proc.waitForFinished(kEventPumpSliceMs))
                return true;
            QCoreApplication::processEvents(QEventLoop::ExcludeUserInputEvents);
            if (timer.hasExpired(timeout_ms))
                return false;
        }
        return true;
    }
}

Result<int> ExportCoordinator::exportForUnigine(const QString& base_output_dir, const QString& qgis_root,
                                                std::function<void(const QString&)> log) const
{
    if (base_output_dir.isEmpty())
        return Result<int>::fail(1, "Output directory not set.");

    // Auto-resolve a GDAL/OSGeo4W root when the caller didn't supply one.
    // The "QGIS root" field was removed from the UI; we now probe common
    // install paths (the plugin already ships OSGeo4W runtime DLLs) so
    // export works out of the box.
    QString resolved_root = qgis_root;
    if (resolved_root.isEmpty())
    {
        const QStringList candidates = {
            qEnvironmentVariable("OSGEO4W_ROOT"),
            QDir::homePath() + "/AppData/Local/Programs/OSGeo4W",
            "C:/OSGeo4W",
            "C:/OSGeo4W64",
            "C:/Program Files/QGIS 3.34/bin",
            "C:/Program Files/QGIS 3.28/bin",
        };
        for (const QString& c : candidates)
        {
            if (c.isEmpty()) continue;
            // Each candidate should contain bin/gdal_translate.exe, so peel
            // off a trailing "/bin" before testing when the candidate points
            // straight at the binaries (QGIS app layout).
            QString root = c.endsWith("/bin") ? c.left(c.size() - 4) : c;
            if (QFileInfo::exists(root + "/bin/gdal_translate.exe"))
            {
                resolved_root = root;
                break;
            }
        }
    }

    if (resolved_root.isEmpty() || !QDir(resolved_root).exists())
        return Result<int>::fail(1, "No GDAL/OSGeo4W installation found. Install OSGeo4W "
                                    "or set the OSGEO4W_ROOT environment variable.");

    const QString gdal_translate = resolved_root + "/bin/gdal_translate.exe";
    const QString ogr2ogr = resolved_root + "/bin/ogr2ogr.exe";
    if (!QFileInfo::exists(gdal_translate))
        return Result<int>::fail(1, "gdal_translate.exe not found at: " + gdal_translate.toStdString() +
                                   "\nPlease verify QGIS/OSGeo4W installation.");

    log("[Export] Using GDAL root: " + resolved_root);

    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert("GDAL_DATA", resolved_root + "/share/gdal");
    env.insert("PROJ_DATA", resolved_root + "/share/proj");
    env.insert("PATH", resolved_root + "/bin;" + env.value("PATH"));

    auto runProc = [&](const QString& prog, const QStringList& args, const QString& label) -> bool
    {
        QProcess proc;
        proc.setProgram(prog);
        proc.setArguments(args);
        proc.setProcessEnvironment(env);
        proc.setWorkingDirectory(base_output_dir);

        proc.start();
        if (!proc.waitForStarted(kStartTimeoutMs))
        {
            log("[FAIL] " + label + ": Failed to start process: " + proc.errorString());
            return false;
        }

        if (!waitForFinishedPumping(proc, kRunTimeoutMs))
        {
            proc.kill();
            proc.waitForFinished(kKillWaitMs);
            log("[FAIL] " + label + ": Process timed out (" +
                QString::number(kRunTimeoutMs / 1000) + "s)");
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
        for (const QString& file : kRasterAssets)
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
            for (const QString& layer : kVectorLayers)
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

    const QString gather_dir      = base_output_dir + "/GatheredExport";
    const QString heightmap_dir   = gather_dir + "/heightmap";
    const QString albedo_dir      = gather_dir + "/albedo";

    for (const QString& dir : { gather_dir, heightmap_dir, albedo_dir })
    {
        if (!QDir().mkpath(dir))
            return Result<int>::fail(1, "Failed to create directory: " + dir.toStdString());
    }

    // Files routed into heightmap/ subfolder.
    const QStringList kHeightmapFiles = { "heightmap.tif" };
    // Files routed into albedo/ subfolder.
    const QStringList kAlbedoFiles    = { "albedo.tif" };

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

            // Route into the correct subfolder based on file name.
            QString dst_dir;
            if (kHeightmapFiles.contains(file, Qt::CaseInsensitive))
                dst_dir = heightmap_dir;
            else if (kAlbedoFiles.contains(file, Qt::CaseInsensitive))
                dst_dir = albedo_dir;
            else
                dst_dir = gather_dir;

            const QString dst = dst_dir + "/" + chunk + "_" + file;
            QFile::remove(dst);
            if (QFile::copy(src, dst))
            {
                ++total;
                ++chunk_count;
                log("[" + chunk + "] -> " + QDir(base_output_dir).relativeFilePath(dst));
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

    log(QString("[Gather] Complete: %1 chunks, %2 files — heightmap/ and albedo/ under %3")
            .arg(chunks_with_files).arg(total).arg(gather_dir));
    return Result<int>::ok(total);
}
