/**
 * Satellite Vegetation Client - Fetches ESA WorldCover 10m land cover
 * raster tiles and produces a grayscale vegetation mask buffer.
 *
 * Uses ESA WorldCover v200 tiles from the AWS open data bucket.
 * WorldCover tiles are organized in a 3x3 degree grid.
 *
 * Vegetation classes extracted:
 *   10 = Tree cover       → 255 (dense vegetation)
 *   20 = Shrubland        → 200
 *   30 = Grassland        → 150
 *   40 = Cropland         → 100
 *   All other classes     → 0 (non-vegetation)
 *
 * On failure, falls back to the existing OSM vegetation approach
 * (fetchVegetation + rasterizePolygons) with a console warning.
 *
 * Runs in the Electron main process (Node.js).
 */

import * as https from 'https';
import sharp from 'sharp';
import type { GeoBounds } from './overpass-client';
import { fetchVegetation } from './overpass-client';
import { rasterizePolygons } from './vector-rasterizer';

// ─── Constants ─────────────────────────────────────────────────

/**
 * ESA WorldCover v200 AWS open data bucket base URL.
 * Tiles are GeoTIFF files named by their southwest corner coordinate.
 * Example: ESA_WorldCover_10m_2021_v200_N48W003_Map.tif
 */
const WORLDCOVER_BASE_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';

/** WorldCover grid tile size in degrees (3x3 degree tiles) */
const TILE_SIZE_DEGREES = 3;

/** HTTP request timeout in milliseconds */
const HTTP_TIMEOUT_MS = 60000;

/**
 * Vegetation class mapping: WorldCover pixel value → grayscale intensity.
 * Higher intensity = denser/taller vegetation.
 */
const VEGETATION_CLASS_MAP: Record<number, number> = {
  10: 255,  // Tree cover
  20: 200,  // Shrubland
  30: 150,  // Grassland
  40: 100,  // Cropland
};

// ─── Tile Grid Computation ─────────────────────────────────────

/**
 * Represents a WorldCover tile by its southwest corner coordinates.
 */
export interface WorldCoverTile {
  /** Latitude of the southwest corner (multiple of 3, snapped to grid) */
  latSW: number;
  /** Longitude of the southwest corner (multiple of 3, snapped to grid) */
  lonSW: number;
}

/**
 * Computes which WorldCover 3x3 degree grid tiles intersect the given bounds.
 *
 * The WorldCover grid is aligned to multiples of 3 degrees starting from
 * the southwest corner. For example, a tile at N48W003 covers lat [48,51)
 * and lon [-3,0).
 *
 * @param bounds - Geographic bounding box to cover
 * @returns Array of tiles whose 3x3 degree extent intersects the bounds
 */
export function computeIntersectingTiles(bounds: GeoBounds): WorldCoverTile[] {
  const tiles: WorldCoverTile[] = [];

  // Snap south/west to the grid floor (nearest multiple of 3 at or below)
  const startLat = Math.floor(bounds.south / TILE_SIZE_DEGREES) * TILE_SIZE_DEGREES;
  const startLon = Math.floor(bounds.west / TILE_SIZE_DEGREES) * TILE_SIZE_DEGREES;

  // Snap north/east to the grid ceiling
  const endLat = Math.ceil(bounds.north / TILE_SIZE_DEGREES) * TILE_SIZE_DEGREES;
  const endLon = Math.ceil(bounds.east / TILE_SIZE_DEGREES) * TILE_SIZE_DEGREES;

  for (let lat = startLat; lat < endLat; lat += TILE_SIZE_DEGREES) {
    for (let lon = startLon; lon < endLon; lon += TILE_SIZE_DEGREES) {
      tiles.push({ latSW: lat, lonSW: lon });
    }
  }

  return tiles;
}

/**
 * Builds the download URL for a WorldCover tile.
 *
 * Tile naming convention:
 *   ESA_WorldCover_10m_2021_v200_<lat><lon>_Map.tif
 * Where:
 *   <lat> = N/S + zero-padded absolute latitude (e.g., N48, S12)
 *   <lon> = E/W + zero-padded absolute longitude (e.g., W003, E012)
 *
 * @param tile - Tile southwest corner coordinates
 * @returns Full URL to the GeoTIFF tile
 */
export function buildTileUrl(tile: WorldCoverTile): string {
  const latPrefix = tile.latSW >= 0 ? 'N' : 'S';
  const lonPrefix = tile.lonSW >= 0 ? 'E' : 'W';

  const latStr = `${latPrefix}${String(Math.abs(tile.latSW)).padStart(2, '0')}`;
  const lonStr = `${lonPrefix}${String(Math.abs(tile.lonSW)).padStart(3, '0')}`;

  const filename = `ESA_WorldCover_10m_2021_v200_${latStr}${lonStr}_Map.tif`;
  return `${WORLDCOVER_BASE_URL}/${filename}`;
}

// ─── HTTP Fetch ────────────────────────────────────────────────

/**
 * Downloads a WorldCover tile as a raw buffer.
 *
 * @param url - Full URL to the GeoTIFF tile
 * @returns Raw buffer containing the GeoTIFF data
 * @throws Error on HTTP failure, timeout, or redirect issues
 */
function downloadTile(url: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const makeRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      https.get(requestUrl, { timeout: HTTP_TIMEOUT_MS }, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          makeRequest(res.headers.location, redirectCount + 1);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching WorldCover tile: ${requestUrl}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('timeout', () => {
        reject(new Error(`Timeout fetching WorldCover tile: ${requestUrl}`));
      }).on('error', reject);
    };

    makeRequest(url, 0);
  });
}

// ─── Vegetation Class Extraction ───────────────────────────────

/**
 * Extracts vegetation classes from a raw WorldCover raster buffer.
 *
 * Maps WorldCover land cover class values to grayscale intensities:
 *   10 (Tree cover)  → 255
 *   20 (Shrubland)   → 200
 *   30 (Grassland)   → 150
 *   40 (Cropland)    → 100
 *   All others       → 0
 *
 * @param rawPixels - Raw 8-bit pixel buffer from WorldCover tile
 * @returns Buffer with vegetation intensity values
 */
export function extractVegetationClasses(rawPixels: Buffer): Buffer {
  const output = Buffer.alloc(rawPixels.length);

  for (let i = 0; i < rawPixels.length; i++) {
    const classValue = rawPixels[i];
    output[i] = VEGETATION_CLASS_MAP[classValue] ?? 0;
  }

  return output;
}

// ─── Crop and Resize ───────────────────────────────────────────

/**
 * Crops a raster tile to the exact geographic bounds requested,
 * then resizes to the target output dimensions.
 *
 * The tile covers a 3x3 degree area starting from its southwest corner.
 * We compute the pixel region within the tile that corresponds to the
 * requested bounds, extract that region, and resize it.
 *
 * @param tileBuffer - Raw grayscale pixel buffer for the full tile
 * @param tileWidth - Width of the tile in pixels
 * @param tileHeight - Height of the tile in pixels
 * @param tileSW - Southwest corner of the tile (lat, lon)
 * @param bounds - Target geographic bounds to crop to
 * @param outputWidth - Target output width in pixels
 * @param outputHeight - Target output height in pixels
 * @returns Cropped and resized buffer at target dimensions
 */
async function cropAndResize(
  tileBuffer: Buffer,
  tileWidth: number,
  tileHeight: number,
  tileSW: { lat: number; lon: number },
  bounds: GeoBounds,
  outputWidth: number,
  outputHeight: number
): Promise<Buffer> {
  // Tile geographic extent
  const tileNorth = tileSW.lat + TILE_SIZE_DEGREES;
  const tileEast = tileSW.lon + TILE_SIZE_DEGREES;
  const tileSouth = tileSW.lat;
  const tileWest = tileSW.lon;

  // Compute pixel coordinates for the crop region
  // X maps longitude: west=0, east=tileWidth
  // Y maps latitude: north=0, south=tileHeight (inverted)
  const xStart = Math.max(0, Math.floor(((bounds.west - tileWest) / (tileEast - tileWest)) * tileWidth));
  const xEnd = Math.min(tileWidth, Math.ceil(((bounds.east - tileWest) / (tileEast - tileWest)) * tileWidth));
  const yStart = Math.max(0, Math.floor(((tileNorth - bounds.north) / (tileNorth - tileSouth)) * tileHeight));
  const yEnd = Math.min(tileHeight, Math.ceil(((tileNorth - bounds.south) / (tileNorth - tileSouth)) * tileHeight));

  const cropWidth = Math.max(1, xEnd - xStart);
  const cropHeight = Math.max(1, yEnd - yStart);

  // Use sharp to extract the crop region and resize with bilinear interpolation
  const resized = await sharp(tileBuffer, {
    raw: { width: tileWidth, height: tileHeight, channels: 1 },
  })
    .extract({ left: xStart, top: yStart, width: cropWidth, height: cropHeight })
    .resize(outputWidth, outputHeight, { kernel: 'lanczos2' })
    .raw()
    .toBuffer();

  return resized;
}

// ─── Multi-Tile Mosaic ─────────────────────────────────────────

/**
 * Fetches and mosaics multiple WorldCover tiles to cover the requested bounds,
 * then crops and resizes to the target output dimensions.
 *
 * For single-tile cases (most common for typical terrain exports), this
 * simply downloads one tile, extracts vegetation classes, crops, and resizes.
 *
 * For multi-tile cases, tiles are composited into a mosaic before cropping.
 *
 * @param bounds - Geographic bounding box
 * @param outputWidth - Target output width in pixels
 * @param outputHeight - Target output height in pixels
 * @returns Raw grayscale buffer of outputWidth * outputHeight bytes
 */
async function fetchAndProcessTiles(
  bounds: GeoBounds,
  outputWidth: number,
  outputHeight: number
): Promise<Buffer> {
  const tiles = computeIntersectingTiles(bounds);

  if (tiles.length === 0) {
    // No tiles found (shouldn't happen for valid bounds)
    return Buffer.alloc(outputWidth * outputHeight, 0);
  }

  if (tiles.length === 1) {
    // Single tile — most common case
    const tile = tiles[0];
    const url = buildTileUrl(tile);
    const tileData = await downloadTile(url);

    // Decode the GeoTIFF to get raw pixel data and dimensions
    const { data: rawPixels, info } = await sharp(tileData)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Extract vegetation classes from the raw WorldCover data
    const vegetationBuffer = extractVegetationClasses(rawPixels);

    // Crop to bounds and resize to target dimensions
    return cropAndResize(
      vegetationBuffer,
      info.width,
      info.height,
      { lat: tile.latSW, lon: tile.lonSW },
      bounds,
      outputWidth,
      outputHeight
    );
  }

  // Multi-tile case: compute mosaic extent and composite
  const mosaicSouth = Math.min(...tiles.map(t => t.latSW));
  const mosaicWest = Math.min(...tiles.map(t => t.lonSW));
  const mosaicNorth = Math.max(...tiles.map(t => t.latSW + TILE_SIZE_DEGREES));
  const mosaicEast = Math.max(...tiles.map(t => t.lonSW + TILE_SIZE_DEGREES));

  // Download all tiles in parallel
  const tileResults = await Promise.all(
    tiles.map(async (tile) => {
      const url = buildTileUrl(tile);
      try {
        const tileData = await downloadTile(url);
        const { data: rawPixels, info } = await sharp(tileData)
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { tile, rawPixels, width: info.width, height: info.height, success: true as const };
      } catch {
        // Individual tile failure — fill with zeros
        return { tile, rawPixels: Buffer.alloc(0), width: 0, height: 0, success: false as const };
      }
    })
  );

  // Determine mosaic pixel dimensions from the first successful tile
  const firstSuccess = tileResults.find(r => r.success);
  if (!firstSuccess) {
    throw new Error('All WorldCover tile downloads failed');
  }

  const pixelsPerDegree = firstSuccess.width / TILE_SIZE_DEGREES;
  const mosaicWidth = Math.round((mosaicEast - mosaicWest) * pixelsPerDegree);
  const mosaicHeight = Math.round((mosaicNorth - mosaicSouth) * pixelsPerDegree);

  // Create mosaic buffer
  const mosaic = Buffer.alloc(mosaicWidth * mosaicHeight, 0);

  // Place each tile into the mosaic
  for (const result of tileResults) {
    if (!result.success) continue;

    const vegetationBuffer = extractVegetationClasses(result.rawPixels);

    // Compute placement offset in mosaic pixel space
    const offsetX = Math.round((result.tile.lonSW - mosaicWest) * pixelsPerDegree);
    const offsetY = Math.round((mosaicNorth - result.tile.latSW - TILE_SIZE_DEGREES) * pixelsPerDegree);

    // Copy tile pixels into mosaic
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        const mosaicX = offsetX + x;
        const mosaicY = offsetY + y;
        if (mosaicX >= 0 && mosaicX < mosaicWidth && mosaicY >= 0 && mosaicY < mosaicHeight) {
          mosaic[mosaicY * mosaicWidth + mosaicX] = vegetationBuffer[y * result.width + x];
        }
      }
    }
  }

  // Crop mosaic to bounds and resize
  return cropAndResize(
    mosaic,
    mosaicWidth,
    mosaicHeight,
    { lat: mosaicSouth, lon: mosaicWest },
    bounds,
    outputWidth,
    outputHeight
  );
}

// ─── OSM Fallback ──────────────────────────────────────────────

/**
 * Falls back to the existing OSM vegetation approach.
 * Fetches vegetation polygons via Overpass and rasterizes them.
 *
 * @param bounds - Geographic bounding box
 * @param outputWidth - Target output width in pixels
 * @param outputHeight - Target output height in pixels
 * @returns Raw grayscale buffer of outputWidth * outputHeight bytes
 */
async function fetchOsmVegetationFallback(
  bounds: GeoBounds,
  outputWidth: number,
  outputHeight: number
): Promise<Buffer> {
  const queryResult = await fetchVegetation(bounds);
  const polygons = queryResult.features.map(f => f.geometry);

  return rasterizePolygons(polygons, {
    width: outputWidth,
    height: outputHeight,
    bounds,
  });
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Fetches satellite-derived vegetation data for the given bounds and
 * returns a raw grayscale buffer at the specified output dimensions.
 *
 * Uses ESA WorldCover 10m land cover data to produce a vegetation mask
 * where pixel intensity reflects vegetation class:
 *   255 = Tree cover (dense forest)
 *   200 = Shrubland
 *   150 = Grassland
 *   100 = Cropland
 *     0 = Non-vegetation (built-up, water, bare, etc.)
 *
 * On failure, falls back to the existing OSM vegetation approach with
 * a console warning, ensuring graceful degradation.
 *
 * @param bounds - Geographic bounding box (south, west, north, east)
 * @param outputWidth - Target output width in pixels (should match heightmap)
 * @param outputHeight - Target output height in pixels (should match heightmap)
 * @returns Raw grayscale Buffer of outputWidth * outputHeight bytes
 */
export async function fetchSatelliteVegetation(
  bounds: GeoBounds,
  outputWidth: number,
  outputHeight: number
): Promise<Buffer> {
  try {
    return await fetchAndProcessTiles(bounds, outputWidth, outputHeight);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[satellite-vegetation] Satellite vegetation fetch failed: ${errorMessage}. ` +
      `Falling back to OSM vegetation data.`
    );

    // Fallback to existing OSM approach
    return fetchOsmVegetationFallback(bounds, outputWidth, outputHeight);
  }
}
