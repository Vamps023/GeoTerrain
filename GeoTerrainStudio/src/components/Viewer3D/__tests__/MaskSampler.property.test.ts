/**
 * Property-based tests for MaskSampler UV sampling.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { sampleAt, hasVegetation, parseMask, MaskData } from '../MaskSampler';

// ─── Arbitraries ───────────────────────────────────────────────

/** Arbitrary for valid MaskData with small dimensions (1-64) and random pixel values */
const arbMaskData: fc.Arbitrary<MaskData> = fc
  .record({
    width: fc.integer({ min: 1, max: 64 }),
    height: fc.integer({ min: 1, max: 64 }),
  })
  .chain(({ width, height }) =>
    fc.uint8Array({ minLength: width * height, maxLength: width * height }).map(
      (pixels) => ({ pixels, width, height })
    )
  );

/** Arbitrary for UV coordinates within [0, 1] */
const arbUVInBounds: fc.Arbitrary<{ u: number; v: number }> = fc.record({
  u: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  v: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/** Arbitrary for a single UV component that is strictly out of bounds (< 0 or > 1) */
const arbOutOfBoundsComponent: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -1000, max: -Number.EPSILON, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 1 + Number.EPSILON, max: 1000, noNaN: true, noDefaultInfinity: true })
);

/** Arbitrary for any UV component (can be anything) */
const arbAnyComponent: fc.Arbitrary<number> = fc.double({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Arbitrary for UV coordinates outside [0, 1] (at least one component strictly out of bounds) */
const arbUVOutOfBounds: fc.Arbitrary<{ u: number; v: number }> = fc.oneof(
  // u out of bounds, v anything
  fc.record({ u: arbOutOfBoundsComponent, v: arbAnyComponent }),
  // v out of bounds, u anything
  fc.record({ u: arbAnyComponent, v: arbOutOfBoundsComponent }),
  // both out of bounds
  fc.record({ u: arbOutOfBoundsComponent, v: arbOutOfBoundsComponent })
);

// ─── Property Test ─────────────────────────────────────────────

/**
 * Property 1: UV Sampling Bounds Correctness
 *
 * For any valid MaskData and for any UV coordinates, `sampleAt` SHALL return
 * a value in [0, 255] when UV is within [0, 1], and SHALL return 0 when UV
 * is outside [0, 1].
 *
 * **Validates: Requirements 2.1, 2.2**
 */
describe('Property 1: UV Sampling Bounds Correctness', () => {
  it('sampleAt returns a value in [0, 255] for any UV in [0, 1]', () => {
    fc.assert(
      fc.property(arbMaskData, arbUVInBounds, (mask, { u, v }) => {
        const result = sampleAt(mask, u, v);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(255);
        expect(Number.isInteger(result)).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });

  it('sampleAt returns 0 for any UV outside [0, 1]', () => {
    fc.assert(
      fc.property(arbMaskData, arbUVOutOfBounds, (mask, { u, v }) => {
        const result = sampleAt(mask, u, v);
        expect(result).toBe(0);
      }),
      { numRuns: 1000 }
    );
  });
});

/**
 * Property 2: Vegetation Threshold Consistency
 *
 * For any valid MaskData, for any UV coordinates, and for any threshold value,
 * `hasVegetation(mask, u, v, threshold)` SHALL return true if and only if
 * `sampleAt(mask, u, v) >= threshold`.
 *
 * **Validates: Requirements 2.3**
 */
describe('Property 2: Vegetation Threshold Consistency', () => {
  it('hasVegetation returns true iff sampleAt >= threshold', () => {
    fc.assert(
      fc.property(
        arbMaskData,
        arbUVInBounds,
        fc.integer({ min: 0, max: 255 }),
        (mask, { u, v }, threshold) => {
          const sampled = sampleAt(mask, u, v);
          const result = hasVegetation(mask, u, v, threshold);
          expect(result).toBe(sampled >= threshold);
        }
      ),
      { numRuns: 500 }
    );
  });
});

/**
 * Property 11: Invalid Input Rejection
 *
 * For any ArrayBuffer that is not a valid GeoTIFF, `parseMask` rejects
 * without throwing an unhandled exception.
 *
 * **Validates: Requirements 1.4**
 */
describe('Property 11: Invalid Input Rejection', () => {
  it('parseMask rejects gracefully for any random ArrayBuffer that is not a valid GeoTIFF', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 1000 }),
        async (randomBytes) => {
          const buffer = randomBytes.buffer.slice(
            randomBytes.byteOffset,
            randomBytes.byteOffset + randomBytes.byteLength
          );
          await expect(parseMask(buffer)).rejects.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });
});
