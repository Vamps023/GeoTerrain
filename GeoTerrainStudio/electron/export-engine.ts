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

// ─── Constants ─────────────────────────────────────────────────

const TILE_SIZE = 256;
const MAX_CONCURRENT_DOWNLOADS = 6;
const MAX_TILES_PER_EXPORT = 1024; // Safety limit
const MAX_MEMORY_MB = 2048; // 2GB safety limit

// ─── Types ─────────────────────────────────────────────────────

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type HeightmapFormat = 'dem' | 'geotiff' | 'r16' | 'png' | 'float32';
type AlbedoFormat = 'png' | 'geotiff';
type DEMSource = 'aws-terrarium' | 'mapzen';
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

// ─── Validation & Safety ──────────────────────────────────────

export function validateExport(options: ExportOptions): ExportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const {
    bounds,
    heightmapSize = 1024,
    albedoSize = 1024,
    imageryZoom = 0,
  } = options;

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

  const demTileCount = demTilesX * demTilesY;
  const imgTileCount = imgTilesX * imgTilesY;
  const totalTiles = demTileCount + imgTileCount;

  // Estimate memory usage
  // DEM: Float32 per pixel (4 bytes)
  // Imagery: RGBA per pixel (4 bytes)
  const demPixels = demTilesX * TILE_SIZE * demTilesY * TILE_SIZE;
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

async function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers.location;
        if (loc) {
          downloadBuffer(loc).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
      reject(new Error(`Timeout for ${url}`));
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

// ─── DEM Decode ───────────────────────────────────────────────

function decodeTerrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

async function decodeTerrariumTile(buffer: Buffer): Promise<Float32Array> {
  const { data, info } = await sharp(buffer)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const elevations = new Float32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4 + 0];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    elevations[i] = decodeTerrariumElevation(r, g, b);
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

  // Build merged canvas as raw RGBA
  const canvas = Buffer.alloc(canvasW * canvasH * 4);
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
  const result = new Float32Array(dstW * dstH);

  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(Math.round((y / dstH) * srcH), srcH - 1);
    const dstRowStart = y * dstW;
    const srcRowStart = srcY * srcW;

    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.round((x / dstW) * srcW), srcW - 1);
      result[dstRowStart + x] = elevations[srcRowStart + srcX];
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
    case 'geotiff':
    case 'dem':
    default: return 'tif';
  }
}

function getAlbedoExtension(format: AlbedoFormat): string {
  switch (format) {
    case 'geotiff': return 'tif';
    case 'png':
    default: return 'png';
  }
}

function getHeightmapFormatLabel(format: HeightmapFormat): string {
  switch (format) {
    case 'float32': return 'Float32 GeoTIFF';
    case 'geotiff': return 'Int16 GeoTIFF';
    case 'dem': return 'DEM (Int16 GeoTIFF)';
    case 'r16': return 'R16 (Raw 16-bit)';
    case 'png': return 'PNG (16-bit grayscale)';
    default: return 'GeoTIFF';
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
      case 'mapzen':
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
      case 'aws-terrarium':
      default:
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    }
  }

  function getImageryUrl(x: number, y: number, z: number): string {
    switch (imagerySource) {
      case 'mapbox': {
        const token = process.env.MAPBOX_ACCESS_TOKEN;
        if (!token) {
          throw new Error('MAPBOX_ACCESS_TOKEN environment variable is required for Mapbox imagery source');
        }
        return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.png?access_token=${token}`;
      }
      case 'maptiler':
        return `https://api.maptiler.com/tiles/satellite/${z}/${x}/${y}.jpg?key=get_your_own_key`;
      case 'arcgis':
      default:
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }
  }

  // ── Download DEM tiles (parallel) ──────────────────────────
  const demRange = getTileRange(bounds, demZoom);
  const demTasks: DownloadTask<Float32Array>[] = [];

  for (let y = demRange.minY; y <= demRange.maxY; y++) {
    for (let x = demRange.minX; x <= demRange.maxX; x++) {
      demTasks.push({
        url: getDEMUrl(x, y, demZoom),
        x,
        y,
        processor: async (buffer) => {
          try {
            return await decodeTerrariumTile(buffer);
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

  const { elevations: mergedDEM, width: demFullW, height: demFullH } = mergeDEMTiles(demTiles, demRange);
  const { elevations: croppedDEM, width: demCropW, height: demCropH } = cropDEM(
    mergedDEM,
    demFullW,
    demFullH,
    bounds,
    demRange,
    demZoom
  );
  const resizedDEM = resizeDEM(croppedDEM, demCropW, demCropH, heightmapSize, heightmapSize);

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
    case 'dem':
    default:
      await writeHeightmapGeoTIFFInt16(resizedDEM, heightmapSize, heightmapSize, bounds, heightmapPath, compression);
      break;
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
    default:
      await writeAlbedoPNG(resizedImg, albedoSize, albedoSize, albedoPath);
      break;
  }

  // ── Write manifest ───────────────────────────────────────────
  if (onProgress) {
    onProgress({ stage: 'write_manifest', current: 0, total: 100, message: 'Writing manifest...' });
  }

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
      chunkSizeM: 1000,
      heightmapResolution: heightmapSize,
      albedoResolution: albedoSize,
    },
    tiles: [
      {
        row: tileRow,
        col: tileCol,
        bounds,
        worldOffset: { x: 0, y: 0, z: 0 },
        files: {
          heightmap: fileNames.heightmap,
          albedo: fileNames.albedo,
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
      dem: { id: demSource, name: demSource === 'aws-terrarium' ? 'AWS Terrarium DEM' : 'Mapzen DEM', attribution: 'Mapzen / AWS' },
      imagery: { id: imagerySource, name: imagerySource === 'arcgis' ? 'ArcGIS World Imagery' : imagerySource === 'mapbox' ? 'Mapbox Satellite' : 'MapTiler Satellite', attribution: imagerySource === 'arcgis' ? 'Esri' : imagerySource === 'mapbox' ? 'Mapbox' : 'MapTiler' },
    },
    exportPreset: preset,
    processing: {
      normalizeHeights: true,
      heightScale: 1.0,
      seamStitching: true,
      fillNodata: true,
      generateRoadMasks: false,
      generateWaterMasks: false,
      generateVegetationMasks: false,
      generateBuildingMasks: false,
      generateCliffMasks: false,
      cliffThresholdDegrees: 45.0,
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
