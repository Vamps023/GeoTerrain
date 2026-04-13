#include "MaskGenerator.h"
#include "GdalUtils.h"

#include <gdal_priv.h>
#include <ogr_spatialref.h>
#include <cpl_string.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

// ---------------------------------------------------------------------------
void MaskGenerator::latLonToPixel(double lat, double lon,
                                   const GeoBounds& bounds,
                                   int width, int height,
                                   int& px, int& py)
{
    px = static_cast<int>((lon - bounds.west)  / bounds.width()  * width);
    py = static_cast<int>((bounds.north - lat) / bounds.height() * height);
    px = std::max(0, std::min(px, width  - 1));
    py = std::max(0, std::min(py, height - 1));
}

// ---------------------------------------------------------------------------
// Simple scanline polygon fill (for closed rings)
void MaskGenerator::rasterizePolygon(std::vector<uint8_t>& buf,
                                      int width, int height,
                                      const GeoBounds& bounds,
                                      const std::vector<std::pair<double,double>>& ring,
                                      uint8_t value)
{
    if (ring.size() < 3) return;

    // Convert all nodes to pixel coords
    std::vector<std::pair<int,int>> pts;
    pts.reserve(ring.size());
    for (const auto& [lat, lon] : ring)
    {
        int px, py;
        latLonToPixel(lat, lon, bounds, width, height, px, py);
        pts.emplace_back(px, py);
    }

    // Bounding box of polygon
    int y_min = height, y_max = 0;
    for (const auto& [x, y] : pts)
    {
        y_min = std::min(y_min, y);
        y_max = std::max(y_max, y);
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

            if (((yi <= scanline && yj > scanline) || (yj <= scanline && yi > scanline)))
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

// ---------------------------------------------------------------------------
void MaskGenerator::rasterizeLine(std::vector<uint8_t>& buf,
                                   int width, int height,
                                   const GeoBounds& bounds,
                                   const std::vector<std::pair<double,double>>& pts,
                                   int radius_px, uint8_t value)
{
    if (pts.size() < 2) return;

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

    // Bresenham-based thick line via circle stamps
    for (size_t i = 0; i + 1 < pts.size(); ++i)
    {
        int x0, y0, x1, y1;
        latLonToPixel(pts[i].first,     pts[i].second,     bounds, width, height, x0, y0);
        latLonToPixel(pts[i+1].first,   pts[i+1].second,   bounds, width, height, x1, y1);

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

// ---------------------------------------------------------------------------
bool MaskGenerator::generate(const GeoBounds&              bounds,
                               const OSMParser::ParseResult& osm,
                               const Config&                 config,
                               ProgressCallback              progress_cb)
{
    if (!bounds.isValid())
    {
        if (progress_cb) progress_cb("ERROR: Invalid bounds for mask generation", 0);
        return false;
    }

    if (!osm.success)
    {
        if (progress_cb) progress_cb("WARNING: OSM parse failed — generating empty mask", 10);
    }

    int out_w = 0, out_h = 0;
    GeoBounds ref_bounds = bounds;

    if (!config.ref_tif_path.empty())
    {
        GDALAllRegister();
        GDALDataset* ref_ds = static_cast<GDALDataset*>(
            GDALOpen(config.ref_tif_path.c_str(), GA_ReadOnly));
        if (ref_ds)
        {
            double gt[6];
            if (ref_ds->GetGeoTransform(gt) == CE_None)
            {
                out_w = ref_ds->GetRasterXSize();
                out_h = ref_ds->GetRasterYSize();
                ref_bounds.west  = gt[0];
                ref_bounds.north = gt[3];
                ref_bounds.east  = gt[0] + gt[1] * out_w;
                ref_bounds.south = gt[3] + gt[5] * out_h;
            }
            GDALClose(ref_ds);
        }
    }

    if (out_w <= 0 || out_h <= 0)
    {
        constexpr double DEG_PER_M = 1.0 / 111320.0;
        const double pixel_deg = config.resolution_m * DEG_PER_M;
        out_w = std::max(1, static_cast<int>(std::ceil(bounds.width()  / pixel_deg)));
        out_h = std::max(1, static_cast<int>(std::ceil(bounds.height() / pixel_deg)));
    }

    if (progress_cb)
        progress_cb("Mask raster size: " + std::to_string(out_w) + "x" + std::to_string(out_h), 5);

    // Allocate five single-band buffers
    const size_t sz = static_cast<size_t>(out_w) * out_h;
    std::vector<uint8_t> band_road(sz, 0);
    std::vector<uint8_t> band_bldg(sz, 0);
    std::vector<uint8_t> band_veg(sz, 0);
    std::vector<uint8_t> band_rail(sz, 0);
    std::vector<uint8_t> band_water(sz, 0);

    // Pixel size from actual output dimensions
    const double px_deg_x = ref_bounds.width()  / out_w;
    const double px_deg_y = ref_bounds.height() / out_h;
    const double px_deg   = std::min(px_deg_x, px_deg_y);
    constexpr double DEG_PER_M = 1.0 / 111320.0;
    const int road_radius_px = std::max(1, static_cast<int>(
        config.road_width_m * DEG_PER_M / px_deg * 0.5));

    int way_count = 0;
    const int total_ways = static_cast<int>(osm.ways.size());

    for (const auto& way : osm.ways)
    {
        way_count++;
        if (progress_cb && way_count % 200 == 0)
        {
            const int pct = 10 + (way_count * 75) / std::max(1, total_ways);
            progress_cb("Rasterizing way " + std::to_string(way_count)
                        + "/" + std::to_string(total_ways), pct);
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
            break;
        case OSMParser::Way::Tag::Water:
            rasterizePolygon(band_water, out_w, out_h, ref_bounds, way.nodes, 255);
            break;
        default:
            break;
        }
    }

    if (progress_cb) progress_cb("Writing mask GeoTIFF...", 88);

    // Write 5-band GeoTIFF
    GDALAllRegister();
    GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
    if (!driver)
    {
        if (progress_cb) progress_cb("ERROR: GTiff driver not available", 0);
        return false;
    }

    char** opts = nullptr;
    opts = CSLSetNameValue(opts, "COMPRESS", "LZW");

    GDALDataset* ds = driver->Create(config.output_path.c_str(),
                                      out_w, out_h, 5, GDT_Byte, opts);
    CSLDestroy(opts);

    if (!ds)
    {
        if (progress_cb) progress_cb("ERROR: Cannot create mask GeoTIFF: " + config.output_path, 0);
        return false;
    }

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

    ds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                                    band_road.data(),  out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(2)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                                    band_bldg.data(),  out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(3)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                                    band_veg.data(),   out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(4)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                                    band_rail.data(),  out_w, out_h, GDT_Byte, 0, 0);
    ds->GetRasterBand(5)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                                    band_water.data(), out_w, out_h, GDT_Byte, 0, 0);
    GDALClose(ds);

    // Log per-band pixel counts so user can verify data presence
    auto countNonZero = [](const std::vector<uint8_t>& b)
    {
        int n = 0;
        for (uint8_t v : b) if (v) ++n;
        return n;
    };
    if (progress_cb)
    {
        progress_cb("Mask pixels — Roads:"      + std::to_string(countNonZero(band_road))  +
                    " Buildings:"               + std::to_string(countNonZero(band_bldg))  +
                    " Vegetation:"              + std::to_string(countNonZero(band_veg))   +
                    " Railways:"                + std::to_string(countNonZero(band_rail))  +
                    " Water:"                   + std::to_string(countNonZero(band_water)), 89);
    }

    // --- Write RGB colour preview: mask_preview.tif ---
    // Roads=Red(255,0,0), Buildings=Yellow(255,255,0),
    // Vegetation=Green(0,200,0), Railways=Blue(0,0,255), Water=Cyan(0,220,255)
    {
        const std::string preview_path =
            config.output_path.substr(0, config.output_path.rfind('.')) + "_preview.tif";

        GDALDataset* pds = driver->Create(preview_path.c_str(), out_w, out_h, 3, GDT_Byte, nullptr);
        if (pds)
        {
            pds->SetGeoTransform(gt);
            OGRSpatialReference psrs;
            psrs.importFromEPSG(4326);
            char* pwkt = nullptr;
            psrs.exportToWkt(&pwkt);
            pds->SetProjection(pwkt);
            CPLFree(pwkt);

            std::vector<uint8_t> pr(sz, 0), pg(sz, 0), pb(sz, 0);
            for (size_t i = 0; i < sz; ++i)
            {
                if (band_water[i])  { pr[i] = 0;   pg[i] = 220; pb[i] = 255; } // Cyan
                if (band_veg[i])    { pr[i] = 0;   pg[i] = 200; pb[i] = 0;   } // Green
                if (band_bldg[i])   { pr[i] = 255; pg[i] = 255; pb[i] = 0;   } // Yellow
                if (band_rail[i])   { pr[i] = 0;   pg[i] = 0;   pb[i] = 255; } // Blue
                if (band_road[i])   { pr[i] = 255; pg[i] = 0;   pb[i] = 0;   } // Red
            }
            pds->GetRasterBand(1)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                pr.data(), out_w, out_h, GDT_Byte, 0, 0);
            pds->GetRasterBand(2)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                pg.data(), out_w, out_h, GDT_Byte, 0, 0);
            pds->GetRasterBand(3)->RasterIO(GF_Write, 0, 0, out_w, out_h,
                pb.data(), out_w, out_h, GDT_Byte, 0, 0);
            GDALClose(pds);
            if (progress_cb) progress_cb("Mask preview saved: " + preview_path, 91);
        }
    }

    if (progress_cb) progress_cb("Tagging mask CRS: EPSG:4326...", 92);
    GdalUtils::fixCrsTag(config.output_path);
    if (progress_cb) progress_cb("Mask saved: " + config.output_path, 95);
    return true;
}
