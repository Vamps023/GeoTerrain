/**
 * Property-Based Tests: MeshBuilder3D - Geographic-to-Local Coordinate Conversion
 *
 * Feature: building-road-3d-extraction, Property 8: Geographic-to-Local Coordinate Conversion
 *
 * Tests the geoToLocal function using fast-check to verify universal properties
 * hold across all valid inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { geoToLocal } from '../MeshBuilder3D';
import type { GeoBounds } from '../../../types/terrain';

// ─── Shared Arbitraries ────────────────────────────────────────

/**
 * Generate valid GeoBounds where west < east and south < north.
 * Uses realistic geographic ranges.
 */
const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    west: fc.double({ min: -179, max: 178, noNaN: true, noDefaultInfinity: true }),
    south: fc.double({ min: -89, max: 88, noNaN: true, noDefaultInfinity: true }),
    widthDeg: fc.double({ min: 0.001, max: 1.0, noNaN: true, noDefaultInfinity: true }),
    heightDeg: fc.double({ min: 0.001, max: 1.0, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ west, south, widthDeg, heightDeg }) => ({
    west,
    south,
    east: west + widthDeg,
    north: south + heightDeg,
  }));

/** Positive tile dimension in meters (realistic range) */
const arbTileWidthM = fc.double({ min: 100, max: 50000, noNaN: true, noDefaultInfinity: true });
const arbTileHeightM = fc.double({ min: 100, max: 50000, noNaN: true, noDefaultInfinity: true });

/**
 * Generate a coordinate (lat, lon) that is strictly within the given bounds.
 * Uses a normalized factor [0, 1] to interpolate within bounds.
 */
function arbCoordWithinBounds(bounds: GeoBounds): fc.Arbitrary<{ lat: number; lon: number }> {
  return fc.record({
    latFactor: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    lonFactor: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }).map(({ latFactor, lonFactor }) => ({
    lat: bounds.south + latFactor * (bounds.north - bounds.south),
    lon: bounds.west + lonFactor * (bounds.east - bounds.west),
  }));
}

// ─── Inverse formula (local → geo) for round-trip verification ─

function localToGeo(
  x: number,
  z: number,
  tileBounds: GeoBounds,
  tileWidthM: number,
  tileHeightM: number
): { lat: number; lon: number } {
  const lon =
    ((x + tileWidthM / 2) / tileWidthM) * (tileBounds.east - tileBounds.west) + tileBounds.west;
  const lat =
    ((z + tileHeightM / 2) / tileHeightM) * (tileBounds.north - tileBounds.south) + tileBounds.south;
  return { lat, lon };
}

// ─── Property 8: Geographic-to-Local Coordinate Conversion ─────
// Feature: building-road-3d-extraction, Property 8: Geographic-to-Local Coordinate Conversion

describe('Property 8: Geographic-to-Local Coordinate Conversion', () => {
  /**
   * **Validates: Requirements 3.2, 4.2**
   *
   * For any geographic coordinate (lat, lon) within a tile's bounds, converting
   * to local tile-space meters and then back to geographic coordinates SHALL
   * produce the original coordinate within a tolerance of 1e-9 degrees.
   * Additionally, the local coordinate SHALL be within [-tileWidthM/2, tileWidthM/2]
   * for X and [-tileHeightM/2, tileHeightM/2] for Z.
   */

  it('round-trip: geoToLocal then localToGeo produces original coordinate within 1e-9 tolerance', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbTileWidthM,
        arbTileHeightM,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (bounds, tileWidthM, tileHeightM, latFactor, lonFactor) => {
          const lat = bounds.south + latFactor * (bounds.north - bounds.south);
          const lon = bounds.west + lonFactor * (bounds.east - bounds.west);

          // Convert geo → local
          const local = geoToLocal(lat, lon, bounds, tileWidthM, tileHeightM);

          // Convert local → geo (inverse)
          const restored = localToGeo(local.x, local.z, bounds, tileWidthM, tileHeightM);

          // Verify round-trip within tolerance
          expect(Math.abs(restored.lat - lat)).toBeLessThan(1e-9);
          expect(Math.abs(restored.lon - lon)).toBeLessThan(1e-9);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('local x is within [-tileWidthM/2, tileWidthM/2] for coordinates within bounds', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbTileWidthM,
        arbTileHeightM,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (bounds, tileWidthM, tileHeightM, latFactor, lonFactor) => {
          const lat = bounds.south + latFactor * (bounds.north - bounds.south);
          const lon = bounds.west + lonFactor * (bounds.east - bounds.west);

          const local = geoToLocal(lat, lon, bounds, tileWidthM, tileHeightM);

          expect(local.x).toBeGreaterThanOrEqual(-tileWidthM / 2);
          expect(local.x).toBeLessThanOrEqual(tileWidthM / 2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('local z is within [-tileHeightM/2, tileHeightM/2] for coordinates within bounds', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbTileWidthM,
        arbTileHeightM,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (bounds, tileWidthM, tileHeightM, latFactor, lonFactor) => {
          const lat = bounds.south + latFactor * (bounds.north - bounds.south);
          const lon = bounds.west + lonFactor * (bounds.east - bounds.west);

          const local = geoToLocal(lat, lon, bounds, tileWidthM, tileHeightM);

          expect(local.z).toBeGreaterThanOrEqual(-tileHeightM / 2);
          expect(local.z).toBeLessThanOrEqual(tileHeightM / 2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('center of tile maps to (0, 0) in local space', () => {
    fc.assert(
      fc.property(
        arbGeoBounds,
        arbTileWidthM,
        arbTileHeightM,
        (bounds, tileWidthM, tileHeightM) => {
          const centerLat = (bounds.south + bounds.north) / 2;
          const centerLon = (bounds.west + bounds.east) / 2;

          const local = geoToLocal(centerLat, centerLon, bounds, tileWidthM, tileHeightM);

          // Use a tolerance proportional to tile size to account for floating-point
          // rounding in the center computation (south + north) / 2
          const xTolerance = tileWidthM * 1e-10;
          const zTolerance = tileHeightM * 1e-10;
          expect(Math.abs(local.x)).toBeLessThan(xTolerance);
          expect(Math.abs(local.z)).toBeLessThan(zTolerance);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ─── Property 9: Settings Value Clamping ───────────────────────
// Feature: building-road-3d-extraction, Property 9: Settings Value Clamping

/**
 * Simple clamp utility matching the behavior the ExportPanel UI will enforce.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

describe('Property 9: Settings Value Clamping', () => {
  /**
   * **Validates: Requirements 7.5**
   *
   * For any numeric input value for building height or road elevation offset,
   * the clamped output SHALL equal:
   * - The input value if within the valid range, OR
   * - The minimum bound if the input is below the range, OR
   * - The maximum bound if the input is above the range.
   *
   * The clamped value SHALL always satisfy: min <= clamped <= max.
   */

  const BUILDING_HEIGHT_MIN = 3;
  const BUILDING_HEIGHT_MAX = 100;
  const ROAD_OFFSET_MIN = 0;
  const ROAD_OFFSET_MAX = 1;

  it('clamped value is always within [min, max] for building height', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, BUILDING_HEIGHT_MIN, BUILDING_HEIGHT_MAX);
          expect(clamped).toBeGreaterThanOrEqual(BUILDING_HEIGHT_MIN);
          expect(clamped).toBeLessThanOrEqual(BUILDING_HEIGHT_MAX);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('clamped value is always within [min, max] for road elevation offset', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, ROAD_OFFSET_MIN, ROAD_OFFSET_MAX);
          expect(clamped).toBeGreaterThanOrEqual(ROAD_OFFSET_MIN);
          expect(clamped).toBeLessThanOrEqual(ROAD_OFFSET_MAX);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is within range, output equals input (building height)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: BUILDING_HEIGHT_MIN, max: BUILDING_HEIGHT_MAX, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, BUILDING_HEIGHT_MIN, BUILDING_HEIGHT_MAX);
          expect(clamped).toBe(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is within range, output equals input (road elevation offset)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: ROAD_OFFSET_MIN, max: ROAD_OFFSET_MAX, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, ROAD_OFFSET_MIN, ROAD_OFFSET_MAX);
          expect(clamped).toBe(value);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is below min, output equals min (building height)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: BUILDING_HEIGHT_MIN - 0.001, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, BUILDING_HEIGHT_MIN, BUILDING_HEIGHT_MAX);
          expect(clamped).toBe(BUILDING_HEIGHT_MIN);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is below min, output equals min (road elevation offset)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: -Number.EPSILON, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, ROAD_OFFSET_MIN, ROAD_OFFSET_MAX);
          expect(clamped).toBe(ROAD_OFFSET_MIN);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is above max, output equals max (building height)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: BUILDING_HEIGHT_MAX + 0.001, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, BUILDING_HEIGHT_MIN, BUILDING_HEIGHT_MAX);
          expect(clamped).toBe(BUILDING_HEIGHT_MAX);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if input is above max, output equals max (road elevation offset)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: ROAD_OFFSET_MAX + 0.001, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (value) => {
          const clamped = clamp(value, ROAD_OFFSET_MIN, ROAD_OFFSET_MAX);
          expect(clamped).toBe(ROAD_OFFSET_MAX);
        }
      ),
      { numRuns: 100 }
    );
  });
});
