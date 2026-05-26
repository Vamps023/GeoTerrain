/**
 * GeoTerrain Export Engine
 *
 * Downloads DEM (AWS Terrarium) and imagery (ArcGIS World Imagery) tiles,
 * merges them, crops to the exact selected bounds, resizes to the target
 * resolution, and writes heightmap + albedo in the requested formats.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
// import * as os from 'os';
import sharp from 'sharp';
import { writeGeoTIFF } from './geotiff-writer';

// ─── Types ────────────────────────────────────────────────────

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

type HeightmapFormat = 'dem' | 'geotiff' | 'r16' | 'png';
type AlbedoFormat = 'png' | 'geotiff';

interface ExportOptions {
  sessionId: string;
  outputPath: string;
  preset: string;
  bounds: GeoBounds;
  heightmapFormat: HeightmapFormat;
  albedoFormat: AlbedoFormat;
  heightmapSize?: number;
  albedoSize?: number;
  demSource?: 'aws-terrarium' | 'mapzen';
  imagerySource?: 'arcgis' | 'mapbox' | 'maptiler';
  imageryZoom?: number; // 0 = auto, or explicit 10-19
}

interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  zoom: number;
}

// ─── Tile Math ────────────────────────────────────────────────

const TILE_SIZE = 256;
// const EARTH_CIRCUMFERENCE = 40075016.686; // meters at equator

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

// ─── Download ─────────────────────────────────────────────────

function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
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

// ─── DEM Decode ───────────────────────────────────────────────

function decodeTerrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

async function decodeTerrariumTile(buffer: Buffer): Promise<{
  elevations: Float32Array;
  width: number;
  height: number;
}> {
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
  return { elevations, width: w, height: h };
}

// ─── Merge & Crop ─────────────────────────────────────────────

async function mergeDEMTiles(
  tiles: Array<{ x: number; y: number; elevations: Float32Array }>,
  range: TileRange
): Promise<{ elevations: Float32Array; width: number; height: number }> {
  const tilesX = range.maxX - range.minX + 1;
  const tilesY = range.maxY - range.minY + 1;
  const w = tilesX * TILE_SIZE;
  const h = tilesY * TILE_SIZE;
  const elevations = new Float32Array(w * h);

  for (const tile of tiles) {
    const offsetX = (tile.x - range.minX) * TILE_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_SIZE;
    for (let ty = 0; ty < TILE_SIZE; ty++) {
      for (let tx = 0; tx < TILE_SIZE; tx++) {
        const srcIdx = ty * TILE_SIZE + tx;
        const dstIdx = (offsetY + ty) * w + (offsetX + tx);
        elevations[dstIdx] = tile.elevations[srcIdx];
      }
    }
  }

  return { elevations, width: w, height: h };
}

async function mergeImageryTiles(
  tiles: Array<{ x: number; y: number; buffer: Buffer }>,
  range: TileRange
): Promise<Buffer> {
  const tilesX = range.maxX - range.minX + 1;
  const tilesY = range.maxY - range.minY + 1;
  const canvasW = tilesX * TILE_SIZE;
  const canvasH = tilesY * TILE_SIZE;

  // Build merged canvas manually as raw RGBA to avoid sharp composite issues
  // with format detection on tile buffers
  const canvas = Buffer.alloc(canvasW * canvasH * 4);
  canvas.fill(0); // black background

  for (const tile of tiles) {
    // Decode each tile to raw RGBA
    const { data, info } = await sharp(tile.buffer)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const tileW = info.width;
    const tileH = info.height;
    const offsetX = (tile.x - range.minX) * TILE_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_SIZE;

    for (let ty = 0; ty < tileH; ty++) {
      for (let tx = 0; tx < tileW; tx++) {
        const srcIdx = (ty * tileW + tx) * 4;
        const dstIdx = ((offsetY + ty) * canvasW + (offsetX + tx)) * 4;
        canvas[dstIdx + 0] = data[srcIdx + 0];
        canvas[dstIdx + 1] = data[srcIdx + 1];
        canvas[dstIdx + 2] = data[srcIdx + 2];
        canvas[dstIdx + 3] = data[srcIdx + 3];
      }
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
  const width = Math.round(pxEast - pxWest);
  const height = Math.round(pxSouth - pxNorth);

  const cropped = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = left + x;
      const srcY = top + y;
      if (srcX >= 0 && srcX < fullW && srcY >= 0 && srcY < fullH) {
        cropped[y * width + x] = elevations[srcY * fullW + srcX];
      } else {
        cropped[y * width + x] = 0;
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
  const width = Math.round(pxEast - pxWest);
  const height = Math.round(pxSouth - pxNorth);

  const cropped = await sharp(merged, { raw: { width: fullW, height: fullH, channels: 4 } })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer();

  return { buffer: cropped, width, height };
}

// ─── Resize ───────────────────────────────────────────────────

function resizeDEM(
  elevations: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  // Use nearest-neighbor to preserve elevation values and avoid smoothing artifacts
  // Bilinear interpolation creates artificial gradients that appear as banding
  const result = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.round((x / dstW) * srcW), srcW - 1);
      const srcY = Math.min(Math.round((y / dstH) * srcH), srcH - 1);
      result[y * dstW + x] = elevations[srcY * srcW + srcX];
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
  // Smart kernel selection:
  // - Downsampling (src > dst): use lanczos3 for smooth, artifact-free reduction
  // - Upsampling (src < dst): use nearest to avoid blurring already-low-res tiles
  const isDownsampling = srcW > dstW || srcH > dstH;
  const kernel = isDownsampling ? sharp.kernel.lanczos3 : sharp.kernel.nearest;

  return sharp(buffer, { raw: { width: srcW, height: srcH, channels: 4 } })
    .resize(dstW, dstH, { kernel, fit: 'fill' })
    .raw()
    .toBuffer();
}

// ─── Write Formats ────────────────────────────────────────────

async function writeHeightmapPNG(
  elevations: Float32Array,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  // Normalize to 16-bit grayscale
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (!isNaN(v) && v !== -Infinity) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) { min = 0; max = 1; }
  if (max === min) { max = min + 1; }

  const range = max - min;
  const uint16 = new Uint16Array(width * height);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = min;
    const norm = Math.round(((v - min) / range) * 65535);
    uint16[i] = Math.max(0, Math.min(65535, norm));
  }

  await sharp(uint16, {
    raw: { width, height, channels: 1 },
  })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function writeHeightmapR16(
  elevations: Float32Array,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < elevations.length; i++) {
    const v = elevations[i];
    if (!isNaN(v) && v !== -Infinity) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) { min = 0; max = 1; }
  if (max === min) { max = min + 1; }

  const range = max - min;
  const buf = Buffer.allocUnsafe(width * height * 2);
  for (let i = 0; i < elevations.length; i++) {
    let v = elevations[i];
    if (isNaN(v) || v === -Infinity) v = min;
    const norm = Math.round(((v - min) / range) * 65535);
    buf.writeUInt16LE(Math.max(0, Math.min(65535, norm)), i * 2);
  }

  await fs.promises.writeFile(outputPath, buf);
}

async function writeHeightmapGeoTIFF(
  elevations: Float32Array,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string
): Promise<void> {
  // Write raw elevation as signed 16-bit integers (standard DEM format)
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
  });

  await fs.promises.writeFile(outputPath, buf);
}

async function writeHeightmapDEM(
  elevations: Float32Array,
  width: number,
  height: number,
  bounds: GeoBounds,
  outputPath: string
): Promise<void> {
  // DEM uses the same signed 16-bit integer format as GeoTIFF heightmap
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
  outputPath: string
): Promise<void> {
  // Strip alpha channel to create RGB buffer in chunky order
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3 + 0] = rgba[i * 4 + 0];
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
  });

  await fs.promises.writeFile(outputPath, buf);
}

// ─── Main Export ──────────────────────────────────────────────

export async function executeExport(options: ExportOptions): Promise<{
  manifestPath: string;
  elevationRange: { min: number; max: number };
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
  } = options;

  await fs.promises.mkdir(outputPath, { recursive: true });

  // Choose zoom levels
  // DEM: max zoom 15 (Terrarium doesn't go higher, ~30m at zoom 15)
  const demZoom = chooseZoom(bounds, heightmapSize, 15);
  // Imagery: use explicit zoom if set, otherwise auto up to 19
  const imgZoom = imageryZoom > 0 ? imageryZoom : chooseZoom(bounds, albedoSize, 19);

  console.log(`[Export] DEM source=${demSource} zoom=${demZoom}, Imagery source=${imagerySource} zoom=${imgZoom}`);

  // ── Build DEM URL ──────────────────────────────────────────
  function getDEMUrl(x: number, y: number, z: number): string {
    switch (demSource) {
      case 'mapzen':
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
      case 'aws-terrarium':
      default:
        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    }
  }

  // ── Build imagery URL ──────────────────────────────────────
  function getImageryUrl(x: number, y: number, z: number): string {
    switch (imagerySource) {
      case 'mapbox':
        // Mapbox satellite — requires user token via MAPBOX_ACCESS_TOKEN env var
        {
          const token = process.env.MAPBOX_ACCESS_TOKEN;
          if (!token) {
            throw new Error('MAPBOX_ACCESS_TOKEN environment variable is required for Mapbox imagery source');
          }
          return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.png?access_token=${token}`;
        }
      case 'maptiler':
        // MapTiler satellite — high-res, free tier available
        return `https://api.maptiler.com/tiles/satellite/${z}/${x}/${y}.jpg?key=get_your_own_key`;
      case 'arcgis':
      default:
        return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }
  }

  // ── Download DEM tiles ─────────────────────────────────────
  const demRange = getTileRange(bounds, demZoom);
  const demTiles: Array<{ x: number; y: number; elevations: Float32Array }> = [];

  for (let y = demRange.minY; y <= demRange.maxY; y++) {
    for (let x = demRange.minX; x <= demRange.maxX; x++) {
      const url = getDEMUrl(x, y, demZoom);
      console.log(`[Export] Downloading DEM tile: ${url}`);
      try {
        const buffer = await downloadTileWithRetry(url);
        const { elevations } = await decodeTerrariumTile(buffer);
        demTiles.push({ x, y, elevations });
      } catch (err) {
        console.warn(`[Export] Failed DEM tile ${x},${y}:`, (err as Error).message);
        // Fill with zeros
        demTiles.push({ x, y, elevations: new Float32Array(TILE_SIZE * TILE_SIZE) });
      }
    }
  }

  // ── Download imagery tiles ─────────────────────────────────
  const imgRange = getTileRange(bounds, imgZoom);
  const imgTiles: Array<{ x: number; y: number; buffer: Buffer }> = [];

  for (let y = imgRange.minY; y <= imgRange.maxY; y++) {
    for (let x = imgRange.minX; x <= imgRange.maxX; x++) {
      const url = getImageryUrl(x, y, imgZoom);
      console.log(`[Export] Downloading imagery tile: ${url}`);
      try {
        const buffer = await downloadTileWithRetry(url);
        imgTiles.push({ x, y, buffer });
      } catch (err) {
        console.warn(`[Export] Failed imagery tile ${x},${y}:`, (err as Error).message);
        // Create a black tile
        const black = await sharp({
          create: { width: TILE_SIZE, height: TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
        })
          .png()
          .toBuffer();
        imgTiles.push({ x, y, buffer: black });
      }
    }
  }

  // ── Merge DEM ──────────────────────────────────────────────
  const { elevations: mergedDEM, width: demFullW, height: demFullH } = await mergeDEMTiles(
    demTiles,
    demRange
  );
  const { elevations: croppedDEM, width: demCropW, height: demCropH } = cropDEM(
    mergedDEM,
    demFullW,
    demFullH,
    bounds,
    demRange,
    demZoom
  );
  const resizedDEM = resizeDEM(croppedDEM, demCropW, demCropH, heightmapSize, heightmapSize);

  // ── Merge imagery ──────────────────────────────────────────
  const mergedImg = await mergeImageryTiles(imgTiles, imgRange);
  const imgFullW = (imgRange.maxX - imgRange.minX + 1) * TILE_SIZE;
  const imgFullH = (imgRange.maxY - imgRange.minY + 1) * TILE_SIZE;
  const { buffer: croppedImg, width: cropW, height: cropH } = await cropImagery(mergedImg, imgFullW, imgFullH, bounds, imgRange, imgZoom);
  const resizedImg = await resizeImagery(croppedImg, cropW, cropH, albedoSize, albedoSize);

  // ── Compute elevation range ────────────────────────────────
  let minEl = Infinity;
  let maxEl = -Infinity;
  for (let i = 0; i < resizedDEM.length; i++) {
    const v = resizedDEM[i];
    if (!isNaN(v) && v !== -Infinity) {
      if (v < minEl) minEl = v;
      if (v > maxEl) maxEl = v;
    }
  }
  if (minEl === Infinity) { minEl = 0; maxEl = 0; }

  // ── Write heightmap ────────────────────────────────────────
  let heightmapFile: string;
  switch (heightmapFormat) {
    case 'png':
      heightmapFile = 'heightmap.png';
      await writeHeightmapPNG(resizedDEM, heightmapSize, heightmapSize, path.join(outputPath, heightmapFile));
      break;
    case 'r16':
      heightmapFile = 'heightmap.r16';
      await writeHeightmapR16(resizedDEM, heightmapSize, heightmapSize, path.join(outputPath, heightmapFile));
      break;
    case 'geotiff':
      heightmapFile = 'heightmap.tif';
      await writeHeightmapGeoTIFF(resizedDEM, heightmapSize, heightmapSize, bounds, path.join(outputPath, heightmapFile));
      break;
    case 'dem':
      heightmapFile = 'heightmap_dem.tif';
      await writeHeightmapDEM(resizedDEM, heightmapSize, heightmapSize, bounds, path.join(outputPath, heightmapFile));
      break;
    default:
      heightmapFile = 'heightmap.tif';
      await writeHeightmapGeoTIFF(resizedDEM, heightmapSize, heightmapSize, bounds, path.join(outputPath, heightmapFile));
  }

  // ── Write albedo ───────────────────────────────────────────
  let albedoFile: string;
  switch (albedoFormat) {
    case 'png':
      albedoFile = 'albedo.png';
      await writeAlbedoPNG(resizedImg, albedoSize, albedoSize, path.join(outputPath, albedoFile));
      break;
    case 'geotiff':
      albedoFile = 'albedo.tif';
      await writeAlbedoGeoTIFF(resizedImg, albedoSize, albedoSize, bounds, path.join(outputPath, albedoFile));
      break;
    default:
      albedoFile = 'albedo.png';
      await writeAlbedoPNG(resizedImg, albedoSize, albedoSize, path.join(outputPath, albedoFile));
  }

  // ── Write manifest ─────────────────────────────────────────
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
        row: 0,
        col: 0,
        bounds,
        worldOffset: { x: 0, y: 0, z: 0 },
        files: {
          heightmap: heightmapFile,
          albedo: albedoFile,
        },
        elevation: {
          min: Math.round(minEl * 100) / 100,
          max: Math.round(maxEl * 100) / 100,
          units: 'meters' as const,
        },
      },
    ],
    sources: {
      dem: { id: 'aws-terrarium', name: 'AWS Terrarium DEM', attribution: 'Mapzen / AWS' },
      imagery: { id: 'arcgis', name: 'ArcGIS World Imagery', attribution: 'Esri' },
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

  console.log(`[Export] Complete. Output: ${outputPath}`);

  return {
    manifestPath: outputPath,
    elevationRange: { min: minEl, max: maxEl },
  };
}
