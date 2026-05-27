/**
 * Property-based tests for the Mask Generator module.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GeoBounds, OverpassQueryResult } from '../overpass-client';
import type { MaskGenerationOptions } from '../mask-generator';

// ─── Mock Setup ────────────────────────────────────────────────

// Mock the overpass-client module so we can control which fetches succeed/fail
vi.mock('../overpass-client', () => ({
  fetchRoads: vi.fn(),
  fetchWater: vi.fn(),
  fetchVegetation: vi.fn(),
  fetchBuildings: vi.fn(),
}));

// Mock the vector-rasterizer to avoid real sharp/PNG operations
vi.mock('../vector-rasterizer', () => ({
  rasterizeToFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock sharp for cliff mask PNG writing
vi.mock('sharp', () => {
  const mockSharp = () => ({
    png: () => ({
      toFile: vi.fn().mockResolvedValue(undefined),
    }),
  });
  return { default: mockSharp };
});

import { fetchRoads, fetchWater, fetchVegetation, fetchBuildings } from '../overpass-client';
import { rasterizeToFile } from '../vector-rasterizer';
import { generateMasks } from '../mask-generator';

// ─── Helpers ───────────────────────────────────────────────────

const MASK_TYPES = ['road', 'water', 'vegetation', 'building'] as const;
type OsmMaskType = typeof MASK_TYPES[number];

/** Creates a successful empty OverpassQueryResult */
function makeEmptyResult(): OverpassQueryResult {
  return { features: [], queryTimeMs: 10, featureCount: 0 };
}

/** Maps mask type to its corresponding mock fetch function */
function getFetchMock(maskType: OsmMaskType) {
  switch (maskType) {
    case 'road': return fetchRoads;
    case 'water': return fetchWater;
    case 'vegetation': return fetchVegetation;
    case 'building': return fetchBuildings;
  }
}

/** Maps mask type to its result field name in MaskResult */
function getResultField(maskType: OsmMaskType): string {
  return `${maskType}Mask`;
}

// ─── Arbitraries ───────────────────────────────────────────────

/** Arbitrary for a non-empty subset of mask types that will fail (1 to 3 types) */
const arbFailingSubset: fc.Arbitrary<OsmMaskType[]> = fc
  .subarray([...MASK_TYPES], { minLength: 1, maxLength: 3 })
  .filter((arr) => arr.length >= 1 && arr.length < MASK_TYPES.length);

/** Arbitrary for valid GeoBounds */
const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -80, max: 70, noNaN: true, noDefaultInfinity: true }),
    latSpan: fc.double({ min: 0.01, max: 2, noNaN: true, noDefaultInfinity: true }),
    west: fc.double({ min: -170, max: 160, noNaN: true, noDefaultInfinity: true }),
    lonSpan: fc.double({ min: 0.01, max: 2, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ south, latSpan, west, lonSpan }) => ({
    south,
    north: south + latSpan,
    west,
    east: west + lonSpan,
  }));

/** Arbitrary for resolution */
const arbResolution = fc.integer({ min: 64, max: 512 });

/** Arbitrary for tile prefix */
const arbTilePrefix = fc.constantFrom('tile_0_0', 'tile_0_1', 'tile_1_0', 'tile_2_3');

// ─── Property Test ─────────────────────────────────────────────

/**
 * Property 15: Failure isolation
 *
 * For any set of enabled mask types where a subset fails during generation,
 * all non-failing mask types SHALL still be generated and written to disk
 * successfully.
 *
 * **Validates: Requirement 8.1**
 */
describe('Property 15: Failure isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-gen-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('non-failing mask types are still generated when a subset of mask types fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailingSubset,
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (failingTypes, bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          // Determine which types succeed
          const succeedingTypes = MASK_TYPES.filter(
            (t) => !failingTypes.includes(t)
          );

          // Configure mocks: failing types throw, succeeding types return empty results
          for (const maskType of MASK_TYPES) {
            const mock = getFetchMock(maskType) as ReturnType<typeof vi.fn>;
            if (failingTypes.includes(maskType)) {
              mock.mockRejectedValue(new Error(`Simulated ${maskType} failure`));
            } else {
              mock.mockResolvedValue(makeEmptyResult());
            }
          }

          // Configure rasterizeToFile to succeed
          (rasterizeToFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: true,
            generateVegetationMask: true,
            generateBuildingMask: true,
            generateCliffMask: false, // Exclude cliff to focus on OSM mask isolation
            cliffThresholdDegrees: 45,
          };

          // generateMasks should NOT throw even when some masks fail
          const result = await generateMasks(options);

          // Succeeding mask types should have their result fields populated
          for (const maskType of succeedingTypes) {
            const field = getResultField(maskType) as keyof typeof result;
            expect(result[field]).toBeDefined();
            expect(result[field]).toContain(`${tilePrefix}_${maskType}_mask.png`);
          }

          // Failing mask types should NOT have their result fields populated
          for (const maskType of failingTypes) {
            const field = getResultField(maskType) as keyof typeof result;
            expect(result[field]).toBeUndefined();
          }

          // generationTimeMs should be set (function completed)
          expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('generateMasks does not throw when all OSM mask types fail but cliff mask succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          // All OSM fetches fail
          for (const maskType of MASK_TYPES) {
            const mock = getFetchMock(maskType) as ReturnType<typeof vi.fn>;
            mock.mockRejectedValue(new Error(`Simulated ${maskType} failure`));
          }

          // Provide valid elevation data for cliff mask
          const elevSize = 16;
          const elevations = new Float32Array(elevSize * elevSize);
          // Create a slope: elevation increases linearly along x
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              elevations[y * elevSize + x] = x * 10; // 10m per pixel
            }
          }

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: true,
            generateVegetationMask: true,
            generateBuildingMask: true,
            generateCliffMask: true,
            cliffThresholdDegrees: 45,
          };

          // Should NOT throw
          const result = await generateMasks(options, elevations, elevSize, elevSize);

          // All OSM masks should be undefined (failed)
          expect(result.roadMask).toBeUndefined();
          expect(result.waterMask).toBeUndefined();
          expect(result.vegetationMask).toBeUndefined();
          expect(result.buildingMask).toBeUndefined();

          // Cliff mask should be generated (elevation data was provided)
          expect(result.cliffMask).toBeDefined();
          expect(result.cliffMask).toContain(`${tilePrefix}_cliff_mask.png`);

          // Function completed
          expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('generateMasks completes with partial results when arbitrary subset fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailingSubset,
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (failingTypes, bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          const succeedingTypes = MASK_TYPES.filter(
            (t) => !failingTypes.includes(t)
          );

          // Configure mocks
          for (const maskType of MASK_TYPES) {
            const mock = getFetchMock(maskType) as ReturnType<typeof vi.fn>;
            if (failingTypes.includes(maskType)) {
              mock.mockRejectedValue(new Error(`Network timeout for ${maskType}`));
            } else {
              mock.mockResolvedValue(makeEmptyResult());
            }
          }

          (rasterizeToFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: true,
            generateVegetationMask: true,
            generateBuildingMask: true,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          // Count how many mask fields are defined in the result
          const definedMasks = MASK_TYPES.filter(
            (t) => result[getResultField(t) as keyof typeof result] !== undefined
          );

          // Exactly the succeeding types should have results
          expect(definedMasks.length).toBe(succeedingTypes.length);
          expect(new Set(definedMasks)).toEqual(new Set(succeedingTypes));
        }
      ),
      { numRuns: 50 }
    );
  });
});
