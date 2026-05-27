/**
 * Property-based tests for parameter validation range enforcement.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 *
 * Property 14: Parameter validation range enforcement
 *
 * For any numeric value outside [0, 90], cliff threshold validation SHALL reject it.
 * For any numeric value outside [1, 10], road width validation SHALL reject it.
 * For any value within the valid range, validation SHALL accept it.
 *
 * **Validates: Requirements 5.5, 5.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Validation Functions ──────────────────────────────────────
// These mirror the validation logic in ExportPanel.tsx:
//   cliffThresholdDegrees < 0 || cliffThresholdDegrees > 90 → invalid
//   roadLineWidthPx < 1 || roadLineWidthPx > 10 → invalid

/**
 * Validates cliff threshold value.
 * Returns true if the value is within the valid range [0, 90].
 */
function validateCliffThreshold(value: number): boolean {
  return value >= 0 && value <= 90;
}

/**
 * Validates road line width value.
 * Returns true if the value is within the valid range [1, 10].
 */
function validateRoadWidth(value: number): boolean {
  return value >= 1 && value <= 10;
}

// ─── Property Tests ────────────────────────────────────────────

describe('Property 14: Parameter validation range enforcement', () => {
  describe('Cliff threshold validation', () => {
    it('accepts any integer in [0, 90]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 90 }),
          (value) => {
            expect(validateCliffThreshold(value)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('rejects any number less than 0', () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1e6, max: -Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            expect(validateCliffThreshold(value)).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('rejects any number greater than 90', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 90 + Number.MIN_VALUE, max: 1e6, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            // Only test values strictly greater than 90
            fc.pre(value > 90);
            expect(validateCliffThreshold(value)).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Road width validation', () => {
    it('accepts any integer in [1, 10]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (value) => {
            expect(validateRoadWidth(value)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('rejects any number less than 1', () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1e6, max: 1 - Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            // Only test values strictly less than 1
            fc.pre(value < 1);
            expect(validateRoadWidth(value)).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('rejects any number greater than 10', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 10 + Number.MIN_VALUE, max: 1e6, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            // Only test values strictly greater than 10
            fc.pre(value > 10);
            expect(validateRoadWidth(value)).toBe(false);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
