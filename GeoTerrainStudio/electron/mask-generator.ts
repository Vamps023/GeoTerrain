/**
 * Mask Generator - Cliff slope computation and mask generation orchestrator.
 *
 * This module computes cliff masks from DEM elevation data using a 3x3
 * finite-difference gradient kernel. Pixels where terrain slope exceeds
 * a configurable threshold are marked white (255), others black (0).
 *
 * Also serves as the orchestrator for all mask types (road, water,
 * vegetation, building, cliff) — orchestration logic added in task 5.2.
 *
 * Runs in the Electron main process (Node.js).
 */

import * as path from 'path';
import sharp from 'sharp';
import {
  fetchRoads,
  fetchWater,
  fetchBuildings,
} from './overpass-client';
import type { GeoBounds, OverpassQueryResult } from './overpass-client';
import { rasterizeToFile } from './vector-rasterizer';
import { fetchSatelliteVegetation } from './satellite-vegetation-client';

// ─── Orchestrator Interfaces ───────────────────────────────────

export interface MaskGenerationOptions {
  bounds: GeoBounds;
  resolution: number;          // Target mask width/height in pixels
  outputPath: string;          // Tile output directory
  tilePrefix: string;          // e.g., "tile_0_1"
  generateRoadMask: boolean;
  generateWaterMask: boolean;
  generateVegetationMask: boolean;
  generateBuildingMask: boolean;
  generateCliffMask: boolean;
  cliffThresholdDegrees: number;
  roadLineWidthPx?: number;   // Default: 3
  onProgress?: (message: string) => void;
  /** Target heightmap width in pixels. Used by resolution-sensitive masks (vegetation) to ensure output matches heightmap dimensions. */
  heightmapWidth?: number;
  /** Target heightmap height in pixels. Used by resolution-sensitive masks (vegetation) to ensure output matches heightmap dimensions. */
  heightmapHeight?: number;
}

export interface MaskResult {
  roadMask?: string;           // Filename only (relative path for manifest)
  waterMask?: string;
  vegetationMask?: string;
  buildingMask?: string;
  cliffMask?: string;
  generationTimeMs: number;
}

// ─── Mask Generation Orchestrator ──────────────────────────────

/**
 * Orchestrates the full mask generation pipeline.
 *
 * For each enabled mask type:
 * 1. Fetches OSM data via overpass-client (road, water, vegetation, building)
 * 2. Rasterizes features to binary mask PNG via vector-rasterizer
 * 3. Computes cliff mask from DEM elevation data when enabled
 *
 * Concurrency is handled by the overpass-client (max 2 concurrent requests).
 * Failed mask types are skipped without aborting remaining masks.
 *
 * @param options - Mask generation configuration
 * @param elevations - DEM elevation data (required if generateCliffMask is true)
 * @param elevationWidth - Width of the elevation grid
 * @param elevationHeight - Height of the elevation grid
 * @returns MaskResult with filenames for successfully generated masks
 */
export async function generateMasks(
  options: MaskGenerationOptions,
  elevations?: Float32Array,
  elevationWidth?: number,
  elevationHeight?: number
): Promise<MaskResult> {
  const startTime = Date.now();
  const result: MaskResult = { generationTimeMs: 0 };
  const progress = options.onProgress ?? (() => {});

  progress('Starting mask generation...');

  // Build list of OSM mask tasks to run concurrently
  const osmTasks: Array<Promise<void>> = [];

  if (options.generateRoadMask) {
    osmTasks.push(
      generateOsmMask(
        'road',
        () => fetchRoads(options.bounds),
        'line',
        options,
        result,
        progress
      )
    );
  }

  if (options.generateWaterMask) {
    osmTasks.push(
      generateOsmMask(
        'water',
        () => fetchWater(options.bounds),
        'polygon',
        options,
        result,
        progress
      )
    );
  }

  if (options.generateVegetationMask) {
    osmTasks.push(
      generateSatelliteVegetationMask(options, result, progress)
    );
  }

  if (options.generateBuildingMask) {
    osmTasks.push(
      generateOsmMask(
        'building',
        () => fetchBuildings(options.bounds),
        'polygon',
        options,
        result,
        progress
      )
    );
  }

  // Run all OSM mask tasks concurrently (overpass-client limits to 2 concurrent)
  await Promise.all(osmTasks);

  // Generate cliff mask from DEM if enabled
  if (options.generateCliffMask) {
    await generateCliffMaskTask(options, result, progress, elevations, elevationWidth, elevationHeight);
  }

  // Post-processing: subtract water mask from vegetation mask to prevent
  // vegetation scattering on water bodies. This handles interpolation artifacts
  // at water boundaries and ensures no trees are placed on rivers/lakes.
  if (result.vegetationMask && result.waterMask) {
    await subtractWaterFromVegetation(options, result, progress);
  }

  result.generationTimeMs = Date.now() - startTime;
  progress(`Mask generation complete in ${result.generationTimeMs}ms`);

  return result;
}

/**
 * Generates a single OSM-based mask (road, water, vegetation, or building).
 * Fetches data from Overpass, rasterizes to PNG, and updates the result.
 * On failure, logs a warning and continues without aborting.
 */
async function generateOsmMask(
  maskType: 'road' | 'water' | 'vegetation' | 'building',
  fetchFn: () => Promise<OverpassQueryResult>,
  featureType: 'polygon' | 'line',
  options: MaskGenerationOptions,
  result: MaskResult,
  progress: (message: string) => void
): Promise<void> {
  const filename = `${options.tilePrefix}_${maskType}_mask.tif`;
  const outputFilePath = path.join(options.outputPath, filename);

  try {
    progress(`Fetching ${maskType} data from Overpass...`);
    console.log(`[mask-generator] Starting ${maskType} mask generation for bounds: S=${options.bounds.south.toFixed(4)}, W=${options.bounds.west.toFixed(4)}, N=${options.bounds.north.toFixed(4)}, E=${options.bounds.east.toFixed(4)}`);
    const queryResult = await fetchFn();
    console.log(`[mask-generator] ${maskType}: received ${queryResult.featureCount} features in ${queryResult.queryTimeMs}ms`);
    progress(`Received ${queryResult.featureCount} ${maskType} features, rasterizing...`);

    // rasterizeToFile handles empty features by generating an all-black mask
    await rasterizeToFile(
      queryResult.features,
      featureType,
      {
        width: options.resolution,
        height: options.resolution,
        bounds: options.bounds,
        lineWidth: maskType === 'road' ? (options.roadLineWidthPx ?? 3) : undefined,
      },
      outputFilePath
    );

    // Verify file was written
    const fs = require('fs');
    if (fs.existsSync(outputFilePath)) {
      const stats = fs.statSync(outputFilePath);
      console.log(`[mask-generator] ${maskType} mask written: ${outputFilePath} (${stats.size} bytes)`);
    } else {
      console.error(`[mask-generator] ${maskType} mask file NOT found after write: ${outputFilePath}`);
    }

    // Update result with filename only (for manifest inclusion)
    switch (maskType) {
      case 'road': result.roadMask = filename; break;
      case 'water': result.waterMask = filename; break;
      case 'vegetation': result.vegetationMask = filename; break;
      case 'building': result.buildingMask = filename; break;
    }
    progress(`${maskType} mask generated: ${filename}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[mask-generator] FAILED to generate ${maskType} mask: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(`[mask-generator] Stack: ${err.stack}`);
    }
    progress(`Warning: ${maskType} mask generation failed — ${errorMessage}`);
    // Skip this mask type, do not abort remaining masks
  }
}

/**
 * Generates the vegetation mask using satellite-derived raster data (ESA WorldCover).
 *
 * Uses `heightmapWidth` and `heightmapHeight` from options when available to ensure
 * the vegetation mask output dimensions match the heightmap exactly. Falls back to
 * `options.resolution` for backward compatibility when heightmap dimensions are not provided.
 *
 * On failure, logs a warning and continues without aborting (non-fatal).
 */
async function generateSatelliteVegetationMask(
  options: MaskGenerationOptions,
  result: MaskResult,
  progress: (message: string) => void
): Promise<void> {
  const filename = `${options.tilePrefix}_vegetation_mask.tif`;
  const outputFilePath = path.join(options.outputPath, filename);

  // Use explicit heightmap dimensions when available, fall back to resolution
  const outputWidth = options.heightmapWidth ?? options.resolution;
  const outputHeight = options.heightmapHeight ?? options.resolution;

  try {
    progress('Fetching satellite vegetation data (ESA WorldCover)...');
    console.log(
      `[mask-generator] Starting satellite vegetation mask generation for bounds: ` +
      `S=${options.bounds.south.toFixed(4)}, W=${options.bounds.west.toFixed(4)}, ` +
      `N=${options.bounds.north.toFixed(4)}, E=${options.bounds.east.toFixed(4)} ` +
      `(output: ${outputWidth}x${outputHeight})`
    );

    const vegetationBuffer = await fetchSatelliteVegetation(
      options.bounds,
      outputWidth,
      outputHeight
    );

    progress('Writing satellite vegetation mask to TIFF...');

    // Write as 8-bit single-channel grayscale TIFF with LZW compression
    await sharp(vegetationBuffer, {
      raw: { width: outputWidth, height: outputHeight, channels: 1 },
    })
      .tiff({ compression: 'lzw' })
      .toFile(outputFilePath);

    // Verify file was written
    const fs = require('fs');
    if (fs.existsSync(outputFilePath)) {
      const stats = fs.statSync(outputFilePath);
      console.log(`[mask-generator] vegetation mask written: ${outputFilePath} (${stats.size} bytes)`);
    } else {
      console.error(`[mask-generator] vegetation mask file NOT found after write: ${outputFilePath}`);
    }

    result.vegetationMask = filename;
    progress(`Vegetation mask generated: ${filename}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[mask-generator] FAILED to generate vegetation mask: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(`[mask-generator] Stack: ${err.stack}`);
    }
    progress(`Warning: vegetation mask generation failed — ${errorMessage}`);
    // Non-fatal: skip this mask type, do not abort remaining masks
  }
}

/**
 * Post-processing step: subtract water mask from vegetation mask.
 *
 * Reads both the vegetation and water mask TIFF files, and for every pixel
 * where the water mask is non-zero (water present), sets the vegetation
 * mask pixel to 0. This prevents vegetation scattering on rivers, lakes,
 * and other water bodies.
 *
 * Also subtracts road mask areas from vegetation if both are present,
 * preventing trees from being placed on roads.
 *
 * Overwrites the vegetation mask file in-place.
 */
async function subtractWaterFromVegetation(
  options: MaskGenerationOptions,
  result: MaskResult,
  progress: (message: string) => void
): Promise<void> {
  const fs = require('fs');
  const vegFilePath = path.join(options.outputPath, result.vegetationMask!);
  const waterFilePath = path.join(options.outputPath, result.waterMask!);

  try {
    progress('Subtracting water areas from vegetation mask...');

    // Read vegetation mask raw pixels
    const vegImage = sharp(vegFilePath);
    const vegMeta = await vegImage.metadata();
    const vegWidth = vegMeta.width!;
    const vegHeight = vegMeta.height!;
    const vegBuffer = await sharp(vegFilePath).raw().toBuffer();

    // Read water mask and resize to match vegetation mask dimensions if needed
    const waterBuffer = await sharp(waterFilePath)
      .resize(vegWidth, vegHeight, { kernel: 'nearest' })
      .raw()
      .toBuffer();

    // Subtract: where water > 0, set vegetation to 0
    const outputBuffer = Buffer.from(vegBuffer);
    let waterPixelsCleared = 0;
    for (let i = 0; i < outputBuffer.length; i++) {
      if (waterBuffer[i] > 0) {
        outputBuffer[i] = 0;
        waterPixelsCleared++;
      }
    }

    // Also subtract road mask if present
    let roadPixelsCleared = 0;
    if (result.roadMask) {
      const roadFilePath = path.join(options.outputPath, result.roadMask);
      if (fs.existsSync(roadFilePath)) {
        const roadBuffer = await sharp(roadFilePath)
          .resize(vegWidth, vegHeight, { kernel: 'nearest' })
          .raw()
          .toBuffer();

        for (let i = 0; i < outputBuffer.length; i++) {
          if (roadBuffer[i] > 0) {
            outputBuffer[i] = 0;
            roadPixelsCleared++;
          }
        }
      }
    }

    // Write the modified vegetation mask back
    await sharp(outputBuffer, {
      raw: { width: vegWidth, height: vegHeight, channels: 1 },
    })
      .tiff({ compression: 'lzw' })
      .toFile(vegFilePath);

    console.log(
      `[mask-generator] Vegetation mask post-processed: ${waterPixelsCleared} water pixels ` +
      `and ${roadPixelsCleared} road pixels cleared from vegetation mask`
    );
    progress('Vegetation mask post-processed (water/road areas excluded)');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[mask-generator] Failed to subtract water from vegetation mask (non-fatal): ${errorMessage}`);
    // Non-fatal: vegetation mask remains as-is without water subtraction
  }
}

/**
 * Generates the cliff mask from DEM elevation data.
 * Skips with a warning if elevation data is unavailable.
 */
async function generateCliffMaskTask(
  options: MaskGenerationOptions,
  result: MaskResult,
  progress: (message: string) => void,
  elevations?: Float32Array,
  elevationWidth?: number,
  elevationHeight?: number
): Promise<void> {
  const filename = `${options.tilePrefix}_cliff_mask.tif`;
  const outputFilePath = path.join(options.outputPath, filename);

  // Skip if elevation data is unavailable
  if (!elevations || !elevationWidth || !elevationHeight || elevations.length === 0) {
    console.warn('[mask-generator] Cliff mask enabled but elevation data unavailable — skipping');
    progress('Warning: cliff mask skipped — elevation data unavailable');
    return;
  }

  try {
    progress('Computing cliff mask from DEM...');

    const cliffBuffer = computeCliffMask(
      elevations,
      elevationWidth,
      elevationHeight,
      options.cliffThresholdDegrees,
      options.resolution
    );

    await writeGrayscalePng(cliffBuffer, options.resolution, options.resolution, outputFilePath);

    result.cliffMask = filename;
    progress(`Cliff mask generated: ${filename}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[mask-generator] Failed to generate cliff mask: ${errorMessage}`);
    progress(`Warning: cliff mask generation failed — ${errorMessage}`);
    // Skip this mask type, do not abort remaining masks
  }
}

// ─── Slope Computation ─────────────────────────────────────────

/**
 * Compute terrain slope at each pixel using a 3x3 finite-difference
 * gradient kernel on DEM elevation data.
 *
 * The kernel computes partial derivatives:
 *   dz/dx = (z[y][x+1] - z[y][x-1]) / 2
 *   dz/dy = (z[y+1][x] - z[y-1][x]) / 2
 *
 * For border pixels, nearest-neighbor padding is applied (edge values
 * are replicated to fill the missing kernel neighborhood).
 *
 * Returns slope in degrees for each pixel as a Float32Array.
 *
 * @param elevations - DEM elevation data as a flat Float32Array (row-major)
 * @param width - Width of the elevation grid in pixels
 * @param height - Height of the elevation grid in pixels
 * @returns Float32Array of slope values in degrees (same dimensions as input)
 */
export function computeSlopeGrid(
  elevations: Float32Array,
  width: number,
  height: number
): Float32Array {
  const slopeGrid = new Float32Array(width * height);
  const RAD_TO_DEG = 180 / Math.PI;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Apply nearest-neighbor padding for border pixels
      const xLeft = Math.max(0, x - 1);
      const xRight = Math.min(width - 1, x + 1);
      const yUp = Math.max(0, y - 1);
      const yDown = Math.min(height - 1, y + 1);

      // Finite-difference gradient
      const zLeft = elevations[y * width + xLeft];
      const zRight = elevations[y * width + xRight];
      const zUp = elevations[yUp * width + x];
      const zDown = elevations[yDown * width + x];

      // Compute partial derivatives
      // Use actual pixel distance for denominator (accounts for border padding)
      const dxDist = xRight - xLeft; // 2 for interior, 1 for border
      const dyDist = yDown - yUp;    // 2 for interior, 1 for border

      const dzdx = dxDist > 0 ? (zRight - zLeft) / dxDist : 0;
      const dzdy = dyDist > 0 ? (zDown - zUp) / dyDist : 0;

      // Slope magnitude in degrees
      const slopeMagnitude = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      const slopeDegrees = Math.atan(slopeMagnitude) * RAD_TO_DEG;

      slopeGrid[y * width + x] = slopeDegrees;
    }
  }

  return slopeGrid;
}

// ─── Cliff Mask Computation ────────────────────────────────────

/**
 * Compute a binary cliff mask from DEM elevation data.
 *
 * Steps:
 * 1. Compute slope grid using 3x3 finite-difference kernel
 * 2. Threshold: slope >= thresholdDegrees → 255, else → 0
 * 3. Resize to outputResolution if DEM dimensions differ (nearest-neighbor)
 *
 * @param elevations - DEM elevation data as a flat Float32Array (row-major)
 * @param width - Width of the elevation grid in pixels
 * @param height - Height of the elevation grid in pixels
 * @param thresholdDegrees - Slope threshold in degrees (0-90)
 * @param outputResolution - Target mask width and height in pixels
 * @returns Raw 8-bit buffer (outputResolution * outputResolution bytes)
 */
export function computeCliffMask(
  elevations: Float32Array,
  width: number,
  height: number,
  thresholdDegrees: number,
  outputResolution: number
): Buffer {
  // Step 1: Compute slope grid
  const slopeGrid = computeSlopeGrid(elevations, width, height);

  // Step 2: Threshold to binary mask
  const binaryMask = Buffer.alloc(width * height);
  for (let i = 0; i < slopeGrid.length; i++) {
    binaryMask[i] = slopeGrid[i] >= thresholdDegrees ? 255 : 0;
  }

  // Step 3: Resize if DEM dimensions differ from target resolution
  if (width === outputResolution && height === outputResolution) {
    return binaryMask;
  }

  // Nearest-neighbor resize to preserve binary values
  return resizeNearestNeighbor(binaryMask, width, height, outputResolution, outputResolution);
}

/**
 * Resize a raw 8-bit buffer using nearest-neighbor interpolation.
 * This preserves binary values (0 and 255) without introducing
 * intermediate values from bilinear/bicubic interpolation.
 *
 * @param source - Source buffer (srcWidth * srcHeight bytes)
 * @param srcWidth - Source width in pixels
 * @param srcHeight - Source height in pixels
 * @param dstWidth - Destination width in pixels
 * @param dstHeight - Destination height in pixels
 * @returns Resized buffer (dstWidth * dstHeight bytes)
 */
export function resizeNearestNeighbor(
  source: Buffer,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Buffer {
  const dest = Buffer.alloc(dstWidth * dstHeight);

  for (let dstY = 0; dstY < dstHeight; dstY++) {
    for (let dstX = 0; dstX < dstWidth; dstX++) {
      // Map destination pixel to source pixel (nearest neighbor)
      const srcX = Math.min(
        srcWidth - 1,
        Math.round((dstX / (dstWidth - 1)) * (srcWidth - 1))
      );
      const srcY = Math.min(
        srcHeight - 1,
        Math.round((dstY / (dstHeight - 1)) * (srcHeight - 1))
      );

      dest[dstY * dstWidth + dstX] = source[srcY * srcWidth + srcX];
    }
  }

  return dest;
}

// ─── PNG Encoding Helper ───────────────────────────────────────

/**
 * Encode a raw 8-bit grayscale buffer as a PNG file using sharp.
 *
 * @param buffer - Raw 8-bit pixel data
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param outputPath - Full path to write the output TIFF file
 */
export async function writeGrayscalePng(
  buffer: Buffer,
  width: number,
  height: number,
  outputPath: string
): Promise<void> {
  await sharp(buffer, {
    raw: {
      width,
      height,
      channels: 1,
    },
  })
    .tiff({ compression: 'lzw' })
    .toFile(outputPath);
}
