/**
 * Bug Condition Exploration Test - OSM-Only Vegetation Mask Inaccuracy
 *
 * This property-based test encodes the EXPECTED behavior for vegetation mask
 * generation. It is written BEFORE the fix is implemented and is EXPECTED TO
 * FAIL on the current (unfixed) code. Failure confirms the bug exists.
 *
 * Bug Condition: isBugCondition(input) holds when:
 *   - options.generateVegetationMask == true
 *   - vegetationDataSource == 'osm' (current behavior)
 *   - OR maskOutputResolution != heightmapPixelDimensions
 *
 * Expected Behavior (after fix):
 *   - result.dataSource == 'satellite' (should use satellite data, not OSM)
 *   - result.outputWidth == input.heightmapSize
 *   - result.outputHeight == input.heightmapSize
 *   - Pixel values reflect satellite land cover classification, not OSM polygon fill
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock the satellite vegetation client to avoid real HTTPS calls to ESA WorldCover.
// The mock simulates a successful satellite fetch returning multi-class vegetation data.
vi.mock('../satellite-vegetation-client', () => ({
  fetchSatelliteVegetation: vi.fn(async (_bounds: any, outputWidth: number, outputHeight: number) => {
    // Generate a buffer with multi-class vegetation values (not binary 0/255)
    // simulating real satellite land cover classification data.
    const buffer = Buffer.alloc(outputWidth * outputHeight);
    for (let i = 0; i < buffer.length; i++) {
      // Distribute values across vegetation classes: 255, 200, 150, 100, 0
      const classValues = [255, 200, 150, 100, 0];
      buffer[i] = classValues[i % classValues.length];
    }
    return buffer;
  }),
}));

// ─── Types ─────────────────────────────────────────────────────

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface MaskGenerationRequest {
  bounds: GeoBounds;
  heightmapSize: number;
  generateVegetationMask: boolean;
  vegetationDataSource: 'osm' | 'satellite';
  maskOutputResolution: number;
}

/**
 * Determines if the bug condition holds for a given input.
 * The bug manifests when vegetation mask is enabled AND either:
 * - The data source is OSM-only (current behavior), OR
 * - The mask output resolution doesn't match heightmap dimensions
 */
function isBugCondition(input: MaskGenerationRequest): boolean {
  const vegetationEnabled = input.generateVegetationMask === true;
  const usesOsmOnly = input.vegetationDataSource === 'osm';
  const resolutionMismatch = input.maskOutputResolution !== input.heightmapSize;
  return vegetationEnabled && (usesOsmOnly || resolutionMismatch);
}

// ─── Arbitraries ───────────────────────────────────────────────

/** Arbitrary for valid GeoBounds (small areas to keep tests fast) */
const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -60, max: 60, noNaN: true, noDefaultInfinity: true }),
    latSpan: fc.double({ min: 0.005, max: 0.1, noNaN: true, noDefaultInfinity: true }),
    west: fc.double({ min: -170, max: 170, noNaN: true, noDefaultInfinity: true }),
    lonSpan: fc.double({ min: 0.005, max: 0.1, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ south, latSpan, west, lonSpan }) => ({
    south,
    north: south + latSpan,
    west,
    east: west + lonSpan,
  }));

/** Arbitrary for heightmap sizes (common power-of-2 resolutions) */
const arbHeightmapSize = fc.constantFrom(256, 512, 1024, 2048);

/**
 * Arbitrary for MaskGenerationRequest inputs where isBugCondition holds.
 * Generates inputs that trigger the bug: vegetation enabled with OSM source.
 */
const arbBugConditionInput: fc.Arbitrary<MaskGenerationRequest> = fc
  .record({
    bounds: arbGeoBounds,
    heightmapSize: arbHeightmapSize,
    // Bug condition: always OSM source (current behavior)
    vegetationDataSource: fc.constant('osm' as const),
    // Resolution may or may not match heightmap (both trigger the bug with OSM source)
    resolutionMatchesHeightmap: fc.boolean(),
  })
  .map(({ bounds, heightmapSize, vegetationDataSource, resolutionMatchesHeightmap }) => ({
    bounds,
    heightmapSize,
    generateVegetationMask: true,
    vegetationDataSource,
    maskOutputResolution: resolutionMatchesHeightmap ? heightmapSize : heightmapSize + 128,
  }));

// ─── Test Setup ────────────────────────────────────────────────

describe('Property 1: Bug Condition - OSM-Only Vegetation Mask Inaccuracy', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veg-mask-bug-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Property: When vegetation mask generation is enabled, the system should
   * use satellite-derived data (not OSM) and output dimensions should match
   * the heightmap pixel dimensions exactly.
   *
   * This test calls the actual generateMasks function and verifies:
   * 1. The vegetation mask pipeline uses satellite data (not OSM vectors)
   * 2. The output mask dimensions match the heightmap size
   * 3. Pixel values reflect multi-class satellite classification (not binary polygon fill)
   *
   * ON UNFIXED CODE: This test WILL FAIL because:
   * - The current code uses fetchVegetation() (OSM Overpass) for vegetation data
   * - The current code produces binary (0/255) polygon fill, not satellite classification
   * - There is no satellite data source in the current pipeline
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
   */
  it('vegetation mask should use satellite data source and match heightmap dimensions', async () => {
    // We need to spy on the actual implementation to verify data source behavior.
    // Import the real modules (no mocking of overpass-client for this test).
    const { generateMasks } = await import('../mask-generator');
    const overpassClient = await import('../overpass-client');

    // Spy on fetchVegetation to detect if OSM is being used
    const fetchVegetationSpy = vi.spyOn(overpassClient, 'fetchVegetation');

    // Mock fetchVegetation to return data quickly (avoid real network calls)
    // but still track that it was called (proving OSM is used)
    fetchVegetationSpy.mockResolvedValue({
      features: [
        {
          type: 'way',
          id: 12345,
          geometry: [
            { lat: 48.0, lon: 11.0 },
            { lat: 48.01, lon: 11.0 },
            { lat: 48.01, lon: 11.01 },
            { lat: 48.0, lon: 11.01 },
            { lat: 48.0, lon: 11.0 },
          ],
          tags: { landuse: 'forest' },
        },
      ],
      queryTimeMs: 50,
      featureCount: 1,
    });

    // Also mock other fetch functions to avoid network calls
    vi.spyOn(overpassClient, 'fetchRoads').mockResolvedValue({
      features: [], queryTimeMs: 10, featureCount: 0,
    });
    vi.spyOn(overpassClient, 'fetchWater').mockResolvedValue({
      features: [], queryTimeMs: 10, featureCount: 0,
    });
    vi.spyOn(overpassClient, 'fetchBuildings').mockResolvedValue({
      features: [], queryTimeMs: 10, featureCount: 0,
    });

    await fc.assert(
      fc.asyncProperty(
        arbBugConditionInput,
        async (input) => {
          // Verify the input satisfies the bug condition
          expect(isBugCondition(input)).toBe(true);

          const { MaskGenerationOptions } = await import('../mask-generator');

          const options = {
            bounds: input.bounds,
            resolution: input.maskOutputResolution,
            outputPath: tmpDir,
            tilePrefix: 'tile_0_0',
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: true,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
            // Pass explicit heightmap dimensions so the vegetation mask
            // uses heightmapSize instead of the mismatched resolution
            heightmapWidth: input.heightmapSize,
            heightmapHeight: input.heightmapSize,
          };

          const result = await generateMasks(options);

          // ─── Assert Expected Behavior ─────────────────────────────

          // 1. Vegetation mask should be generated
          expect(result.vegetationMask).toBeDefined();

          // 2. The system should NOT have called fetchVegetation (OSM).
          //    Expected behavior: use satellite data source instead.
          //    ON UNFIXED CODE: This will FAIL because fetchVegetation IS called.
          expect(fetchVegetationSpy).not.toHaveBeenCalled();

          // 3. If a vegetation mask file was produced, verify its dimensions
          //    match the heightmap size (not the configured mask resolution if different)
          if (result.vegetationMask) {
            const maskFilePath = path.join(tmpDir, result.vegetationMask);
            if (fs.existsSync(maskFilePath)) {
              // Read the mask file and verify dimensions match heightmapSize
              const sharp = (await import('sharp')).default;
              const metadata = await sharp(maskFilePath).metadata();

              // Expected: output dimensions match heightmap size exactly
              expect(metadata.width).toBe(input.heightmapSize);
              expect(metadata.height).toBe(input.heightmapSize);

              // 4. Verify pixel values are NOT purely binary (0/255).
              //    Satellite classification should produce multi-value output
              //    representing different vegetation density levels.
              //    ON UNFIXED CODE: This will FAIL because rasterizePolygons
              //    produces only binary 0/255 values.
              const { data } = await sharp(maskFilePath)
                .raw()
                .toBuffer({ resolveWithObject: true });

              const uniqueValues = new Set<number>();
              for (let i = 0; i < data.length; i++) {
                uniqueValues.add(data[i]);
              }

              // Satellite-derived masks should have more than just 2 values (0 and 255).
              // They should reflect vegetation density/classification with intermediate values.
              // Binary-only output (exactly {0, 255}) indicates OSM polygon fill, not satellite data.
              const isBinaryOnly = uniqueValues.size <= 2 &&
                (uniqueValues.has(0) || uniqueValues.has(255));

              expect(isBinaryOnly).toBe(false);
            }
          }

          // Reset spy call count for next iteration
          fetchVegetationSpy.mockClear();
        }
      ),
      { numRuns: 10 }
    );
  });

  /**
   * Property: Resolution alignment - vegetation mask output dimensions must
   * always equal the heightmap pixel dimensions, regardless of the configured
   * mask resolution.
   *
   * ON UNFIXED CODE: This test WILL FAIL when maskOutputResolution != heightmapSize
   * because the current code uses options.resolution directly without ensuring
   * alignment with heightmap dimensions.
   *
   * **Validates: Requirements 1.5**
   */
  it('vegetation mask output resolution should always match heightmap dimensions', async () => {
    const { generateMasks } = await import('../mask-generator');
    const overpassClient = await import('../overpass-client');

    // Mock to avoid network calls
    vi.spyOn(overpassClient, 'fetchVegetation').mockResolvedValue({
      features: [
        {
          type: 'way',
          id: 99999,
          geometry: [
            { lat: 48.0, lon: 11.0 },
            { lat: 48.05, lon: 11.0 },
            { lat: 48.05, lon: 11.05 },
            { lat: 48.0, lon: 11.05 },
            { lat: 48.0, lon: 11.0 },
          ],
          tags: { natural: 'wood' },
        },
      ],
      queryTimeMs: 30,
      featureCount: 1,
    });

    // Generate inputs where resolution explicitly mismatches heightmap
    const arbMismatchInput = fc.record({
      bounds: arbGeoBounds,
      heightmapSize: arbHeightmapSize,
      // Resolution offset ensures mismatch
      resolutionOffset: fc.integer({ min: 64, max: 512 }),
    }).map(({ bounds, heightmapSize, resolutionOffset }) => ({
      bounds,
      heightmapSize,
      maskOutputResolution: heightmapSize + resolutionOffset,
    }));

    await fc.assert(
      fc.asyncProperty(
        arbMismatchInput,
        async (input) => {
          const options = {
            bounds: input.bounds,
            resolution: input.maskOutputResolution, // Intentionally mismatched
            outputPath: tmpDir,
            tilePrefix: 'tile_0_0',
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: true,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
            // Pass explicit heightmap dimensions — the fix uses these
            // to ensure vegetation mask matches heightmap, not the mismatched resolution
            heightmapWidth: input.heightmapSize,
            heightmapHeight: input.heightmapSize,
          };

          const result = await generateMasks(options);

          // Vegetation mask should be generated
          expect(result.vegetationMask).toBeDefined();

          if (result.vegetationMask) {
            const maskFilePath = path.join(tmpDir, result.vegetationMask);
            if (fs.existsSync(maskFilePath)) {
              const sharp = (await import('sharp')).default;
              const metadata = await sharp(maskFilePath).metadata();

              // Expected: output dimensions should match heightmapSize,
              // NOT the configured mask resolution.
              // ON UNFIXED CODE: This FAILS because the current code uses
              // options.resolution directly (which is maskOutputResolution).
              expect(metadata.width).toBe(input.heightmapSize);
              expect(metadata.height).toBe(input.heightmapSize);
            }
          }
        }
      ),
      { numRuns: 10 }
    );
  });
});
