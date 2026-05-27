/**
 * Property-based tests for the Vector Rasterizer module.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { rasterizePolygons, rasterizeLines, geoToPixel } from '../vector-rasterizer';
import type { GeoBounds } from '../overpass-client';
import type { RasterizeOptions } from '../vector-rasterizer';

/**
 * Property 3: Coordinate projection stays within raster bounds
 *
 * For any geographic point (lat, lon) that lies within the tile GeoBounds,
 * the Vector_Rasterizer coordinate conversion SHALL produce pixel coordinates
 * (x, y) where 0 <= x < width and 0 <= y < height.
 *
 * **Validates: Requirement 2.1**
 */
describe('Property 3: Coordinate projection stays within raster bounds', () => {
  /**
   * Arbitrary for valid GeoBounds where south < north and west < east,
   * constrained to valid geographic coordinate ranges.
   */
  const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
    .record({
      south: fc.double({ min: -85, max: 84, noNaN: true, noDefaultInfinity: true }),
      latSpan: fc.double({ min: 0.001, max: 10, noNaN: true, noDefaultInfinity: true }),
      west: fc.double({ min: -179, max: 178, noNaN: true, noDefaultInfinity: true }),
      lonSpan: fc.double({ min: 0.001, max: 10, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ south, latSpan, west, lonSpan }) => ({
      south,
      north: Math.min(south + latSpan, 85),
      west,
      east: Math.min(west + lonSpan, 180),
    }))
    .filter((b) => b.south < b.north && b.west < b.east);

  /**
   * Arbitrary for raster dimensions (width and height) in a reasonable range.
   */
  const arbDimension: fc.Arbitrary<number> = fc.integer({ min: 16, max: 4096 });

  it('geoToPixel produces x in [0, width) and y in [0, height) for any point within bounds', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbDimension,
        arbDimension,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (bounds, width, height, latFrac, lonFrac) => {
          // Generate a point within the bounds using fractional interpolation
          const lat = bounds.south + (bounds.north - bounds.south) * latFrac;
          const lon = bounds.west + (bounds.east - bounds.west) * lonFrac;

          const { x, y } = geoToPixel(lat, lon, bounds, width, height);

          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(width);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(height);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('geoToPixel produces valid coordinates for points exactly on bounds edges', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbDimension,
        arbDimension,
        (bounds, width, height) => {
          // Test all four corners and midpoints of edges
          const edgePoints = [
            { lat: bounds.south, lon: bounds.west },   // SW corner
            { lat: bounds.south, lon: bounds.east },   // SE corner
            { lat: bounds.north, lon: bounds.west },   // NW corner
            { lat: bounds.north, lon: bounds.east },   // NE corner
            { lat: (bounds.south + bounds.north) / 2, lon: bounds.west },  // W midpoint
            { lat: (bounds.south + bounds.north) / 2, lon: bounds.east },  // E midpoint
            { lat: bounds.south, lon: (bounds.west + bounds.east) / 2 },   // S midpoint
            { lat: bounds.north, lon: (bounds.west + bounds.east) / 2 },   // N midpoint
          ];

          for (const { lat, lon } of edgePoints) {
            const { x, y } = geoToPixel(lat, lon, bounds, width, height);

            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(width);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThan(height);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it('geoToPixel clamps points outside bounds to valid pixel range [0, width-1] and [0, height-1]', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbDimension,
        arbDimension,
        fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
        (bounds, width, height, lat, lon) => {
          const { x, y } = geoToPixel(lat, lon, bounds, width, height);

          // Regardless of whether point is inside or outside bounds,
          // output must always be within valid pixel range
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(width - 1);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(height - 1);
        }
      ),
      { numRuns: 500 }
    );
  });
});

/**
 * Property 4: Polygon rasterization fills interior
 *
 * For any valid closed polygon whose centroid lies within the tile GeoBounds,
 * rasterizing that polygon SHALL produce pixel value 255 at the centroid pixel
 * position and pixel value 0 at positions far outside the polygon boundary.
 *
 * **Validates: Requirement 2.2**
 */
describe('Property 4: Polygon rasterization fills interior', () => {
  /**
   * Arbitrary for a valid GeoBounds where south < north and west < east,
   * with a reasonable geographic range.
   */
  const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
    .record({
      south: fc.double({ min: -80, max: 70, noNaN: true }),
      latSpan: fc.double({ min: 0.01, max: 5, noNaN: true }),
      west: fc.double({ min: -170, max: 160, noNaN: true }),
      lonSpan: fc.double({ min: 0.01, max: 5, noNaN: true }),
    })
    .map(({ south, latSpan, west, lonSpan }) => ({
      south,
      north: south + latSpan,
      west,
      east: west + lonSpan,
    }));

  /**
   * Arbitrary for raster resolution (width/height) between 64 and 512.
   */
  const arbResolution = fc.integer({ min: 64, max: 512 });

  it('centroid pixel is filled (255) and far-outside corners are empty (0)', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbResolution,
        fc.double({ min: 0.2, max: 0.35, noNaN: true }),
        fc.double({ min: 0.65, max: 0.8, noNaN: true }),
        fc.double({ min: 0.2, max: 0.35, noNaN: true }),
        fc.double({ min: 0.65, max: 0.8, noNaN: true }),
        (bounds, resolution, latMinFrac, latMaxFrac, lonMinFrac, lonMaxFrac) => {
          const latRange = bounds.north - bounds.south;
          const lonRange = bounds.east - bounds.west;

          // Build a rectangle polygon well within bounds
          const south = bounds.south + latRange * latMinFrac;
          const north = bounds.south + latRange * latMaxFrac;
          const west = bounds.west + lonRange * lonMinFrac;
          const east = bounds.west + lonRange * lonMaxFrac;

          const polygon = [
            { lat: south, lon: west },
            { lat: south, lon: east },
            { lat: north, lon: east },
            { lat: north, lon: west },
          ];

          // Compute centroid (average of vertices)
          const centroidLat = (south + north) / 2;
          const centroidLon = (west + east) / 2;

          const options: RasterizeOptions = {
            width: resolution,
            height: resolution,
            bounds,
          };

          // Rasterize the polygon
          const buffer = rasterizePolygons([polygon], options);

          // Convert centroid to pixel coordinates
          const centroidPixel = geoToPixel(
            centroidLat,
            centroidLon,
            bounds,
            resolution,
            resolution
          );

          // Assert centroid pixel is filled
          const centroidValue = buffer[centroidPixel.y * resolution + centroidPixel.x];
          expect(centroidValue).toBe(255);

          // Assert corners of the raster (far outside the polygon) are empty
          // Top-left corner (0, 0)
          const topLeftValue = buffer[0];
          expect(topLeftValue).toBe(0);

          // Bottom-right corner
          const bottomRightValue = buffer[(resolution - 1) * resolution + (resolution - 1)];
          expect(bottomRightValue).toBe(0);

          // Top-right corner
          const topRightValue = buffer[resolution - 1];
          expect(topRightValue).toBe(0);

          // Bottom-left corner
          const bottomLeftValue = buffer[(resolution - 1) * resolution];
          expect(bottomLeftValue).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 9: Empty features produce all-black mask
 *
 * For any target resolution and empty feature set (zero features),
 * rasterization SHALL produce a mask image where every pixel has value 0.
 *
 * **Validates: Requirements 4.6**
 */
describe('Property 9: Empty features produce all-black mask', () => {
  // Generator for valid GeoBounds where south < north and west < east
  const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
    .record({
      south: fc.double({ min: -85, max: 84, noNaN: true, noDefaultInfinity: true }),
      north: fc.double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true }),
      west: fc.double({ min: -180, max: 179, noNaN: true, noDefaultInfinity: true }),
      east: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    })
    .filter((b) => b.south < b.north && b.west < b.east);

  // Generator for resolution (width/height) between 16 and 512
  const arbResolution = fc.integer({ min: 16, max: 512 });

  it('rasterizePolygons with empty array produces all-zero buffer', () => {
    fc.assert(
      fc.property(arbGeoBounds, arbResolution, arbResolution, (bounds, width, height) => {
        const options: RasterizeOptions = { width, height, bounds };
        const buffer = rasterizePolygons([], options);

        // Buffer length must equal width * height
        expect(buffer.length).toBe(width * height);

        // Every pixel must be 0
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] !== 0) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 }
    );
  });

  it('rasterizeLines with empty array produces all-zero buffer', () => {
    fc.assert(
      fc.property(arbGeoBounds, arbResolution, arbResolution, (bounds, width, height) => {
        const options: RasterizeOptions = { width, height, bounds };
        const buffer = rasterizeLines([], options);

        // Buffer length must equal width * height
        expect(buffer.length).toBe(width * height);

        // Every pixel must be 0
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] !== 0) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 10: Mask output is binary 8-bit grayscale
 *
 * For any generated mask image regardless of input features, every pixel value
 * SHALL be either 0 or 255, the image SHALL be 8-bit single-channel grayscale
 * PNG format.
 *
 * **Validates: Requirements 2.4, 9.1, 9.2**
 */
describe('Property 10: Mask output is binary 8-bit grayscale', () => {
  // Generator for valid GeoBounds
  const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
    .record({
      south: fc.double({ min: -80, max: 70, noNaN: true, noDefaultInfinity: true }),
      latSpan: fc.double({ min: 0.01, max: 5, noNaN: true, noDefaultInfinity: true }),
      west: fc.double({ min: -170, max: 160, noNaN: true, noDefaultInfinity: true }),
      lonSpan: fc.double({ min: 0.01, max: 5, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ south, latSpan, west, lonSpan }) => ({
      south,
      north: south + latSpan,
      west,
      east: west + lonSpan,
    }));

  // Generator for resolution (width/height) between 16 and 256
  const arbResolution = fc.integer({ min: 16, max: 256 });

  // Generator for a point within given bounds
  const arbPointInBounds = (bounds: GeoBounds) =>
    fc.record({
      lat: fc.double({ min: bounds.south, max: bounds.north, noNaN: true, noDefaultInfinity: true }),
      lon: fc.double({ min: bounds.west, max: bounds.east, noNaN: true, noDefaultInfinity: true }),
    });

  // Generator for a polygon (at least 3 points) within bounds
  const arbPolygonInBounds = (bounds: GeoBounds) =>
    fc.array(arbPointInBounds(bounds), { minLength: 3, maxLength: 12 });

  // Generator for a line (at least 2 points) within bounds
  const arbLineInBounds = (bounds: GeoBounds) =>
    fc.array(arbPointInBounds(bounds), { minLength: 2, maxLength: 10 });

  it('rasterizePolygons output contains only binary values (0 or 255) and correct buffer length', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbResolution,
        arbResolution,
        (bounds, width, height) => {
          // Generate deterministic polygons within bounds
          const latStep = (bounds.north - bounds.south) / 4;
          const lonStep = (bounds.east - bounds.west) / 4;
          const polygons = [
            [
              { lat: bounds.south + latStep, lon: bounds.west + lonStep },
              { lat: bounds.south + latStep * 3, lon: bounds.west + lonStep },
              { lat: bounds.south + latStep * 3, lon: bounds.west + lonStep * 3 },
              { lat: bounds.south + latStep, lon: bounds.west + lonStep * 3 },
            ],
          ];

          const options: RasterizeOptions = { width, height, bounds };
          const buffer = rasterizePolygons(polygons, options);

          // Buffer length must equal width * height (single channel)
          expect(buffer.length).toBe(width * height);

          // Every pixel must be either 0 or 255
          for (let i = 0; i < buffer.length; i++) {
            const val = buffer[i];
            if (val !== 0 && val !== 255) {
              throw new Error(`Non-binary pixel value ${val} at index ${i}`);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rasterizeLines output contains only binary values (0 or 255) and correct buffer length', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbResolution,
        arbResolution,
        fc.integer({ min: 1, max: 10 }),
        (bounds, width, height, lineWidth) => {
          // Generate deterministic lines within bounds
          const latStep = (bounds.north - bounds.south) / 4;
          const lonStep = (bounds.east - bounds.west) / 4;
          const lines = [
            [
              { lat: bounds.south + latStep, lon: bounds.west + lonStep },
              { lat: bounds.south + latStep * 2, lon: bounds.west + lonStep * 3 },
              { lat: bounds.south + latStep * 3, lon: bounds.west + lonStep * 2 },
            ],
          ];

          const options: RasterizeOptions = { width, height, bounds, lineWidth };
          const buffer = rasterizeLines(lines, options);

          // Buffer length must equal width * height (single channel)
          expect(buffer.length).toBe(width * height);

          // Every pixel must be either 0 or 255
          for (let i = 0; i < buffer.length; i++) {
            const val = buffer[i];
            if (val !== 0 && val !== 255) {
              throw new Error(`Non-binary pixel value ${val} at index ${i}`);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rasterizePolygons with random polygons produces only binary output', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbResolution,
        arbResolution,
        (bounds, width, height) => {
          // Use nested property to generate random polygons within the bounds
          fc.assert(
            fc.property(
              fc.array(arbPolygonInBounds(bounds), { minLength: 0, maxLength: 4 }),
              (polygons) => {
                const options: RasterizeOptions = { width, height, bounds };
                const buffer = rasterizePolygons(polygons, options);

                expect(buffer.length).toBe(width * height);

                for (let i = 0; i < buffer.length; i++) {
                  const val = buffer[i];
                  if (val !== 0 && val !== 255) {
                    throw new Error(`Non-binary pixel value ${val} at index ${i}`);
                  }
                }
              }
            ),
            { numRuns: 10 }
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  it('rasterizeLines with random lines produces only binary output', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbResolution,
        arbResolution,
        fc.integer({ min: 1, max: 10 }),
        (bounds, width, height, lineWidth) => {
          // Use nested property to generate random lines within the bounds
          fc.assert(
            fc.property(
              fc.array(arbLineInBounds(bounds), { minLength: 0, maxLength: 4 }),
              (lines) => {
                const options: RasterizeOptions = { width, height, bounds, lineWidth };
                const buffer = rasterizeLines(lines, options);

                expect(buffer.length).toBe(width * height);

                for (let i = 0; i < buffer.length; i++) {
                  const val = buffer[i];
                  if (val !== 0 && val !== 255) {
                    throw new Error(`Non-binary pixel value ${val} at index ${i}`);
                  }
                }
              }
            ),
            { numRuns: 10 }
          );
        }
      ),
      { numRuns: 20 }
    );
  });
});
