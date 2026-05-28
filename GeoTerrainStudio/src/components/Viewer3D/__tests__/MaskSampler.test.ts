import { describe, it, expect } from 'vitest';
import { parseMask, sampleAt, hasVegetation, MaskData } from '../MaskSampler';
import { writeArrayBuffer } from 'geotiff';

/**
 * Helper: create a minimal single-band GeoTIFF ArrayBuffer from pixel data.
 * Uses the geotiff library's writeArrayBuffer with flattened data format.
 */
function createGeoTiffBuffer(
  pixels: number[],
  width: number,
  height: number
): ArrayBuffer {
  const metadata = {
    width,
    height,
    BitsPerSample: [8],
    SampleFormat: [1], // unsigned int
    PhotometricInterpretation: 1, // min-is-black
    SamplesPerPixel: [1],
  };
  return writeArrayBuffer(pixels, metadata) as ArrayBuffer;
}

describe('MaskSampler', () => {
  describe('parseMask', () => {
    it('should decode a valid 8-bit GeoTIFF into MaskData', async () => {
      const width = 4;
      const height = 4;
      const pixels = Array.from({ length: width * height }, (_, i) => i * 16);
      const buffer = createGeoTiffBuffer(pixels, width, height);

      const result = await parseMask(buffer);

      expect(result.width).toBe(width);
      expect(result.height).toBe(height);
      expect(result.pixels).toBeInstanceOf(Uint8Array);
      expect(result.pixels.length).toBe(width * height);
    });

    it('should normalize pixel values to 0-255 range', async () => {
      const width = 2;
      const height = 2;
      // Values 0, 85, 170, 255 should stay as-is for 8-bit
      const pixels = [0, 85, 170, 255];
      const buffer = createGeoTiffBuffer(pixels, width, height);

      const result = await parseMask(buffer);

      expect(result.pixels[0]).toBe(0);
      expect(result.pixels[1]).toBe(85);
      expect(result.pixels[2]).toBe(170);
      expect(result.pixels[3]).toBe(255);
    });

    it('should reject with descriptive error for invalid GeoTIFF data', async () => {
      const invalidBuffer = new ArrayBuffer(64);
      // Fill with random non-TIFF data
      const view = new Uint8Array(invalidBuffer);
      view.fill(0xAB);

      await expect(parseMask(invalidBuffer)).rejects.toThrow(/Failed to parse GeoTIFF/);
    });

    it('should reject with descriptive error for empty buffer', async () => {
      const emptyBuffer = new ArrayBuffer(0);

      await expect(parseMask(emptyBuffer)).rejects.toThrow();
    });
  });

  describe('sampleAt', () => {
    const mask: MaskData = {
      pixels: new Uint8Array([
        0, 64, 128, 255,
        32, 96, 160, 200,
        50, 100, 180, 220,
        10, 80, 140, 250,
      ]),
      width: 4,
      height: 4,
    };

    it('should return correct pixel value for valid UV coordinates', () => {
      // u=0, v=0 -> pixel at (0, 0) = 0
      expect(sampleAt(mask, 0, 0)).toBe(0);

      // u=0.5, v=0 -> x = floor(0.5*4) = 2, y = 0 -> pixel at (2, 0) = 128
      expect(sampleAt(mask, 0.5, 0)).toBe(128);

      // u=1, v=0 -> x = min(floor(1*4), 3) = 3, y = 0 -> pixel at (3, 0) = 255
      expect(sampleAt(mask, 1, 0)).toBe(255);
    });

    it('should return 0 for out-of-bounds UV coordinates', () => {
      expect(sampleAt(mask, -0.1, 0.5)).toBe(0);
      expect(sampleAt(mask, 1.1, 0.5)).toBe(0);
      expect(sampleAt(mask, 0.5, -0.1)).toBe(0);
      expect(sampleAt(mask, 0.5, 1.1)).toBe(0);
      expect(sampleAt(mask, -1, -1)).toBe(0);
      expect(sampleAt(mask, 2, 2)).toBe(0);
    });

    it('should clamp to last pixel at UV boundary (1.0)', () => {
      // u=1.0 -> x = min(floor(1*4), 3) = min(4, 3) = 3
      // v=1.0 -> y = min(floor(1*4), 3) = min(4, 3) = 3
      expect(sampleAt(mask, 1.0, 1.0)).toBe(250);
    });

    it('should use nearest-neighbor sampling', () => {
      // u=0.3, v=0.3 -> x = floor(0.3*4) = 1, y = floor(0.3*4) = 1
      // pixel at (1, 1) = 96
      expect(sampleAt(mask, 0.3, 0.3)).toBe(96);
    });
  });

  describe('hasVegetation', () => {
    const mask: MaskData = {
      pixels: new Uint8Array([0, 127, 128, 255]),
      width: 2,
      height: 2,
    };

    it('should return true when pixel value >= threshold (default 128)', () => {
      // pixel at (1, 0) = 127 -> false
      expect(hasVegetation(mask, 0.6, 0)).toBe(false);
      // pixel at (0, 1) = 128 -> true
      expect(hasVegetation(mask, 0, 0.6)).toBe(true);
      // pixel at (1, 1) = 255 -> true
      expect(hasVegetation(mask, 0.6, 0.6)).toBe(true);
    });

    it('should use custom threshold when provided', () => {
      // pixel at (0, 0) = 0
      expect(hasVegetation(mask, 0, 0, 0)).toBe(true); // 0 >= 0
      expect(hasVegetation(mask, 0, 0, 1)).toBe(false); // 0 >= 1

      // pixel at (1, 1) = 255
      expect(hasVegetation(mask, 0.6, 0.6, 255)).toBe(true); // 255 >= 255
      expect(hasVegetation(mask, 0.6, 0.6, 256)).toBe(false); // 255 >= 256
    });

    it('should return false for out-of-bounds UV (sampleAt returns 0)', () => {
      expect(hasVegetation(mask, -0.1, 0.5)).toBe(false);
      expect(hasVegetation(mask, 0.5, 1.1)).toBe(false);
    });
  });
});
