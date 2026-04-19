#include "pipeline/MaskGenerator.h"
#include "infrastructure/GdalUtils.h"

#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <cpl_string.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace
{
void report(RunContext& context, const std::string& message, int percent)
{
    if (context.progress)
        context.progress(message, percent);
}

Result<MaskArtifact> cancelledMask()
{
    return Result<MaskArtifact>::fail(999, "Cancelled.");
}
}

void MaskGenerator::latLonToPixel(double lat, double lon, const GeoBounds& bounds,
                                  int width, int height, int& px, int& py)
{
    px = static_cast<int>((lon - bounds.west) / bounds.width() * width);
    py = static_cast<int>((bounds.north - lat) / bounds.height() * height);
    px = std::max(0, std::min(px, width - 1));
    py = std::max(0, std::min(py, height - 1));
}

void MaskGenerator::rasterizePolygon(std::vector<uint8_t>& buf, int width, int height,
                                     const GeoBounds& bounds,
                                     const std::vector<std::pair<double, double>>& ring,
                                     uint8_t value)
{
    if (ring.size() < 3)
        return;

    std::vector<std::pair<int, int>> pts;
    pts.reserve(ring.size());
    for (const auto& node : ring)
    {
        int px = 0;
        int py = 0;
        latLonToPixel(node.first, node.second, bounds, width, height, px, py);
        pts.emplace_back(px, py);
    }

    int y_min = height;
    int y_max = 0;
    for (const auto& pt : pts)
    {
        y_min = std::min(y_min, pt.second);
        y_max = std::max(y_max, pt.second);
    }
    y_min = std::max(y_min, 0);
    y_max = std::min(y_max, height - 1);

    const int n = static_cast<int>(pts.size());
    for (int scanline = y_min; scanline <= y_max; ++scanline)
    {
        std::vector<int> intersects;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            const int yi = pts[i].second;
            const int yj = pts[j].second;
            const int xi = pts[i].first;
            const int xj = pts[j].first;
            if ((yi <= scanline && yj > scanline) || (yj <= scanline && yi > scanline))
            {
                const int x = xi + (scanline - yi) * (xj - xi) / (yj - yi);
                intersects.push_back(x);
            }
        }
        std::sort(intersects.begin(), intersects.end());
        for (int k = 0; k + 1 < static_cast<int>(intersects.size()); k += 2)
        {
            const int x0 = std::max(0, intersects[k]);
            const int x1 = std::min(width - 1, intersects[k + 1]);
            for (int x = x0; x <= x1; ++x)
                buf[scanline * width + x] = value;
        }
    }
}

void MaskGenerator::rasterizeLine(std::vector<uint8_t>& buf, int width, int height,
                                  const GeoBounds& bounds,
                                  const std::vector<std::pair<double, double>>& pts,
                                  int radius_px, uint8_t value)
{
    if (pts.size() < 2)
        return;

    auto plot_circle = [&](int cx, int cy)
    {
        for (int dy = -radius_px; dy <= radius_px; ++dy)
        {
            for (int dx = -radius_px; dx <= radius_px; ++dx)
            {
                if (dx * dx + dy * dy <= radius_px * radius_px)
                {
                    const int x = cx + dx;
                    const int y = cy + dy;
                    if (x >= 0 && x < width && y >= 0 && y < height)
                        buf[y * width + x] = value;
                }
            }
        }
    };

    for (size_t i = 0; i + 1 < pts.size(); ++i)
    {
        int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
        latLonToPixel(pts[i].first, pts[i].second, bounds, width, height, x0, y0);
        latLonToPixel(pts[i + 1].first, pts[i + 1].second, bounds, width, height, x1, y1);

        const int dx = std::abs(x1 - x0);
        const int dy = std::abs(y1 - y0);
        const int steps = std::max(dx, dy);
        for (int s = 0; s <= steps; ++s)
        {
            const int sx = (steps > 0) ? x0 + s * (x1 - x0) / steps : x0;
            const int sy = (steps > 0) ? y0 + s * (y1 - y0) / steps : y0;
            plot_circle(sx, sy);
        }
    }
}

Result<MaskArtifact> MaskGenerator::generate(const GeoBounds& bounds, const OSMParser::ParseResult& osm,
                                             const Config& config, RunContext& context)
{
    if (context.isCancelled())
        return cancelledMask();
    if (!bounds.isValid())
        return Result<MaskArtifact>::fail(1, "Invalid bounds for mask generation.");

    int out_w = 0;
    int out_h = 0;
    GeoBounds ref_bounds = bounds;

    if (!config.ref_tif_path.empty())
    {
        GDALAllRegister();
        GDALDataset* ref_ds = static_cast<GDALDataset*>(GDALOpen(config.ref_tif_path.c_str(), GA_ReadOnly));
        if (ref_ds)
        {
            double gt[6];
            if (ref_ds->GetGeoTransform(gt) == CE_None)
            {
                out_w = ref_ds->GetRasterXSize();
                out_h = ref_ds->GetRasterYSize();
                ref_bounds.west = gt[0];
                ref_bounds.north = gt[3];
                ref_bounds.east = gt[0] + gt[1] * out_w;
                ref_bounds.south = gt[3] + gt[5] * out_h;
            }
            GDALClose(ref_ds);
        }
    }

    if (out_w <= 0 || out_h <= 0)
    {
        constexpr double DEG_PER_M = 1.0 / 111320.0;
        const double pixel_deg = config.resolution_m * DEG_PER_M;
        out_w = std::max(1, static_cast<int>(std::ceil(bounds.width() / pixel_deg)));
        out_h = std::max(1, static_cast<int>(std::ceil(bounds.height() / pixel_deg)));
    }

    const size_t sz = static_cast<size_t>(out_w) * out_h;
    std::vector<uint8_t> band_road(sz, 0);
    std::vector<uint8_t> band_bldg(sz, 0);
    std::vector<uint8_t> band_veg(sz, 0);
    std::vector<uint8_t> band_rail(sz, 0);
    std::vector<uint8_t> band_water(sz, 0);
    std::vector<std::vector<uint8_t>> veg_cat(6, std::vector<uint8_t>(sz, 0));

    const double px_deg_x = ref_bounds.width() / out_w;
    const double px_deg_y = ref_bounds.height() / out_h;
    const double px_deg = std::min(px_deg_x, px_deg_y);
    constexpr double DEG_PER_M = 1.0 / 111320.0;
    const int road_radius_px = std::max(1, static_cast<int>(config.road_width_m * DEG_PER_M / px_deg * 0.5));

    const int total_ways = static_cast<int>(osm.ways.size());
    for (int i = 0; i < total_ways; ++i)
    {
        if (context.isCancelled())
            return cancelledMask();

        const auto& way = osm.ways[i];
        if (i % 200 == 0)
        {
            const int pct = 10 + (i * 75) / std::max(1, total_ways);
            report(context, "Rasterizing way " + std::to_string(i) + "/" + std::to_string(total_ways), pct);
        }

        switch (way.tag)
        {
        case OSMParser::Way::Tag::Road:
            rasterizeLine(band_road, out_w, out_h, ref_bounds, way.nodes, road_radius_px, 255);
            break;
        case OSMParser::Way::Tag::Railway:
            rasterizeLine(band_rail, out_w, out_h, ref_bounds, way.nodes, 2, 255);
            break;
        case OSMParser::Way::Tag::Building:
            rasterizePolygon(band_bldg, out_w, out_h, ref_bounds, way.nodes, 255);
            break;
        case OSMParser::Way::Tag::Vegetation:
            rasterizePolygon(band_veg, out_w, out_h, ref_bounds, way.nodes, 255);
            {
                int category = 5;
                if (way.subtype == "forest" || way.subtype == "wood") category = 0;
                else if (way.subtype == "park" || way.subtype == "garden" || way.subtype == "nature_reserve") category = 1;
                else if (way.subtype == "grass" || way.subtype == "meadow" || way.subtype == "village_green") category = 2;
                else if (way.subtype == "farmland" || way.subtype == "farmyard" || way.subtype == "orchard") category = 3;
                else if (way.subtype == "scrub" || way.subtype == "heath" || way.subtype == "wetland") category = 4;
                rasterizePolygon(veg_cat[category], out_w, out_h, ref_bounds, way.nodes, 255);
            }
            break;
        case OSMParser::Way::Tag::Water:
            rasterizePolygon(band_water, out_w, out_h, ref_bounds, way.nodes, 255);
            break;
        default:
            break;
        }
    }

    GDALAllRegister();
    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver)
        return Result<MaskArtifact>::fail(2, "GTiff driver not available.");

    char** opts = nullptr;
    opts = CSLSetNameValue(opts, "COMPRESS", "LZW");
    GDALDataset* ds = driver->Create(config.output_path.c_str(), out_w, out_h, 5, GDT_Byte, opts);
    CSLDestroy(opts);
    if (!ds)
        return Result<MaskArtifact>::fail(3, "Cannot create mask GeoTIFF.");

    double gt[6] = { ref_bounds.west, px_deg_x, 0.0, ref_bounds.north, 0.0, -px_deg_y };
    ds->SetGeoTransform(gt);

    OGRSpatialReference srs;
    srs.importFromEPSG(4326);
    char* wkt = nullptr;
    srs.exportToWkt(&wkt);
    ds->SetProjection(wkt);
    CPLFree(wkt);

    ds->GetRasterBand(1)->SetDescription("Roads");
    ds->GetRasterBand(2)->SetDescription("Buildings");
    ds->GetRasterBand(3)->SetDescription("Vegetation");
    ds->GetRasterBand(4)->SetDescription("Railways");
    ds->GetRasterBand(5)->SetDescription("Water");
    ds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, out_w, out_h, band_road.data(), out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(2)->RasterIO(GF_Write, 0, 0, out_w, out_h, band_bldg.data(), out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(3)->RasterIO(GF_Write, 0, 0, out_w, out_h, band_veg.data(), out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(4)->RasterIO(GF_Write, 0, 0, out_w, out_h, band_rail.data(), out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(5)->RasterIO(GF_Write, 0, 0, out_w, out_h, band_water.data(), out_w, out_h, GDT_Byte, 0, 0);
    GDALClose(ds);

    {
        const std::string preview_path =
            config.output_path.substr(0, config.output_path.rfind('.')) + "_preview.tif";
        GDALDataset* preview_ds = driver->Create(preview_path.c_str(), out_w, out_h, 3, GDT_Byte, nullptr);
        if (preview_ds)
        {
            preview_ds->SetGeoTransform(gt);
            OGRSpatialReference preview_srs;
            preview_srs.importFromEPSG(4326);
            char* preview_wkt = nullptr;
            preview_srs.exportToWkt(&preview_wkt);
            preview_ds->SetProjection(preview_wkt);
            CPLFree(preview_wkt);

            std::vector<uint8_t> pr(sz, 0), pg(sz, 0), pb(sz, 0);
            for (size_t i = 0; i < sz; ++i)
            {
                if (band_water[i]) { pr[i] = 0; pg[i] = 220; pb[i] = 255; }
                if (band_veg[i]) { pr[i] = 0; pg[i] = 200; pb[i] = 0; }
                if (band_bldg[i]) { pr[i] = 255; pg[i] = 255; pb[i] = 0; }
                if (band_rail[i]) { pr[i] = 0; pg[i] = 0; pb[i] = 255; }
                if (band_road[i]) { pr[i] = 255; pg[i] = 0; pb[i] = 0; }
            }
            preview_ds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, out_w, out_h, pr.data(), out_w, out_h, GDT_Byte, 0, 0);
            preview_ds->GetRasterBand(2)->RasterIO(GF_Write, 0, 0, out_w, out_h, pg.data(), out_w, out_h, GDT_Byte, 0, 0);
            preview_ds->GetRasterBand(3)->RasterIO(GF_Write, 0, 0, out_w, out_h, pb.data(), out_w, out_h, GDT_Byte, 0, 0);
            GDALClose(preview_ds);
            GdalUtils::fixCrsTag(preview_path);
        }
    }

    {
        static const struct { uint8_t r, g, b; } colors[6] = {
            { 34, 139, 34 }, { 0, 200, 80 }, { 144, 238, 80 },
            { 200, 220, 60 }, { 107, 142, 35 }, { 180, 230, 130 }
        };
        const std::string veg_path =
            config.output_path.substr(0, config.output_path.rfind('/') + 1) + "vegetation_mask.tif";
        GDALDataset* veg_ds = driver->Create(veg_path.c_str(), out_w, out_h, 3, GDT_Byte, nullptr);
        if (veg_ds)
        {
            veg_ds->SetGeoTransform(gt);
            OGRSpatialReference veg_srs;
            veg_srs.importFromEPSG(4326);
            char* veg_wkt = nullptr;
            veg_srs.exportToWkt(&veg_wkt);
            veg_ds->SetProjection(veg_wkt);
            CPLFree(veg_wkt);

            std::vector<uint8_t> vr(sz, 0), vg(sz, 0), vb(sz, 0);
            for (int category = 5; category >= 0; --category)
            {
                for (size_t i = 0; i < sz; ++i)
                {
                    if (veg_cat[category][i])
                    {
                        vr[i] = colors[category].r;
                        vg[i] = colors[category].g;
                        vb[i] = colors[category].b;
                    }
                }
            }
            veg_ds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, out_w, out_h, vr.data(), out_w, out_h, GDT_Byte, 0, 0);
            veg_ds->GetRasterBand(2)->RasterIO(GF_Write, 0, 0, out_w, out_h, vg.data(), out_w, out_h, GDT_Byte, 0, 0);
            veg_ds->GetRasterBand(3)->RasterIO(GF_Write, 0, 0, out_w, out_h, vb.data(), out_w, out_h, GDT_Byte, 0, 0);
            GDALClose(veg_ds);
            GdalUtils::fixCrsTag(veg_path);
        }
    }

    GdalUtils::fixCrsTag(config.output_path);
    report(context, "Mask saved: " + config.output_path, 95);
    MaskArtifact artifact;
    artifact.output_path = config.output_path;
    return Result<MaskArtifact>::ok(artifact);
}
