import { describe, it, expect, vi } from 'vitest';
import {
  createPRNG,
  generateCandidates,
  filterByMask,
  enforceInstanceCap,
  sampleTerrainHeight,
  generateTransformMatrices,
  validateMatrixBuffer,
  DEFAULT_SCATTER_CONFIG,
  ScatterConfig,
  CandidatePosition,
} from '../TreeScatterer';
import { MaskData } from '../MaskSampler';

describe('TreeScatterer', () => {
  describe('createPRNG', () => {
    it('produces deterministic output for the same seed', () => {
      const rng1 = createPRNG(42);
      const rng2 = createPRNG(42);

      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());

      expect(seq1).toEqual(seq2);
    });

    it('produces different output for different seeds', () => {
      const rng1 = createPRNG(42);
      const rng2 = createPRNG(99);

      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());

      expect(seq1).not.toEqual(seq2);
    });

    it('produces values in [0, 1)', () => {
      const rng = createPRNG(123);
      for (let i = 0; i < 1000; i++) {
        const val = rng();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });
  });

  describe('generateCandidates', () => {
    it('produces candidates within tile bounds', () => {
      const tileWidth = 100;
      const tileHeight = 100;
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, density: 0.01 };

      const candidates = generateCandidates(tileWidth, tileHeight, config);

      for (const pos of candidates) {
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x).toBeLessThanOrEqual(tileWidth);
        expect(pos.z).toBeGreaterThanOrEqual(0);
        expect(pos.z).toBeLessThanOrEqual(tileHeight);
      }
    });

    it('produces expected number of candidates based on density', () => {
      const tileWidth = 100;
      const tileHeight = 100;
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, density: 0.01 };

      // spacing = 1/sqrt(0.01) = 10m
      // cols = ceil(100/10) = 10, rows = ceil(100/10) = 10
      // expected = 10 * 10 = 100
      const candidates = generateCandidates(tileWidth, tileHeight, config);
      expect(candidates.length).toBe(100);
    });

    it('is deterministic with the same seed', () => {
      const tileWidth = 50;
      const tileHeight = 50;
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, seed: 7 };

      const candidates1 = generateCandidates(tileWidth, tileHeight, config);
      const candidates2 = generateCandidates(tileWidth, tileHeight, config);

      expect(candidates1).toEqual(candidates2);
    });

    it('produces different results with different seeds', () => {
      const tileWidth = 50;
      const tileHeight = 50;
      const config1: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, seed: 7 };
      const config2: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, seed: 99 };

      const candidates1 = generateCandidates(tileWidth, tileHeight, config1);
      const candidates2 = generateCandidates(tileWidth, tileHeight, config2);

      // Same count but different positions
      expect(candidates1.length).toBe(candidates2.length);
      expect(candidates1).not.toEqual(candidates2);
    });
  });

  describe('filterByMask', () => {
    it('accepts positions where mask pixel >= threshold', () => {
      // 2x2 mask: top-left and bottom-right are vegetation (255)
      const mask: MaskData = {
        pixels: new Uint8Array([255, 0, 0, 255]),
        width: 2,
        height: 2,
      };

      const candidates = [
        { x: 2.5, z: 2.5 },  // UV (0.25, 0.25) -> pixel (0,0) = 255 -> accept
        { x: 7.5, z: 2.5 },  // UV (0.75, 0.25) -> pixel (1,0) = 0 -> reject
        { x: 2.5, z: 7.5 },  // UV (0.25, 0.75) -> pixel (0,1) = 0 -> reject
        { x: 7.5, z: 7.5 },  // UV (0.75, 0.75) -> pixel (1,1) = 255 -> accept
      ];

      const filtered = filterByMask(candidates, mask, 10, 10, 128);

      expect(filtered.length).toBe(2);
      expect(filtered[0]).toEqual({ x: 2.5, z: 2.5 });
      expect(filtered[1]).toEqual({ x: 7.5, z: 7.5 });
    });

    it('rejects all positions when mask is all black', () => {
      const mask: MaskData = {
        pixels: new Uint8Array([0, 0, 0, 0]),
        width: 2,
        height: 2,
      };

      const candidates = [
        { x: 2.5, z: 2.5 },
        { x: 7.5, z: 7.5 },
      ];

      const filtered = filterByMask(candidates, mask, 10, 10, 128);
      expect(filtered.length).toBe(0);
    });

    it('accepts all positions when mask is all white', () => {
      const mask: MaskData = {
        pixels: new Uint8Array([255, 255, 255, 255]),
        width: 2,
        height: 2,
      };

      const candidates = [
        { x: 2.5, z: 2.5 },
        { x: 7.5, z: 7.5 },
      ];

      const filtered = filterByMask(candidates, mask, 10, 10, 128);
      expect(filtered.length).toBe(2);
    });

    it('respects custom threshold', () => {
      // All pixels at value 100
      const mask: MaskData = {
        pixels: new Uint8Array([100, 100, 100, 100]),
        width: 2,
        height: 2,
      };

      const candidates = [{ x: 2.5, z: 2.5 }];

      // Threshold 128 -> reject (100 < 128)
      expect(filterByMask(candidates, mask, 10, 10, 128).length).toBe(0);

      // Threshold 50 -> accept (100 >= 50)
      expect(filterByMask(candidates, mask, 10, 10, 50).length).toBe(1);
    });
  });

  describe('enforceInstanceCap', () => {
    it('returns all positions when count is below cap', () => {
      const positions: CandidatePosition[] = [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
        { x: 3, z: 3 },
      ];
      const rng = createPRNG(42);

      const result = enforceInstanceCap(positions, 10, rng);
      expect(result).toEqual(positions);
    });

    it('returns exactly maxCount positions when count exceeds cap', () => {
      const positions: CandidatePosition[] = Array.from({ length: 100 }, (_, i) => ({
        x: i,
        z: i,
      }));
      const rng = createPRNG(42);

      const result = enforceInstanceCap(positions, 10, rng);
      expect(result.length).toBe(10);
    });

    it('returns positions that are a subset of the original', () => {
      const positions: CandidatePosition[] = Array.from({ length: 50 }, (_, i) => ({
        x: i * 2,
        z: i * 3,
      }));
      const rng = createPRNG(7);

      const result = enforceInstanceCap(positions, 5, rng);
      expect(result.length).toBe(5);

      // Every returned position must exist in the original array
      for (const pos of result) {
        expect(positions).toContainEqual(pos);
      }
    });

    it('is deterministic with the same PRNG seed', () => {
      const positions: CandidatePosition[] = Array.from({ length: 100 }, (_, i) => ({
        x: i,
        z: i,
      }));

      const result1 = enforceInstanceCap(positions, 10, createPRNG(42));
      const result2 = enforceInstanceCap(positions, 10, createPRNG(42));
      expect(result1).toEqual(result2);
    });

    it('logs a console warning when cap is reached', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const positions: CandidatePosition[] = Array.from({ length: 20 }, (_, i) => ({
        x: i,
        z: i,
      }));
      const rng = createPRNG(42);

      enforceInstanceCap(positions, 5, rng);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'TreeScatterer: Instance cap reached (20 candidates, cap: 5). Randomly selecting 5 positions.'
      );
      warnSpy.mockRestore();
    });

    it('does not log a warning when count is at or below cap', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const positions: CandidatePosition[] = [{ x: 1, z: 1 }];
      const rng = createPRNG(42);

      enforceInstanceCap(positions, 5, rng);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('sampleTerrainHeight', () => {
    it('returns picked Y coordinate on successful hit', async () => {
      const mockPickResult = {
        hit: true,
        pickedPoint: { x: 5, y: 42.5, z: 10 },
      };
      const mockScene = {
        pickWithRay: vi.fn().mockReturnValue(mockPickResult),
      } as any;
      const mockMesh = {} as any;

      const height = await sampleTerrainHeight(mockScene, mockMesh, 5, 10);
      expect(height).toBe(42.5);
      expect(mockScene.pickWithRay).toHaveBeenCalledTimes(1);
    });

    it('retries up to 3 times on miss then falls back to 0', async () => {
      const mockScene = {
        pickWithRay: vi.fn().mockReturnValue({ hit: false, pickedPoint: null }),
      } as any;
      const mockMesh = {} as any;

      const height = await sampleTerrainHeight(mockScene, mockMesh, 5, 10);
      expect(height).toBe(0);
      expect(mockScene.pickWithRay).toHaveBeenCalledTimes(3);
    });

    it('succeeds on retry after initial miss', async () => {
      const mockScene = {
        pickWithRay: vi
          .fn()
          .mockReturnValueOnce({ hit: false, pickedPoint: null })
          .mockReturnValueOnce({ hit: true, pickedPoint: { x: 5, y: 100, z: 10 } }),
      } as any;
      const mockMesh = {} as any;

      const height = await sampleTerrainHeight(mockScene, mockMesh, 5, 10);
      expect(height).toBe(100);
      expect(mockScene.pickWithRay).toHaveBeenCalledTimes(2);
    });

    it('passes correct predicate that matches only the terrain mesh', async () => {
      const terrainMesh = { id: 'terrain' } as any;
      const otherMesh = { id: 'other' } as any;
      let capturedPredicate: ((mesh: any) => boolean) | undefined;

      const mockScene = {
        pickWithRay: vi.fn().mockImplementation((_ray: any, predicate: any) => {
          capturedPredicate = predicate;
          return { hit: true, pickedPoint: { x: 0, y: 5, z: 0 } };
        }),
      } as any;

      await sampleTerrainHeight(mockScene, terrainMesh, 0, 0);

      expect(capturedPredicate).toBeDefined();
      expect(capturedPredicate!(terrainMesh)).toBe(true);
      expect(capturedPredicate!(otherMesh)).toBe(false);
    });
  });

  describe('generateTransformMatrices', () => {
    it('produces a Float32Array of length positions.length * 16', async () => {
      const positions = [
        { x: 10, y: 5, z: 20 },
        { x: 30, y: 8, z: 40 },
        { x: 50, y: 2, z: 60 },
      ];
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG };
      const rng = createPRNG(42);

      const matrices = await generateTransformMatrices(positions, config, rng);

      expect(matrices).toBeInstanceOf(Float32Array);
      expect(matrices.length).toBe(positions.length * 16);
    });

    it('produces all finite values', async () => {
      const positions = [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 50, z: 200 },
      ];
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG };
      const rng = createPRNG(7);

      const matrices = await generateTransformMatrices(positions, config, rng);

      for (let i = 0; i < matrices.length; i++) {
        expect(isFinite(matrices[i])).toBe(true);
      }
    });

    it('encodes translation in the correct matrix positions', async () => {
      const positions = [{ x: 10, y: 20, z: 30 }];
      // Disable rotation and use scale=1 to isolate translation
      const config: ScatterConfig = {
        ...DEFAULT_SCATTER_CONFIG,
        randomRotation: false,
        minScale: 1,
        maxScale: 1,
      };
      const rng = createPRNG(42);

      const matrices = await generateTransformMatrices(positions, config, rng);

      // Babylon.js uses column-major matrices
      // Translation is at indices 12, 13, 14 (column 3, rows 0-2)
      expect(matrices[12]).toBe(10); // x
      expect(matrices[13]).toBe(20); // y
      expect(matrices[14]).toBe(30); // z
    });

    it('applies uniform scale correctly', async () => {
      const positions = [{ x: 0, y: 0, z: 0 }];
      // Fixed scale (min=max=2), no rotation
      const config: ScatterConfig = {
        ...DEFAULT_SCATTER_CONFIG,
        randomRotation: false,
        minScale: 2,
        maxScale: 2,
      };
      const rng = createPRNG(42);

      const matrices = await generateTransformMatrices(positions, config, rng);

      // With no rotation and uniform scale=2, diagonal should be 2
      // Column-major: m[0]=sx, m[5]=sy, m[10]=sz
      expect(matrices[0]).toBe(2);  // scale X
      expect(matrices[5]).toBe(2);  // scale Y
      expect(matrices[10]).toBe(2); // scale Z
    });

    it('applies identity rotation when randomRotation is disabled', async () => {
      const positions = [{ x: 5, y: 10, z: 15 }];
      const config: ScatterConfig = {
        ...DEFAULT_SCATTER_CONFIG,
        randomRotation: false,
        minScale: 1,
        maxScale: 1,
      };
      const rng = createPRNG(42);

      const matrices = await generateTransformMatrices(positions, config, rng);

      // Identity rotation + scale 1 means diagonal is 1, off-diagonals are 0
      expect(matrices[0]).toBe(1);  // m00
      expect(matrices[1]).toBe(0);  // m01
      expect(matrices[2]).toBe(0);  // m02
      expect(matrices[4]).toBe(0);  // m10
      expect(matrices[5]).toBe(1);  // m11
      expect(matrices[6]).toBe(0);  // m12
      expect(matrices[8]).toBe(0);  // m20
      expect(matrices[9]).toBe(0);  // m21
      expect(matrices[10]).toBe(1); // m22
    });

    it('is deterministic with the same PRNG seed', async () => {
      const positions = [
        { x: 10, y: 5, z: 20 },
        { x: 30, y: 8, z: 40 },
      ];
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG };

      const matrices1 = await generateTransformMatrices(positions, config, createPRNG(42));
      const matrices2 = await generateTransformMatrices(positions, config, createPRNG(42));

      expect(matrices1).toEqual(matrices2);
    });

    it('returns empty buffer for zero positions', async () => {
      const positions: Array<{ x: number; y: number; z: number }> = [];
      const config: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG };
      const rng = createPRNG(42);

      const matrices = await generateTransformMatrices(positions, config, rng);

      expect(matrices.length).toBe(0);
    });
  });

  describe('validateMatrixBuffer', () => {
    it('returns true for a buffer with all finite values', () => {
      const buffer = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 10, 15, 1]);
      expect(validateMatrixBuffer(buffer)).toBe(true);
    });

    it('returns false when buffer contains NaN', () => {
      const buffer = new Float32Array([1, 0, 0, 0, 0, NaN, 0, 0, 0, 0, 1, 0, 5, 10, 15, 1]);
      expect(validateMatrixBuffer(buffer)).toBe(false);
    });

    it('returns false when buffer contains Infinity', () => {
      const buffer = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, Infinity, 0, 5, 10, 15, 1]);
      expect(validateMatrixBuffer(buffer)).toBe(false);
    });

    it('returns false when buffer contains -Infinity', () => {
      const buffer = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, -Infinity, 0, 1, 0, 5, 10, 15, 1]);
      expect(validateMatrixBuffer(buffer)).toBe(false);
    });

    it('returns true for an empty buffer', () => {
      const buffer = new Float32Array(0);
      expect(validateMatrixBuffer(buffer)).toBe(true);
    });
  });
});
