/**
 * Property-based tests for export engine integration — manifest field correctness.
 *
 * Uses fast-check for property-based testing and vitest as test runner.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Types ─────────────────────────────────────────────────────

/** Mirrors the MaskResult interface from mask-generator.ts */
interface MaskResult {
  roadMask?: string;
  waterMask?: string;
  vegetationMask?: string;
  buildingMask?: string;
  cliffMask?: string;
  generationTimeMs: number;
}

/** The mask keys that can appear in the manifest */
const MASK_KEYS = ['roadMask', 'waterMask', 'vegetationMask', 'buildingMask', 'cliffMask'] as const;
type MaskKey = typeof MASK_KEYS[number];

// ─── Manifest Construction Logic (extracted from export-engine.ts) ──────────

/**
 * Replicates the manifest field construction logic from export-engine.ts.
 *
 * In the real code:
 * 1. maskFiles record is populated only for masks that have a non-empty string
 *    value AND whose file exists on disk.
 * 2. The manifest uses conditional spread:
 *    ...(maskFiles.roadMask ? { roadMask: maskFiles.roadMask } : {})
 *
 * This function simulates both steps.
 */
function buildManifestMaskFields(
  maskResult: MaskResult,
  existsOnDisk: Set<string>
): Record<string, string> {
  // Step 1: Build maskFiles record (only non-empty strings that exist on disk)
  const maskFiles: Record<string, string> = {};

  for (const key of MASK_KEYS) {
    const filename = maskResult[key];
    if (typeof filename === 'string' && filename.length > 0) {
      // Simulate fs.existsSync check
      if (existsOnDisk.has(filename)) {
        maskFiles[key] = filename;
      }
    }
  }

  // Step 2: Build manifest files object using conditional spread (same as export-engine.ts)
  const manifestFiles: Record<string, string> = {
    ...(maskFiles.roadMask ? { roadMask: maskFiles.roadMask } : {}),
    ...(maskFiles.waterMask ? { waterMask: maskFiles.waterMask } : {}),
    ...(maskFiles.vegetationMask ? { vegetationMask: maskFiles.vegetationMask } : {}),
    ...(maskFiles.buildingMask ? { buildingMask: maskFiles.buildingMask } : {}),
    ...(maskFiles.cliffMask ? { cliffMask: maskFiles.cliffMask } : {}),
  };

  return manifestFiles;
}

// ─── Arbitraries ───────────────────────────────────────────────

/** Arbitrary for a tile prefix */
const arbTilePrefix = fc.constantFrom('tile_0_0', 'tile_0_1', 'tile_1_0', 'tile_2_3', 'tile_5_7');

/** Arbitrary for a mask type */
const arbMaskType = fc.constantFrom(...MASK_KEYS);

/**
 * Arbitrary for a MaskResult where each mask field is randomly:
 * - undefined (mask was not generated / failed)
 * - a valid filename string (mask was successfully generated)
 */
const arbMaskResult: fc.Arbitrary<{ maskResult: MaskResult; generatedMasks: Set<MaskKey> }> =
  fc.record({
    tilePrefix: arbTilePrefix,
    roadEnabled: fc.boolean(),
    waterEnabled: fc.boolean(),
    vegetationEnabled: fc.boolean(),
    buildingEnabled: fc.boolean(),
    cliffEnabled: fc.boolean(),
  }).map(({ tilePrefix, roadEnabled, waterEnabled, vegetationEnabled, buildingEnabled, cliffEnabled }) => {
    const maskResult: MaskResult = { generationTimeMs: 100 };
    const generatedMasks = new Set<MaskKey>();

    if (roadEnabled) {
      maskResult.roadMask = `${tilePrefix}_road_mask.png`;
      generatedMasks.add('roadMask');
    }
    if (waterEnabled) {
      maskResult.waterMask = `${tilePrefix}_water_mask.png`;
      generatedMasks.add('waterMask');
    }
    if (vegetationEnabled) {
      maskResult.vegetationMask = `${tilePrefix}_vegetation_mask.png`;
      generatedMasks.add('vegetationMask');
    }
    if (buildingEnabled) {
      maskResult.buildingMask = `${tilePrefix}_building_mask.png`;
      generatedMasks.add('buildingMask');
    }
    if (cliffEnabled) {
      maskResult.cliffMask = `${tilePrefix}_cliff_mask.png`;
      generatedMasks.add('cliffMask');
    }

    return { maskResult, generatedMasks };
  });

/**
 * Arbitrary for a subset of generated masks that actually exist on disk.
 * Simulates the case where some mask files were written successfully and
 * others were not (e.g., disk error after generation reported success).
 */
const arbDiskPresence: fc.Arbitrary<'all' | 'subset' | 'none'> =
  fc.constantFrom('all', 'subset', 'none');

// ─── Property Tests ────────────────────────────────────────────

/**
 * Property 13: Manifest field correctness
 *
 * For any combination of enabled/disabled mask types, the tile manifest SHALL
 * contain fields only for masks that were successfully generated, and SHALL not
 * contain null values for any mask field.
 *
 * **Validates: Requirements 6.1, 6.2**
 */
describe('Property 13: Manifest field correctness', () => {
  it('manifest contains only fields for masks that were successfully generated and exist on disk', () => {
    fc.assert(
      fc.property(
        arbMaskResult,
        arbDiskPresence,
        ({ maskResult, generatedMasks }, diskPresence) => {
          // Determine which files "exist on disk"
          let existsOnDisk: Set<string>;

          if (diskPresence === 'all') {
            // All generated masks exist on disk
            existsOnDisk = new Set<string>();
            for (const key of generatedMasks) {
              const filename = maskResult[key];
              if (filename) existsOnDisk.add(filename);
            }
          } else if (diskPresence === 'none') {
            // No files exist on disk
            existsOnDisk = new Set<string>();
          } else {
            // Random subset exists on disk
            existsOnDisk = new Set<string>();
            for (const key of generatedMasks) {
              const filename = maskResult[key];
              // Include roughly half
              if (filename && key.charCodeAt(0) % 2 === 0) {
                existsOnDisk.add(filename);
              }
            }
          }

          const manifestFields = buildManifestMaskFields(maskResult, existsOnDisk);

          // PROPERTY: No null values in manifest fields
          for (const value of Object.values(manifestFields)) {
            expect(value).not.toBeNull();
            expect(value).not.toBeUndefined();
          }

          // PROPERTY: No empty string values in manifest fields
          for (const value of Object.values(manifestFields)) {
            expect(value).not.toBe('');
          }

          // PROPERTY: Every field in manifest corresponds to a mask that was
          // generated AND exists on disk
          for (const [key, value] of Object.entries(manifestFields)) {
            expect(MASK_KEYS).toContain(key);
            expect(generatedMasks.has(key as MaskKey)).toBe(true);
            expect(existsOnDisk.has(value)).toBe(true);
          }

          // PROPERTY: Masks that were NOT generated are absent from manifest
          for (const key of MASK_KEYS) {
            if (!generatedMasks.has(key)) {
              expect(manifestFields).not.toHaveProperty(key);
            }
          }

          // PROPERTY: Masks that don't exist on disk are absent from manifest
          for (const key of generatedMasks) {
            const filename = maskResult[key];
            if (filename && !existsOnDisk.has(filename)) {
              expect(manifestFields).not.toHaveProperty(key);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('manifest never contains null or undefined values regardless of MaskResult content', () => {
    fc.assert(
      fc.property(
        arbMaskResult,
        ({ maskResult }) => {
          // All generated masks exist on disk (happy path)
          const existsOnDisk = new Set<string>();
          for (const key of MASK_KEYS) {
            const filename = maskResult[key];
            if (filename) existsOnDisk.add(filename);
          }

          const manifestFields = buildManifestMaskFields(maskResult, existsOnDisk);

          // Check every value is a non-empty string (never null, undefined, or empty)
          for (const [key, value] of Object.entries(manifestFields)) {
            expect(value).toBeTypeOf('string');
            expect(value.length).toBeGreaterThan(0);
            // Verify it's a valid mask key
            expect(MASK_KEYS).toContain(key);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('disabled/skipped mask types are completely absent from manifest (not present as null)', () => {
    fc.assert(
      fc.property(
        arbTilePrefix,
        fc.record({
          road: fc.boolean(),
          water: fc.boolean(),
          vegetation: fc.boolean(),
          building: fc.boolean(),
          cliff: fc.boolean(),
        }),
        (tilePrefix, enabledFlags) => {
          // Build a MaskResult based on enabled flags
          const maskResult: MaskResult = { generationTimeMs: 50 };
          const existsOnDisk = new Set<string>();

          if (enabledFlags.road) {
            const f = `${tilePrefix}_road_mask.png`;
            maskResult.roadMask = f;
            existsOnDisk.add(f);
          }
          if (enabledFlags.water) {
            const f = `${tilePrefix}_water_mask.png`;
            maskResult.waterMask = f;
            existsOnDisk.add(f);
          }
          if (enabledFlags.vegetation) {
            const f = `${tilePrefix}_vegetation_mask.png`;
            maskResult.vegetationMask = f;
            existsOnDisk.add(f);
          }
          if (enabledFlags.building) {
            const f = `${tilePrefix}_building_mask.png`;
            maskResult.buildingMask = f;
            existsOnDisk.add(f);
          }
          if (enabledFlags.cliff) {
            const f = `${tilePrefix}_cliff_mask.png`;
            maskResult.cliffMask = f;
            existsOnDisk.add(f);
          }

          const manifestFields = buildManifestMaskFields(maskResult, existsOnDisk);

          // Enabled masks should be present
          if (enabledFlags.road) expect(manifestFields).toHaveProperty('roadMask');
          if (enabledFlags.water) expect(manifestFields).toHaveProperty('waterMask');
          if (enabledFlags.vegetation) expect(manifestFields).toHaveProperty('vegetationMask');
          if (enabledFlags.building) expect(manifestFields).toHaveProperty('buildingMask');
          if (enabledFlags.cliff) expect(manifestFields).toHaveProperty('cliffMask');

          // Disabled masks should be completely absent (not null, not undefined key)
          if (!enabledFlags.road) expect(manifestFields).not.toHaveProperty('roadMask');
          if (!enabledFlags.water) expect(manifestFields).not.toHaveProperty('waterMask');
          if (!enabledFlags.vegetation) expect(manifestFields).not.toHaveProperty('vegetationMask');
          if (!enabledFlags.building) expect(manifestFields).not.toHaveProperty('buildingMask');
          if (!enabledFlags.cliff) expect(manifestFields).not.toHaveProperty('cliffMask');

          // Total field count matches enabled count
          const enabledCount = Object.values(enabledFlags).filter(Boolean).length;
          expect(Object.keys(manifestFields).length).toBe(enabledCount);
        }
      ),
      { numRuns: 200 }
    );
  });
});
