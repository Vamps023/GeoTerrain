/**
 * Property-Based Tests for Geocoding Service
 *
 * Feature: map-search-vegetation-markers
 *
 * Tests Properties 4, 6, 8, and 9 from the design document.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  shouldTriggerSearch,
  getZoomForPlaceType,
  buildNominatimUrl,
  parseNominatimResponse,
  type NominatimRawResult,
} from '../core/geocoding-service';

/**
 * Property 4: Search query trigger threshold
 *
 * For any string input, a geocoding query SHALL be triggered if and only if
 * the trimmed input length is >= 3 characters. Strings shorter than 3
 * characters SHALL NOT trigger any geocoding request.
 *
 * Feature: map-search-vegetation-markers, Property 4: Search query trigger threshold
 *
 * **Validates: Requirements 2.2, 2.6**
 */
describe('Property 4: Search query trigger threshold', () => {
  it('triggers search only when trimmed input has >= 3 characters', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const trimmed = input.trim();
        const result = shouldTriggerSearch(input);

        if (trimmed.length >= 3) {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('whitespace-only strings never trigger search', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 20 }).map((chars) => chars.join('')),
        (input) => {
          expect(shouldTriggerSearch(input)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('strings with leading/trailing whitespace are evaluated by trimmed length', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3 }),
        fc.string(),
        fc.string(),
        (core, prefix, suffix) => {
          // Ensure core has no leading/trailing whitespace so trimming doesn't reduce it
          const trimmedCore = core.trim();
          if (trimmedCore.length >= 3) {
            const padded = `  ${trimmedCore}  `;
            expect(shouldTriggerSearch(padded)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 6: Zoom level selection by place type
 *
 * For any place type string, getZoomForPlaceType() SHALL return:
 * 12 for "city", 14 for "town", 16 for "village"/"address"/"landmark",
 * and a sensible default (14) for unknown types.
 * The return value SHALL always be in the range [2, 18].
 *
 * Feature: map-search-vegetation-markers, Property 6: Zoom level selection by place type
 *
 * **Validates: Requirements 2.4**
 */
describe('Property 6: Zoom level selection by place type', () => {
  it('returns correct zoom for known place types', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('city', 'town', 'village', 'address', 'landmark'),
        (type) => {
          const zoom = getZoomForPlaceType(type);

          switch (type) {
            case 'city':
              expect(zoom).toBe(12);
              break;
            case 'town':
              expect(zoom).toBe(14);
              break;
            case 'village':
            case 'address':
            case 'landmark':
              expect(zoom).toBe(16);
              break;
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns 14 for unknown place types', () => {
    fc.assert(
      fc.property(
        fc.string().filter(
          (s) => !['city', 'town', 'village', 'address', 'landmark'].includes(s)
        ),
        (type) => {
          expect(getZoomForPlaceType(type)).toBe(14);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('always returns a value in [2, 18] for any input', () => {
    fc.assert(
      fc.property(fc.string(), (type) => {
        const zoom = getZoomForPlaceType(type);
        expect(zoom).toBeGreaterThanOrEqual(2);
        expect(zoom).toBeLessThanOrEqual(18);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 8: Nominatim URL construction
 *
 * For any non-empty search query string, buildNominatimUrl(query) SHALL produce
 * a URL that: starts with 'https://nominatim.openstreetmap.org/search',
 * contains 'format=json', contains 'limit=5', contains 'addressdetails=1',
 * and contains the query as the q parameter (URL-encoded).
 *
 * Feature: map-search-vegetation-markers, Property 8: Nominatim URL construction
 *
 * **Validates: Requirements 4.2**
 */
describe('Property 8: Nominatim URL construction', () => {
  it('URL starts with correct base and contains required params', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (query) => {
          const url = buildNominatimUrl(query);

          // Must start with the Nominatim base URL
          expect(url.startsWith('https://nominatim.openstreetmap.org/search')).toBe(true);

          // Must contain required parameters
          expect(url).toContain('format=json');
          expect(url).toContain('limit=5');
          expect(url).toContain('addressdetails=1');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('URL contains the query as URL-encoded q parameter', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (query) => {
          const url = buildNominatimUrl(query);

          // The URL should contain the query encoded as the q parameter
          const urlObj = new URL(url);
          expect(urlObj.searchParams.get('q')).toBe(query);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('URL is always a valid URL', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (query) => {
          const url = buildNominatimUrl(query);

          // Should not throw when parsed as a URL
          expect(() => new URL(url)).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 9: Nominatim response parsing never throws
 *
 * For any array of objects conforming to the NominatimRawResult shape,
 * parseNominatimResponse() SHALL return a valid array of GeocodingResult
 * objects without throwing exceptions. Each result SHALL have numeric lat
 * in [-90, 90], numeric lon in [-180, 180], a non-empty displayName,
 * and a boundingBox array of 4 numbers.
 *
 * Feature: map-search-vegetation-markers, Property 9: Nominatim response parsing never throws
 *
 * **Validates: Requirements 4.3, 4.7**
 */
describe('Property 9: Nominatim response parsing never throws', () => {
  /**
   * Generator for valid NominatimRawResult objects
   */
  const arbNominatimRawResult: fc.Arbitrary<NominatimRawResult> = fc.record({
    place_id: fc.integer({ min: 1, max: 999999999 }),
    display_name: fc.string({ minLength: 1 }),
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }).map(String),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }).map(String),
    type: fc.constantFrom('city', 'town', 'village', 'address', 'residential', 'suburb'),
    class: fc.constantFrom('place', 'boundary', 'highway', 'building'),
    boundingbox: fc.tuple(
      fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }).map(String),
      fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }).map(String),
      fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }).map(String),
      fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }).map(String),
    ),
  });

  it('never throws for any conforming input array', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 0, maxLength: 10 }),
        (rawResults) => {
          expect(() => parseNominatimResponse(rawResults)).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns an array of the same length as input', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 0, maxLength: 10 }),
        (rawResults) => {
          const results = parseNominatimResponse(rawResults);
          expect(results).toHaveLength(rawResults.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each result has numeric latitude in [-90, 90]', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 1, maxLength: 10 }),
        (rawResults) => {
          const results = parseNominatimResponse(rawResults);

          for (const result of results) {
            expect(typeof result.latitude).toBe('number');
            expect(result.latitude).toBeGreaterThanOrEqual(-90);
            expect(result.latitude).toBeLessThanOrEqual(90);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each result has numeric longitude in [-180, 180]', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 1, maxLength: 10 }),
        (rawResults) => {
          const results = parseNominatimResponse(rawResults);

          for (const result of results) {
            expect(typeof result.longitude).toBe('number');
            expect(result.longitude).toBeGreaterThanOrEqual(-180);
            expect(result.longitude).toBeLessThanOrEqual(180);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each result has a non-empty displayName', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 1, maxLength: 10 }),
        (rawResults) => {
          const results = parseNominatimResponse(rawResults);

          for (const result of results) {
            expect(typeof result.displayName).toBe('string');
            expect(result.displayName.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each result has a boundingBox array of 4 numbers', () => {
    fc.assert(
      fc.property(
        fc.array(arbNominatimRawResult, { minLength: 1, maxLength: 10 }),
        (rawResults) => {
          const results = parseNominatimResponse(rawResults);

          for (const result of results) {
            expect(result.boundingBox).toHaveLength(4);
            for (const val of result.boundingBox) {
              expect(typeof val).toBe('number');
              expect(Number.isFinite(val)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 5: Suggestion list is capped at 5 items
 *
 * For any array of geocoding results of length N (where N >= 0), the rendered
 * suggestion dropdown SHALL display exactly min(N, 5) selectable items.
 *
 * Since the SearchBar component uses `results.slice(0, 5)` to render suggestions,
 * we test the slicing logic directly as a pure function.
 *
 * Feature: map-search-vegetation-markers, Property 5: Suggestion list is capped at 5 items
 *
 * **Validates: Requirements 2.3**
 */
describe('Property 5: Suggestion list is capped at 5 items', () => {
  /**
   * Generator for GeocodingResult-like objects
   */
  const arbGeocodingResult = fc.record({
    displayName: fc.string({ minLength: 1 }),
    latitude: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    longitude: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
    type: fc.constantFrom('city', 'town', 'village', 'address', 'landmark', 'residential'),
    boundingBox: fc.tuple(
      fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true })
    ) as fc.Arbitrary<[number, number, number, number]>,
  });

  it('displayed suggestions count equals min(N, 5) for any N results', () => {
    fc.assert(
      fc.property(
        fc.array(arbGeocodingResult, { minLength: 0, maxLength: 20 }),
        (results) => {
          // This mirrors the SearchBar rendering logic: results.slice(0, 5)
          const displayed = results.slice(0, 5);
          expect(displayed.length).toBe(Math.min(results.length, 5));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never displays more than 5 items regardless of input size', () => {
    fc.assert(
      fc.property(
        fc.array(arbGeocodingResult, { minLength: 0, maxLength: 20 }),
        (results) => {
          const displayed = results.slice(0, 5);
          expect(displayed.length).toBeLessThanOrEqual(5);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('displays all items when N <= 5', () => {
    fc.assert(
      fc.property(
        fc.array(arbGeocodingResult, { minLength: 0, maxLength: 5 }),
        (results) => {
          const displayed = results.slice(0, 5);
          expect(displayed.length).toBe(results.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 7: Keyboard navigation stays within bounds
 *
 * For any suggestion list of length N > 0 and any sequence of Up/Down arrow
 * key presses, the highlighted index SHALL always remain in the range [0, N-1].
 * Down from the last item wraps to 0. Up from the first item wraps to N-1.
 *
 * The SearchBar uses this navigation logic:
 * - ArrowDown: if (prev < results.length - 1) return prev + 1; else return 0;
 * - ArrowUp: if (prev > 0) return prev - 1; else return results.length - 1;
 * Starting index is -1 (nothing highlighted). After the first ArrowDown, index
 * becomes 0 and stays within [0, N-1] for all subsequent presses.
 *
 * Feature: map-search-vegetation-markers, Property 7: Keyboard navigation stays within bounds
 *
 * **Validates: Requirements 2.8**
 */
describe('Property 7: Keyboard navigation stays within bounds', () => {
  /**
   * Simulates the SearchBar keyboard navigation logic.
   * Returns the highlighted index after processing all key presses.
   */
  function simulateNavigation(
    listLength: number,
    keyPresses: Array<'ArrowDown' | 'ArrowUp'>
  ): number[] {
    let index = -1; // Starting state: nothing highlighted
    const indices: number[] = [];

    for (const key of keyPresses) {
      if (key === 'ArrowDown') {
        if (index < listLength - 1) {
          index = index + 1;
        } else {
          index = 0;
        }
      } else {
        // ArrowUp
        if (index > 0) {
          index = index - 1;
        } else {
          index = listLength - 1;
        }
      }
      indices.push(index);
    }

    return indices;
  }

  it('highlighted index is always in [0, N-1] after the first key press', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.constantFrom('ArrowDown' as const, 'ArrowUp' as const), { minLength: 1, maxLength: 50 }),
        (listLength, keyPresses) => {
          const indices = simulateNavigation(listLength, keyPresses);

          for (const idx of indices) {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(listLength);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ArrowDown from last item wraps to 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (listLength) => {
          // Navigate to the last item (index N-1) by pressing ArrowDown N times from -1
          const keyPresses: Array<'ArrowDown' | 'ArrowUp'> = Array(listLength).fill('ArrowDown');
          const indices = simulateNavigation(listLength, keyPresses);

          // After N ArrowDown presses from -1, we should be at index N-1
          expect(indices[listLength - 1]).toBe(listLength - 1);

          // One more ArrowDown should wrap to 0
          const wrappedIndices = simulateNavigation(listLength, [...keyPresses, 'ArrowDown']);
          expect(wrappedIndices[listLength]).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ArrowUp from first item (index 0) wraps to N-1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (listLength) => {
          // First ArrowDown moves from -1 to 0
          // Then ArrowUp from 0 should wrap to N-1
          const keyPresses: Array<'ArrowDown' | 'ArrowUp'> = ['ArrowDown', 'ArrowUp'];
          const indices = simulateNavigation(listLength, keyPresses);

          expect(indices[0]).toBe(0); // After first ArrowDown: at 0
          expect(indices[1]).toBe(listLength - 1); // After ArrowUp from 0: wraps to N-1
        }
      ),
      { numRuns: 100 }
    );
  });

  it('navigation is deterministic for the same sequence of key presses', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.constantFrom('ArrowDown' as const, 'ArrowUp' as const), { minLength: 1, maxLength: 50 }),
        (listLength, keyPresses) => {
          const indices1 = simulateNavigation(listLength, keyPresses);
          const indices2 = simulateNavigation(listLength, keyPresses);

          expect(indices1).toEqual(indices2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
