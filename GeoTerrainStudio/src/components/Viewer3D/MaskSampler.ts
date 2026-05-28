import { fromArrayBuffer } from 'geotiff';

/**
 * Decoded vegetation mask data ready for UV-based sampling.
 */
export interface MaskData {
  /** Raw 8-bit grayscale pixel values (row-major, top-to-bottom) */
  pixels: Uint8Array;
  /** Mask width in pixels */
  width: number;
  /** Mask height in pixels */
  height: number;
}

/**
 * Parse a GeoTIFF ArrayBuffer into MaskData.
 * Extracts the first raster band and normalizes pixel values to 0-255
 * regardless of source bit depth.
 *
 * @param buffer - Raw GeoTIFF file contents
 * @returns Decoded mask data with 8-bit grayscale pixels
 * @throws Error if the buffer is not a valid GeoTIFF or contains no raster bands
 */
export async function parseMask(buffer: ArrayBuffer): Promise<MaskData> {
  let tiff;
  try {
    tiff = await fromArrayBuffer(buffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse GeoTIFF: ${message}`);
  }

  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  const rasters = await image.readRasters();
  if (!rasters || rasters.length === 0) {
    throw new Error('GeoTIFF contains zero raster bands: no usable band data');
  }

  const band = rasters[0] as
    | Float32Array
    | Float64Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Uint8Array
    | Int8Array;

  // Normalize pixel values to 0-255 range
  const pixels = new Uint8Array(width * height);
  const pixelCount = Math.min(band.length, width * height);

  // Find min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixelCount; i++) {
    const v = band[i];
    if (isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // If all values are the same or no finite values found, output zeros
  if (!isFinite(min) || !isFinite(max) || min === max) {
    // If all values are the same and non-zero, map to 255 (full coverage)
    // If all zero, keep as zero
    if (isFinite(min) && min > 0) {
      pixels.fill(255);
    }
    // Otherwise pixels remain all zeros (default Uint8Array)
    return { pixels, width, height };
  }

  // If data is already in 0-255 range (8-bit source), copy directly
  if (min >= 0 && max <= 255 && Number.isInteger(min) && Number.isInteger(max)) {
    for (let i = 0; i < pixelCount; i++) {
      pixels[i] = Math.round(Math.max(0, Math.min(255, band[i])));
    }
  } else {
    // Normalize from arbitrary range to 0-255
    const range = max - min;
    for (let i = 0; i < pixelCount; i++) {
      const v = band[i];
      const normalized = isFinite(v) ? ((v - min) / range) * 255 : 0;
      pixels[i] = Math.round(Math.max(0, Math.min(255, normalized)));
    }
  }

  return { pixels, width, height };
}

/**
 * Sample the mask at normalized UV coordinates using nearest-neighbor lookup.
 *
 * @param mask - Decoded mask data
 * @param u - Horizontal coordinate in [0, 1] range (left to right)
 * @param v - Vertical coordinate in [0, 1] range (top to bottom)
 * @returns Pixel value 0-255, or 0 for out-of-bounds UV coordinates
 */
export function sampleAt(mask: MaskData, u: number, v: number): number {
  // Return 0 for out-of-bounds UV coordinates
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return 0;
  }

  // Nearest-neighbor lookup
  const x = Math.min(Math.floor(u * mask.width), mask.width - 1);
  const y = Math.min(Math.floor(v * mask.height), mask.height - 1);

  return mask.pixels[y * mask.width + x];
}

/**
 * Check if a UV position has vegetation based on the mask threshold.
 *
 * @param mask - Decoded mask data
 * @param u - Horizontal coordinate in [0, 1] range
 * @param v - Vertical coordinate in [0, 1] range
 * @param threshold - Pixel value threshold for vegetation presence (default: 128)
 * @returns true if the sampled pixel value >= threshold
 */
export function hasVegetation(
  mask: MaskData,
  u: number,
  v: number,
  threshold: number = 128
): boolean {
  return sampleAt(mask, u, v) >= threshold;
}
