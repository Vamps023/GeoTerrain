/**
 * Property-based tests for TreeScatterer module.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 * Tests cover mask filtering, instance count monotonicity, position bounds,
 * transform bounds, deterministic placement, instance cap enforcement,
 * and matrix buffer validity.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  createPRNG,
  generateCandidates,
  filterByMask,
  enforceInstanceCap,
  generateTransformMatrices,
  validateMatrixBuffer,
  DEFAULT_SCATTER_CONFIG,
  ScatterConfig,
} from '../TreeScatterer';
import { sampleAt, MaskData } from '../MaskSampler';

// ─── Shared Arbitraries ────────────────────────────────────────

/** Arbitrary for valid MaskData with small dimensions (2-16) and random pixel values */
const arbMaskData: fc.Arbitrary<MaskData> = fc
  .record({
    width: fc.integer({ min: 2, max: 16 }),
    height: fc.integer({ min: 2, max: 16 }),
  })
  .chain(({ width, height }) =>
    fc.uint8Array({ minLength: width * height, maxLength: width * height }).map(
      (pixels) => ({ pixels, width, height })
    )
  );

/** Arbitrary for ScatterConfig with reasonable ranges */
const arbScatterConfig: fc.Arbitrary<ScatterConfig> = fc.record({
  density: fc.double({ min: 0.001, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  minScale: fc.double({ min: 0.1, max: 1.0, noNaN: true, noDefaultInfinity: true }),
  maxScale: fc.double({ min: 1.0, max: 3.0, noNaN: true, noDefaultInfinity: true }),
  randomRotation: fc.boolean(),
  seed: fc.integer({ min: 0, max: 1000000 }),
  vegetationThreshold: fc.integer({ min: 0, max: 255 }),
  maxInstancesPerTile: fc.integer({ min: 10, max: 50000 }),
  heightExaggeration: fc.double({ min: 0.5, max: 5.0, noNaN: true, noDefaultInfinity: true }),
  jitterAmount: fc.double({ min: 0.0, max: 1.0, noNaN: true, noDefaultInfinity: true }),
});

/** Arbitrary for tile dimensions in meters (kept small to limit candidate count) */
const arbTileDimensions: fc.Arbitrary<{ width: number; height: number }> = fc.record({
  width: fc.double({ min: 10, max: 200, noNaN: true, noDefaultInfinity: true }),
  height: fc.double({ min: 10, max: 200, noNaN: true, noDefaultInfinity: true }),
});

// ─── Property 3: Mask Filtering Correctness ────────────────────

/**
 * Property 3: Mask Filtering Correctness
 *
 * For any vegetation mask and scatter configuration, every placed tree instance
 * SHALL correspond to a mask position with pixel value at or above the vegetation
 * threshold, and no tree instance SHALL be placed at a position where the mask
 * pixel value is below the threshold.
 *
 * **Validates: Requirements 4.2, 4.3**
 */
describe('Property 3: Mask Filtering Correctness', () => {
  it('every filtered position has mask value >= threshold at its UV coordinate', () => {
    fc.assert(
      fc.property(arbMaskData, arbScatterConfig, arbTileDimensions, (mask, config, tile) => {
        const candidates = generateCandidates(tile.width, tile.height, config);
        const filtered = filterByMask(candidates, mask, tile.width, tile.height, config.vegetationThreshold);

        // Every accepted position must have mask value >= threshold
        for (const pos of filtered) {
          const u = pos.x / tile.width;
          const v = pos.z / tile.height;
          const pixelValue = sampleAt(mask, u, v);
          expect(pixelValue).toBeGreaterThanOrEqual(config.vegetationThreshold);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('no candidate with mask value < threshold passes the filter', () => {
    fc.assert(
      fc.property(arbMaskData, arbScatterConfig, arbTileDimensions, (mask, config, tile) => {
        const candidates = generateCandidates(tile.width, tile.height, config);
        const filtered = filterByMask(candidates, mask, tile.width, tile.height, config.vegetationThreshold);
        const filteredSet = new Set(filtered.map((p) => `${p.x},${p.z}`));

        // Every rejected candidate must have mask value < threshold
        for (const pos of candidates) {
          if (!filteredSet.has(`${pos.x},${pos.z}`)) {
            const u = pos.x / tile.width;
            const v = pos.z / tile.height;
            const pixelValue = sampleAt(mask, u, v);
            expect(pixelValue).toBeLessThan(config.vegetationThreshold);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 4: Instance Count Monotonicity ───────────────────

/**
 * Property 4: Instance Count Monotonicity with Mask Coverage
 *
 * For two masks with the same dimensions and a fixed scatter configuration,
 * if mask A has equal or greater vegetation coverage (pixel count >= threshold)
 * than mask B, then scattering on mask A SHALL produce equal or more tree
 * instances than scattering on mask B.
 *
 * **Validates: Requirements 4.1, 4.2**
 */
describe('Property 4: Instance Count Monotonicity', () => {
  it('mask with more coverage produces >= instances than mask with less coverage', () => {
    // Generate two masks where A has more white pixels than B (same dimensions)
    const arbMaskPair = fc
      .record({
        width: fc.integer({ min: 2, max: 16 }),
        height: fc.integer({ min: 2, max: 16 }),
      })
      .chain(({ width, height }) => {
        const size = width * height;
        return fc
          .record({
            // maskB: random pixels
            pixelsB: fc.uint8Array({ minLength: size, maxLength: size }),
            // For maskA: we'll ensure it has >= coverage by setting additional pixels above threshold
            extraWhiteIndices: fc.uniqueArray(fc.integer({ min: 0, max: size - 1 }), {
              minLength: 0,
              maxLength: Math.min(size, 10),
            }),
          })
          .map(({ pixelsB, extraWhiteIndices }) => {
            // maskA = copy of maskB with extra pixels set to 255
            const pixelsA = new Uint8Array(pixelsB);
            for (const idx of extraWhiteIndices) {
              pixelsA[idx] = 255;
            }
            return {
              maskA: { pixels: pixelsA, width, height } as MaskData,
              maskB: { pixels: pixelsB, width, height } as MaskData,
            };
          });
      });

    fc.assert(
      fc.property(arbMaskPair, arbScatterConfig, arbTileDimensions, ({ maskA, maskB }, config, tile) => {
        const candidates = generateCandidates(tile.width, tile.height, config);
        const filteredA = filterByMask(candidates, maskA, tile.width, tile.height, config.vegetationThreshold);
        const filteredB = filterByMask(candidates, maskB, tile.width, tile.height, config.vegetationThreshold);

        expect(filteredA.length).toBeGreaterThanOrEqual(filteredB.length);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 5: Position Bounds Enforcement ───────────────────

/**
 * Property 5: Position Bounds Enforcement
 *
 * For any scatter result, every tree instance XZ position SHALL lie within
 * [0, tileWidthM] x [0, tileHeightM] regardless of jitter amount or density
 * configuration.
 *
 * **Validates: Requirements 4.4, 4.6**
 */
describe('Property 5: Position Bounds Enforcement', () => {
  it('all candidate positions are within [0, tileWidthM] x [0, tileHeightM]', () => {
    fc.assert(
      fc.property(arbScatterConfig, arbTileDimensions, (config, tile) => {
        const candidates = generateCandidates(tile.width, tile.height, config);

        for (const pos of candidates) {
          expect(pos.x).toBeGreaterThanOrEqual(0);
          expect(pos.x).toBeLessThanOrEqual(tile.width);
          expect(pos.z).toBeGreaterThanOrEqual(0);
          expect(pos.z).toBeLessThanOrEqual(tile.height);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 7: Transform Bounds ──────────────────────────────

/**
 * Property 7: Transform Bounds
 *
 * For any scatter result, every scale factor is within [minScale, maxScale],
 * and when randomRotation is enabled, every Y-axis rotation is within [0, 2*PI].
 *
 * **Validates: Requirements 6.1, 6.2, 6.3**
 */
describe('Property 7: Transform Bounds', () => {
  it('every instance scale is within [minScale, maxScale] and rotation within [0, 2*PI]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000000 }),
        fc.double({ min: 0.1, max: 1.0, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1.0, max: 3.0, noNaN: true, noDefaultInfinity: true }),
        fc.boolean(),
        async (seed, minScale, maxScale, randomRotation) => {
          const config: ScatterConfig = {
            ...DEFAULT_SCATTER_CONFIG,
            seed,
            minScale,
            maxScale,
            randomRotation,
          };

          // Generate a small set of random positions
          const rng = createPRNG(seed);
          const positions: Array<{ x: number; y: number; z: number }> = [];
          const count = 2 + Math.floor(rng() * 3); // 2-4 positions
          for (let i = 0; i < count; i++) {
            positions.push({
              x: rng() * 100,
              y: rng() * 50,
              z: rng() * 100,
            });
          }

          const transformRng = createPRNG(seed + 2);
          const matrices = await generateTransformMatrices(positions, config, transformRng);

          for (let i = 0; i < positions.length; i++) {
            const offset = i * 16;

            // Extract scale from column-major 4x4 matrix
            // Column 0: [m[0], m[1], m[2], m[3]]
            // Column 1: [m[4], m[5], m[6], m[7]]
            // Column 2: [m[8], m[9], m[10], m[11]]
            const scaleX = Math.sqrt(
              matrices[offset + 0] ** 2 +
              matrices[offset + 1] ** 2 +
              matrices[offset + 2] ** 2
            );
            const scaleY = Math.sqrt(
              matrices[offset + 4] ** 2 +
              matrices[offset + 5] ** 2 +
              matrices[offset + 6] ** 2
            );
            const scaleZ = Math.sqrt(
              matrices[offset + 8] ** 2 +
              matrices[offset + 9] ** 2 +
              matrices[offset + 10] ** 2
            );

            // All scales should be uniform and within [minScale, maxScale]
            const tolerance = 1e-5;
            expect(scaleX).toBeGreaterThanOrEqual(minScale - tolerance);
            expect(scaleX).toBeLessThanOrEqual(maxScale + tolerance);
            expect(scaleY).toBeGreaterThanOrEqual(minScale - tolerance);
            expect(scaleY).toBeLessThanOrEqual(maxScale + tolerance);
            expect(scaleZ).toBeGreaterThanOrEqual(minScale - tolerance);
            expect(scaleZ).toBeLessThanOrEqual(maxScale + tolerance);

            // Verify uniform scale (all axes equal)
            expect(Math.abs(scaleX - scaleY)).toBeLessThan(tolerance);
            expect(Math.abs(scaleX - scaleZ)).toBeLessThan(tolerance);

            // Extract Y-axis rotation from the rotation matrix
            // For a Y-rotation matrix R combined with uniform scale s:
            // Column 0: [s*cos(θ), 0, s*(-sin(θ)), 0]  (column-major)
            // Column 2: [s*sin(θ), 0, s*cos(θ), 0]
            // So: sin(θ) = m[8] / scaleZ, cos(θ) = m[0] / scaleX
            if (randomRotation) {
              const cosTheta = matrices[offset + 0] / scaleX;
              const sinTheta = matrices[offset + 8] / scaleZ;
              let angle = Math.atan2(sinTheta, cosTheta);
              // Normalize to [0, 2*PI]
              if (angle < 0) angle += 2 * Math.PI;

              expect(angle).toBeGreaterThanOrEqual(-tolerance);
              expect(angle).toBeLessThanOrEqual(2 * Math.PI + tolerance);
            } else {
              // When rotation is disabled, the rotation part should be identity (scaled)
              // Off-diagonal rotation elements should be ~0
              expect(Math.abs(matrices[offset + 8] / scaleZ)).toBeLessThan(tolerance);
              expect(Math.abs(matrices[offset + 2] / scaleX)).toBeLessThan(tolerance);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 8: Deterministic Placement ───────────────────────

/**
 * Property 8: Deterministic Placement
 *
 * For any mask, terrain, and config (including seed), invoking scatter twice
 * with identical inputs produces byte-identical instance counts and matrix buffers.
 *
 * **Validates: Requirements 6.5**
 */
describe('Property 8: Deterministic Placement', () => {
  it('identical inputs produce identical outputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMaskData,
        arbScatterConfig,
        arbTileDimensions,
        async (mask, config, tile) => {
          // Run 1
          const candidates1 = generateCandidates(tile.width, tile.height, config);
          const filtered1 = filterByMask(candidates1, mask, tile.width, tile.height, config.vegetationThreshold);
          const positions1 = filtered1.slice(0, 3).map((p) => ({ x: p.x, y: 0, z: p.z }));
          let matrices1: Float32Array | null = null;
          if (positions1.length > 0) {
            const rng1 = createPRNG(config.seed + 2);
            matrices1 = await generateTransformMatrices(positions1, config, rng1);
          }

          // Run 2 (identical inputs)
          const candidates2 = generateCandidates(tile.width, tile.height, config);
          const filtered2 = filterByMask(candidates2, mask, tile.width, tile.height, config.vegetationThreshold);
          const positions2 = filtered2.slice(0, 3).map((p) => ({ x: p.x, y: 0, z: p.z }));
          let matrices2: Float32Array | null = null;
          if (positions2.length > 0) {
            const rng2 = createPRNG(config.seed + 2);
            matrices2 = await generateTransformMatrices(positions2, config, rng2);
          }

          // Verify identical results
          expect(filtered1.length).toBe(filtered2.length);
          expect(positions1.length).toBe(positions2.length);

          if (matrices1 && matrices2) {
            expect(matrices1.length).toBe(matrices2.length);
            for (let i = 0; i < matrices1.length; i++) {
              expect(matrices1[i]).toBe(matrices2[i]);
            }
          } else {
            expect(matrices1).toBe(matrices2); // both null
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 9: Instance Cap Enforcement ──────────────────────

/**
 * Property 9: Instance Cap Enforcement
 *
 * For any mask and config, placed instance count never exceeds `maxInstancesPerTile`.
 *
 * **Validates: Requirements 7.1, 7.2, 10.1**
 */
describe('Property 9: Instance Cap Enforcement', () => {
  it('enforceInstanceCap never returns more than maxInstancesPerTile positions', () => {
    // Suppress console.warn for cap-reached messages
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      fc.assert(
        fc.property(
          arbMaskData,
          // Use configs with low caps to trigger the cap frequently
          fc.record({
            density: fc.double({ min: 0.01, max: 0.05, noNaN: true, noDefaultInfinity: true }),
            minScale: fc.constant(0.6),
            maxScale: fc.constant(1.4),
            randomRotation: fc.constant(true),
            seed: fc.integer({ min: 0, max: 1000000 }),
            vegetationThreshold: fc.integer({ min: 0, max: 100 }), // low threshold = more coverage
            maxInstancesPerTile: fc.integer({ min: 1, max: 50 }), // low cap to trigger enforcement
            heightExaggeration: fc.constant(1.5),
            jitterAmount: fc.double({ min: 0.0, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          }),
          arbTileDimensions,
          (mask, config, tile) => {
            const candidates = generateCandidates(tile.width, tile.height, config);
            const filtered = filterByMask(candidates, mask, tile.width, tile.height, config.vegetationThreshold);
            const rng = createPRNG(config.seed + 1);
            const capped = enforceInstanceCap(filtered, config.maxInstancesPerTile, rng);

            expect(capped.length).toBeLessThanOrEqual(config.maxInstancesPerTile);
          }
        ),
        { numRuns: 200 }
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── Property 10: Matrix Buffer Validity ───────────────────────

/**
 * Property 10: Matrix Buffer Validity
 *
 * For any scatter result, buffer length equals `instanceCount * 16` and every
 * float is finite.
 *
 * **Validates: Requirements 6.4, 8.3**
 */
describe('Property 10: Matrix Buffer Validity', () => {
  it('buffer length equals positions.length * 16 and all values are finite', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000000 }),
        fc.double({ min: 0.1, max: 1.0, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1.0, max: 3.0, noNaN: true, noDefaultInfinity: true }),
        fc.boolean(),
        async (seed, minScale, maxScale, randomRotation) => {
          const config: ScatterConfig = {
            ...DEFAULT_SCATTER_CONFIG,
            seed,
            minScale,
            maxScale,
            randomRotation,
          };

          // Generate random positions
          const rng = createPRNG(seed);
          const count = 1 + Math.floor(rng() * 4); // 1-4 positions
          const positions: Array<{ x: number; y: number; z: number }> = [];
          for (let i = 0; i < count; i++) {
            positions.push({
              x: rng() * 500,
              y: rng() * 100,
              z: rng() * 500,
            });
          }

          const transformRng = createPRNG(seed + 2);
          const matrices = await generateTransformMatrices(positions, config, transformRng);

          // Buffer length must equal positions.length * 16
          expect(matrices.length).toBe(positions.length * 16);

          // All values must be finite
          expect(validateMatrixBuffer(matrices)).toBe(true);

          // Double-check: verify each value individually
          for (let i = 0; i < matrices.length; i++) {
            expect(isFinite(matrices[i])).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
