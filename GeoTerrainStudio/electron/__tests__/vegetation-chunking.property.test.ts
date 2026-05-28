/**
 * Property-Based Tests: Vegetation Chunking
 *
 * Tests for the vegetation mask tiling/chunking pipeline in satellite-vegetation-client.ts.
 * Uses fast-check for property-based testing with minimum 100 iterations.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeChunks, extractVegetationClasses, reassembleChunks } from '../satellite-vegetation-client';
import type { GeoBounds } from '../overpass-client';

// ─── Constants (mirrored from satellite-vegetation-client.ts) ──────────
const SHARP_PIXEL_LIMIT = 268_435_456;
const CHUNK_SAFETY_MARGIN = 0.9;

// ─── Shared Arbitraries ────────────────────────────────────────────────

/**
 * Arbitrary for valid GeoBounds where north > south and east > west.
 */
const arbGeoBounds: fc.Arbitrary<GeoBounds> = fc
  .record({
    south: fc.double({ min: -85, max: 84, noNaN: true, noDefaultInfinity: true }),
    latSpan: fc.double({ min: 0.01, max: 10, noNaN: true, noDefaultInfinity: true }),
    west: fc.double({ min: -175, max: 174, noNaN: true, noDefaultInfinity: true }),
    lonSpan: fc.double({ min: 0.01, max: 10, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((r) => r.south + r.latSpan <= 90 && r.west + r.lonSpan <= 180)
  .map((r) => ({
    south: r.south,
    north: r.south + r.latSpan,
    west: r.west,
    east: r.west + r.lonSpan,
  }));

/**
 * Arbitrary for output dimensions (reasonable pixel sizes for terrain exports).
 */
const arbOutputDimensions = fc.record({
  outputWidth: fc.integer({ min: 64, max: 16384 }),
  outputHeight: fc.integer({ min: 64, max: 16384 }),
});

/**
 * Arbitrary for source dimensions that CAN exceed the pixel limit.
 * Generates both small (within limit) and large (exceeding limit) cases.
 */
const arbSourceDimensions = fc.record({
  sourceWidth: fc.integer({ min: 100, max: 50000 }),
  sourceHeight: fc.integer({ min: 100, max: 50000 }),
});

/**
 * Arbitrary for source dimensions that are guaranteed to EXCEED the pixel limit.
 * sourceWidth * sourceHeight >= SHARP_PIXEL_LIMIT * CHUNK_SAFETY_MARGIN
 */
const arbLargeSourceDimensions = fc
  .record({
    sourceWidth: fc.integer({ min: 16000, max: 50000 }),
    sourceHeight: fc.integer({ min: 16000, max: 50000 }),
  })
  .filter((d) => d.sourceWidth * d.sourceHeight >= SHARP_PIXEL_LIMIT * CHUNK_SAFETY_MARGIN);

/**
 * Arbitrary for source dimensions that are guaranteed to be WITHIN the pixel limit.
 * sourceWidth * sourceHeight < SHARP_PIXEL_LIMIT * CHUNK_SAFETY_MARGIN
 */
const arbSmallSourceDimensions = fc
  .record({
    sourceWidth: fc.integer({ min: 100, max: 15000 }),
    sourceHeight: fc.integer({ min: 100, max: 15000 }),
  })
  .filter((d) => d.sourceWidth * d.sourceHeight < SHARP_PIXEL_LIMIT * CHUNK_SAFETY_MARGIN);

// ─── Property 1: Chunk computation keeps all chunks below the pixel limit ──

/**
 * Property 1: Chunk computation keeps all chunks below the pixel limit
 *
 * For any source dimensions (sourceWidth, sourceHeight) and output dimensions
 * (outputWidth, outputHeight) and valid GeoBounds, computeChunks() SHALL produce
 * chunk definitions where each chunk's corresponding source region has
 * sourceChunkWidth * sourceChunkHeight < SHARP_PIXEL_LIMIT.
 *
 * Additionally, when sourceWidth * sourceHeight < SHARP_PIXEL_LIMIT * CHUNK_SAFETY_MARGIN,
 * exactly one chunk covering the full output area SHALL be returned.
 *
 * **Validates: Requirements 1.1, 1.4, 1.7**
 */
describe('Property 1: Chunk computation keeps all chunks below the pixel limit', () => {
  it('each chunk source region has sourceChunkWidth * sourceChunkHeight < SHARP_PIXEL_LIMIT', () => {
    fc.assert(
      fc.property(
        arbSourceDimensions,
        arbOutputDimensions,
        arbGeoBounds,
        (source, output, bounds) => {
          const chunks = computeChunks(
            output.outputWidth,
            output.outputHeight,
            source.sourceWidth,
            source.sourceHeight,
            bounds
          );

          expect(chunks.length).toBeGreaterThan(0);

          for (const chunk of chunks) {
            // Compute the corresponding source region dimensions for this chunk
            const sourceChunkWidth = source.sourceWidth * (chunk.width / output.outputWidth);
            const sourceChunkHeight = source.sourceHeight * (chunk.height / output.outputHeight);
            const sourceChunkPixels = sourceChunkWidth * sourceChunkHeight;

            expect(sourceChunkPixels).toBeLessThan(SHARP_PIXEL_LIMIT);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns exactly 1 chunk covering full output when source fits within limit', () => {
    fc.assert(
      fc.property(
        arbSmallSourceDimensions,
        arbOutputDimensions,
        arbGeoBounds,
        (source, output, bounds) => {
          const chunks = computeChunks(
            output.outputWidth,
            output.outputHeight,
            source.sourceWidth,
            source.sourceHeight,
            bounds
          );

          // Should return exactly one chunk
          expect(chunks).toHaveLength(1);

          // The single chunk should cover the full output area
          const chunk = chunks[0];
          expect(chunk.outputX).toBe(0);
          expect(chunk.outputY).toBe(0);
          expect(chunk.width).toBe(output.outputWidth);
          expect(chunk.height).toBe(output.outputHeight);

          // The chunk bounds should match the input bounds
          expect(chunk.bounds).toEqual(bounds);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns multiple chunks when source exceeds the pixel limit', () => {
    fc.assert(
      fc.property(
        arbLargeSourceDimensions,
        arbOutputDimensions,
        arbGeoBounds,
        (source, output, bounds) => {
          const chunks = computeChunks(
            output.outputWidth,
            output.outputHeight,
            source.sourceWidth,
            source.sourceHeight,
            bounds
          );

          // Should return more than one chunk
          expect(chunks.length).toBeGreaterThan(1);

          // Each chunk's source region must still be below the pixel limit
          for (const chunk of chunks) {
            const sourceChunkWidth = source.sourceWidth * (chunk.width / output.outputWidth);
            const sourceChunkHeight = source.sourceHeight * (chunk.height / output.outputHeight);
            const sourceChunkPixels = sourceChunkWidth * sourceChunkHeight;

            expect(sourceChunkPixels).toBeLessThan(SHARP_PIXEL_LIMIT);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: Vegetation class mapping is preserved ─────────

/**
 * Property 3: Vegetation class mapping is preserved
 *
 * For any raw pixel buffer containing byte values in [0, 255],
 * extractVegetationClasses() SHALL produce an output buffer of the same length where:
 * value 10 maps to 255, value 20 maps to 200, value 30 maps to 150,
 * value 40 maps to 100, and all other values map to 0.
 *
 * **Validates: Requirements 1.5**
 */
describe('Property 3: Vegetation class mapping is preserved', () => {
  const EXPECTED_MAPPING: Record<number, number> = {
    10: 255, // Tree cover
    20: 200, // Shrubland
    30: 150, // Grassland
    40: 100, // Cropland
  };

  it('output buffer length equals input buffer length for any byte array', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 1000 }),
        (inputBytes) => {
          const inputBuffer = Buffer.from(inputBytes);
          const output = extractVegetationClasses(inputBuffer);

          expect(output.length).toBe(inputBuffer.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('known vegetation classes map to correct intensity values', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 1000 }),
        (inputBytes) => {
          const inputBuffer = Buffer.from(inputBytes);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < inputBuffer.length; i++) {
            const inputValue = inputBuffer[i];
            const expectedOutput = EXPECTED_MAPPING[inputValue] ?? 0;
            expect(output[i]).toBe(expectedOutput);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('value 10 always maps to 255 (Tree cover)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999 }).map((len) => len + 1),
        (length) => {
          const inputBuffer = Buffer.alloc(length, 10);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < output.length; i++) {
            expect(output[i]).toBe(255);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('value 20 always maps to 200 (Shrubland)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999 }).map((len) => len + 1),
        (length) => {
          const inputBuffer = Buffer.alloc(length, 20);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < output.length; i++) {
            expect(output[i]).toBe(200);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('value 30 always maps to 150 (Grassland)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999 }).map((len) => len + 1),
        (length) => {
          const inputBuffer = Buffer.alloc(length, 30);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < output.length; i++) {
            expect(output[i]).toBe(150);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('value 40 always maps to 100 (Cropland)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999 }).map((len) => len + 1),
        (length) => {
          const inputBuffer = Buffer.alloc(length, 40);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < output.length; i++) {
            expect(output[i]).toBe(100);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all non-vegetation values map to 0', () => {
    // Generate byte values that are NOT 10, 20, 30, or 40
    const nonVegetationByte = fc.nat({ max: 255 }).filter(
      (v) => v !== 10 && v !== 20 && v !== 30 && v !== 40
    );

    fc.assert(
      fc.property(
        fc.array(nonVegetationByte, { minLength: 1, maxLength: 1000 }),
        (values) => {
          const inputBuffer = Buffer.from(values);
          const output = extractVegetationClasses(inputBuffer);

          for (let i = 0; i < output.length; i++) {
            expect(output[i]).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ─── Property 2: Chunk reassembly produces a complete output buffer ────────

/**
 * Property 2: Chunk reassembly produces a complete output buffer
 *
 * For any set of chunk definitions that tile an output area of (outputWidth, outputHeight)
 * without gaps or overlaps, and corresponding chunk buffers of the correct sizes,
 * reassembleChunks() SHALL produce a buffer of exactly outputWidth * outputHeight bytes
 * where every pixel at position (x, y) equals the value from the chunk whose region
 * contains that position.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
describe('Property 2: Chunk reassembly produces a complete output buffer', () => {
  /**
   * Generates a grid of chunk definitions that perfectly tile an output area.
   * Produces arbitrary output dimensions and grid subdivisions, then computes
   * chunk definitions that cover the entire area without gaps or overlaps.
   */
  const arbChunkGrid = fc
    .record({
      outputWidth: fc.integer({ min: 10, max: 500 }),
      outputHeight: fc.integer({ min: 10, max: 500 }),
      cols: fc.integer({ min: 1, max: 5 }),
      rows: fc.integer({ min: 1, max: 5 }),
    })
    .map(({ outputWidth, outputHeight, cols, rows }) => {
      const chunkWidth = Math.floor(outputWidth / cols);
      const chunkHeight = Math.floor(outputHeight / rows);

      // Skip degenerate cases where chunk dimensions would be 0
      if (chunkWidth < 1 || chunkHeight < 1) {
        return null;
      }

      const chunks: Array<{
        definition: {
          outputX: number;
          outputY: number;
          width: number;
          height: number;
          bounds: { south: number; north: number; west: number; east: number };
        };
        buffer: Buffer;
        fillValue: number;
      }> = [];

      let chunkIndex = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const outputX = col * chunkWidth;
          const outputY = row * chunkHeight;

          // Last column/row absorbs remaining pixels to avoid gaps
          const width = col === cols - 1 ? outputWidth - outputX : chunkWidth;
          const height = row === rows - 1 ? outputHeight - outputY : chunkHeight;

          // Each chunk gets a unique fill value (1-based to distinguish from zero-fill)
          const fillValue = (chunkIndex + 1) % 256;

          const buffer = Buffer.alloc(width * height, fillValue);

          chunks.push({
            definition: {
              outputX,
              outputY,
              width,
              height,
              bounds: {
                south: 40 + row,
                north: 41 + row,
                west: -3 + col,
                east: -2 + col,
              },
            },
            buffer,
            fillValue,
          });

          chunkIndex++;
        }
      }

      return { outputWidth, outputHeight, cols, rows, chunks };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  it('output buffer length is exactly outputWidth * outputHeight bytes', () => {
    fc.assert(
      fc.property(arbChunkGrid, ({ outputWidth, outputHeight, chunks }) => {
        const chunkInputs = chunks.map(({ definition, buffer }) => ({
          definition,
          buffer,
        }));

        const result = reassembleChunks(chunkInputs, outputWidth, outputHeight);

        expect(result.length).toBe(outputWidth * outputHeight);
      }),
      { numRuns: 100 }
    );
  });

  it('every pixel at position (x, y) equals the value from the chunk containing that position', () => {
    fc.assert(
      fc.property(arbChunkGrid, ({ outputWidth, outputHeight, chunks }) => {
        const chunkInputs = chunks.map(({ definition, buffer }) => ({
          definition,
          buffer,
        }));

        const result = reassembleChunks(chunkInputs, outputWidth, outputHeight);

        // Verify every pixel matches the expected chunk's fill value.
        // For efficiency, check all pixels in smaller buffers and sample in larger ones.
        const totalPixels = outputWidth * outputHeight;
        const checkAll = totalPixels <= 2500;

        if (checkAll) {
          for (let y = 0; y < outputHeight; y++) {
            for (let x = 0; x < outputWidth; x++) {
              const containingChunk = chunks.find(
                ({ definition }) =>
                  x >= definition.outputX &&
                  x < definition.outputX + definition.width &&
                  y >= definition.outputY &&
                  y < definition.outputY + definition.height
              );

              const pixelIndex = y * outputWidth + x;
              if (containingChunk) {
                expect(result[pixelIndex]).toBe(containingChunk.fillValue);
              }
            }
          }
        } else {
          // Sample pixels: check chunk boundaries and interiors
          for (const chunk of chunks) {
            const { definition, fillValue } = chunk;
            // Check corners and center of each chunk
            const testPoints = [
              { x: definition.outputX, y: definition.outputY }, // top-left
              { x: definition.outputX + definition.width - 1, y: definition.outputY }, // top-right
              { x: definition.outputX, y: definition.outputY + definition.height - 1 }, // bottom-left
              { x: definition.outputX + definition.width - 1, y: definition.outputY + definition.height - 1 }, // bottom-right
              { x: definition.outputX + Math.floor(definition.width / 2), y: definition.outputY + Math.floor(definition.height / 2) }, // center
            ];

            for (const { x, y } of testPoints) {
              if (x < outputWidth && y < outputHeight) {
                const pixelIndex = y * outputWidth + x;
                expect(result[pixelIndex]).toBe(fillValue);
              }
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('single chunk covering entire output produces correct buffer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 500 }),
        fc.integer({ min: 10, max: 500 }),
        fc.integer({ min: 0, max: 255 }),
        (outputWidth, outputHeight, fillValue) => {
          const buffer = Buffer.alloc(outputWidth * outputHeight, fillValue);
          const chunks = [
            {
              definition: {
                outputX: 0,
                outputY: 0,
                width: outputWidth,
                height: outputHeight,
                bounds: { south: 40, north: 41, west: -3, east: -2 },
              },
              buffer,
            },
          ];

          const result = reassembleChunks(chunks, outputWidth, outputHeight);

          expect(result.length).toBe(outputWidth * outputHeight);
          // Verify the entire buffer matches using Buffer.equals for efficiency
          const expected = Buffer.alloc(outputWidth * outputHeight, fillValue);
          expect(result.equals(expected)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
