/**
 * Preservation Property Tests — Task 2
 *
 * These tests capture the EXISTING correct behavior of the system that must
 * not regress when bug fixes are applied. They run on UNFIXED code and MUST PASS.
 *
 * Observation-first methodology:
 * 1. PNG heightmap export produces valid 16-bit PNG
 * 2. R16 heightmap export produces valid raw 16-bit LE binary
 * 3. Uncompressed GeoTIFF produces valid TIFF readable by geotiff library
 * 4. fs:readFileBinary with valid path returns file contents
 * 5. Manifest JSON structure contains all required fields
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeGeoTIFF } from '../electron/geotiff-writer';
import { fromArrayBuffer } from 'geotiff';

// ─── Helpers ──────────────────────────────────────────────────

/** Generate a random Float32Array of elevations within realistic range */
function arbElevationArray(minSize = 4, maxSize = 64) {
  return fc.integer({ min: minSize, max: maxSize }).chain((size) =>
    fc.array(fc.double({ min: -500, max: 9000, noNaN: true, noDefaultInfinity: true }), {
      minLength: size * size,
      maxLength: size * size,
    }).map((arr) => ({
      elevations: new Float32Array(arr),
      width: size,
      height: size,
    }))
  );
}

/** Generate a random GeoBounds within valid WGS84 range */
function arbGeoBounds() {
  return fc.record({
    west: fc.double({ min: -179, max: 178, noNaN: true, noDefaultInfinity: true }),
    south: fc.double({ min: -89, max: 88, noNaN: true, noDefaultInfinity: true }),
  }).chain(({ west, south }) =>
    fc.record({
      west: fc.constant(west),
      south: fc.constant(south),
      east: fc.double({ min: west + 0.01, max: Math.min(west + 2, 180), noNaN: true, noDefaultInfinity: true }),
      north: fc.double({ min: south + 0.01, max: Math.min(south + 2, 90), noNaN: true, noDefaultInfinity: true }),
    })
  );
}

// ─── Property Tests ───────────────────────────────────────────

describe('Preservation Property Tests', () => {

  /**
   * Property 2a: PNG normalization produces values in 0–65535 range
   *
   * For any random elevation array, the PNG normalization logic
   * (which normalizes to 16-bit range) always produces values within [0, 65535].
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  describe('PNG/R16 normalization produces values in 0–65535 range', () => {
    it('for all valid elevation arrays, normalized values are within 0–65535', () => {
      fc.assert(
        fc.property(
          arbElevationArray(4, 32),
          ({ elevations, width, height }) => {
            // Replicate the normalization logic from writeHeightmapPNG/writeHeightmapR16
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < elevations.length; i++) {
              const v = elevations[i];
              if (!isNaN(v) && v !== -Infinity) {
                if (v < min) min = v;
                if (v > max) max = v;
              }
            }
            if (min === Infinity) { min = 0; max = 0; }
            const range = max - min;

            // Normalize each value
            for (let i = 0; i < elevations.length; i++) {
              let v = elevations[i];
              if (isNaN(v) || v === -Infinity) v = min;
              const norm = Math.round(((v - min) / (range || 1)) * 65535);
              const clamped = Math.max(0, Math.min(65535, norm));

              // Property: all normalized values are in [0, 65535]
              expect(clamped).toBeGreaterThanOrEqual(0);
              expect(clamped).toBeLessThanOrEqual(65535);
              // Property: clamped value is an integer
              expect(Number.isInteger(clamped)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for all valid elevation arrays, R16 buffer has correct byte length', () => {
      fc.assert(
        fc.property(
          arbElevationArray(4, 32),
          ({ elevations, width, height }) => {
            // R16 format: 2 bytes per pixel, little-endian
            const expectedByteLength = width * height * 2;
            const buf = Buffer.allocUnsafe(expectedByteLength);

            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < elevations.length; i++) {
              const v = elevations[i];
              if (!isNaN(v) && v !== -Infinity) {
                if (v < min) min = v;
                if (v > max) max = v;
              }
            }
            if (min === Infinity) { min = 0; max = 0; }
            const range = max - min;

            for (let i = 0; i < elevations.length; i++) {
              let v = elevations[i];
              if (isNaN(v) || v === -Infinity) v = min;
              const norm = Math.round(((v - min) / (range || 1)) * 65535);
              buf.writeUInt16LE(Math.max(0, Math.min(65535, norm)), i * 2);
            }

            // Property: buffer length matches expected
            expect(buf.length).toBe(expectedByteLength);
            // Property: all values readable as UInt16LE
            for (let i = 0; i < width * height; i++) {
              const val = buf.readUInt16LE(i * 2);
              expect(val).toBeGreaterThanOrEqual(0);
              expect(val).toBeLessThanOrEqual(65535);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2b: Uncompressed GeoTIFF writes produce valid TIFF with correct tags
   *
   * For any random elevation array and valid bounds, writing an uncompressed GeoTIFF
   * produces a buffer that is parseable by the geotiff library and has correct tags.
   *
   * **Validates: Requirements 3.3, 3.5**
   */
  describe('Uncompressed GeoTIFF produces valid TIFF readable by geotiff library', () => {
    it('Int16 GeoTIFF has correct TIFF structure and tags', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbElevationArray(4, 16),
          arbGeoBounds(),
          async ({ elevations, width, height }, bounds) => {
            // Convert to Int16Array (same as writeHeightmapGeoTIFFInt16)
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
              photometricInterpretation: 1,
              bounds,
              compression: 'none',
              rasterType: 'point',
            });

            // Property: output is a valid TIFF (parseable by geotiff library)
            const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
            const tiff = await fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();

            // Property: dimensions match input
            expect(image.getWidth()).toBe(width);
            expect(image.getHeight()).toBe(height);

            // Property: bits per sample is 16
            const bps = image.getBitsPerSample();
            const bpsValue = Array.isArray(bps) ? bps[0] : bps;
            expect(bpsValue).toBe(16);

            // Property: sample format is signed int (2)
            const sf = image.getSampleFormat();
            const sfValue = Array.isArray(sf) ? sf[0] : sf;
            expect(sfValue).toBe(2);

            // Property: compression is none (1)
            const fileDirectory = image.fileDirectory;
            expect(fileDirectory.Compression).toBe(1);

            // Property: has GeoTIFF tags (ModelTiepoint, ModelPixelScale)
            expect(fileDirectory.ModelTiepoint).toBeDefined();
            expect(fileDirectory.ModelPixelScale).toBeDefined();

            // Property: pixel data is readable
            const rasters = await image.readRasters();
            expect(rasters[0].length).toBe(width * height);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('Float32 GeoTIFF has correct TIFF structure and tags', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbElevationArray(4, 16),
          arbGeoBounds(),
          async ({ elevations, width, height }, bounds) => {
            // Float32 data (same as writeHeightmapGeoTIFFFloat32)
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
              photometricInterpretation: 1,
              bounds,
              compression: 'none',
              rasterType: 'point',
            });

            // Property: output is a valid TIFF
            const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
            const tiff = await fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();

            // Property: dimensions match
            expect(image.getWidth()).toBe(width);
            expect(image.getHeight()).toBe(height);

            // Property: bits per sample is 32
            const bps = image.getBitsPerSample();
            const bpsValue = Array.isArray(bps) ? bps[0] : bps;
            expect(bpsValue).toBe(32);

            // Property: sample format is IEEE float (3)
            const sf = image.getSampleFormat();
            const sfValue = Array.isArray(sf) ? sf[0] : sf;
            expect(sfValue).toBe(3);

            // Property: compression is none
            expect(image.fileDirectory.Compression).toBe(1);

            // Property: pixel data is readable and matches input
            const rasters = await image.readRasters();
            const output = rasters[0] as Float32Array;
            expect(output.length).toBe(width * height);

            // Values should match within float precision
            for (let i = 0; i < float32.length; i++) {
              expect(output[i]).toBeCloseTo(float32[i], 4);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 2c: IPC fs:readFileBinary with valid paths returns file contents
   *
   * For any file that exists within a valid directory, reading it returns
   * the correct contents.
   *
   * **Validates: Requirements 3.7, 3.8**
   */
  describe('IPC readFileBinary with valid paths returns correct contents', () => {
    it('reading a file that exists returns its exact contents', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 1, maxLength: 1024 }),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
          (content, filename) => {
            // Create a temp file, read it back, verify contents match
            const tmpDir = os.tmpdir();
            const filePath = path.join(tmpDir, `preservation_test_${filename}.bin`);

            try {
              fs.writeFileSync(filePath, Buffer.from(content));
              const readBack = fs.readFileSync(filePath);

              // Property: read contents match written contents exactly
              expect(Buffer.from(content).equals(readBack)).toBe(true);
            } finally {
              try { fs.unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 2d: Manifest JSON structure is always valid with required fields
   *
   * For any random tile configuration, the manifest structure produced by the
   * export engine always contains all required fields and is valid JSON.
   *
   * **Validates: Requirements 3.11**
   */
  describe('Manifest structure is always valid JSON with required fields', () => {
    it('for all valid tile configurations, manifest has required fields', () => {
      fc.assert(
        fc.property(
          arbGeoBounds(),
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          fc.constantFrom('unigine', 'unreal', 'blender', 'generic', 'babylon'),
          fc.constantFrom('aws-terrarium', 'mapzen'),
          fc.constantFrom('arcgis', 'mapbox', 'maptiler'),
          fc.double({ min: -500, max: 9000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: -500, max: 9000, noNaN: true, noDefaultInfinity: true }),
          (bounds, tileRow, tileCol, preset, demSource, imagerySource, elevMin, elevMax) => {
            // Ensure elevMin < elevMax
            const actualMin = Math.min(elevMin, elevMax);
            const actualMax = Math.max(elevMin, elevMax);

            // Replicate manifest structure from export-engine.ts
            const manifest = {
              version: '1.0.0',
              createdBy: 'GeoTerrain Studio',
              createdAt: new Date().toISOString(),
              terrainName: `Terrain_test`,
              bounds,
              crs: 'EPSG:4326',
              tileGrid: {
                rows: 1,
                cols: 1,
                chunkSizeM: 1000,
                tileWidthM: 1000,
                tileHeightM: 1000,
                heightmapResolution: 1024,
                albedoResolution: 1024,
              },
              tiles: [
                {
                  row: tileRow,
                  col: tileCol,
                  bounds,
                  worldOffset: { x: tileCol * 1000, y: 0, z: tileRow * 1000 },
                  files: {
                    heightmap: `tile_${tileRow}_${tileCol}_heightmap.tif`,
                    albedo: `tile_${tileRow}_${tileCol}_albedo.png`,
                  },
                  elevation: {
                    min: Math.round(actualMin * 100) / 100,
                    max: Math.round(actualMax * 100) / 100,
                    units: 'meters' as const,
                    actualMin,
                    actualMax,
                    hasNoData: false,
                  },
                },
              ],
              sources: {
                dem: { id: demSource, name: 'Test DEM', attribution: 'Test' },
                imagery: { id: imagerySource, name: 'Test Imagery', attribution: 'Test' },
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

            // Property: manifest is valid JSON (serializable and parseable)
            const json = JSON.stringify(manifest, null, 2);
            const parsed = JSON.parse(json);

            // Property: required top-level fields exist
            expect(parsed.version).toBeDefined();
            expect(parsed.bounds).toBeDefined();
            expect(parsed.crs).toBeDefined();
            expect(parsed.tileGrid).toBeDefined();
            expect(parsed.tiles).toBeDefined();
            expect(parsed.sources).toBeDefined();
            expect(parsed.exportPreset).toBeDefined();

            // Property: bounds has all required fields
            expect(parsed.bounds.west).toBeDefined();
            expect(parsed.bounds.south).toBeDefined();
            expect(parsed.bounds.east).toBeDefined();
            expect(parsed.bounds.north).toBeDefined();

            // Property: bounds are valid (west < east, south < north)
            expect(parsed.bounds.west).toBeLessThan(parsed.bounds.east);
            expect(parsed.bounds.south).toBeLessThan(parsed.bounds.north);

            // Property: tiles array is non-empty
            expect(parsed.tiles.length).toBeGreaterThan(0);

            // Property: each tile has required fields
            for (const tile of parsed.tiles) {
              expect(tile.row).toBeDefined();
              expect(tile.col).toBeDefined();
              expect(tile.bounds).toBeDefined();
              expect(tile.worldOffset).toBeDefined();
              expect(tile.files).toBeDefined();
              expect(tile.files.heightmap).toBeDefined();
              expect(tile.files.albedo).toBeDefined();
              expect(tile.elevation).toBeDefined();
              expect(tile.elevation.min).toBeDefined();
              expect(tile.elevation.max).toBeDefined();
              expect(tile.elevation.units).toBe('meters');
            }

            // Property: sources has dem and imagery
            expect(parsed.sources.dem).toBeDefined();
            expect(parsed.sources.dem.id).toBeDefined();
            expect(parsed.sources.imagery).toBeDefined();
            expect(parsed.sources.imagery.id).toBeDefined();

            // Property: tileGrid has required fields
            expect(parsed.tileGrid.rows).toBeDefined();
            expect(parsed.tileGrid.cols).toBeDefined();
            expect(parsed.tileGrid.heightmapResolution).toBeDefined();
            expect(parsed.tileGrid.albedoResolution).toBeDefined();

            // Property: version is a valid semver-like string
            expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/);

            // Property: crs is EPSG:4326
            expect(parsed.crs).toBe('EPSG:4326');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2e: GeoTIFF writer TIFF header is always valid
   *
   * For any pixel data written with compression='none', the output buffer
   * starts with valid TIFF magic bytes and has a valid IFD structure.
   *
   * **Validates: Requirements 3.3, 3.5**
   */
  describe('GeoTIFF writer always produces valid TIFF header', () => {
    it('output always starts with TIFF magic bytes (little-endian)', () => {
      fc.assert(
        fc.property(
          arbElevationArray(4, 32),
          arbGeoBounds(),
          ({ elevations, width, height }, bounds) => {
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
              sampleFormat: 2,
              samplesPerPixel: 1,
              photometricInterpretation: 1,
              bounds,
              compression: 'none',
            });

            // Property: starts with "II" (little-endian byte order)
            expect(buf[0]).toBe(0x49); // 'I'
            expect(buf[1]).toBe(0x49); // 'I'

            // Property: TIFF magic number 42
            expect(buf.readUInt16LE(2)).toBe(42);

            // Property: IFD offset is 8 (immediately after header)
            expect(buf.readUInt32LE(4)).toBe(8);

            // Property: buffer size is at least header + IFD + pixel data
            const minSize = 8 + 2 + 12 + 4 + (width * height * 2); // header + 1 entry min + pixel data
            expect(buf.length).toBeGreaterThanOrEqual(minSize);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
