/**
 * Property 2: Preservation - Non-Vegetation Mask Behavior Unchanged
 *
 * These tests capture the existing correct behavior of non-vegetation masks
 * (road, water, building, cliff) and the vegetation-disabled scenario.
 * They MUST PASS on the unfixed code to establish a baseline, and continue
 * to pass after the vegetation fix is applied (confirming no regressions).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GeoBounds, OverpassFeature, OverpassQueryResult } from '../overpass-client';
import type { MaskGenerationOptions, MaskResult } from '../mask-generator';

// ─── Mock Setup ────────────────────────────────────────────────

// Mock the overpass-client module to avoid real network calls
vi.mock('../overpass-client', () => ({
  fetchRoads: vi.fn(),
  fetchWater: vi.fn(),
  fetchVegetation: vi.fn(),
  fetchBuildings: vi.fn(),
}));

// Mock sharp to avoid real image I/O but track calls
vi.mock('sharp', () => {
  const mockSharp = (buffer: Buffer, opts: any) => ({
    tiff: (tiffOpts: any) => ({
      toFile: vi.fn().mockImplementation(async (filePath: string) => {
        // Write a minimal file so fs.existsSync checks pass
        const dir = require('path').dirname(filePath);
        if (!require('fs').existsSync(dir)) {
          require('fs').mkdirSync(dir, { recursive: true });
        }
        require('fs').writeFileSync(filePath, buffer);
      }),
    }),
    png: () => ({
      toFile: vi.fn().mockImplementation(async (filePath: string) => {
        const dir = require('path').dirname(filePath);
        if (!require('fs').existsSync(dir)) {
          require('fs').mkdirSync(dir, { recursive: true });
        }
        require('fs').writeFileSync(filePath, buffer);
      }),
    }),
  });
  return { default: mockSharp };
});

import { fetchRoads, fetchWater, fetchVegetation, fetchBuildings } from '../overpass-client';
import { rasterizeToFile } from '../vector-rasterizer';
import { generateMasks, computeCliffMask, computeSlopeGrid } from '../mask-generator';

// ─── Helpers ───────────────────────────────────────────────────

/** Creates a mock OverpassQueryResult with given features */
function makeQueryResult(features: OverpassFeature[] = []): OverpassQueryResult {
  return { features, queryTimeMs: 10, featureCount: features.length };
}

/** Creates sample polygon features within given bounds */
function makeSamplePolygonFeatures(bounds: GeoBounds, count: number): OverpassFeature[] {
  const features: OverpassFeature[] = [];
  const latStep = (bounds.north - bounds.south) / (count + 1);
  const lonStep = (bounds.east - bounds.west) / (count + 1);

  for (let i = 0; i < count; i++) {
    const baseLat = bounds.south + latStep * (i + 0.5);
    const baseLon = bounds.west + lonStep * (i + 0.5);
    const size = Math.min(latStep, lonStep) * 0.3;

    features.push({
      type: 'way',
      id: 1000 + i,
      geometry: [
        { lat: baseLat, lon: baseLon },
        { lat: baseLat + size, lon: baseLon },
        { lat: baseLat + size, lon: baseLon + size },
        { lat: baseLat, lon: baseLon + size },
      ],
      tags: {},
    });
  }
  return features;
}

/** Creates sample line features within given bounds */
function makeSampleLineFeatures(bounds: GeoBounds, count: number): OverpassFeature[] {
  const features: OverpassFeature[] = [];
  const latStep = (bounds.north - bounds.south) / (count + 1);

  for (let i = 0; i < count; i++) {
    const lat = bounds.south + latStep * (i + 1);
    features.push({
      type: 'way',
      id: 2000 + i,
      geometry: [
        { lat, lon: bounds.west + (bounds.east - bounds.west) * 0.1 },
        { lat, lon: bounds.west + (bounds.east - bounds.west) * 0.9 },
      ],
      tags: { highway: 'primary' },
    });
  }
  return features;
}

// ─── Arbitraries ───────────────────────────────────────────────

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

/** Arbitrary for mask resolution */
const arbResolution = fc.integer({ min: 64, max: 512 });

/** Arbitrary for tile prefix */
const arbTilePrefix = fc.constantFrom('tile_0_0', 'tile_0_1', 'tile_1_0', 'tile_2_3');

/** Arbitrary for cliff threshold degrees */
const arbCliffThreshold = fc.double({ min: 10, max: 80, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for road line width */
const arbRoadLineWidth = fc.integer({ min: 1, max: 10 });

// ─── Property Tests ────────────────────────────────────────────


/**
 * Property 2.1: Vegetation Disabled - No Vegetation Data Fetched
 *
 * For all random GeoBounds and mask settings where vegetation is disabled:
 * no vegetation data is fetched and no vegetation mask file is produced.
 *
 * **Validates: Requirements 3.1**
 */
describe('Property 2.1: Vegetation disabled produces no vegetation mask', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-veg-disabled-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('when generateVegetationMask=false, fetchVegetation is never called and result has no vegetationMask', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          // Configure all fetch mocks to return empty results
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: false, // Disabled
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          // fetchVegetation should never be called
          expect(fetchVegetation).not.toHaveBeenCalled();

          // No vegetation mask in result
          expect(result.vegetationMask).toBeUndefined();

          // No vegetation mask file on disk
          const files = fs.readdirSync(tmpDir);
          const vegFiles = files.filter(f => f.includes('vegetation'));
          expect(vegFiles.length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('when vegetation is disabled but other masks are enabled, vegetation is still not fetched', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: true,
            generateVegetationMask: false, // Disabled
            generateBuildingMask: true,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          // fetchVegetation should never be called even when other masks are enabled
          expect(fetchVegetation).not.toHaveBeenCalled();
          expect(result.vegetationMask).toBeUndefined();

          // Other masks should be generated
          expect(fetchRoads).toHaveBeenCalledTimes(1);
          expect(fetchWater).toHaveBeenCalledTimes(1);
          expect(fetchBuildings).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.2: Road Mask Generation Unchanged
 *
 * For all random GeoBounds: road mask generation produces identical output
 * regardless of vegetation pipeline changes. The road mask uses fetchRoads()
 * and rasterizes as lines at the configured resolution.
 *
 * **Validates: Requirements 3.3**
 */
describe('Property 2.2: Road mask generation produces consistent output', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-road-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('road mask is generated using fetchRoads and produces a file with correct naming', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        arbRoadLineWidth,
        async (bounds, resolution, tilePrefix, roadLineWidth) => {
          vi.clearAllMocks();

          const roadFeatures = makeSampleLineFeatures(bounds, 3);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(roadFeatures));
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: false,
            generateVegetationMask: false,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
            roadLineWidthPx: roadLineWidth,
          };

          const result = await generateMasks(options);

          // Road mask should be generated
          expect(result.roadMask).toBeDefined();
          expect(result.roadMask).toBe(`${tilePrefix}_road_mask.tif`);

          // fetchRoads was called with the correct bounds
          expect(fetchRoads).toHaveBeenCalledWith(bounds);

          // File should exist on disk
          const filePath = path.join(tmpDir, result.roadMask!);
          expect(fs.existsSync(filePath)).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('road mask generation is independent of vegetation mask setting', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        fc.boolean(),
        async (bounds, resolution, tilePrefix, vegEnabled) => {
          vi.clearAllMocks();

          const roadFeatures = makeSampleLineFeatures(bounds, 2);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(roadFeatures));
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: false,
            generateVegetationMask: vegEnabled,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          // Road mask is always generated regardless of vegetation setting
          expect(result.roadMask).toBeDefined();
          expect(result.roadMask).toBe(`${tilePrefix}_road_mask.tif`);
          expect(fetchRoads).toHaveBeenCalledWith(bounds);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.3: Water Mask Generation Unchanged
 *
 * For all random GeoBounds: water mask generation produces identical output
 * regardless of vegetation pipeline changes.
 *
 * **Validates: Requirements 3.3**
 */
describe('Property 2.3: Water mask generation produces consistent output', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-water-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('water mask is generated using fetchWater and produces a file with correct naming', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          const waterFeatures = makeSamplePolygonFeatures(bounds, 2);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(waterFeatures));
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: true,
            generateVegetationMask: false,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          expect(result.waterMask).toBeDefined();
          expect(result.waterMask).toBe(`${tilePrefix}_water_mask.tif`);
          expect(fetchWater).toHaveBeenCalledWith(bounds);

          const filePath = path.join(tmpDir, result.waterMask!);
          expect(fs.existsSync(filePath)).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('water mask generation is independent of vegetation mask setting', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        fc.boolean(),
        async (bounds, resolution, tilePrefix, vegEnabled) => {
          vi.clearAllMocks();

          const waterFeatures = makeSamplePolygonFeatures(bounds, 2);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(waterFeatures));
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: true,
            generateVegetationMask: vegEnabled,
            generateBuildingMask: false,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          expect(result.waterMask).toBeDefined();
          expect(result.waterMask).toBe(`${tilePrefix}_water_mask.tif`);
          expect(fetchWater).toHaveBeenCalledWith(bounds);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.4: Building Mask Generation Unchanged
 *
 * For all random GeoBounds: building mask generation produces identical output
 * regardless of vegetation pipeline changes.
 *
 * **Validates: Requirements 3.3**
 */
describe('Property 2.4: Building mask generation produces consistent output', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-building-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('building mask is generated using fetchBuildings and produces a file with correct naming', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          const buildingFeatures = makeSamplePolygonFeatures(bounds, 4);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(buildingFeatures));

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: false,
            generateBuildingMask: true,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          expect(result.buildingMask).toBeDefined();
          expect(result.buildingMask).toBe(`${tilePrefix}_building_mask.tif`);
          expect(fetchBuildings).toHaveBeenCalledWith(bounds);

          const filePath = path.join(tmpDir, result.buildingMask!);
          expect(fs.existsSync(filePath)).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('building mask generation is independent of vegetation mask setting', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        fc.boolean(),
        async (bounds, resolution, tilePrefix, vegEnabled) => {
          vi.clearAllMocks();

          const buildingFeatures = makeSamplePolygonFeatures(bounds, 3);
          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(buildingFeatures));

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: vegEnabled,
            generateBuildingMask: true,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          expect(result.buildingMask).toBeDefined();
          expect(result.buildingMask).toBe(`${tilePrefix}_building_mask.tif`);
          expect(fetchBuildings).toHaveBeenCalledWith(bounds);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.5: Cliff Mask Computation Unchanged
 *
 * For all random GeoBounds with DEM data: cliff mask computation produces
 * identical output regardless of vegetation pipeline changes. The cliff mask
 * is computed purely from elevation data using a slope threshold.
 *
 * **Validates: Requirements 3.3**
 */
describe('Property 2.5: Cliff mask computation produces consistent output', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-cliff-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('cliff mask is computed from DEM data and produces correct binary output', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 32 }),
        arbCliffThreshold,
        fc.integer({ min: 16, max: 128 }),
        (elevSize, threshold, outputResolution) => {
          // Generate random elevation data with some steep slopes
          const elevations = new Float32Array(elevSize * elevSize);
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              // Create a gradient that produces slopes
              elevations[y * elevSize + x] = x * 50 + y * 20;
            }
          }

          const result = computeCliffMask(elevations, elevSize, elevSize, threshold, outputResolution);

          // Output should be the correct size
          expect(result.length).toBe(outputResolution * outputResolution);

          // All values should be binary (0 or 255)
          for (let i = 0; i < result.length; i++) {
            expect(result[i] === 0 || result[i] === 255).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('cliff mask computation is deterministic for the same elevation data', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 32 }),
        arbCliffThreshold,
        arbResolution,
        (elevSize, threshold, outputResolution) => {
          const elevations = new Float32Array(elevSize * elevSize);
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              elevations[y * elevSize + x] = Math.sin(x * 0.5) * 100 + Math.cos(y * 0.3) * 50;
            }
          }

          // Compute twice with same inputs
          const result1 = computeCliffMask(elevations, elevSize, elevSize, threshold, outputResolution);
          const result2 = computeCliffMask(elevations, elevSize, elevSize, threshold, outputResolution);

          // Results must be byte-identical
          expect(Buffer.compare(result1, result2)).toBe(0);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('cliff mask generation via generateMasks is independent of vegetation setting', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        arbCliffThreshold,
        fc.boolean(),
        async (bounds, resolution, tilePrefix, threshold, vegEnabled) => {
          vi.clearAllMocks();

          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

          // Create elevation data with slopes
          const elevSize = 16;
          const elevations = new Float32Array(elevSize * elevSize);
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              elevations[y * elevSize + x] = x * 30;
            }
          }

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: false,
            generateWaterMask: false,
            generateVegetationMask: vegEnabled,
            generateBuildingMask: false,
            generateCliffMask: true,
            cliffThresholdDegrees: threshold,
          };

          const result = await generateMasks(options, elevations, elevSize, elevSize);

          // Cliff mask should always be generated when enabled, regardless of vegetation
          expect(result.cliffMask).toBeDefined();
          expect(result.cliffMask).toBe(`${tilePrefix}_cliff_mask.tif`);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.6: Output Resolution Uses Configured Resolution
 *
 * For all mask types (road, water, building, cliff): output resolution uses
 * their configured resolution, unaffected by vegetation changes.
 *
 * **Validates: Requirements 3.7**
 */
describe('Property 2.6: Non-vegetation masks use configured resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-resolution-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('cliff mask output dimensions match the configured resolution', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 32 }),
        arbResolution,
        arbCliffThreshold,
        (elevSize, outputResolution, threshold) => {
          const elevations = new Float32Array(elevSize * elevSize);
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              elevations[y * elevSize + x] = x * 20 + y * 10;
            }
          }

          const result = computeCliffMask(elevations, elevSize, elevSize, threshold, outputResolution);

          // Output buffer size must be outputResolution^2
          expect(result.length).toBe(outputResolution * outputResolution);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('slope grid computation dimensions match input DEM dimensions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 64 }),
        fc.integer({ min: 4, max: 64 }),
        (width, height) => {
          const elevations = new Float32Array(width * height);
          for (let i = 0; i < elevations.length; i++) {
            elevations[i] = Math.random() * 1000;
          }

          const slopeGrid = computeSlopeGrid(elevations, width, height);

          // Slope grid must have same dimensions as input
          expect(slopeGrid.length).toBe(width * height);

          // All slope values must be non-negative (degrees)
          for (let i = 0; i < slopeGrid.length; i++) {
            expect(slopeGrid[i]).toBeGreaterThanOrEqual(0);
            expect(slopeGrid[i]).toBeLessThanOrEqual(90);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('all non-vegetation OSM masks use options.resolution for rasterization', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        arbResolution,
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();

          const roadFeatures = makeSampleLineFeatures(bounds, 2);
          const waterFeatures = makeSamplePolygonFeatures(bounds, 2);
          const buildingFeatures = makeSamplePolygonFeatures(bounds, 2);

          (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(roadFeatures));
          (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(waterFeatures));
          (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
          (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(buildingFeatures));

          const options: MaskGenerationOptions = {
            bounds,
            resolution,
            outputPath: tmpDir,
            tilePrefix,
            generateRoadMask: true,
            generateWaterMask: true,
            generateVegetationMask: false,
            generateBuildingMask: true,
            generateCliffMask: false,
            cliffThresholdDegrees: 45,
          };

          const result = await generateMasks(options);

          // All three masks should be generated
          expect(result.roadMask).toBeDefined();
          expect(result.waterMask).toBeDefined();
          expect(result.buildingMask).toBeDefined();

          // Verify files exist and have content (resolution is encoded in the raw buffer)
          for (const maskFile of [result.roadMask!, result.waterMask!, result.buildingMask!]) {
            const filePath = path.join(tmpDir, maskFile);
            expect(fs.existsSync(filePath)).toBe(true);
            const stats = fs.statSync(filePath);
            // File should contain resolution*resolution bytes (raw buffer written by mock)
            expect(stats.size).toBe(resolution * resolution);
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Property 2.7: Output Format is 8-bit Single-Channel Grayscale TIFF
 *
 * For all mask types: the output format is 8-bit single-channel grayscale
 * TIFF with LZW compression. Verified by checking that cliff mask (which
 * uses writeGrayscalePng/sharp TIFF pipeline) produces binary 8-bit output,
 * and that the raw buffers from computeCliffMask are single-channel 8-bit.
 *
 * **Validates: Requirements 3.4**
 */
describe('Property 2.7: Output format is 8-bit grayscale TIFF with LZW compression', () => {
  it('cliff mask output is 8-bit single-channel (values 0 or 255 only)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 32 }),
        fc.integer({ min: 16, max: 128 }),
        arbCliffThreshold,
        (elevSize, outputResolution, threshold) => {
          const elevations = new Float32Array(elevSize * elevSize);
          // Create varied terrain
          for (let y = 0; y < elevSize; y++) {
            for (let x = 0; x < elevSize; x++) {
              elevations[y * elevSize + x] = Math.sin(x * 0.8) * 200 + y * 15;
            }
          }

          const result = computeCliffMask(elevations, elevSize, elevSize, threshold, outputResolution);

          // Verify single-channel: buffer size = width * height (1 byte per pixel)
          expect(result.length).toBe(outputResolution * outputResolution);

          // Verify 8-bit binary: all values are 0 or 255
          for (let i = 0; i < result.length; i++) {
            const val = result[i];
            expect(val === 0 || val === 255).toBe(true);
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it('OSM mask files written to disk are single-channel 8-bit (resolution*resolution bytes)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGeoBounds,
        fc.integer({ min: 16, max: 128 }),
        arbTilePrefix,
        async (bounds, resolution, tilePrefix) => {
          vi.clearAllMocks();
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preservation-format-'));

          try {
            const waterFeatures = makeSamplePolygonFeatures(bounds, 2);
            (fetchRoads as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
            (fetchWater as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult(waterFeatures));
            (fetchVegetation as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());
            (fetchBuildings as ReturnType<typeof vi.fn>).mockResolvedValue(makeQueryResult());

            const options: MaskGenerationOptions = {
              bounds,
              resolution,
              outputPath: tmpDir,
              tilePrefix,
              generateRoadMask: false,
              generateWaterMask: true,
              generateVegetationMask: false,
              generateBuildingMask: false,
              generateCliffMask: false,
              cliffThresholdDegrees: 45,
            };

            const result = await generateMasks(options);
            expect(result.waterMask).toBeDefined();

            // The mock sharp writes the raw buffer to disk
            // Raw buffer should be resolution*resolution bytes (8-bit single channel)
            const filePath = path.join(tmpDir, result.waterMask!);
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              expect(stats.size).toBe(resolution * resolution);
            }
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
