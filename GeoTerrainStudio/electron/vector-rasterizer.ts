/**
 * Vector Rasterizer - Converts vector geometry (polygons, polylines) into
 * binary raster mask images at a specified resolution.
 *
 * Uses scanline rasterization with even-odd rule for filled polygons and
 * Bresenham line drawing for roads/linear features.
 *
 * Output: 8-bit single-channel grayscale PNG via sharp.
 */

import sharp from 'sharp';
import type { GeoBounds, OverpassFeature } from './overpass-client';

// ─── Interfaces ────────────────────────────────────────────────

export interface RasterizeOptions {
  width: number;
  height: number;
  bounds: GeoBounds;          // { south, west, north, east }
  lineWidth?: number;         // For linear features (roads), in pixels, default 3
  fillValue?: number;         // Pixel value for filled areas (default: 255)
  backgroundColor?: number;   // Background pixel value (default: 0)
}

// ─── Coordinate Conversion ─────────────────────────────────────

/**
 * Convert geographic coordinates (lat, lon) to pixel coordinates (x, y).
 *
 * Mapping:
 *   lon → X: west=0, east=width-1
 *   lat → Y: north=0, south=height-1
 *
 * Coordinates outside bounds are clamped to the nearest edge pixel.
 */
export function geoToPixel(
  lat: number,
  lon: number,
  bounds: GeoBounds,
  width: number,
  height: number
): { x: number; y: number } {
  const lonRange = bounds.east - bounds.west;
  const latRange = bounds.north - bounds.south;

  // Normalize to [0, 1] range
  let xNorm = lonRange === 0 ? 0.5 : (lon - bounds.west) / lonRange;
  let yNorm = latRange === 0 ? 0.5 : (bounds.north - lat) / latRange;

  // Convert to pixel coordinates
  let x = xNorm * (width - 1);
  let y = yNorm * (height - 1);

  // Clamp to valid pixel range
  x = Math.round(Math.max(0, Math.min(width - 1, x)));
  y = Math.round(Math.max(0, Math.min(height - 1, y)));

  return { x, y };
}

// ─── Polygon Rasterization (Scanline Fill, Even-Odd Rule) ──────

/**
 * Rasterize an array of polygons into a raw 8-bit pixel buffer.
 * Uses scanline fill with the even-odd rule.
 *
 * Each polygon is an array of {lat, lon} points forming a closed ring.
 * Geometry extending beyond tile bounds is clipped to the raster extent.
 */
export function rasterizePolygons(
  polygons: Array<Array<{ lat: number; lon: number }>>,
  options: RasterizeOptions
): Buffer {
  const { width, height, bounds } = options;
  const fillValue = options.fillValue ?? 255;
  const backgroundColor = options.backgroundColor ?? 0;

  // Initialize buffer with background color
  const buffer = Buffer.alloc(width * height, backgroundColor);

  for (const polygon of polygons) {
    if (polygon.length < 3) continue;

    // Convert polygon vertices to pixel coordinates
    const pixelPoints = polygon.map(p => geoToPixel(p.lat, p.lon, bounds, width, height));

    // Find bounding box of the polygon in pixel space
    let minY = height;
    let maxY = 0;
    for (const pt of pixelPoints) {
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    minY = Math.max(0, minY);
    maxY = Math.min(height - 1, maxY);

    // Scanline fill with even-odd rule
    for (let y = minY; y <= maxY; y++) {
      const intersections: number[] = [];

      for (let i = 0; i < pixelPoints.length; i++) {
        const j = (i + 1) % pixelPoints.length;
        const yi = pixelPoints[i].y;
        const yj = pixelPoints[j].y;
        const xi = pixelPoints[i].x;
        const xj = pixelPoints[j].x;

        // Check if scanline crosses this edge
        if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
          // Compute x intersection
          const t = (y - yi) / (yj - yi);
          const xIntersect = xi + t * (xj - xi);
          intersections.push(xIntersect);
        }
      }

      // Sort intersections left to right
      intersections.sort((a, b) => a - b);

      // Fill between pairs (even-odd rule)
      for (let k = 0; k < intersections.length - 1; k += 2) {
        const xStart = Math.max(0, Math.round(intersections[k]));
        const xEnd = Math.min(width - 1, Math.round(intersections[k + 1]));

        for (let x = xStart; x <= xEnd; x++) {
          buffer[y * width + x] = fillValue;
        }
      }
    }
  }

  return buffer;
}

// ─── Line Rasterization (Bresenham with Configurable Width) ────

/**
 * Rasterize an array of polylines into a raw 8-bit pixel buffer.
 * Uses Bresenham line drawing with configurable width.
 *
 * Each line is an array of {lat, lon} points forming a polyline.
 * Line width is applied symmetrically around the line center.
 */
export function rasterizeLines(
  lines: Array<Array<{ lat: number; lon: number }>>,
  options: RasterizeOptions
): Buffer {
  const { width, height, bounds } = options;
  const lineWidth = options.lineWidth ?? 3;
  const fillValue = options.fillValue ?? 255;
  const backgroundColor = options.backgroundColor ?? 0;

  // Initialize buffer with background color
  const buffer = Buffer.alloc(width * height, backgroundColor);

  for (const line of lines) {
    if (line.length < 2) continue;

    // Convert line vertices to pixel coordinates
    const pixelPoints = line.map(p => geoToPixel(p.lat, p.lon, bounds, width, height));

    // Draw each segment of the polyline
    for (let i = 0; i < pixelPoints.length - 1; i++) {
      drawThickLine(
        buffer,
        pixelPoints[i].x,
        pixelPoints[i].y,
        pixelPoints[i + 1].x,
        pixelPoints[i + 1].y,
        lineWidth,
        fillValue,
        width,
        height
      );
    }
  }

  return buffer;
}

/**
 * Draw a thick line between two points using Bresenham's algorithm
 * with perpendicular expansion for width.
 */
function drawThickLine(
  buffer: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lineWidth: number,
  fillValue: number,
  width: number,
  height: number
): void {
  const halfWidth = (lineWidth - 1) / 2;

  // Bresenham's line algorithm
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let cx = x0;
  let cy = y0;

  while (true) {
    // Draw a filled circle/square at each point along the line for width
    fillCircle(buffer, cx, cy, halfWidth, fillValue, width, height);

    if (cx === x1 && cy === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

/**
 * Fill a circular area around a center point to create line width.
 * Uses a simple radius check for symmetric width application.
 */
function fillCircle(
  buffer: Buffer,
  cx: number,
  cy: number,
  radius: number,
  fillValue: number,
  width: number,
  height: number
): void {
  const r = Math.ceil(radius);
  const rSquared = radius * radius;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rSquared) {
        const px = cx + dx;
        const py = cy + dy;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          buffer[py * width + px] = fillValue;
        }
      }
    }
  }
}

// ─── High-Level Rasterize-to-File ──────────────────────────────

/**
 * Rasterize features and write the result as an 8-bit single-channel
 * grayscale GeoTIFF file via sharp.
 *
 * @param features - Array of OverpassFeature objects to rasterize
 * @param featureType - 'polygon' for filled areas, 'line' for linear features
 * @param options - Rasterization options (dimensions, bounds, styling)
 * @param outputPath - Full path to write the output file (.tif)
 */
export async function rasterizeToFile(
  features: OverpassFeature[],
  featureType: 'polygon' | 'line',
  options: RasterizeOptions,
  outputPath: string
): Promise<void> {
  let rawBuffer: Buffer;

  if (features.length === 0) {
    // Empty features → all-black mask
    rawBuffer = Buffer.alloc(options.width * options.height, options.backgroundColor ?? 0);
  } else {
    // Extract geometry arrays from features
    const geometries = features.map(f => f.geometry);

    if (featureType === 'polygon') {
      rawBuffer = rasterizePolygons(geometries, options);
    } else {
      rawBuffer = rasterizeLines(geometries, options);
    }
  }

  // Write as 8-bit single-channel grayscale TIFF via sharp
  await sharp(rawBuffer, {
    raw: {
      width: options.width,
      height: options.height,
      channels: 1,
    },
  })
    .tiff({ compression: 'lzw' })
    .toFile(outputPath);
}
