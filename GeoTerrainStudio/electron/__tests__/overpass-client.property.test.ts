/**
 * Property-Based Test: Query Construction Correctness
 *
 * Property 1: For any valid GeoBounds and mask type (road, water, vegetation, building),
 * the constructed Overpass QL query SHALL contain the correct OSM tags for that mask type
 * and a correctly formatted bounding box in `south,west,north,east` order.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildRoadQuery,
  buildWaterQuery,
  buildVegetationQuery,
  buildBuildingQuery,
  formatBbox,
  type GeoBounds,
} from '../overpass-client';

/**
 * Arbitrary for valid GeoBounds where:
 * - south is in [-90, 89] (leaving room for north > south)
 * - north > south and in [-90, 90]
 * - west is in [-180, 179] (leaving room for east > west)
 * - east > west and in [-180, 180]
 */
const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -90, max: 89, noNaN: true, noDefaultInfinity: true }),
    north: fc.double({ min: -89, max: 90, noNaN: true, noDefaultInfinity: true }),
    west: fc.double({ min: -180, max: 179, noNaN: true, noDefaultInfinity: true }),
    east: fc.double({ min: -179, max: 180, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((b) => b.north > b.south && b.east > b.west);

describe('Property 1: Query construction correctness', () => {
  it('road query contains "highway" tag and correct bbox', () => {
    fc.assert(
      fc.property(arbGeoBounds, (bounds) => {
        const query = buildRoadQuery(bounds);

        // Must contain the highway tag
        expect(query).toContain('"highway"');

        // Must contain correctly formatted bbox: south,west,north,east
        const expectedBbox = formatBbox(bounds);
        expect(query).toContain(expectedBbox);

        // Must contain output format and timeout directives
        expect(query).toContain('[out:json]');
        expect(query).toContain('[timeout:60]');
      }),
      { numRuns: 200 }
    );
  });

  it('water query contains correct OSM tags and correct bbox', () => {
    fc.assert(
      fc.property(arbGeoBounds, (bounds) => {
        const query = buildWaterQuery(bounds);

        // Must contain all water-related tags
        expect(query).toContain('"natural"="water"');
        expect(query).toContain('"waterway"');
        expect(query).toContain('"landuse"="reservoir"');

        // Must contain correctly formatted bbox
        const expectedBbox = formatBbox(bounds);
        expect(query).toContain(expectedBbox);

        // Must contain output format and timeout directives
        expect(query).toContain('[out:json]');
        expect(query).toContain('[timeout:60]');
      }),
      { numRuns: 200 }
    );
  });

  it('vegetation query contains correct OSM tags and correct bbox', () => {
    fc.assert(
      fc.property(arbGeoBounds, (bounds) => {
        const query = buildVegetationQuery(bounds);

        // Must contain all vegetation-related tags
        expect(query).toContain('"landuse"="forest"');
        expect(query).toContain('"natural"="wood"');
        expect(query).toContain('"landuse"="grass"');
        expect(query).toContain('"leisure"="park"');

        // Must contain correctly formatted bbox
        const expectedBbox = formatBbox(bounds);
        expect(query).toContain(expectedBbox);

        // Must contain output format and timeout directives
        expect(query).toContain('[out:json]');
        expect(query).toContain('[timeout:60]');
      }),
      { numRuns: 200 }
    );
  });

  it('building query contains "building" tag and correct bbox', () => {
    fc.assert(
      fc.property(arbGeoBounds, (bounds) => {
        const query = buildBuildingQuery(bounds);

        // Must contain the building tag
        expect(query).toContain('"building"');

        // Must contain correctly formatted bbox
        const expectedBbox = formatBbox(bounds);
        expect(query).toContain(expectedBbox);

        // Must contain output format and timeout directives
        expect(query).toContain('[out:json]');
        expect(query).toContain('[timeout:60]');
      }),
      { numRuns: 200 }
    );
  });

  it('formatBbox produces south,west,north,east order', () => {
    fc.assert(
      fc.property(arbGeoBounds, (bounds) => {
        const bbox = formatBbox(bounds);
        const parts = bbox.split(',');

        expect(parts).toHaveLength(4);
        // Compare as strings to avoid -0/+0 Object.is issues with floating point
        expect(parts[0]).toBe(String(bounds.south));
        expect(parts[1]).toBe(String(bounds.west));
        expect(parts[2]).toBe(String(bounds.north));
        expect(parts[3]).toBe(String(bounds.east));
      }),
      { numRuns: 200 }
    );
  });
});


/**
 * Property-Based Test: Bounding Box Splitting Coverage
 *
 * Property 8: For any GeoBounds with area exceeding 0.25 square degrees,
 * splitting into sub-regions SHALL produce sub-regions that (a) each have
 * area ≤ 0.25 square degrees and (b) collectively cover the entire original
 * bounding box without gaps.
 *
 * **Validates: Requirement 4.3**
 */

import { splitBounds } from '../overpass-client';

/**
 * Arbitrary for GeoBounds with area > 0.25 square degrees.
 * We generate south in [-80, 70], then pick latSpan and lonSpan such that
 * latSpan * lonSpan > 0.25.
 */
const arbLargeBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -80, max: 70, noNaN: true, noDefaultInfinity: true }),
    latSpan: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
    lonSpan: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((r) => r.latSpan * r.lonSpan > 0.25)
  .filter((r) => r.south + r.latSpan <= 90)
  .map((r) => ({
    south: r.south,
    north: r.south + r.latSpan,
    west: -50, // fixed west to keep things simple
    east: -50 + r.lonSpan,
  }))
  .filter((b) => b.east <= 180);

/**
 * Arbitrary for GeoBounds with area ≤ 0.25 square degrees (small bounds).
 */
const arbSmallBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -80, max: 80, noNaN: true, noDefaultInfinity: true }),
    latSpan: fc.double({ min: 0.01, max: 0.5, noNaN: true, noDefaultInfinity: true }),
    lonSpan: fc.double({ min: 0.01, max: 0.5, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((r) => r.latSpan * r.lonSpan <= 0.25)
  .filter((r) => r.south + r.latSpan <= 90)
  .map((r) => ({
    south: r.south,
    north: r.south + r.latSpan,
    west: 10,
    east: 10 + r.lonSpan,
  }))
  .filter((b) => b.east <= 180);

describe('Property 8: Bounding box splitting coverage', () => {
  it('every sub-region has area ≤ 0.25 square degrees', () => {
    fc.assert(
      fc.property(arbLargeBounds, (bounds) => {
        const subRegions = splitBounds(bounds);

        for (const sub of subRegions) {
          const area = (sub.north - sub.south) * (sub.east - sub.west);
          expect(area).toBeLessThanOrEqual(0.25 + 1e-10); // small epsilon for floating point
        }
      }),
      { numRuns: 200 }
    );
  });

  it('sub-regions collectively cover the original bounding box (no gaps at edges)', () => {
    fc.assert(
      fc.property(arbLargeBounds, (bounds) => {
        const subRegions = splitBounds(bounds);

        // The union of all sub-regions must cover the original bounds:
        // min(south) == original south
        const minSouth = Math.min(...subRegions.map((r) => r.south));
        // max(north) == original north
        const maxNorth = Math.max(...subRegions.map((r) => r.north));
        // min(west) == original west
        const minWest = Math.min(...subRegions.map((r) => r.west));
        // max(east) == original east
        const maxEast = Math.max(...subRegions.map((r) => r.east));

        expect(minSouth).toBeCloseTo(bounds.south, 10);
        expect(maxNorth).toBeCloseTo(bounds.north, 10);
        expect(minWest).toBeCloseTo(bounds.west, 10);
        expect(maxEast).toBeCloseTo(bounds.east, 10);
      }),
      { numRuns: 200 }
    );
  });

  it('sub-regions tile without gaps (adjacent sub-regions share boundaries)', () => {
    fc.assert(
      fc.property(arbLargeBounds, (bounds) => {
        const subRegions = splitBounds(bounds);

        // Sort sub-regions by south then west to form a grid
        const sorted = [...subRegions].sort((a, b) => {
          if (Math.abs(a.south - b.south) < 1e-10) return a.west - b.west;
          return a.south - b.south;
        });

        // Group by rows (same south value within epsilon)
        const rows: GeoBounds[][] = [];
        let currentRow: GeoBounds[] = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
          if (Math.abs(sorted[i].south - currentRow[0].south) < 1e-10) {
            currentRow.push(sorted[i]);
          } else {
            rows.push(currentRow);
            currentRow = [sorted[i]];
          }
        }
        rows.push(currentRow);

        // Check horizontal continuity within each row
        for (const row of rows) {
          for (let i = 1; i < row.length; i++) {
            // East of previous should equal west of current (shared boundary)
            expect(row[i].west).toBeCloseTo(row[i - 1].east, 10);
          }
          // First cell's west should be original west
          expect(row[0].west).toBeCloseTo(bounds.west, 10);
          // Last cell's east should be original east
          expect(row[row.length - 1].east).toBeCloseTo(bounds.east, 10);
        }

        // Check vertical continuity between rows
        for (let r = 1; r < rows.length; r++) {
          // North of previous row should equal south of current row
          expect(rows[r][0].south).toBeCloseTo(rows[r - 1][0].north, 10);
        }

        // First row's south should be original south
        expect(rows[0][0].south).toBeCloseTo(bounds.south, 10);
        // Last row's north should be original north
        expect(rows[rows.length - 1][0].north).toBeCloseTo(bounds.north, 10);
      }),
      { numRuns: 200 }
    );
  });

  it('bounds with area ≤ 0.25 square degrees return a single region (the original)', () => {
    fc.assert(
      fc.property(arbSmallBounds, (bounds) => {
        const subRegions = splitBounds(bounds);

        expect(subRegions).toHaveLength(1);
        expect(subRegions[0]).toEqual(bounds);
      }),
      { numRuns: 200 }
    );
  });
});
