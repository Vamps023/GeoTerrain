#pragma once

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cmath>
#include <algorithm>
#include <string>

// Geographic bounding box in WGS-84 (EPSG:4326)
struct GeoBounds
{
    double west  = 0.0;
    double south = 0.0;
    double east  = 0.0;
    double north = 0.0;

    bool isValid() const
    {
        return west < east && south < north
            && west  >= -180.0 && east  <= 180.0
            && south >= -90.0  && north <= 90.0;
    }

    double width()  const { return east  - west;  }
    double height() const { return north - south; }

    std::string toOverpassBBox() const
    {
        // Overpass uses (south,west,north,east)
        return std::to_string(south) + "," + std::to_string(west) + ","
             + std::to_string(north) + "," + std::to_string(east);
    }

    std::string toWMSBBox() const
    {
        return std::to_string(west)  + "," + std::to_string(south) + ","
             + std::to_string(east)  + "," + std::to_string(north);
    }
};

// Tile coordinate helpers for XYZ/TMS schemes
struct TileCoord
{
    int x = 0;
    int y = 0;
    int z = 0;
};

inline TileCoord latLonToTile(double lat, double lon, int zoom)
{
    const double n = std::pow(2.0, zoom);
    const double lat_rad = lat * M_PI / 180.0;
    TileCoord t;
    t.z = zoom;
    t.x = static_cast<int>(std::floor((lon + 180.0) / 360.0 * n));
    t.y = static_cast<int>(std::floor((1.0 - std::log(std::tan(lat_rad) + 1.0 / std::cos(lat_rad)) / M_PI) / 2.0 * n));
    t.x = std::max(0, std::min(t.x, static_cast<int>(n) - 1));
    t.y = std::max(0, std::min(t.y, static_cast<int>(n) - 1));
    return t;
}

inline double tileToLon(int x, int z)
{
    return x / std::pow(2.0, z) * 360.0 - 180.0;
}

inline double tileToLat(int y, int z)
{
    const double n = M_PI - 2.0 * M_PI * y / std::pow(2.0, z);
    return 180.0 / M_PI * std::atan(0.5 * (std::exp(n) - std::exp(-n)));
}
