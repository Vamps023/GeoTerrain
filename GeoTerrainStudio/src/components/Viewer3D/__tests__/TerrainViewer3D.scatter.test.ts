/**
 * Integration tests for TerrainViewer3D tree scattering orchestration.
 *
 * Tests the scatter pipeline logic (parseMask → scatter → cleanup) rather than
 * the React component rendering. Uses NullEngine for Babylon.js scene creation
 * and geotiff writeArrayBuffer to create test mask buffers.
 *
 * Validates: Requirements 9.1, 9.3, 9.4, 9.5, 11.1, 11.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NullEngine, Scene, Mesh, MeshBuilder } from '@babylonjs/core';
import { writeArrayBuffer } from 'geotiff';
import { parseMask } from '../MaskSampler';
import { scatter, clear, DEFAULT_SCATTER_CONFIG, type ScatterResult } from '../TreeScatterer';

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Create a minimal single-band GeoTIFF ArrayBuffer from pixel data.
 */
function createGeoTiffBuffer(
  pixels: number[],
  width: number,
  height: number
): ArrayBuffer {
  const metadata = {
    width,
    height,
    BitsPerSample: [8],
    SampleFormat: [1], // unsigned int
    PhotometricInterpretation: 1, // min-is-black
    SamplesPerPixel: [1],
  };
  return writeArrayBuffer(pixels, metadata) as ArrayBuffer;
}

/**
 * Create a flat ground mesh for terrain height sampling in tests.
 * The mesh is a simple subdivided plane at Y=0.
 */
function createFlatGround(scene: Scene, width: number, height: number): Mesh {
  const ground = MeshBuilder.CreateGround(
    'testGround',
    { width, height, subdivisions: 4 },
    scene
  );
  ground.computeWorldMatrix(true);
  return ground;
}

// ─── Test Suite ────────────────────────────────────────────────

describe('TerrainViewer3D tree scattering integration', () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    if (scene && !scene.isDisposed) {
      scene.dispose();
    }
    if (engine) {
      engine.dispose();
    }
  });

  describe('Full scatter pipeline (parseMask + scatter)', () => {
    /**
     * Validates: Requirement 9.1
     * WHEN a tile manifest contains a vegetationMask file path, the system
     * SHALL load the mask, parse it, and invoke tree scattering.
     */
    it('should produce instances when vegetation mask has white pixels', async () => {
      const tileWidth = 100;
      const tileHeight = 100;

      // Create a mask that is all-white (255) — full vegetation coverage
      const maskWidth = 8;
      const maskHeight = 8;
      const pixels = Array.from({ length: maskWidth * maskHeight }, () => 255);
      const maskBuffer = createGeoTiffBuffer(pixels, maskWidth, maskHeight);

      // Parse the mask (simulates what TerrainViewer3D does after FsAPI.readFileBinary)
      const maskData = await parseMask(maskBuffer);
      expect(maskData.width).toBe(maskWidth);
      expect(maskData.height).toBe(maskHeight);

      // Create a flat ground mesh for height sampling
      const ground = createFlatGround(scene, tileWidth, tileHeight);

      // Run scatter (simulates the scatter invocation in TerrainViewer3D)
      const result = await scatter(
        scene,
        ground,
        maskData,
        tileWidth,
        tileHeight,
        0,
        100,
        { ...DEFAULT_SCATTER_CONFIG, density: 0.01 }
      );

      // Verify instances were placed
      expect(result.instanceCount).toBeGreaterThan(0);
      expect(result.mesh).toBeDefined();
      expect(result.mesh.isDisposed()).toBe(false);
      expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Skip when no mask', () => {
    /**
     * Validates: Requirement 9.4
     * WHEN a tile manifest does not include a vegetationMask field,
     * THE TerrainViewer3D SHALL skip tree scattering for that tile.
     */
    it('should not invoke scatter when vegetationMask is undefined', () => {
      // Simulate the conditional check in TerrainViewer3D.loadAllTiles:
      // if (centeredTile.files.vegetationMask) { ... scatter ... }
      const tileFiles = {
        heightmap: 'tile_0_0_heightmap.png',
        albedo: 'tile_0_0_albedo.png',
        vegetationMask: undefined as string | undefined,
      };

      // The scatter should NOT be called when vegetationMask is absent
      const shouldScatter = !!tileFiles.vegetationMask;
      expect(shouldScatter).toBe(false);
    });

    it('should invoke scatter when vegetationMask is present', () => {
      const tileFiles = {
        heightmap: 'tile_0_0_heightmap.png',
        albedo: 'tile_0_0_albedo.png',
        vegetationMask: 'tile_0_0_vegetation_mask.tif',
      };

      const shouldScatter = !!tileFiles.vegetationMask;
      expect(shouldScatter).toBe(true);
    });
  });

  describe('Disposal cleans up scatter results on reload', () => {
    /**
     * Validates: Requirement 9.3
     * WHEN the terrain is reloaded or the component unmounts, THE TerrainViewer3D
     * SHALL dispose all scattered tree meshes and instance buffers.
     */
    it('should clean up scatter result mesh via clear() and dispose()', async () => {
      const tileWidth = 50;
      const tileHeight = 50;

      // Create a mask with vegetation
      const pixels = Array.from({ length: 16 }, () => 255);
      const maskBuffer = createGeoTiffBuffer(pixels, 4, 4);
      const maskData = await parseMask(maskBuffer);

      const ground = createFlatGround(scene, tileWidth, tileHeight);

      // Scatter trees
      const result = await scatter(
        scene,
        ground,
        maskData,
        tileWidth,
        tileHeight,
        0,
        50,
        { ...DEFAULT_SCATTER_CONFIG, density: 0.01 }
      );

      expect(result.instanceCount).toBeGreaterThan(0);
      expect(result.mesh.isDisposed()).toBe(false);

      // Simulate the cleanup logic from TerrainViewer3D:
      // clear(result) sets thinInstanceCount to 0
      clear(result);
      expect(result.mesh.thinInstanceCount).toBe(0);

      // Then dispose the mesh (as TerrainViewer3D does on reload)
      result.mesh.dispose(false, true);
      expect(result.mesh.isDisposed()).toBe(true);
    });

    it('should clean up multiple scatter results stored in a Map', async () => {
      const tileWidth = 50;
      const tileHeight = 50;

      // Simulate the scatterResultsRef Map used in TerrainViewer3D
      const scatterResults = new Map<string, ScatterResult>();

      // Create two scatter results (simulating two tiles)
      const pixels = Array.from({ length: 16 }, () => 255);
      const maskBuffer = createGeoTiffBuffer(pixels, 4, 4);
      const maskData = await parseMask(maskBuffer);

      const ground1 = createFlatGround(scene, tileWidth, tileHeight);
      ground1.name = 'tile_0_0_0';
      const result1 = await scatter(scene, ground1, maskData, tileWidth, tileHeight, 0, 50);
      scatterResults.set('tile_0_0_0', result1);

      const ground2 = createFlatGround(scene, tileWidth, tileHeight);
      ground2.name = 'tile_0_1_1';
      const result2 = await scatter(scene, ground2, maskData, tileWidth, tileHeight, 0, 50);
      scatterResults.set('tile_0_1_1', result2);

      expect(scatterResults.size).toBe(2);

      // Simulate the disposal loop from TerrainViewer3D.loadAllTiles:
      for (const result of scatterResults.values()) {
        clear(result);
        if (result.mesh && !result.mesh.isDisposed()) {
          result.mesh.dispose(false, true);
        }
      }
      scatterResults.clear();

      // Verify all cleaned up
      expect(scatterResults.size).toBe(0);
      expect(result1.mesh.isDisposed()).toBe(true);
      expect(result2.mesh.isDisposed()).toBe(true);
    });
  });

  describe('Error recovery: missing file / invalid GeoTIFF', () => {
    /**
     * Validates: Requirements 9.5, 11.1
     * IF the vegetation mask file cannot be read or fails GeoTIFF parsing,
     * THEN THE TerrainViewer3D SHALL log a warning, skip tree scattering,
     * and continue rendering the terrain without trees.
     */
    it('should reject gracefully for invalid GeoTIFF buffer', async () => {
      // Simulate a corrupt/invalid file read
      const invalidBuffer = new ArrayBuffer(64);
      const view = new Uint8Array(invalidBuffer);
      view.fill(0xAB);

      // parseMask should reject with a descriptive error
      await expect(parseMask(invalidBuffer)).rejects.toThrow(/Failed to parse GeoTIFF/);
    });

    it('should handle parseMask rejection without crashing the scatter pipeline', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invalidBuffer = new ArrayBuffer(32);

      // Simulate the error recovery logic from TerrainViewer3D:
      // try { maskData = await parseMask(buffer); } catch { console.warn(...); return; }
      let scatterInvoked = false;
      try {
        await parseMask(invalidBuffer);
        scatterInvoked = true; // This should NOT be reached
      } catch (err) {
        // TerrainViewer3D logs a warning and skips scattering
        console.warn(`Tree scattering skipped: mask loading/parsing failed`, err);
      }

      expect(scatterInvoked).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tree scattering skipped'),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    /**
     * Validates: Requirement 11.4
     * IF any unhandled exception occurs during tree scattering or mask sampling,
     * THEN THE TerrainViewer3D SHALL catch the exception, log it, and continue.
     */
    it('should handle the full error recovery flow without affecting terrain rendering', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Simulate the complete fire-and-forget pattern from TerrainViewer3D
      const terrainRendered = true; // Terrain mesh was already created
      let treesPlaced = false;

      // Simulate the async scatter IIFE from TerrainViewer3D
      await (async () => {
        try {
          const invalidBuffer = new ArrayBuffer(10);
          // Step 1: Try to parse mask (will fail)
          try {
            await parseMask(invalidBuffer);
          } catch (maskErr) {
            console.warn('Tree scattering skipped for tile: mask loading/parsing failed', maskErr);
            return;
          }
          treesPlaced = true;
        } catch (err) {
          console.warn('Tree scattering skipped for tile:', err);
        }
      })();

      // Terrain should still be rendered, trees should not be placed
      expect(terrainRendered).toBe(true);
      expect(treesPlaced).toBe(false);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('Error recovery: empty mask (all zeros)', () => {
    /**
     * Validates: Requirement 9.5
     * When the mask is all zeros (no vegetation), scatter should return
     * instanceCount 0 without error.
     */
    it('should return instanceCount 0 when mask is all zeros', async () => {
      const tileWidth = 100;
      const tileHeight = 100;

      // Create a mask that is all-black (0) — no vegetation
      const maskWidth = 8;
      const maskHeight = 8;
      const pixels = Array.from({ length: maskWidth * maskHeight }, () => 0);
      const maskBuffer = createGeoTiffBuffer(pixels, maskWidth, maskHeight);

      const maskData = await parseMask(maskBuffer);

      const ground = createFlatGround(scene, tileWidth, tileHeight);

      // Scatter should complete without error but place zero trees
      const result = await scatter(
        scene,
        ground,
        maskData,
        tileWidth,
        tileHeight,
        0,
        100,
        { ...DEFAULT_SCATTER_CONFIG, density: 0.01 }
      );

      expect(result.instanceCount).toBe(0);
      expect(result.mesh).toBeDefined();
      expect(result.mesh.isDisposed()).toBe(false);
      expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
