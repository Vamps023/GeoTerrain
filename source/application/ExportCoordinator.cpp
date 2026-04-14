#include "ExportCoordinator.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QProcessEnvironment>

Result<int> ExportCoordinator::exportForUnigine(const QString& base_output_dir, const QString& qgis_root,
                                                std::function<void(const QString&)> log) const
{
    const QString gdal_translate = qgis_root + "/bin/gdal_translate.exe";
    const QString ogr2ogr = qgis_root + "/bin/ogr2ogr.exe";
    if (!QFileInfo::exists(gdal_translate))
        return Result<int>::fail(1, "gdal_translate.exe not found.");

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
        proc.start();
        proc.waitForFinished(120000);
        if (proc.exitCode() == 0)
        {
            log("[OK] " + label);
            return true;
        }
        log("[FAIL] " + label + ": " + QString::fromUtf8(proc.readAllStandardError()).trimmed());
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

    QStringList src_dirs;
    src_dirs << base_output_dir;
    QDir base_dir(base_output_dir);
    const QStringList chunk_dirs = base_dir.entryList(QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString& chunk : chunk_dirs)
        src_dirs << base_output_dir + "/" + chunk;

    int total = 0;
    for (const QString& src_dir : src_dirs)
    {
        total += exportDir(src_dir, src_dir + "/UnigineExport");
    }
    return Result<int>::ok(total);
}

Result<int> ExportCoordinator::gatherChunks(const QString& base_output_dir,
                                            std::function<void(const QString&)> log) const
{
    const QString gather_dir = base_output_dir + "/GatheredExport";
    QDir().mkpath(gather_dir);

    QDir base_dir(base_output_dir);
    const QStringList chunk_names = base_dir.entryList(QStringList() << "chunk_*", QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    if (chunk_names.isEmpty())
        return Result<int>::fail(1, "No chunk directories found.");

    int total = 0;
    for (const QString& chunk : chunk_names)
    {
        const QString src_export = base_output_dir + "/" + chunk + "/UnigineExport";
        if (!QDir(src_export).exists())
            continue;
        const QStringList files = QDir(src_export).entryList(QDir::Files, QDir::Name);
        for (const QString& file : files)
        {
            const QString dst = gather_dir + "/" + chunk + "_" + file;
            QFile::remove(dst);
            if (QFile::copy(src_export + "/" + file, dst))
                ++total;
        }
        log("[" + chunk + "] gathered " + QString::number(files.size()) + " file(s)");
    }
    return Result<int>::ok(total);
}
