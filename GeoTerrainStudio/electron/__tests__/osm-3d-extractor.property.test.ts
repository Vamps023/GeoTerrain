/**
 * Property-Based Tests: OSM 3D Extractor
 *
 * Feature: building-road-3d-extraction
 *
 * Tests core extraction logic using fast-check to verify universal properties
 * hold across all valid inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractBuildings, estimateBuildingHeight, extractRoads, estimateRoadWidth } from '../osm-3d-extractor';
import type { OverpassFeature } from '../overpass-client';

// ─── Shared Arbitraries ────────────────────────────────────────

/** Valid height tag value: numeric string in [0.1, 1000] */
const arbValidHeight = fc.double({ min: 0.1, max: 1000, noNaN: true, noDefaultInfinity: true })
  .map(v => String(v));

/** Invalid height tag value: non-numeric or out-of-range */
const arbInvalidHeight = fc.oneof(
  // Non-numeric strings
  fc.stringMatching(/^[a-zA-Z ]{1,10}$/),
  // Out-of-range low (below 0.1)
  fc.double({ min: -1000, max: 0.09, noNaN: true, noDefaultInfinity: true }).map(v => String(v)),
  // Out-of-range high (above 1000)
  fc.double({ min: 1000.01, max: 100000, noNaN: true, noDefaultInfinity: true }).map(v => String(v)),
  // Special invalid strings
  fc.constantFrom('NaN', 'Infinity', '-Infinity', '', ' ', 'abc', '10m', '5 meters')
);

/** Valid building:levels tag value: integer string in [1, 200] */
const arbValidLevels = fc.integer({ min: 1, max: 200 }).map(v => String(v));

/** Invalid building:levels tag value: non-integer, out-of-range, or non-numeric */
const arbInvalidLevels = fc.oneof(
  // Non-integer (decimal)
  fc.double({ min: 1.01, max: 199.99, noNaN: true, noDefaultInfinity: true })
    .filter(v => !Number.isInteger(v))
    .map(v => String(v)),
  // Out-of-range low (0 or negative)
  fc.integer({ min: -100, max: 0 }).map(v => String(v)),
  // Out-of-range high (above 200)
  fc.integer({ min: 201, max: 1000 }).map(v => String(v)),
  // Non-numeric strings
  fc.constantFrom('abc', '', ' ', 'NaN', '3.5', '1.1', 'two')
);

/** Valid default height: number in [1, 100] */
const arbDefaultHeight = fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true });

/** A valid polygon geometry (minimum 4 coordinate pairs) */
const arbValidGeometry = fc.array(
  fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 4, maxLength: 20 }
);

/**
 * Arbitrary for a valid building footprint polygon (≥4 coordinate pairs).
 * Generates 3-19 points then closes the polygon.
 */
const arbValidFootprint: fc.Arbitrary<Array<{ lat: number; lon: number }>> = fc
  .array(
    fc.record({
      lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 3, maxLength: 19 }
  )
  .map((pts) => [...pts, pts[0]]); // close the polygon

// ─── Helper ────────────────────────────────────────────────────

function makeFeature(tags: Record<string, string>, geometry?: Array<{ lat: number; lon: number }>): OverpassFeature {
  return {
    type: 'way',
    id: 1,
    geometry: geometry ?? [
      { lat: 48.0, lon: 2.0 },
      { lat: 48.001, lon: 2.0 },
      { lat: 48.001, lon: 2.001 },
      { lat: 48.0, lon: 2.0 },
    ],
    tags,
  };
}


// ─── Property 1: Building Height Determination ─────────────────
// Feature: building-road-3d-extraction, Property 1: Building Height Determination

describe('Property 1: Building Height Determination', () => {
  /**
   * **Validates: Requirements 1.2, 1.3, 1.4, 1.10**
   */

  it('Priority 1: uses explicit height tag when value is valid [0.1, 1000]', () => {
    fc.assert(
      fc.property(
        arbValidHeight,
        arbDefaultHeight,
        (heightStr, defaultHeight) => {
          const tags: Record<string, string> = { building: 'yes', height: heightStr };
          const { height } = estimateBuildingHeight(tags, defaultHeight);
          expect(height).toBe(Number(heightStr));
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Priority 1: height tag takes precedence over valid building:levels', () => {
    fc.assert(
      fc.property(
        arbValidHeight,
        arbValidLevels,
        arbDefaultHeight,
        (heightStr, levelsStr, defaultHeight) => {
          const tags: Record<string, string> = {
            building: 'yes',
            height: heightStr,
            'building:levels': levelsStr,
          };
          const { height } = estimateBuildingHeight(tags, defaultHeight);
          expect(height).toBe(Number(heightStr));
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Priority 2: uses building:levels * 3.0 when height tag is invalid', () => {
    fc.assert(
      fc.property(
        arbInvalidHeight,
        arbValidLevels,
        arbDefaultHeight,
        (invalidHeight, levelsStr, defaultHeight) => {
          const tags: Record<string, string> = {
            building: 'yes',
            height: invalidHeight,
            'building:levels': levelsStr,
          };
          const { height, floors } = estimateBuildingHeight(tags, defaultHeight);
          const expectedLevels = Number(levelsStr);
          expect(height).toBe(expectedLevels * 3.0);
          expect(floors).toBe(expectedLevels);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Priority 2: uses building:levels * 3.0 when height tag is absent', () => {
    fc.assert(
      fc.property(
        arbValidLevels,
        arbDefaultHeight,
        (levelsStr, defaultHeight) => {
          const tags: Record<string, string> = {
            building: 'yes',
            'building:levels': levelsStr,
          };
          const { height, floors } = estimateBuildingHeight(tags, defaultHeight);
          const expectedLevels = Number(levelsStr);
          expect(height).toBe(expectedLevels * 3.0);
          expect(floors).toBe(expectedLevels);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Priority 3: falls back to default height when both height and levels are invalid', () => {
    fc.assert(
      fc.property(
        arbInvalidHeight,
        arbInvalidLevels,
        arbDefaultHeight,
        (invalidHeight, invalidLevels, defaultHeight) => {
          const tags: Record<string, string> = {
            building: 'yes',
            height: invalidHeight,
            'building:levels': invalidLevels,
          };
          const { height } = estimateBuildingHeight(tags, defaultHeight);
          expect(height).toBe(defaultHeight);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('Priority 3: falls back to default height when both tags are absent', () => {
    fc.assert(
      fc.property(
        arbDefaultHeight,
        (defaultHeight) => {
          const tags: Record<string, string> = { building: 'yes' };
          const { height } = estimateBuildingHeight(tags, defaultHeight);
          expect(height).toBe(defaultHeight);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('extractBuildings applies height determination correctly for arbitrary tag combinations', () => {
    const arbTags = fc.oneof(
      arbValidHeight.map(h => ({ building: 'yes', height: h })),
      fc.tuple(arbInvalidHeight, arbValidLevels).map(([h, l]) => ({
        building: 'yes', height: h, 'building:levels': l,
      })),
      arbValidLevels.map(l => ({ building: 'yes', 'building:levels': l })),
      fc.tuple(arbInvalidHeight, arbInvalidLevels).map(([h, l]) => ({
        building: 'yes', height: h, 'building:levels': l,
      })),
      fc.constant({ building: 'yes' } as Record<string, string>)
    );

    fc.assert(
      fc.property(
        arbTags,
        arbValidGeometry,
        arbDefaultHeight,
        (tags, geometry, defaultHeight) => {
          const feature = makeFeature(tags, geometry);
          const result = extractBuildings([feature], defaultHeight);

          expect(result).toHaveLength(1);
          const building = result[0];

          const heightValue = Number(tags['height']);
          const levelsValue = Number(tags['building:levels']);

          if (tags['height'] !== undefined &&
              Number.isFinite(heightValue) &&
              heightValue >= 0.1 && heightValue <= 1000) {
            expect(building.height).toBe(heightValue);
          } else if (tags['building:levels'] !== undefined &&
                     Number.isFinite(levelsValue) &&
                     Number.isInteger(levelsValue) &&
                     levelsValue >= 1 && levelsValue <= 200) {
            expect(building.height).toBe(levelsValue * 3.0);
          } else {
            expect(building.height).toBe(defaultHeight);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});


// ─── Property 3: Building Optional Tag Filtering ───────────────
// Feature: building-road-3d-extraction, Property 3: Building Optional Tag Filtering

describe('Property 3: Building Optional Tag Filtering', () => {
  const VALID_ROOF_SHAPES = ['flat', 'gabled', 'hipped', 'pyramidal'];

  /**
   * **Validates: Requirements 1.7, 1.8**
   *
   * For any OSM building element, the extracted BuildingGeometry SHALL include
   * roofShape only when the roof:shape tag value is one of {flat, gabled, hipped, pyramidal},
   * and SHALL include minLevel only when the building:min_level tag is a valid integer in [0, 200].
   * All other values SHALL result in omission of the respective field.
   */

  it('roofShape is included only for valid roof shape values', () => {
    const arbRoofShapeTag = fc.oneof(
      // Valid roof shapes
      fc.constantFrom(...VALID_ROOF_SHAPES),
      // Invalid roof shapes: random strings
      fc.string({ minLength: 1, maxLength: 20 }).filter(
        (s) => !VALID_ROOF_SHAPES.includes(s)
      ),
      // Edge cases: empty string, numeric strings, special characters
      fc.constantFrom('', 'dome', 'mansard', 'round', 'onion', '123', 'FLAT', 'Gabled')
    );

    fc.assert(
      fc.property(arbValidFootprint, arbRoofShapeTag, (footprint, roofShape) => {
        const feature: OverpassFeature = {
          type: 'way',
          id: 1,
          geometry: footprint,
          tags: { building: 'yes', 'roof:shape': roofShape },
        };

        const result = extractBuildings([feature], 9);
        expect(result).toHaveLength(1);

        if (VALID_ROOF_SHAPES.includes(roofShape)) {
          expect(result[0].roofShape).toBe(roofShape);
        } else {
          expect(result[0].roofShape).toBeUndefined();
        }
      }),
      { numRuns: 100 }
    );
  });

  it('roofShape is omitted when roof:shape tag is absent', () => {
    fc.assert(
      fc.property(arbValidFootprint, (footprint) => {
        const feature: OverpassFeature = {
          type: 'way',
          id: 1,
          geometry: footprint,
          tags: { building: 'yes' },
        };

        const result = extractBuildings([feature], 9);
        expect(result).toHaveLength(1);
        expect(result[0].roofShape).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('minLevel equals tag value for valid integers in [0, 200]', () => {
    const arbValidMinLevel = fc.integer({ min: 0, max: 200 });

    fc.assert(
      fc.property(arbValidFootprint, arbValidMinLevel, (footprint, minLevel) => {
        const feature: OverpassFeature = {
          type: 'way',
          id: 1,
          geometry: footprint,
          tags: { building: 'yes', 'building:min_level': String(minLevel) },
        };

        const result = extractBuildings([feature], 9);
        expect(result).toHaveLength(1);
        expect(result[0].minLevel).toBe(minLevel);
      }),
      { numRuns: 100 }
    );
  });

  it('minLevel defaults to 0 for invalid or out-of-range building:min_level values', () => {
    const arbInvalidMinLevel = fc.oneof(
      // Non-numeric strings
      fc.stringMatching(/^[a-zA-Z]{1,10}$/),
      // Out-of-range integers (negative)
      fc.integer({ min: -1000, max: -1 }).map(String),
      // Out-of-range integers (too high)
      fc.integer({ min: 201, max: 10000 }).map(String),
      // Non-integer numbers
      fc.double({ min: 0.1, max: 199.9, noNaN: true, noDefaultInfinity: true })
        .filter((n) => !Number.isInteger(n))
        .map(String),
      // Edge cases
      fc.constantFrom('', 'abc', 'NaN', 'Infinity', '-Infinity', '3.5', '1e999')
    );

    fc.assert(
      fc.property(arbValidFootprint, arbInvalidMinLevel, (footprint, minLevelStr) => {
        const feature: OverpassFeature = {
          type: 'way',
          id: 1,
          geometry: footprint,
          tags: { building: 'yes', 'building:min_level': minLevelStr },
        };

        const result = extractBuildings([feature], 9);
        expect(result).toHaveLength(1);
        expect(result[0].minLevel).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('minLevel defaults to 0 when building:min_level tag is absent', () => {
    fc.assert(
      fc.property(arbValidFootprint, (footprint) => {
        const feature: OverpassFeature = {
          type: 'way',
          id: 1,
          geometry: footprint,
          tags: { building: 'yes' },
        };

        const result = extractBuildings([feature], 9);
        expect(result).toHaveLength(1);
        expect(result[0].minLevel).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('roofShape and minLevel are independently determined from their respective tags', () => {
    const arbRoofShape = fc.constantFrom(...VALID_ROOF_SHAPES);
    const arbMinLevel = fc.integer({ min: 0, max: 200 });

    fc.assert(
      fc.property(
        arbValidFootprint,
        arbRoofShape,
        arbMinLevel,
        (footprint, roofShape, minLevel) => {
          const feature: OverpassFeature = {
            type: 'way',
            id: 1,
            geometry: footprint,
            tags: {
              building: 'yes',
              'roof:shape': roofShape,
              'building:min_level': String(minLevel),
            },
          };

          const result = extractBuildings([feature], 9);
          expect(result).toHaveLength(1);
          expect(result[0].roofShape).toBe(roofShape);
          expect(result[0].minLevel).toBe(minLevel);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ─── Property 4: Road Width Determination ──────────────────────
// Feature: building-road-3d-extraction, Property 4: Road Width Determination

describe('Property 4: Road Width Determination', () => {
  /**
   * **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
   *
   * For any OSM road element with arbitrary tag combinations, the extracted
   * RoadGeometry.width SHALL equal:
   * - The `width` tag value if it is a valid number in [0.5, 50], OR
   * - `lanes * 3.5` if lanes is a valid positive integer and no valid width tag exists, OR
   * - The classification-based default width for the element's `highway` tag value otherwise.
   *
   * Invalid width tag values (non-numeric, out-of-range) SHALL always result in
   * fallback to the next priority level.
   */

  // ─── Road-specific Arbitraries ─────────────────────────────────

  /** Valid width tag value: numeric string in [0.5, 50] */
  const arbValidWidth = fc.double({ min: 0.5, max: 50, noNaN: true, noDefaultInfinity: true })
    .map(v => String(v));

  /** Invalid width tag value: non-numeric or out-of-range */
  const arbInvalidWidth = fc.oneof(
    // Non-numeric strings
    fc.stringMatching(/^[a-zA-Z ]{1,10}$/),
    // Out-of-range low (below 0.5)
    fc.double({ min: -100, max: 0.49, noNaN: true, noDefaultInfinity: true }).map(v => String(v)),
    // Out-of-range high (above 50)
    fc.double({ min: 50.01, max: 10000, noNaN: true, noDefaultInfinity: true }).map(v => String(v)),
    // Special invalid strings
    fc.constantFrom('NaN', 'Infinity', '-Infinity', '', ' ', 'abc', '10m', '5 meters', '0', '0.0')
  );

  /** Valid lanes tag value: positive integer string */
  const arbValidLanes = fc.integer({ min: 1, max: 20 }).map(v => String(v));

  /** Invalid lanes tag value: non-integer, non-positive, or non-numeric */
  const arbInvalidLanes = fc.oneof(
    // Non-integer (decimal)
    fc.double({ min: 0.1, max: 19.9, noNaN: true, noDefaultInfinity: true })
      .filter(v => !Number.isInteger(v))
      .map(v => String(v)),
    // Zero or negative
    fc.integer({ min: -100, max: 0 }).map(v => String(v)),
    // Non-numeric strings
    fc.constantFrom('abc', '', ' ', 'NaN', '3.5', '1.1', 'two', 'Infinity')
  );

  /** Known highway classification values with defined widths */
  const CLASSIFICATION_WIDTHS: Record<string, number> = {
    motorway: 12,
    trunk: 10,
    primary: 8,
    secondary: 7,
    tertiary: 6,
    residential: 5,
    service: 3.5,
    footway: 2,
    path: 2,
    cycleway: 2,
  };
  const ROAD_WIDTH_DEFAULT = 4;

  const arbKnownHighway = fc.constantFrom(
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'residential', 'service', 'footway', 'path', 'cycleway'
  );

  /** Unknown highway types that should get the default width */
  const arbUnknownHighway = fc.constantFrom(
    'track', 'bridleway', 'steps', 'corridor', 'bus_guideway',
    'construction', 'proposed', 'raceway', 'living_street', 'unclassified'
  );

  /** A valid road geometry (minimum 2 coordinate points) */
  const arbRoadGeometry = fc.array(
    fc.record({
      lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 2, maxLength: 10 }
  );

  function makeRoadFeature(tags: Record<string, string>, geometry?: Array<{ lat: number; lon: number }>): OverpassFeature {
    return {
      type: 'way',
      id: 1,
      geometry: geometry ?? [
        { lat: 48.0, lon: 2.0 },
        { lat: 48.001, lon: 2.001 },
      ],
      tags,
    };
  }

  // ─── Tests ─────────────────────────────────────────────────────

  it('Priority 1: uses explicit width tag when value is valid [0.5, 50]', () => {
    fc.assert(
      fc.property(
        arbValidWidth,
        arbKnownHighway,
        (widthStr, highway) => {
          const tags: Record<string, string> = { highway, width: widthStr };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(Number(widthStr));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 1: width tag takes precedence over valid lanes tag', () => {
    fc.assert(
      fc.property(
        arbValidWidth,
        arbValidLanes,
        arbKnownHighway,
        (widthStr, lanesStr, highway) => {
          const tags: Record<string, string> = { highway, width: widthStr, lanes: lanesStr };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(Number(widthStr));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 2: uses lanes * 3.5 when width tag is invalid', () => {
    fc.assert(
      fc.property(
        arbInvalidWidth,
        arbValidLanes,
        arbKnownHighway,
        (invalidWidth, lanesStr, highway) => {
          const tags: Record<string, string> = { highway, width: invalidWidth, lanes: lanesStr };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(Number(lanesStr) * 3.5);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 2: uses lanes * 3.5 when width tag is absent', () => {
    fc.assert(
      fc.property(
        arbValidLanes,
        arbKnownHighway,
        (lanesStr, highway) => {
          const tags: Record<string, string> = { highway, lanes: lanesStr };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(Number(lanesStr) * 3.5);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 3: falls back to classification-based width when both width and lanes are invalid', () => {
    fc.assert(
      fc.property(
        arbInvalidWidth,
        arbInvalidLanes,
        arbKnownHighway,
        (invalidWidth, invalidLanes, highway) => {
          const tags: Record<string, string> = { highway, width: invalidWidth, lanes: invalidLanes };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(CLASSIFICATION_WIDTHS[highway]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 3: falls back to classification-based width when both tags are absent', () => {
    fc.assert(
      fc.property(
        arbKnownHighway,
        (highway) => {
          const tags: Record<string, string> = { highway };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(CLASSIFICATION_WIDTHS[highway]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Priority 3: unknown highway types get default width (4m) when no width or lanes', () => {
    fc.assert(
      fc.property(
        arbUnknownHighway,
        (highway) => {
          const tags: Record<string, string> = { highway };
          const result = extractRoads([makeRoadFeature(tags)]);
          expect(result).toHaveLength(1);
          expect(result[0].width).toBe(ROAD_WIDTH_DEFAULT);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extractRoads applies width determination correctly for arbitrary tag combinations', () => {
    const arbTags = fc.oneof(
      // Case 1: valid width tag (should use width directly)
      fc.tuple(arbValidWidth, arbKnownHighway).map(([w, h]) => ({
        highway: h, width: w,
      })),
      // Case 2: invalid width + valid lanes (should use lanes * 3.5)
      fc.tuple(arbInvalidWidth, arbValidLanes, arbKnownHighway).map(([w, l, h]) => ({
        highway: h, width: w, lanes: l,
      })),
      // Case 3: no width + valid lanes (should use lanes * 3.5)
      fc.tuple(arbValidLanes, arbKnownHighway).map(([l, h]) => ({
        highway: h, lanes: l,
      })),
      // Case 4: invalid width + invalid lanes (should use classification)
      fc.tuple(arbInvalidWidth, arbInvalidLanes, arbKnownHighway).map(([w, l, h]) => ({
        highway: h, width: w, lanes: l,
      })),
      // Case 5: no width, no lanes (should use classification)
      arbKnownHighway.map(h => ({ highway: h } as Record<string, string>)),
      // Case 6: unknown highway, no width, no lanes (should use default 4m)
      arbUnknownHighway.map(h => ({ highway: h } as Record<string, string>))
    );

    fc.assert(
      fc.property(
        arbTags,
        arbRoadGeometry,
        (tags, geometry) => {
          const feature = makeRoadFeature(tags, geometry);
          const result = extractRoads([feature]);

          expect(result).toHaveLength(1);
          const road = result[0];

          const widthValue = Number(tags['width']);
          const lanesValue = Number(tags['lanes']);

          if (tags['width'] !== undefined &&
              Number.isFinite(widthValue) &&
              widthValue >= 0.5 && widthValue <= 50) {
            // Priority 1: valid width tag
            expect(road.width).toBe(widthValue);
          } else if (tags['lanes'] !== undefined &&
                     Number.isFinite(lanesValue) &&
                     Number.isInteger(lanesValue) &&
                     lanesValue > 0) {
            // Priority 2: valid lanes tag
            expect(road.width).toBe(lanesValue * 3.5);
          } else {
            // Priority 3: classification-based
            const highway = tags['highway'] ?? '';
            const expectedWidth = CLASSIFICATION_WIDTHS[highway] ?? ROAD_WIDTH_DEFAULT;
            expect(road.width).toBe(expectedWidth);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});


// ─── Property 5: Road Path and Tag Extraction ──────────────────
// Feature: building-road-3d-extraction, Property 5: Road Path and Tag Extraction

describe('Property 5: Road Path and Tag Extraction', () => {
  /**
   * **Validates: Requirements 2.6, 2.7, 2.8, 2.9**
   *
   * For any OSM road element with 2 or more coordinate points, the extracted
   * RoadGeometry SHALL contain all centerline coordinates in their original order,
   * the raw surface tag value (or empty string if absent), and the highway
   * classification tag value. Elements with fewer than 2 points SHALL be excluded
   * from the output array.
   */

  // ─── Arbitraries ───────────────────────────────────────────────

  /** A coordinate point with valid lat/lon */
  const arbCoord = fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  });

  /** A valid road centerline (≥2 coordinate points) */
  const arbValidCenterline = fc.array(arbCoord, { minLength: 2, maxLength: 20 });

  /** An invalid road centerline (<2 coordinate points) */
  const arbInvalidCenterline = fc.array(arbCoord, { minLength: 0, maxLength: 1 });

  /** Random surface tag values */
  const arbSurfaceTag = fc.oneof(
    fc.constantFrom('asphalt', 'concrete', 'gravel', 'dirt', 'paved', 'unpaved', 'cobblestone', 'sand'),
    fc.string({ minLength: 1, maxLength: 20 })
  );

  /** Random highway classification tag values */
  const arbHighwayTag = fc.oneof(
    fc.constantFrom('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway', 'path', 'cycleway'),
    fc.string({ minLength: 1, maxLength: 15 })
  );

  /** Helper to create a road feature */
  function makeRoadFeature(
    geometry: Array<{ lat: number; lon: number }>,
    tags: Record<string, string>
  ): OverpassFeature {
    return {
      type: 'way',
      id: 1,
      geometry,
      tags,
    };
  }

  // ─── Tests ─────────────────────────────────────────────────────

  it('extracts all centerline coordinates in original order for roads with ≥2 points', () => {
    fc.assert(
      fc.property(arbValidCenterline, arbHighwayTag, (centerline, highway) => {
        const feature = makeRoadFeature(centerline, { highway });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(1);
        expect(result[0].centerline).toHaveLength(centerline.length);

        // Verify all coordinates are preserved in order
        for (let i = 0; i < centerline.length; i++) {
          expect(result[0].centerline[i].lat).toBe(centerline[i].lat);
          expect(result[0].centerline[i].lon).toBe(centerline[i].lon);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('excludes road elements with fewer than 2 coordinate points', () => {
    fc.assert(
      fc.property(arbInvalidCenterline, arbHighwayTag, (centerline, highway) => {
        const feature = makeRoadFeature(centerline, { highway });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves raw surface tag value when present', () => {
    fc.assert(
      fc.property(arbValidCenterline, arbSurfaceTag, arbHighwayTag, (centerline, surface, highway) => {
        const feature = makeRoadFeature(centerline, { highway, surface });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(1);
        expect(result[0].surface).toBe(surface);
      }),
      { numRuns: 100 }
    );
  });

  it('uses empty string for surface when surface tag is absent', () => {
    fc.assert(
      fc.property(arbValidCenterline, arbHighwayTag, (centerline, highway) => {
        const feature = makeRoadFeature(centerline, { highway });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(1);
        expect(result[0].surface).toBe('');
      }),
      { numRuns: 100 }
    );
  });

  it('preserves highway classification tag value', () => {
    fc.assert(
      fc.property(arbValidCenterline, arbHighwayTag, (centerline, highway) => {
        const feature = makeRoadFeature(centerline, { highway });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(1);
        expect(result[0].highway).toBe(highway);
      }),
      { numRuns: 100 }
    );
  });

  it('uses empty string for highway when highway tag is absent', () => {
    fc.assert(
      fc.property(arbValidCenterline, arbSurfaceTag, (centerline, surface) => {
        const feature = makeRoadFeature(centerline, { surface });
        const result = extractRoads([feature]);

        expect(result).toHaveLength(1);
        expect(result[0].highway).toBe('');
      }),
      { numRuns: 100 }
    );
  });

  it('preserves all tags in the output tags field', () => {
    const arbExtraTags = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter(s => s !== 'highway' && s !== 'surface'),
      fc.string({ minLength: 0, maxLength: 20 }),
      { minKeys: 0, maxKeys: 5 }
    );

    fc.assert(
      fc.property(
        arbValidCenterline,
        arbHighwayTag,
        arbSurfaceTag,
        arbExtraTags,
        (centerline, highway, surface, extraTags) => {
          const tags = { highway, surface, ...extraTags };
          const feature = makeRoadFeature(centerline, tags);
          const result = extractRoads([feature]);

          expect(result).toHaveLength(1);
          // All original tags should be preserved in the output
          for (const [key, value] of Object.entries(tags)) {
            expect(result[0].tags[key]).toBe(value);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('correctly filters mixed arrays of valid and invalid road features', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.array(arbCoord, { minLength: 0, maxLength: 20 }),
            arbHighwayTag
          ),
          { minLength: 1, maxLength: 10 }
        ),
        (featureSpecs) => {
          const features = featureSpecs.map(([geometry, highway], idx) =>
            ({
              type: 'way' as const,
              id: idx,
              geometry,
              tags: { highway },
            })
          );

          const result = extractRoads(features);

          // Count how many features have ≥2 points
          const expectedCount = featureSpecs.filter(([geom]) => geom.length >= 2).length;
          expect(result).toHaveLength(expectedCount);

          // Verify each result corresponds to a valid feature in order
          let resultIdx = 0;
          for (const [geometry, highway] of featureSpecs) {
            if (geometry.length >= 2) {
              expect(result[resultIdx].centerline).toHaveLength(geometry.length);
              expect(result[resultIdx].highway).toBe(highway);
              resultIdx++;
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ─── Property 6: Building Geometry Serialization Round-Trip ────
// Feature: building-road-3d-extraction, Property 6: Building Geometry Serialization Round-Trip

describe('Property 6: Building Geometry Serialization Round-Trip', () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**
   *
   * For any valid BuildingGeometry[] array, serializing to JSON and then parsing
   * back SHALL produce a structurally equal array where all numeric values match
   * within a tolerance of 1e-9 and all string and coordinate values are identical.
   */

  // ─── Arbitraries ───────────────────────────────────────────────

  /** A coordinate point with valid lat/lon */
  const arbCoord = fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  });

  /** A valid building footprint polygon (≥4 coordinate pairs, closed) */
  const arbFootprint = fc
    .array(arbCoord, { minLength: 3, maxLength: 19 })
    .map((pts) => [...pts, pts[0]]);

  /** Valid height: number in [0, 1000] */
  const arbHeight = fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true });

  /** Valid floors: integer >= 0 */
  const arbFloors = fc.integer({ min: 0, max: 200 });

  /** Valid minLevel: integer >= 0 */
  const arbMinLevel = fc.integer({ min: 0, max: 200 });

  /** Optional roof shape */
  const arbRoofShape = fc.option(
    fc.constantFrom('flat', 'gabled', 'hipped', 'pyramidal'),
    { nil: undefined }
  );

  /** Tags: record of string key-value pairs */
  const arbTags = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z0-9:_]+$/.test(s)),
    fc.string({ minLength: 0, maxLength: 30 }),
    { minKeys: 0, maxKeys: 5 }
  );

  /** A single valid BuildingGeometry object */
  const arbBuildingGeometry = fc.record({
    footprint: arbFootprint,
    height: arbHeight,
    floors: arbFloors,
    minLevel: arbMinLevel,
    roofShape: arbRoofShape,
    tags: arbTags,
  });

  /** An array of BuildingGeometry objects (0 to 10 elements) */
  const arbBuildingGeometryArray = fc.array(arbBuildingGeometry, { minLength: 0, maxLength: 10 });

  // ─── Helpers ───────────────────────────────────────────────────

  const TOLERANCE = 1e-9;

  function assertNumericClose(actual: number, expected: number, path: string): void {
    const diff = Math.abs(actual - expected);
    if (diff > TOLERANCE) {
      throw new Error(
        `Numeric mismatch at ${path}: expected ${expected}, got ${actual} (diff: ${diff})`
      );
    }
  }

  function assertBuildingGeometryEqual(
    actual: any[],
    expected: any[]
  ): void {
    expect(actual.length).toBe(expected.length);

    for (let i = 0; i < expected.length; i++) {
      const a = actual[i];
      const e = expected[i];

      // Footprint coordinates
      expect(a.footprint.length).toBe(e.footprint.length);
      for (let j = 0; j < e.footprint.length; j++) {
        assertNumericClose(a.footprint[j].lat, e.footprint[j].lat, `[${i}].footprint[${j}].lat`);
        assertNumericClose(a.footprint[j].lon, e.footprint[j].lon, `[${i}].footprint[${j}].lon`);
      }

      // Numeric fields
      assertNumericClose(a.height, e.height, `[${i}].height`);
      assertNumericClose(a.floors, e.floors, `[${i}].floors`);
      assertNumericClose(a.minLevel, e.minLevel, `[${i}].minLevel`);

      // String fields
      if (e.roofShape !== undefined) {
        expect(a.roofShape).toBe(e.roofShape);
      } else {
        expect(a.roofShape).toBeUndefined();
      }

      // Tags
      expect(a.tags).toEqual(e.tags);
    }
  }

  // ─── Tests ─────────────────────────────────────────────────────

  it('serialization round-trip preserves BuildingGeometry[] structure and values', () => {
    fc.assert(
      fc.property(arbBuildingGeometryArray, (buildings) => {
        // Filter out undefined roofShape keys for clean serialization
        const cleanBuildings = buildings.map(b => {
          const result: any = {
            footprint: b.footprint,
            height: b.height,
            floors: b.floors,
            minLevel: b.minLevel,
            tags: b.tags,
          };
          if (b.roofShape !== undefined) {
            result.roofShape = b.roofShape;
          }
          return result;
        });

        // Serialize to JSON and parse back
        const json = JSON.stringify(cleanBuildings);
        const parsed = JSON.parse(json);

        // Verify structural equality with numeric tolerance
        assertBuildingGeometryEqual(parsed, cleanBuildings);
      }),
      { numRuns: 100 }
    );
  });

  it('empty BuildingGeometry[] array round-trips correctly', () => {
    fc.assert(
      fc.property(fc.constant([]), (emptyArray) => {
        const json = JSON.stringify(emptyArray);
        const parsed = JSON.parse(json);

        expect(parsed).toEqual([]);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('coordinate values are preserved exactly through serialization', () => {
    fc.assert(
      fc.property(arbBuildingGeometry, (building) => {
        const cleanBuilding: any = {
          footprint: building.footprint,
          height: building.height,
          floors: building.floors,
          minLevel: building.minLevel,
          tags: building.tags,
        };
        if (building.roofShape !== undefined) {
          cleanBuilding.roofShape = building.roofShape;
        }

        const json = JSON.stringify([cleanBuilding]);
        const parsed = JSON.parse(json);

        // Every coordinate pair must match within tolerance
        for (let i = 0; i < building.footprint.length; i++) {
          assertNumericClose(
            parsed[0].footprint[i].lat,
            building.footprint[i].lat,
            `footprint[${i}].lat`
          );
          assertNumericClose(
            parsed[0].footprint[i].lon,
            building.footprint[i].lon,
            `footprint[${i}].lon`
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});


// ─── Property 7: Road Geometry Serialization Round-Trip ────────
// Feature: building-road-3d-extraction, Property 7: Road Geometry Serialization Round-Trip

describe('Property 7: Road Geometry Serialization Round-Trip', () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**
   *
   * For any valid RoadGeometry[] array, serializing to JSON and then parsing
   * back SHALL produce a structurally equal array where all numeric values match
   * within a tolerance of 1e-9 and all string and coordinate values are identical.
   */

  // ─── Arbitraries ───────────────────────────────────────────────

  /** A coordinate point with valid lat/lon */
  const arbCoord = fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  });

  /** A valid road centerline (≥2 coordinate points) */
  const arbCenterline = fc.array(arbCoord, { minLength: 2, maxLength: 20 });

  /** Valid width: number >= 0 */
  const arbWidth = fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true });

  /** Surface string */
  const arbSurface = fc.oneof(
    fc.constantFrom('asphalt', 'concrete', 'gravel', 'dirt', 'paved', 'unpaved', 'cobblestone', ''),
    fc.string({ minLength: 0, maxLength: 20 })
  );

  /** Highway classification string */
  const arbHighway = fc.oneof(
    fc.constantFrom('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway', 'path', 'cycleway', ''),
    fc.string({ minLength: 0, maxLength: 15 })
  );

  /** Tags: record of string key-value pairs */
  const arbTags = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-zA-Z0-9:_]+$/.test(s)),
    fc.string({ minLength: 0, maxLength: 30 }),
    { minKeys: 0, maxKeys: 5 }
  );

  /** A single valid RoadGeometry object */
  const arbRoadGeometry = fc.record({
    centerline: arbCenterline,
    width: arbWidth,
    surface: arbSurface,
    highway: arbHighway,
    tags: arbTags,
  });

  /** An array of RoadGeometry objects (0 to 10 elements) */
  const arbRoadGeometryArray = fc.array(arbRoadGeometry, { minLength: 0, maxLength: 10 });

  // ─── Helpers ───────────────────────────────────────────────────

  const TOLERANCE = 1e-9;

  function assertNumericClose(actual: number, expected: number, path: string): void {
    const diff = Math.abs(actual - expected);
    if (diff > TOLERANCE) {
      throw new Error(
        `Numeric mismatch at ${path}: expected ${expected}, got ${actual} (diff: ${diff})`
      );
    }
  }

  function assertRoadGeometryEqual(
    actual: any[],
    expected: any[]
  ): void {
    expect(actual.length).toBe(expected.length);

    for (let i = 0; i < expected.length; i++) {
      const a = actual[i];
      const e = expected[i];

      // Centerline coordinates
      expect(a.centerline.length).toBe(e.centerline.length);
      for (let j = 0; j < e.centerline.length; j++) {
        assertNumericClose(a.centerline[j].lat, e.centerline[j].lat, `[${i}].centerline[${j}].lat`);
        assertNumericClose(a.centerline[j].lon, e.centerline[j].lon, `[${i}].centerline[${j}].lon`);
      }

      // Numeric fields
      assertNumericClose(a.width, e.width, `[${i}].width`);

      // String fields
      expect(a.surface).toBe(e.surface);
      expect(a.highway).toBe(e.highway);

      // Tags
      expect(a.tags).toEqual(e.tags);
    }
  }

  // ─── Tests ─────────────────────────────────────────────────────

  it('serialization round-trip preserves RoadGeometry[] structure and values', () => {
    fc.assert(
      fc.property(arbRoadGeometryArray, (roads) => {
        // Serialize to JSON and parse back
        const json = JSON.stringify(roads);
        const parsed = JSON.parse(json);

        // Verify structural equality with numeric tolerance
        assertRoadGeometryEqual(parsed, roads);
      }),
      { numRuns: 100 }
    );
  });

  it('empty RoadGeometry[] array round-trips correctly', () => {
    fc.assert(
      fc.property(fc.constant([]), (emptyArray) => {
        const json = JSON.stringify(emptyArray);
        const parsed = JSON.parse(json);

        expect(parsed).toEqual([]);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('coordinate values are preserved exactly through serialization', () => {
    fc.assert(
      fc.property(arbRoadGeometry, (road) => {
        const json = JSON.stringify([road]);
        const parsed = JSON.parse(json);

        // Every coordinate pair must match within tolerance
        for (let i = 0; i < road.centerline.length; i++) {
          assertNumericClose(
            parsed[0].centerline[i].lat,
            road.centerline[i].lat,
            `centerline[${i}].lat`
          );
          assertNumericClose(
            parsed[0].centerline[i].lon,
            road.centerline[i].lon,
            `centerline[${i}].lon`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('string fields (surface, highway) are preserved identically through serialization', () => {
    fc.assert(
      fc.property(arbRoadGeometry, (road) => {
        const json = JSON.stringify([road]);
        const parsed = JSON.parse(json);

        expect(parsed[0].surface).toBe(road.surface);
        expect(parsed[0].highway).toBe(road.highway);

        // Tags must also be identical
        for (const [key, value] of Object.entries(road.tags)) {
          expect(parsed[0].tags[key]).toBe(value);
        }
      }),
      { numRuns: 100 }
    );
  });
});
