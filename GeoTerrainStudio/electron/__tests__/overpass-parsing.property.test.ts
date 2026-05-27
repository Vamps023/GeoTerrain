/**
 * Property-based test: Overpass response parsing round-trip
 *
 * For any valid Overpass API JSON response containing features with geometry
 * and tags, parsing the response into normalized OverpassFeature objects SHALL
 * preserve all geometry coordinates and tag key-value pairs from the original response.
 *
 * **Validates: Requirements 1.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseOverpassResponse } from '../overpass-client';

// ─── Generators ────────────────────────────────────────────────

/** Generate a valid lat/lon coordinate pair (excluding -0 since JSON normalizes it to 0) */
const arbCoordinate = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }).map(
    (v) => (Object.is(v, -0) ? 0 : v)
  ),
  lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }).map(
    (v) => (Object.is(v, -0) ? 0 : v)
  ),
});

/** Generate a non-empty geometry array (ways need at least 1 point to be included) */
const arbGeometry = fc.array(arbCoordinate, { minLength: 1, maxLength: 20 });

/** Generate a valid OSM tag key (alphanumeric + colon, no empty) */
const arbTagKey = fc.stringMatching(/^[a-z][a-z0-9:_]{0,30}$/);

/** Generate a valid OSM tag value (non-empty string, no control chars) */
const arbTagValue = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => !s.includes('\0') && !s.includes('\\') && !s.includes('"')
);

/** Generate a tags object with 0-5 key-value pairs */
const arbTags = fc.dictionary(arbTagKey, arbTagValue, { minKeys: 0, maxKeys: 5 });

/** Generate a positive numeric OSM ID */
const arbId = fc.integer({ min: 1, max: 999999999 });

/** Generate a valid Overpass way element (with geometry) */
const arbWayElement = fc.record({
  type: fc.constant('way' as const),
  id: arbId,
  geometry: arbGeometry,
  tags: arbTags,
});

/** Generate a relation member with geometry */
const arbMemberWithGeometry = fc.record({
  type: fc.constantFrom('way', 'node', 'relation'),
  geometry: arbGeometry,
});

/** Generate a valid Overpass relation element (with members that have geometry) */
const arbRelationElement = fc.record({
  type: fc.constant('relation' as const),
  id: arbId,
  members: fc.array(arbMemberWithGeometry, { minLength: 1, maxLength: 5 }),
  tags: arbTags,
});

/** Generate a mixed Overpass response with ways and relations */
const arbOverpassResponse = fc.record({
  elements: fc.array(fc.oneof(arbWayElement, arbRelationElement), {
    minLength: 1,
    maxLength: 10,
  }),
});

// ─── Property Tests ────────────────────────────────────────────

describe('Property 2: Overpass response parsing round-trip', () => {
  it('preserves all way geometry coordinates from the original response', () => {
    fc.assert(
      fc.property(arbWayElement, (wayElement) => {
        const response = JSON.stringify({ elements: [wayElement] });
        const features = parseOverpassResponse(response);

        expect(features).toHaveLength(1);
        expect(features[0].type).toBe('way');
        expect(features[0].id).toBe(wayElement.id);
        expect(features[0].geometry).toHaveLength(wayElement.geometry.length);

        // Verify each coordinate is preserved exactly
        for (let i = 0; i < wayElement.geometry.length; i++) {
          expect(features[0].geometry[i].lat).toBe(wayElement.geometry[i].lat);
          expect(features[0].geometry[i].lon).toBe(wayElement.geometry[i].lon);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('preserves all tag key-value pairs from the original response', () => {
    fc.assert(
      fc.property(arbWayElement, (wayElement) => {
        const response = JSON.stringify({ elements: [wayElement] });
        const features = parseOverpassResponse(response);

        expect(features).toHaveLength(1);

        // All original tags must be present with same values
        for (const [key, value] of Object.entries(wayElement.tags)) {
          expect(features[0].tags[key]).toBe(value);
        }

        // No extra tags should be added
        expect(Object.keys(features[0].tags).length).toBe(
          Object.keys(wayElement.tags).length
        );
      }),
      { numRuns: 200 }
    );
  });

  it('preserves relation geometry from members', () => {
    fc.assert(
      fc.property(arbRelationElement, (relElement) => {
        const response = JSON.stringify({ elements: [relElement] });
        const features = parseOverpassResponse(response);

        expect(features).toHaveLength(1);
        expect(features[0].type).toBe('relation');
        expect(features[0].id).toBe(relElement.id);

        // Combined geometry should contain all member geometry points in order
        const expectedGeometry = relElement.members.flatMap((m) => m.geometry);
        expect(features[0].geometry).toHaveLength(expectedGeometry.length);

        for (let i = 0; i < expectedGeometry.length; i++) {
          expect(features[0].geometry[i].lat).toBe(expectedGeometry[i].lat);
          expect(features[0].geometry[i].lon).toBe(expectedGeometry[i].lon);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('preserves relation tag key-value pairs', () => {
    fc.assert(
      fc.property(arbRelationElement, (relElement) => {
        const response = JSON.stringify({ elements: [relElement] });
        const features = parseOverpassResponse(response);

        expect(features).toHaveLength(1);

        for (const [key, value] of Object.entries(relElement.tags)) {
          expect(features[0].tags[key]).toBe(value);
        }

        expect(Object.keys(features[0].tags).length).toBe(
          Object.keys(relElement.tags).length
        );
      }),
      { numRuns: 200 }
    );
  });

  it('feature count matches expected (ways with geometry + relations with member geometry)', () => {
    fc.assert(
      fc.property(arbOverpassResponse, (overpassData) => {
        const response = JSON.stringify(overpassData);
        const features = parseOverpassResponse(response);

        // Count expected features: ways with geometry + relations with member geometry
        const expectedCount = overpassData.elements.filter((el) => {
          if (el.type === 'way' && 'geometry' in el && el.geometry.length > 0) {
            return true;
          }
          if (el.type === 'relation' && 'members' in el) {
            const combinedLen = el.members.reduce(
              (sum, m) => sum + (m.geometry ? m.geometry.length : 0),
              0
            );
            return combinedLen > 0;
          }
          return false;
        }).length;

        expect(features.length).toBe(expectedCount);
      }),
      { numRuns: 200 }
    );
  });

  it('feature type is correctly set for ways and relations', () => {
    fc.assert(
      fc.property(arbOverpassResponse, (overpassData) => {
        const response = JSON.stringify(overpassData);
        const features = parseOverpassResponse(response);

        for (const feature of features) {
          expect(['way', 'relation']).toContain(feature.type);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('feature IDs are preserved from the original response', () => {
    fc.assert(
      fc.property(arbOverpassResponse, (overpassData) => {
        const response = JSON.stringify(overpassData);
        const features = parseOverpassResponse(response);

        // Collect expected IDs from elements that would produce features
        const expectedIds = overpassData.elements
          .filter((el) => {
            if (el.type === 'way' && 'geometry' in el && el.geometry.length > 0) {
              return true;
            }
            if (el.type === 'relation' && 'members' in el) {
              const combinedLen = el.members.reduce(
                (sum, m) => sum + (m.geometry ? m.geometry.length : 0),
                0
              );
              return combinedLen > 0;
            }
            return false;
          })
          .map((el) => el.id);

        const actualIds = features.map((f) => f.id);
        expect(actualIds).toEqual(expectedIds);
      }),
      { numRuns: 200 }
    );
  });
});
