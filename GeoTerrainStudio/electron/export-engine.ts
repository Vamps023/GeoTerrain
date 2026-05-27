/**
 * GeoTerrain Export Engine - Refactored
 *
 * Downloads DEM (AWS Terrarium) and imagery (ArcGIS World Imagery) tiles,
 * merges them, crops to the exact selected bounds, resizes to the target
 * resolution, and writes heightmap + albedo in the requested formats.
 *
 * Features:
 * - Proper Float32/Int16/UInt16 GeoTIFF export
 * - Unique tile naming system
 * - Tile count protection with memory estimation
 * - Parallel download queue with bounded concurrency
 * - Memory-efficient chunked processing
 * - Export validation
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { writeGeoTIFF, GeoTIFFCompression } from './geotiff-writer';
import { fromArrayBuffer } from 'geotiff';
import { generateMasks } from './mask-generator';
import type { MaskGenerationOptions, MaskResult } from './mask-generator';

// ─── Constants ─────────────────────────────────────────────────

const TILE_SIZE = 256;
const MAX_CONCURRENT_DOWNLOADS = 6;
const MAX_TILES_PER_EXPORT = 1024; // Safety limit
const MAX_MEMORY_MB = 2048; // 2GB safety limit

/**
 * Exhaustive switch check helper. When used as the default case in a switch
 * on a union type, TypeScript will error at compile time if any case is missing.
 */
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}

/**
 * Redact sensitive tokens/keys from URLs before logging.
 * Handles API_Key, access_token, and key query parameters.
 */
function redactUrl(url: string): string {
  return url
    .replace(/API_Key=[^&]+/gi, 'API_Key=****')
    .replace(/access_token=[^&]+/gi, 'access_token=****')
    .replace(/\bkey=[^&]+/gi, 'key=****');
}

// ─── Types ─────────────────────────────────────────────────────

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type HeightmapFormat = 'dem' | 'geotiff' | 'r16' | 'png' | 'float32';
type AlbedoFormat = 'png' | 'geotiff';
type DEMSource =
  | 'aws-terrarium'
  | 'mapzen'
  | 'mapbox-terrain-rgb'
  // OpenTopography API sources (require free API key, return GeoTIFF directly)
  | 'opentopo-srtmgl1'    // SRTM GL1, ~30m global
  | 'opentopo-srtmgl3'    // SRTM GL3, ~90m global
  | 'opentopo-aw3d30'     // ALOS AW3D30, ~30m global
  | 'opentopo-cop30'      // Copernicus GLO-30, ~30m best quality
  | 'opentopo-nasadem'    // NASADEM, ~30m reprocessed
  | 'opentopo-usgs10m'    // USGS 3DEP, ~10m USA only
  // NASA Earthdata direct (requires free Earthdata bearer token, no rate limit)
  | 'nasa-earthdata';     // NASADEM via NASA LP DAAC, ~30m global

const OPENTOPO_SOURCES: DEMSource[] = [
  'opentopo-srtmgl1',
  'opentopo-srtmgl3',
  'opentopo-aw3d30',
  'opentopo-cop30',
  'opentopo-nasadem',
  'opentopo-usgs10m',
];

function isOpenTopoSource(source: DEMSource): boolean {
  return OPENTOPO_SOURCES.includes(source);
}

function getOpenTopoDemType(source: DEMSource): string {
  switch (source) {
    case 'opentopo-srtmgl1': return 'SRTMGL1';
    case 'opentopo-srtmgl3': return 'SRTMGL3';
    case 'opentopo-aw3d30': return 'AW3D30';
    case 'opentopo-cop30': return 'COP30';
    case 'opentopo-nasadem': return 'NASADEM';
    case 'opentopo-usgs10m': return 'USGS10m';
    case 'aws-terrarium':
    case 'mapzen':
    case 'mapbox-terrain-rgb':
    case 'nasa-earthdata':
      throw new Error(`getOpenTopoDemType called with non-OpenTopo source: ${source}`);
    default: return assertNever(source);
  }
}

function getDEMSourceInfo(source: DEMSource): { name: string; attribution: string } {
  switch (source) {
    case 'aws-terrarium':
      return { name: 'AWS Terrain Tiles (Terrarium)', attribution: 'Mapzen / AWS' };
    case 'mapzen':
      return { name: 'Mapzen Terrain Tiles', attribution: 'Mapzen' };
    case 'mapbox-terrain-rgb':
      return { name: 'Mapbox Terrain RGB', attribution: 'Mapbox' };
    case 'opentopo-srtmgl1':
      return { name: 'SRTM GL1 (30m)', attribution: 'NASA / OpenTopography' };
    case 'opentopo-srtmgl3':
      return { name: 'SRTM GL3 (90m)', attribution: 'NASA / OpenTopography' };
    case 'opentopo-aw3d30':
      return { name: 'ALOS World 3D (30m)', attribution: 'JAXA / OpenTopography' };
    case 'opentopo-cop30':
      return { name: 'Copernicus GLO-30', attribution: 'ESA / OpenTopography' };
    case 'opentopo-nasadem':
      return { name: 'NASADEM (30m)', attribution: 'NASA / OpenTopography' };
    case 'opentopo-usgs10m':
      return { name: 'USGS 3DEP (10m)', attribution: 'USGS / OpenTopography' };
    case 'nasa-earthdata':
      return { name: 'Copernicus GLO-30 (30m) via AWS', attribution: 'ESA / Copernicus' };
    default:
      return assertNever(source);
  }
}

type ImagerySource = 'arcgis' | 'mapbox' | 'maptiler';

interface ExportOptions {
  sessionId: string;
  outputPath: string;
  preset: string;
  bounds: GeoBounds;
  heightmapFormat: HeightmapFormat;
  albedoFormat: AlbedoFormat;
  heightmapSize?: number;
  albedoSize?: number;
  demSource?: DEMSource;
  imagerySource?: ImagerySource;
  imageryZoom?: number;
  tileRow?: number;
  tileCol?: number;
  compression?: GeoTIFFCompression;
  // API keys (passed from settings, fallback to env vars)
  opentopographyApiKey?: string;
  mapboxAccessToken?: string;
  maptilerApiKey?: string;
  // Mask generation settings
  maskSettings?: MaskSettings;
}

interface MaskSettings {
  generateRoadMask: boolean;
  generateWaterMask: boolean;
  generateVegetationMask: boolean;
  generateBuildingMask: boolean;
  generateCliffMask: boolean;
  cliffThresholdDegrees: number;
  roadLineWidthPx: number;
}

interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  zoom: number;
}

interface ExportValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimatedTiles: number;
  estimatedMemoryBytes: number;
}

interface ElevationMetadata {
  min: number;
  max: number;
  range: number;
  hasNoData: boolean;
}

function estimateTileSizeMeters(bounds: GeoBounds): { widthM: number; heightM: number; chunkSizeM: number } {
  const midLatRad = ((bounds.north + bounds.south) * 0.5 * Math.PI) / 180.0;
  const metersPerDegLat = 111320.0;
  const metersPerDegLon = metersPerDegLat * Math.cos(midLatRad);
  const widthM = Math.max(1.0, (bounds.east - bounds.west) * metersPerDegLon);
  const heightM = Math.max(1.0, (bounds.north - bounds.south) * metersPerDegLat);
  return { widthM, heightM, chunkSizeM: Math.max(widthM, heightM) };
}

// ─── Validation & Safety ──────────────────────────────────────

export function validateExport(options: ExportOptions): ExportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const {
    bounds,
    heightmapSize = 1024,
    albedoSize = 1024,
    imageryZoom = 0,
    demSource = 'aws-terrarium',
  } = options;

  const demIsOpenTopo = isOpenTopoSource(demSource);

  // Validate bounds
  if (bounds.west >= bounds.east) {
    errors.push('Invalid bounds: west must be less than east');
  }
  if (bounds.south >= bounds.north) {
    errors.push('Invalid bounds: south must be less than north');
  }
  if (bounds.west < -180 || bounds.east > 180) {
    errors.push('Invalid bounds: longitude out of range (-180 to 180)');
  }
  if (bounds.south < -90 || bounds.north > 90) {
    errors.push('Invalid bounds: latitude out of range (-90 to 90)');
  }

  // Calculate estimated tiles
  const demZoom = chooseZoom(bounds, heightmapSize, 15);
  const imgZoom = imageryZoom > 0 ? imageryZoom : chooseZoom(bounds, albedoSize, 19);

  const demRange = getTileRange(bounds, demZoom);
  const imgRange = getTileRange(bounds, imgZoom);

  const demTilesX = demRange.maxX - demRange.minX + 1;
  const demTilesY = demRange.maxY - demRange.minY + 1;
  const imgTilesX = imgRange.maxX - imgRange.minX + 1;
  const imgTilesY = imgRange.maxY - imgRange.minY + 1;

  // OpenTopography is a single GeoTIFF request (not tiled)
  const demTileCount = demIsOpenTopo ? 1 : demTilesX * demTilesY;
  const imgTileCount = imgTilesX * imgTilesY;
  const totalTiles = demTileCount + imgTileCount;

  // Estimate memory usage
  const demPixels = demIsOpenTopo
    ? heightmapSize * heightmapSize
    : demTilesX * TILE_SIZE * demTilesY * TILE_SIZE;
  const imgPixels = imgTilesX * TILE_SIZE * imgTilesY * TILE_SIZE;
  const estimatedMemoryBytes = (demPixels * 4) + (imgPixels * 4);

  // Check limits
  if (totalTiles > MAX_TILES_PER_EXPORT) {
    errors.push(
      `Export too large: ${totalTiles} tiles exceeds maximum of ${MAX_TILES_PER_EXPORT}. ` +
      `Reduce bounding box area or use lower zoom levels.`
    );
  }

  if (estimatedMemoryBytes > MAX_MEMORY_MB * 1024 * 1024) {
    errors.push(
      `Export would require ~${Math.round(estimatedMemoryBytes / 1024 / 1024)}MB RAM, ` +
      `exceeding safety limit of ${MAX_MEMORY_MB}MB. Reduce tile count or zoom level.`
    );
  }

  // Warnings
  if (totalTiles > 256) {
    warnings.push(`Large export: ${totalTiles} tiles. Download may take several minutes.`);
  }

  if (imgZoom > 17) {
    warnings.push(`Very high imagery zoom (${imgZoom}) may result in slow downloads.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    estimatedTiles: totalTiles,
    estimatedMemoryBytes,
  };
}

// ─── Tile Math ────────────────────────────────────────────────

function lngToPixelX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom) * TILE_SIZE;
}

function latToPixelY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
    2 *
    Math.pow(2, zoom) *
    TILE_SIZE
  );
}

function lngToTileX(lng: number, zoom: number): number {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 *
    Math.pow(2, zoom)
  );
}

function tileXToLng(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function chooseZoom(bounds: GeoBounds, targetSize: number, maxZoom = 19): number {
  const widthDeg = bounds.east - bounds.west;
  const heightDeg = bounds.north - bounds.south;
  const minDimDeg = Math.min(widthDeg, heightDeg);
  if (minDimDeg <= 0) return 10;
  const z = Math.log2((targetSize * 360) / (minDimDeg * TILE_SIZE));
  return Math.max(1, Math.min(maxZoom, Math.ceil(z)));
}

function getTileRange(bounds: GeoBounds, zoom: number): TileRange {
  return {
    minX: lngToTileX(bounds.west, zoom),
    maxX: lngToTileX(bounds.east, zoom),
    minY: latToTileY(bounds.north, zoom),
    maxY: latToTileY(bounds.south, zoom),
    zoom,
  };
}

// ─── Parallel Download Queue ──────────────────────────────────

interface DownloadTask<T> {
  url: string;
  x: number;
  y: number;
  processor: (buffer: Buffer) => Promise<T> | T;
}

interface DownloadResult<T> {
  x: number;
  y: number;
  data: T;
  success: boolean;
  error?: string;
}

async function downloadBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
  if (maxRedirects <= 0) {
    throw new Error(`[Download] Too many redirects for ${redactUrl(url)}`);
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers.location;
        if (loc) {
          downloadBuffer(loc, maxRedirects - 1).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode === 401) {
        const isOpenTopo = url.includes('opentopography.org');
        if (isOpenTopo) {
          // OpenTopography returns 401 for both invalid keys AND rate limits.
          // Collect the response body to distinguish between the two.
          const errChunks: Buffer[] = [];
          res.on('data', (chunk) => errChunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(errChunks).toString('utf-8');
            if (body.includes('rate limit')) {
              reject(new Error(
                'OpenTopography API rate limit reached (50 calls/24hrs). ' +
                'Wait 24 hours or switch to AWS Terrarium (free, no limit).'
              ));
            } else {
              reject(new Error(
                'HTTP 401: OpenTopography API key invalid or unauthorized for this dataset. ' +
                'Check your key at https://portal.opentopography.org/myopentopo'
              ));
            }
          });
        } else {
          res.resume();
          reject(new Error('HTTP 401 Unauthorized'));
        }
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${redactUrl(url)}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${redactUrl(url)}`));
    });
  });
}

async function downloadTileWithRetry(url: string, retries = 3): Promise<Buffer> {
  for (let i = 0; i < retries; i++) {
    try {
      return await downloadBuffer(url);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error('Unreachable');
}

async function parallelDownload<T>(
  tasks: DownloadTask<T>[],
  maxConcurrency = MAX_CONCURRENT_DOWNLOADS,
  onProgress?: (completed: number, total: number) => void
): Promise<DownloadResult<T>[]> {
  const results: DownloadResult<T>[] = [];
  let completed = 0;

  async function processTask(task: DownloadTask<T>): Promise<void> {
    try {
      const buffer = await downloadTileWithRetry(task.url);
      const data = await task.processor(buffer);
      results.push({ x: task.x, y: task.y, data, success: true });
    } catch (err) {
      results.push({
        x: task.x,
        y: task.y,
        data: null as unknown as T,
        success: false,
        error: (err as Error).message,
      });
    }
    completed++;
    if (onProgress) {
      onProgress(completed, tasks.length);
    }
  }

  // Process in batches
  for (let i = 0; i < tasks.length; i += maxConcurrency) {
    const batch = tasks.slice(i, i + maxConcurrency);
    await Promise.all(batch.map(processTask));
  }

  return results;
}

// ─── OpenTopography API ───────────────────────────────────────

/**
 * Fetch a DEM from OpenTopography Global DEM API.
 * Returns a single GeoTIFF covering the entire bbox (no tiling).
 *
 * Requires OPENTOPOGRAPHY_API_KEY env var. Get a free key at:
 * https://portal.opentopography.org/myopentopo
 */
async function fetchOpenTopoDEM(
  bounds: GeoBounds,
  source: DEMSource,
  apiKeyArg?: string
): Promise<{ elevations: Float32Array; width: number; height: number }> {
  const apiKey = (apiKeyArg || process.env.OPENTOPOGRAPHY_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'OpenTopography API key is required. ' +
      'Add it in the Export panel → API Keys section, or get a free key at https://portal.opentopography.org/myopentopo'
    );
  }

  const demType = getOpenTopoDemType(source);
  const url =
    `https://portal.opentopography.org/API/globaldem?` +
    `demtype=${demType}` +
    `&south=${bounds.south}` +
    `&north=${bounds.north}` +
    `&west=${bounds.west}` +
    `&east=${bounds.east}` +
    `&outputFormat=GTiff` +
    `&API_Key=${encodeURIComponent(apiKey)}`;

  console.log(`[OpenTopo] Requesting ${demType} for bbox: ${bounds.west},${bounds.south},${bounds.east},${bounds.north} (API key: ${apiKey.substring(0, 4)}***)`);

  const buffer = await downloadBuffer(url);

  // Validate response is actually a GeoTIFF (not an error message)
  if (buffer.length < 100) {
    throw new Error(`OpenTopography returned suspiciously small response (${buffer.length} bytes): ${buffer.toString('utf-8').substring(0, 200)}`);
  }

  // Check TIFF magic bytes
  const isTiff =
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || // little-endian
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a);   // big-endian

  if (!isTiff) {
    throw new Error(`OpenTopography did not return a TIFF. Response: ${buffer.toString('utf-8').substring(0, 500)}`);
  }

  // Parse GeoTIFF
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters();
  const raw = rasters[0] as Int16Array | Float32Array | Uint16Array;

  // Convert to Float32Array for consistent downstream processing
  const elevations = new Float32Array(width * height);
  const noDataValue = image.getGDALNoData();

  // Only replace noData pixels if a noData value is actually defined
  if (noDataValue !== null && noDataValue !== undefined) {
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      elevations[i] = v === noDataValue ? 0 : v;
    }
  } else {
    // No noData value defined — all pixel values are valid elevation data
    for (let i = 0; i < raw.length; i++) {
      elevations[i] = raw[i];
    }
  }

  console.log(`[OpenTopo] Received ${demType}: ${width}x${height} pixels, ${(buffer.length / 1024).toFixed(1)} KB`);

  return { elevations, width, height };
}

// ─── NASA Earthdata Direct DEM Download ───────────────────────

/**
 * Fetches Copernicus GLO-30 DEM data directly from AWS Open Data (S3).
 * Downloads the needed 1°×1° GeoTIFF tile(s), reads the georeferencing from
 * the GeoTIFF metadata, and crops to the exact requested bounds.
 *
 * NO authentication required. NO rate limit. Free and open.
 * Same data as OpenTopography's "Copernicus GLO-30" but without the 50 calls/day limit.
 */
async function fetchNasaEarthdataDEM(
  bounds: GeoBounds,
  _bearerTokenArg?: string
): Promise<{ elevations: Float32Array; width: number; height: number }> {
  // Determine which 1°×1° tiles we need
  const minLat = Math.floor(bounds.south);
  const maxLat = Math.floor(bounds.north);
  const minLon = Math.floor(bounds.west);
  const maxLon = Math.floor(bounds.east);

  // Download all needed tiles
  const tileData: Array<{
    elevations: Float32Array;
    width: number;
    height: number;
    originLat: number; // geographic lat of pixel row 0 (north edge)
    originLon: number; // geographic lon of pixel col 0 (west edge)
    pixelWidth: number; // degrees per pixel in X
    pixelHeight: number; // degrees per pixel in Y (positive = south)
  }> = [];

  for (let lat = minLat; lat <= maxLat; lat++) {
    for (let lon = minLon; lon <= maxLon; lon++) {
      const tile = await fetchCopernicusDEMTileWithGeo(lat, lon);
      tileData.push(tile);
    }
  }

  if (tileData.length === 0) {
    throw new Error('No Copernicus DEM tiles found for the selected area');
  }

  if (tileData.length === 1) {
    // Single tile — crop using its georeferencing
    const t = tileData[0];
    return cropUsingGeoref(t.elevations, t.width, t.height, t.originLat, t.originLon, t.pixelWidth, t.pixelHeight, bounds);
  }

  // Multiple tiles — merge then crop
  const numTilesLat = maxLat - minLat + 1;
  const numTilesLon = maxLon - minLon + 1;
  const tileW = tileData[0].width;
  const tileH = tileData[0].height;
  const mergedWidth = numTilesLon * tileW;
  const mergedHeight = numTilesLat * tileH;
  const merged = new Float32Array(mergedWidth * mergedHeight);

  for (const t of tileData) {
    // Determine grid position from the tile's origin coordinates
    const tileCol = Math.round((t.originLon - minLon) / 1);
    const tileRow = Math.round((maxLat + 1 - t.originLat) / 1);
    const offsetX = tileCol * tileW;
    const offsetY = tileRow * tileH;

    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const dx = offsetX + x;
        const dy = offsetY + y;
        if (dx < mergedWidth && dy < mergedHeight) {
          merged[dy * mergedWidth + dx] = t.elevations[y * t.width + x];
        }
      }
    }
  }

  // Crop merged grid using georeferencing of the full merged area
  const mergedOriginLat = maxLat + 1; // north edge
  const mergedOriginLon = minLon;     // west edge
  const pixelW = tileData[0].pixelWidth;
  const pixelH = tileData[0].pixelHeight;

  return cropUsingGeoref(merged, mergedWidth, mergedHeight, mergedOriginLat, mergedOriginLon, pixelW, pixelH, bounds);
}

/**
 * Crops elevation data using actual georeferencing parameters.
 * originLat = latitude of the TOP edge (north) of pixel row 0
 * originLon = longitude of the LEFT edge (west) of pixel col 0
 * pixelWidth = degrees per pixel in longitude (positive, going east)
 * pixelHeight = degrees per pixel in latitude (positive, going south)
 */
function cropUsingGeoref(
  elevations: Float32Array,
  srcWidth: number,
  srcHeight: number,
  originLat: number,
  originLon: number,
  pixelWidth: number,
  pixelHeight: number,
  bounds: GeoBounds
): { elevations: Float32Array; width: number; height: number } {
  // Convert target bounds to pixel coordinates
  const startCol = Math.max(0, Math.floor((bounds.west - originLon) / pixelWidth));
  const endCol = Math.min(srcWidth - 1, Math.ceil((bounds.east - originLon) / pixelWidth) - 1);
  const startRow = Math.max(0, Math.floor((originLat - bounds.north) / pixelHeight));
  const endRow = Math.min(srcHeight - 1, Math.ceil((originLat - bounds.south) / pixelHeight) - 1);

  const cropWidth = Math.max(1, endCol - startCol + 1);
  const cropHeight = Math.max(1, endRow - startRow + 1);

  console.log(`[COP30] Crop: origin=(${originLat},${originLon}), px=(${pixelWidth.toFixed(6)},${pixelHeight.toFixed(6)}), src=${srcWidth}x${srcHeight}, bounds=[${bounds.south.toFixed(4)},${bounds.west.toFixed(4)}→${bounds.north.toFixed(4)},${bounds.east.toFixed(4)}], pixels=[col ${startCol}-${endCol}, row ${startRow}-${endRow}], result=${cropWidth}x${cropHeight}`);

  const cropped = new Float32Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      cropped[y * cropWidth + x] = elevations[(startRow + y) * srcWidth + (startCol + x)];
    }
  }

  return { elevations: cropped, width: cropWidth, height: cropHeight };
}

/**
 * Downloads a Copernicus GLO-30 tile and extracts its georeferencing metadata.
 */
async function fetchCopernicusDEMTileWithGeo(
  lat: number,
  lon: number
): Promise<{
  elevations: Float32Array;
  width: number;
  height: number;
  originLat: number;
  originLon: number;
  pixelWidth: number;
  pixelHeight: number;
}> {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  const latStr = String(Math.abs(lat)).padStart(2, '0');
  const lonStr = String(Math.abs(lon)).padStart(3, '0');
  const tileName = `Copernicus_DSM_COG_10_${latDir}${latStr}_00_${lonDir}${lonStr}_00_DEM`;

  const url = `https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/${tileName}/${tileName}.tif`;

  console.log(`[COP30] Downloading tile: ${latDir}${latStr} ${lonDir}${lonStr}`);

  const buffer = await downloadBuffer(url);

  if (buffer.length < 100) {
    throw new Error(`Copernicus DEM tile ${latDir}${latStr}${lonDir}${lonStr} returned empty response`);
  }

  // Parse GeoTIFF
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  // Extract georeferencing from GeoTIFF metadata
  const origin = image.getOrigin(); // [originX (lon), originY (lat), ...]
  const resolution = image.getResolution(); // [pixelWidth, pixelHeight (negative for north-up), ...]

  const originLon = origin[0];
  const originLat = origin[1];
  const pixelWidth = Math.abs(resolution[0]);
  const pixelHeight = Math.abs(resolution[1]);

  console.log(`[COP30] Tile ${latDir}${latStr}${lonDir}${lonStr}: ${width}x${height}px, origin=(${originLat.toFixed(4)}, ${originLon.toFixed(4)}), res=(${pixelWidth.toFixed(6)}°, ${pixelHeight.toFixed(6)}°), ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  const rasters = await image.readRasters();
  const raw = rasters[0] as Float32Array | Int16Array | Uint16Array;

  // Convert to Float32Array
  const elevations = new Float32Array(width * height);
  const noDataValue = image.getGDALNoData();

  if (noDataValue !== null && noDataValue !== undefined) {
    for (let i = 0; i < raw.length; i++) {
      elevations[i] = raw[i] === noDataValue ? 0 : raw[i];
    }
  } else {
    for (let i = 0; i < raw.length; i++) {
      elevations[i] = raw[i];
    }
  }

  return { elevations, width, height, originLat, originLon, pixelWidth, pixelHeight };
}

// ─── DEM Decode ───────────────────────────────────────────────

function decodeTerrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

// Mapbox Terrain-RGB encoding: elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
// Higher precision than Terrarium (0.1m vs 1m)
function decodeMapboxTerrainRGB(r: number, g: number, b: number): number {
  return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
}

async function decodeDEMTile(buffer: Buffer, source: DEMSource): Promise<Float32Array> {
  const { data, info } = await sharp(buffer)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const elevations = new Float32Array(w * h);

  const decoder = source === 'mapbox-terrain-rgb' ? decodeMapboxTerrainRGB : decodeTerrariumElevation;

  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4 + 0];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    elevations[i] = decoder(r, g, b);
  }

  return elevations;
}

// ─── Memory-Efficient Merge & Crop ─────────────────────────────

function mergeDEMTiles(
  tiles: Array<{ x: number; y: number; elevations: Float32Array }>,
  range: TileRange
): { elevations: Float32Array; width: number; height: number } {
  const tilesX = range.maxX - range.minX + 1;
  const tilesY = range.maxY - range.minY + 1;
  const w = tilesX * TILE_SIZE;
  const h = tilesY * TILE_SIZE;
  const elevations = new Float32Array(w * h);

  for (const tile of tiles) {
    const offsetX = (tile.x - range.minX) * TILE_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_SIZE;

    // Fast copy using typed array
    for (let ty = 0; ty < TILE_SIZE; ty++) {
      const srcStart = ty * TILE_SIZE;
      const dstStart = (offsetY + ty) * w + offsetX;
      elevations.set(tile.elevations.subarray(srcStart, srcStart + TILE_SIZE), dstStart);
    }
  }

  return { elevations, width: w, height: h };
}

async function mergeImageryTilesChunked(
  tiles: Array<{ x: number; y: number; buffer: Buffer }>,
  range: TileRange,
  onProgress?: (completed: number, total: number) => void
): Promise<Buffer> {
  const tilesX = range.maxX - range.minX + 1;
  const tilesY = range.maxY - range.minY + 1;
  const canvasW = tilesX * TILE_SIZE;
  const canvasH = tilesY * TILE_SIZE;

  // Guard against OOM: reject if merged buffer would exceed 512MB
  const requiredBytes = canvasW * canvasH * 4; // RGBA
  const MAX_MERGE_BYTES = 512 * 1024 * 1024; // 512 MB
  if (requiredBytes > MAX_MERGE_BYTES) {
    throw new Error(
      `[Export] Imagery merge would require ${Math.round(requiredBytes / (1024 * 1024))}MB ` +
      `(${canvasW}x${canvasH} pixels), exceeding the ${Math.round(MAX_MERGE_BYTES / (1024 * 1024))}MB safety limit. ` +
      `Reduce the export area, lower the imagery zoom level, or use fewer tiles.`
    );
  }

  // Build merged canvas as raw RGBA
  const canvas = Buffer.alloc(requiredBytes);
  canvas.fill(0);

  let processed = 0;

  for (const tile of tiles) {
    const { data, info } = await sharp(tile.buffer)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const tileW = info.width;
    const tileH = info.height;
    const offsetX = (tile.x - range.minX) * TILE_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_SIZE;

    // Fast pixel copy
    for (let ty = 0; ty < tileH; ty++) {
      const srcRowStart = ty * tileW * 4;
      const dstRowStart = ((offsetY + ty) * canvasW + offsetX) * 4;

      for (let tx = 0; tx < tileW; tx++) {
        const srcIdx = srcRowStart + tx * 4;
        const dstIdx = dstRowStart + tx * 4;
        canvas[dstIdx] = data[srcIdx];
        canvas[dstIdx + 1] = data[srcIdx + 1];
        canvas[dstIdx + 2] = data[srcIdx + 2];
        canvas[dstIdx + 3] = data[srcIdx + 3];
      }
    }

    processed++;
    if (onProgress) {
      onProgress(processed, tiles.length);
    }
  }

  return canvas;
}

function cropDEM(
  elevations: Float32Array,
  fullW: number,
  fullH: number,
  bounds: GeoBounds,
  range: TileRange,
  zoom: number
): { elevations: Float32Array; width: number; height: number } {
  const pxWest = lngToPixelX(bounds.west, zoom);
  const pxEast = lngToPixelX(bounds.east, zoom);
  const pxNorth = latToPixelY(bounds.north, zoom);
  const pxSouth = latToPixelY(bounds.south, zoom);

  const fullPxWest = lngToPixelX(tileXToLng(range.minX, zoom), zoom);
  const fullPxNorth = latToPixelY(tileYToLat(range.minY, zoom), zoom);

  const left = Math.round(pxWest - fullPxWest);
  const top = Math.round(pxNorth - fullPxNorth);
  const width = Math.round(Math.abs(pxEast - pxWest));
  const height = Math.round(Math.abs(pxSouth - pxNorth));

  if (width <= 0 || height <= 0) {
    throw new Error(`[cropDEM] Invalid crop dimensions: width=${width}, height=${height}. Check bounds coordinates.`);
  }

  const cropped = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const srcY = top + y;
    const dstRowStart = y * width;
    const srcRowStart = srcY * fullW;

    for (let x = 0; x < width; x++) {
      const srcX = left + x;
      if (srcX >= 0 && srcX < fullW && srcY >= 0 && srcY < fullH) {
        cropped[dstRowStart + x] = elevations[srcRowStart + srcX];
      } else {
        cropped[dstRowStart + x] = 0;
      }
    }
  }

  return { elevations: cropped, width, height };
}

async function cropImagery(
  merged: Buffer,
  fullW: number,
  fullH: number,
  bounds: GeoBounds,
  range: TileRange,
  zoom: number
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const pxWest = lngToPixelX(bounds.west, zoom);
  const pxEast = lngToPixelX(bounds.east, zoom);
  const pxNorth = latToPixelY(bounds.north, zoom);
  const pxSouth = latToPixelY(bounds.south, zoom);

  const fullPxWest = lngToPixelX(tileXToLng(range.minX, zoom), zoom);
  const fullPxNorth = latToPixelY(tileYToLat(range.minY, zoom), zoom);

  const left = Math.round(pxWest - fullPxWest);
  const top = Math.round(pxNorth - fullPxNorth);
  const width = Math.round(Math.abs(pxEast - pxWest));
  const height = Math.round(Math.abs(pxSouth - pxNorth));

  const cropped = await sharp(merged, { raw: { width: fullW, height: fullH, channels: 4 } })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer();

  return { buffer: cropped, width, height };
}

// ─── Resize ─────────────────────────────────────────────────────

function resizeDEM(
  elevations: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  if (dstW < 2 || dstH < 2) {
    throw new Error(`[resizeDEM] Target dimensions must be at least 2x2, got ${dstW}x${dstH}`);
  }
  // Use PixelIsPoint sampling: dst pixel positions map to fractional source positions
  // This ensures adjacent tile edges share exact values (last pixel = src[W-1])
  // Bilinear interpolation prevents aliasing
  const result = new Float32Array(dstW * dstH);

  const sxScale = (srcW - 1) / (dstW - 1 || 1);
  const syScale = (srcH - 1) / (dstH - 1 || 1);

  for (let y = 0; y < dstH; y++) {
    const sy = y * syScale;
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(sy0 + 1, srcH - 1);
    const fy = sy - sy0;

    for (let x = 0; x < dstW; x++) {
      const sx = x * sxScale;
      const sx0 = Math.floor(sx);
      const sx1 = Math.min(sx0 + 1, srcW - 1);
      const fx = sx - sx0;

      // Bilinear interpolation
      const v00 = elevations[sy0 * srcW + sx0];
      const v01 = elevations[sy0 * srcW + sx1];
      const v10 = elevations[sy1 * srcW + sx0];
      const v11 = elevations[sy1 * srcW + sx1];

      const top = v00 * (1 - fx) + v01 * fx;
      const bot = v10 * (1 - fx) + v11 * fx;
      result[y * dstW + x] = top * (1 - fy) + bot * fy;
    }
  }

  return result;
}

async function resizeImagery(
  buffer: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Promise<Buffer> {
  const isDownsampling = srcW > dstW || srcH > dstH;
  const kernel = isDownsampling ? sharp.kernel.lanczos3 : sharp.kernel.nearest;

  return sharp(buffer, { raw: { width: srcW, height: srcH, channels: 4 } })
    .resize(dstW, dstH, { kernel, fit: 'fill' })
    .raw()
    .toBuffer();
}

// ─── Elevation Metadata ───────────────────────────────────────

function computeElevationMetadata(elevations: Float32Array): ElevationMetadata {
  let min = Infinity;
  let max = -Infinity;
  let hasNoData = false;

  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (isNaN(v) || v === -Infinity) {
      hasNoData = true;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min === Infinity) {
    min = 0;
    max = 0;
  }

  return {
    min,
    max,
    range: max - min,
    hasNoData,
  };
}

// ─── Write Formats ────────────────────────────────────────────

async function writeHeightmapPNG(
  elevations: Float32Array,
  width: number,
  height: number,
  outputPath: string,
  metadata: ElevationMetadata
): Promise<void> {
  const { min, max, range } = metadata;

  const uint16 = new Uint16Array(width * height);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = min;
    const norm = Math.round(((v - min) / (range || 1)) * 65535);
    uint16[i] = Math.max(0, Math.min(65535, norm));
  }

  await sharp(uint16, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function writeHeightmapR16(
  elevations: Float32Array,
  width: number,
  height: number,
  outputPath: string,
  metadata: ElevationMetadata
): Promise<void> {
  const { min, max, range } = metadata;

  const buf = Buffer.allocUnsafe(width * height * 2);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = min;
    const norm = Math.round(((v - min) / (range || 1)) * 65535);
    buf.writeUInt16LE(Math.max(0, Math.min(65535, norm)), i * 2);
  }

  await fs.promises.writeFile(outputPath, buf);
}

async function writeHeightmapGeoTIFFInt16(
  elevations: Float32Array,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string,
  compression: GeoTIFFCompression = 'none'
): Promise<void> {
  const int16 = new Int16Array(width * height);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = 0;
    int16[i] = Math.round(Math.max(-32768, Math.min(32767, v)));
  }

  const buf = writeGeoTIFF(int16, {
    width,
    height,
    bitsPerSample: 16,
    sampleFormat: 2, // signed integer
    samplesPerPixel: 1,
    photometricInterpretation: 1, // grayscale
    bounds,
    compression,
    rasterType: 'point', // Heightmaps use PixelIsPoint to prevent tile seams (UNIGINE)
  });

  await fs.promises.writeFile(outputPath, buf);
}

async function writeHeightmapGeoTIFFUint16(
  elevations: Float32Array,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string,
  compression: GeoTIFFCompression = 'none'
): Promise<void> {
  // Compute per-tile min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (isNaN(v) || v === -Infinity) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) { min = 0; max = 0; }
  const range = max - min;

  // Normalize elevations to 0–65535 range
  const uint16 = new Uint16Array(width * height);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = min;
    const norm = Math.round(((v - min) / (range || 1)) * 65535);
    uint16[i] = Math.max(0, Math.min(65535, norm));
  }

  const buf = writeGeoTIFF(uint16, {
    width,
    height,
    bitsPerSample: 16,
    sampleFormat: 1, // unsigned integer
    samplesPerPixel: 1,
    photometricInterpretation: 1, // grayscale
    bounds,
    compression,
    rasterType: 'point', // Heightmaps use PixelIsPoint to prevent tile seams (UNIGINE)
  });

  await fs.promises.writeFile(outputPath, buf);
}

async function writeHeightmapGeoTIFFFloat32(
  elevations: Float32Array,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string,
  compression: GeoTIFFCompression = 'none'
): Promise<void> {
  // Float32 preserves full elevation precision
  const float32 = new Float32Array(width * height);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = 0;
    float32[i] = v;
  }

  const buf = writeGeoTIFF(float32, {
    width,
    height,
    bitsPerSample: 32,
    sampleFormat: 3, // IEEE float
    samplesPerPixel: 1,
    photometricInterpretation: 1, // grayscale
    bounds,
    compression,
    rasterType: 'point', // Heightmaps use PixelIsPoint to prevent tile seams (UNIGINE)
  });

  await fs.promises.writeFile(outputPath, buf);
}

async function writeAlbedoPNG(
  rgba: Buffer,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function writeAlbedoGeoTIFF(
  rgba: Buffer,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string,
  compression: GeoTIFFCompression = 'none'
): Promise<void> {
  // Strip alpha to RGB
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }

  const buf = writeGeoTIFF(rgb, {
    width,
    height,
    bitsPerSample: 8,
    sampleFormat: 1, // unsigned integer
    samplesPerPixel: 3,
    photometricInterpretation: 2, // RGB
    bounds,
    compression,
  });

  await fs.promises.writeFile(outputPath, buf);
}

// ─── Tile Naming ──────────────────────────────────────────────

function generateTileFileNames(
  tileRow: number,
  tileCol: number,
  heightmapFormat: HeightmapFormat,
  albedoFormat: AlbedoFormat
): { heightmap: string; albedo: string } {
  const heightmapExt = getHeightmapExtension(heightmapFormat);
  const albedoExt = getAlbedoExtension(albedoFormat);

  return {
    heightmap: `tile_${tileRow}_${tileCol}_heightmap.${heightmapExt}`,
    albedo: `tile_${tileRow}_${tileCol}_albedo.${albedoExt}`,
  };
}

function getHeightmapExtension(format: HeightmapFormat): string {
  switch (format) {
    case 'png': return 'png';
    case 'r16': return 'r16';
    case 'float32': return 'tif';
    case 'geotiff': return 'tif';
    case 'dem': return 'tif';
    default: return assertNever(format);
  }
}

function getAlbedoExtension(format: AlbedoFormat): string {
  switch (format) {
    case 'geotiff': return 'tif';
    case 'png': return 'png';
    default: return assertNever(format);
  }
}

function getHeightmapFormatLabel(format: HeightmapFormat): string {
  switch (format) {
    case 'float32': return 'Float32 GeoTIFF';
    case 'geotiff': return 'UInt16 GeoTIFF (normalized)';
    case 'dem': return 'DEM (Int16 GeoTIFF)';
    case 'r16': return 'R16 (Raw 16-bit)';
    case 'png': return 'PNG (16-bit grayscale)';
    default: return assertNever(format);
  }
}

// ─── Main Export ──────────────────────────────────────────────

export async function executeExport(
  options: ExportOptions,
  onProgress?: (progress: { stage: string; current: number; total: number; message: string }) => void
): Promise<{
  manifestPath: string;
  elevationRange: { min: number; max: number };
  files: { heightmap: string; albedo: string };
}> {
  const {
    sessionId,
    outputPath,
    preset,
    bounds,
    heightmapFormat,
    albedoFormat,
    heightmapSize = 1024,
    albedoSize = 1024,
    demSource = 'aws-terrarium',
    imagerySource = 'arcgis',
    imageryZoom = 0,
    tileRow = 0,
    tileCol = 0,
    compression = 'none',
  } = options;

  // Validate export
  const validation = validateExport(options);
  if (!validation.valid) {
    throw new Error(`Export validation failed: ${validation.errors.join(', ')}`);
  }

  if (validation.warnings.length > 0) {
    console.warn('[Export] Warnings:', validation.warnings);
  }

  await fs.promises.mkdir(outputPath, { recursive: true });

  // Generate unique filenames
  const fileNames = generateTileFileNames(tileRow, tileCol, heightmapFormat, albedoFormat);

  // Choose zoom levels
  const demZoom = chooseZoom(bounds, heightmapSize, 15);
  const imgZoom = imageryZoom > 0 ? imageryZoom : chooseZoom(bounds, albedoSize, 19);

  console.log(`[Export] DEM source=${demSource} zoom=${demZoom}, Imagery source=${imagerySource} zoom=${imgZoom}`);
  console.log(`[Export] Output files: ${fileNames.heightmap}, ${fileNames.albedo}`);

  if (onProgress) {
    onProgress({ stage: 'setup', current: 0, total: 100, message: 'Starting export...' });
  }

  // ── Build URLs ───────────────────────────────────────────────
  function getDEMUrl(x: number, y: number, z: number): string {
    switch (demSource) {
      case 'mapbox-terrain-rgb': {
        const token = options.mapboxAccessToken || process.env.MAPBOX_ACCESS_TOKEN;
        if (!token) {
          throw new Error('Mapbox access token required for Mapbox Terrain-RGB. Add it in the Export panel → API Keys section, or get a free token at https://account.mapbox.com/');
        }
        // @2x = 512px tiles, higher precision
        return `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`;
      }
      case 'mapzen':
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
      case 'aws-terrarium':
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
      case 'opentopo-srtmgl1':
      case 'opentopo-srtmgl3':
      case 'opentopo-aw3d30':
      case 'opentopo-cop30':
      case 'opentopo-nasadem':
      case 'opentopo-usgs10m':
        throw new Error(`getDEMUrl called with OpenTopo source: ${demSource}. Use fetchOpenTopoDEM instead.`);
      case 'nasa-earthdata':
        throw new Error(`getDEMUrl called with NASA Earthdata source. Use fetchNasaEarthdataDEM instead.`);
      default: return assertNever(demSource);
    }
  }

  function getImageryUrl(x: number, y: number, z: number): string {
    switch (imagerySource) {
      case 'mapbox': {
        const token = options.mapboxAccessToken || process.env.MAPBOX_ACCESS_TOKEN;
        if (!token) {
          throw new Error('Mapbox access token required. Add it in the Export panel → API Keys section.');
        }
        return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.png?access_token=${token}`;
      }
      case 'maptiler': {
        const key = options.maptilerApiKey || process.env.MAPTILER_API_KEY;
        if (!key) {
          throw new Error('MapTiler API key required. Add it in the Export panel → API Keys section.');
        }
        return `https://api.maptiler.com/tiles/satellite/${z}/${x}/${y}.jpg?key=${key}`;
      }
      case 'arcgis':
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      default: return assertNever(imagerySource);
    }
  }

  // ── Download DEM ──────────────────────────────────────────────
  let demSourceData: { elevations: Float32Array; width: number; height: number };
  const demRange = getTileRange(bounds, demZoom);

  if (isOpenTopoSource(demSource)) {
    // OpenTopography returns a single GeoTIFF for the bbox
    if (onProgress) {
      onProgress({ stage: 'download_dem', current: 0, total: 1, message: `Requesting ${getOpenTopoDemType(demSource)} from OpenTopography...` });
    }
    demSourceData = await fetchOpenTopoDEM(bounds, demSource, options.opentopographyApiKey);
    if (onProgress) {
      onProgress({ stage: 'download_dem', current: 1, total: 1, message: `Downloaded ${getOpenTopoDemType(demSource)} (${demSourceData.width}x${demSourceData.height})` });
    }
  } else if (demSource === 'nasa-earthdata') {
    // NASA Earthdata: download NASADEM HGT tiles directly from LP DAAC
    if (onProgress) {
      onProgress({ stage: 'download_dem', current: 0, total: 1, message: 'Downloading NASADEM from NASA Earthdata...' });
    }
    demSourceData = await fetchNasaEarthdataDEM(bounds, options.opentopographyApiKey);
    if (onProgress) {
      onProgress({ stage: 'download_dem', current: 1, total: 1, message: `Downloaded NASADEM (${demSourceData.width}x${demSourceData.height})` });
    }
  } else {
    // Tile-based DEM (Terrarium, Mapbox)
    const demTasks: DownloadTask<Float32Array>[] = [];

    for (let y = demRange.minY; y <= demRange.maxY; y++) {
      for (let x = demRange.minX; x <= demRange.maxX; x++) {
        demTasks.push({
          url: getDEMUrl(x, y, demZoom),
          x,
          y,
          processor: async (buffer) => {
            try {
              return await decodeDEMTile(buffer, demSource);
            } catch (err) {
              console.warn(`[Export] Failed DEM tile ${x},${y}:`, (err as Error).message);
              return new Float32Array(TILE_SIZE * TILE_SIZE);
            }
          },
        });
      }
    }

    if (onProgress) {
      onProgress({ stage: 'download_dem', current: 0, total: demTasks.length, message: `Downloading ${demTasks.length} DEM tiles...` });
    }

    const demResults = await parallelDownload(
      demTasks,
      MAX_CONCURRENT_DOWNLOADS,
      (completed, total) => {
        if (onProgress) {
          onProgress({ stage: 'download_dem', current: completed, total, message: `Downloaded ${completed}/${total} DEM tiles` });
        }
      }
    );

    const demTiles = demResults
      .filter((r) => r.success)
      .map((r) => ({ x: r.x, y: r.y, elevations: r.data }));

    const merged = mergeDEMTiles(demTiles, demRange);
    const cropped = cropDEM(merged.elevations, merged.width, merged.height, bounds, demRange, demZoom);
    demSourceData = cropped;
  }

  // ── Download imagery tiles (parallel) ────────────────────────
  const imgRange = getTileRange(bounds, imgZoom);
  const imgTasks: DownloadTask<Buffer>[] = [];

  for (let y = imgRange.minY; y <= imgRange.maxY; y++) {
    for (let x = imgRange.minX; x <= imgRange.maxX; x++) {
      imgTasks.push({
        url: getImageryUrl(x, y, imgZoom),
        x,
        y,
        processor: (buffer) => buffer,
      });
    }
  }

  if (onProgress) {
    onProgress({ stage: 'download_imagery', current: 0, total: imgTasks.length, message: `Downloading ${imgTasks.length} imagery tiles...` });
  }

  const imgResults = await parallelDownload(
    imgTasks,
    MAX_CONCURRENT_DOWNLOADS,
    (completed, total) => {
      if (onProgress) {
        onProgress({ stage: 'download_imagery', current: completed, total, message: `Downloaded ${completed}/${total} imagery tiles` });
      }
    }
  );

  const imgTiles = await Promise.all(
    imgResults.map(async (r) => {
      if (r.success) {
        return { x: r.x, y: r.y, buffer: r.data };
      } else {
        // Create black tile as fallback
        const black = await sharp({
          create: { width: TILE_SIZE, height: TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
        })
          .png()
          .toBuffer();
        return { x: r.x, y: r.y, buffer: black };
      }
    })
  );

  // ── Process DEM ──────────────────────────────────────────────
  if (onProgress) {
    onProgress({ stage: 'process_dem', current: 0, total: 100, message: 'Processing DEM...' });
  }

  const resizedDEM = resizeDEM(
    demSourceData.elevations,
    demSourceData.width,
    demSourceData.height,
    heightmapSize,
    heightmapSize
  );

  // Compute elevation metadata
  const elevationMeta = computeElevationMetadata(resizedDEM);

  if (onProgress) {
    onProgress({ stage: 'process_imagery', current: 0, total: 100, message: 'Processing imagery...' });
  }

  // ── Process imagery ──────────────────────────────────────────
  const mergedImg = await mergeImageryTilesChunked(imgTiles, imgRange, (completed, total) => {
    if (onProgress) {
      onProgress({ stage: 'process_imagery', current: completed, total, message: `Merged ${completed}/${total} imagery tiles` });
    }
  });

  const imgFullW = (imgRange.maxX - imgRange.minX + 1) * TILE_SIZE;
  const imgFullH = (imgRange.maxY - imgRange.minY + 1) * TILE_SIZE;
  const { buffer: croppedImg, width: cropW, height: cropH } = await cropImagery(
    mergedImg,
    imgFullW,
    imgFullH,
    bounds,
    imgRange,
    imgZoom
  );
  const resizedImg = await resizeImagery(croppedImg, cropW, cropH, albedoSize, albedoSize);

  // ── Write heightmap ──────────────────────────────────────────
  if (onProgress) {
    onProgress({ stage: 'write_heightmap', current: 0, total: 100, message: `Writing ${getHeightmapFormatLabel(heightmapFormat)}...` });
  }

  const heightmapPath = path.join(outputPath, fileNames.heightmap);

  switch (heightmapFormat) {
    case 'png':
      await writeHeightmapPNG(resizedDEM, heightmapSize, heightmapSize, heightmapPath, elevationMeta);
      break;
    case 'r16':
      await writeHeightmapR16(resizedDEM, heightmapSize, heightmapSize, heightmapPath, elevationMeta);
      break;
    case 'float32':
      await writeHeightmapGeoTIFFFloat32(resizedDEM, heightmapSize, heightmapSize, bounds, heightmapPath, compression);
      break;
    case 'geotiff':
      await writeHeightmapGeoTIFFUint16(resizedDEM, heightmapSize, heightmapSize, bounds, heightmapPath, compression);
      break;
    case 'dem':
      await writeHeightmapGeoTIFFInt16(resizedDEM, heightmapSize, heightmapSize, bounds, heightmapPath, compression);
      break;
    default:
      assertNever(heightmapFormat);
  }

  // ── Write albedo ─────────────────────────────────────────────
  if (onProgress) {
    onProgress({ stage: 'write_albedo', current: 0, total: 100, message: 'Writing albedo...' });
  }

  const albedoPath = path.join(outputPath, fileNames.albedo);

  switch (albedoFormat) {
    case 'geotiff':
      await writeAlbedoGeoTIFF(resizedImg, albedoSize, albedoSize, bounds, albedoPath, compression);
      break;
    case 'png':
      await writeAlbedoPNG(resizedImg, albedoSize, albedoSize, albedoPath);
      break;
    default:
      assertNever(albedoFormat);
  }

  // ── Write manifest ───────────────────────────────────────────
  if (onProgress) {
    onProgress({ stage: 'write_manifest', current: 0, total: 100, message: 'Writing manifest...' });
  }

  // ── Generate terrain masks (if any enabled) ──────────────────
  const maskFiles: Record<string, string> = {};
  const { maskSettings } = options;

  console.log(`[Export] maskSettings from options:`, maskSettings ? JSON.stringify(maskSettings) : 'undefined');

  if (maskSettings && (
    maskSettings.generateRoadMask ||
    maskSettings.generateWaterMask ||
    maskSettings.generateVegetationMask ||
    maskSettings.generateBuildingMask ||
    maskSettings.generateCliffMask
  )) {
    if (onProgress) {
      onProgress({ stage: 'generate_masks', current: 0, total: 100, message: 'Generating terrain masks...' });
    }

    console.log(`[Export] Mask settings received:`, JSON.stringify(maskSettings));

    const tilePrefix = `tile_${tileRow}_${tileCol}`;

    const maskOptions: MaskGenerationOptions = {
      bounds,
      resolution: heightmapSize,
      outputPath,
      tilePrefix,
      generateRoadMask: maskSettings.generateRoadMask,
      generateWaterMask: maskSettings.generateWaterMask,
      generateVegetationMask: maskSettings.generateVegetationMask,
      generateBuildingMask: maskSettings.generateBuildingMask,
      generateCliffMask: maskSettings.generateCliffMask,
      cliffThresholdDegrees: maskSettings.cliffThresholdDegrees,
      roadLineWidthPx: maskSettings.roadLineWidthPx,
      onProgress: (message: string) => {
        if (onProgress) {
          onProgress({ stage: 'generate_masks', current: 0, total: 100, message });
        }
      },
    };

    try {
      const maskResult: MaskResult = await generateMasks(
        maskOptions,
        demSourceData.elevations,
        demSourceData.width,
        demSourceData.height
      );

      // Verify each mask file exists on disk before including in manifest
      const maskKeys: Array<{ key: keyof MaskResult; manifestKey: string }> = [
        { key: 'roadMask', manifestKey: 'roadMask' },
        { key: 'waterMask', manifestKey: 'waterMask' },
        { key: 'vegetationMask', manifestKey: 'vegetationMask' },
        { key: 'buildingMask', manifestKey: 'buildingMask' },
        { key: 'cliffMask', manifestKey: 'cliffMask' },
      ];

      for (const { key, manifestKey } of maskKeys) {
        const filename = maskResult[key];
        if (typeof filename === 'string' && filename.length > 0) {
          const fullPath = path.join(outputPath, filename);
          if (fs.existsSync(fullPath)) {
            maskFiles[manifestKey] = filename;
          } else {
            console.warn(`[Export] Mask file not found on disk, omitting from manifest: ${fullPath}`);
          }
        }
      }

      if (onProgress) {
        onProgress({ stage: 'generate_masks', current: 100, total: 100, message: `Mask generation complete (${maskResult.generationTimeMs}ms)` });
      }
    } catch (err) {
      const error = err as Error;
      // Disk write failures should abort the export
      if (error.message && (
        error.message.includes('ENOSPC') ||
        error.message.includes('EACCES') ||
        error.message.includes('EROFS') ||
        error.message.includes('EIO')
      )) {
        throw new Error(`Mask generation failed due to disk write error: ${error.message}`);
      }
      // Other mask generation failures are non-fatal — skip masks and continue
      console.warn(`[Export] Mask generation failed (non-fatal), continuing without masks:`, error.message);
    }
  }

  const { widthM: tileWidthM, heightM: tileHeightM, chunkSizeM } = estimateTileSizeMeters(bounds);
  const worldOffsetX = tileCol * tileWidthM;
  const worldOffsetZ = tileRow * tileHeightM;

  const demInfo = getDEMSourceInfo(demSource);

  const manifest = {
    version: '1.0.0',
    createdBy: 'GeoTerrain Studio',
    createdAt: new Date().toISOString(),
    terrainName: `Terrain_${sessionId}`,
    bounds,
    crs: 'EPSG:4326',
    tileGrid: {
      rows: 1,
      cols: 1,
      chunkSizeM,
      tileWidthM,
      tileHeightM,
      heightmapResolution: heightmapSize,
      albedoResolution: albedoSize,
    },
    tiles: [
      {
        row: tileRow,
        col: tileCol,
        bounds,
        worldOffset: { x: worldOffsetX, y: 0, z: worldOffsetZ },
        files: {
          heightmap: fileNames.heightmap,
          albedo: fileNames.albedo,
          ...(maskFiles.roadMask ? { roadMask: maskFiles.roadMask } : {}),
          ...(maskFiles.waterMask ? { waterMask: maskFiles.waterMask } : {}),
          ...(maskFiles.vegetationMask ? { vegetationMask: maskFiles.vegetationMask } : {}),
          ...(maskFiles.buildingMask ? { buildingMask: maskFiles.buildingMask } : {}),
          ...(maskFiles.cliffMask ? { cliffMask: maskFiles.cliffMask } : {}),
        },
        elevation: {
          min: Math.round(elevationMeta.min * 100) / 100,
          max: Math.round(elevationMeta.max * 100) / 100,
          units: 'meters' as const,
          actualMin: elevationMeta.min,
          actualMax: elevationMeta.max,
          hasNoData: elevationMeta.hasNoData,
        },
      },
    ],
    sources: {
      dem: { id: demSource, name: demInfo.name, attribution: demInfo.attribution },
      imagery: { id: imagerySource, name: imagerySource === 'arcgis' ? 'ArcGIS World Imagery' : imagerySource === 'mapbox' ? 'Mapbox Satellite' : 'MapTiler Satellite', attribution: imagerySource === 'arcgis' ? 'Esri' : imagerySource === 'mapbox' ? 'Mapbox' : 'MapTiler' },
    },
    exportPreset: preset,
    processing: {
      normalizeHeights: true,
      heightScale: 1.0,
      seamStitching: true,
      fillNodata: true,
      generateRoadMasks: maskSettings?.generateRoadMask ?? false,
      generateWaterMasks: maskSettings?.generateWaterMask ?? false,
      generateVegetationMasks: maskSettings?.generateVegetationMask ?? false,
      generateBuildingMasks: maskSettings?.generateBuildingMask ?? false,
      generateCliffMasks: maskSettings?.generateCliffMask ?? false,
      cliffThresholdDegrees: maskSettings?.cliffThresholdDegrees ?? 45.0,
    },
  };

  const manifestPath = path.join(outputPath, 'manifest.json');
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  if (onProgress) {
    onProgress({ stage: 'complete', current: 100, total: 100, message: 'Export complete!' });
  }

  console.log(`[Export] Complete. Output: ${outputPath}`);
  console.log(`[Export] Files: ${fileNames.heightmap}, ${fileNames.albedo}`);
  console.log(`[Export] Elevation range: ${elevationMeta.min.toFixed(2)}m to ${elevationMeta.max.toFixed(2)}m`);

  return {
    manifestPath: outputPath,
    elevationRange: { min: elevationMeta.min, max: elevationMeta.max },
    files: fileNames,
  };
}

// validateExport, computeElevationMetadata, and generateTileFileNames are already exported above
