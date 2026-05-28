import { describe, it, expect, afterEach } from 'vitest';
import { NullEngine, Scene } from '@babylonjs/core';
import { createTreeMesh, dispose, TreeMeshConfig } from '../TreeGeometry';

describe('TreeGeometry', () => {
  let engine: NullEngine;
  let scene: Scene;

  function setup() {
    engine = new NullEngine();
    scene = new Scene(engine);
  }

  afterEach(() => {
    if (scene && !scene.isDisposed) {
      scene.dispose();
    }
    if (engine) {
      engine.dispose();
    }
  });

  describe('createTreeMesh', () => {
    it('should produce a mesh with expected triangle count (~36)', () => {
      setup();
      const mesh = createTreeMesh(scene);

      // Default tessellation: trunk=6 (no caps), canopy=8 (bottom cap)
      // Babylon.js CreateCylinder produces:
      //   trunk (6 tessellation, no caps): 12 triangles
      //   canopy (8 tessellation, bottom cap): 24 triangles (16 side + 8 cap)
      // Total: 36 triangles — low-poly, suitable for 50k thin instances
      const indices = mesh.getIndices();
      expect(indices).not.toBeNull();
      const triangleCount = indices!.length / 3;
      expect(triangleCount).toBeGreaterThanOrEqual(20);
      expect(triangleCount).toBeLessThanOrEqual(50);
      expect(triangleCount).toBe(36);
    });

    it('should produce a mesh with reasonable vertex count', () => {
      setup();
      const mesh = createTreeMesh(scene);

      const vertexCount = mesh.getTotalVertices();
      // Trunk (6 tessellation, no caps): 14 vertices (7 top ring + 7 bottom ring, with seam)
      // Canopy (8 tessellation, bottom cap): ~18+ vertices
      // Merged mesh should have a reasonable total
      expect(vertexCount).toBeGreaterThan(0);
      expect(vertexCount).toBeLessThan(200); // sanity upper bound for low-poly tree
    });

    it('should have bounding box dimensions matching config', () => {
      setup();
      const config: Partial<TreeMeshConfig> = {
        trunkRadius: 0.3,
        trunkHeight: 3,
        canopyRadius: 2.5,
        canopyHeight: 5,
      };
      const mesh = createTreeMesh(scene, config);

      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      const min = bounds.minimumWorld;
      const max = bounds.maximumWorld;

      // Width (X extent) should be ~canopyRadius*2 = 5m
      const width = max.x - min.x;
      expect(width).toBeCloseTo(5.0, 0); // canopyRadius * 2

      // Height (Y extent) should be ~trunkHeight + canopyHeight = 8m
      const height = max.y - min.y;
      expect(height).toBeCloseTo(8.0, 0); // 3 + 5

      // Depth (Z extent) should be ~canopyRadius*2 = 5m
      const depth = max.z - min.z;
      expect(depth).toBeCloseTo(5.0, 0);
    });

    it('should have mesh origin at Y=0 (base of trunk)', () => {
      setup();
      const mesh = createTreeMesh(scene);

      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      const minY = bounds.minimumWorld.y;

      // The base of the trunk should be at Y=0 (or very close)
      expect(minY).toBeCloseTo(0, 1);
    });

    it('should have mesh named "treeBase"', () => {
      setup();
      const mesh = createTreeMesh(scene);
      expect(mesh.name).toBe('treeBase');
    });

    it('should respect custom config values', () => {
      setup();
      const config: Partial<TreeMeshConfig> = {
        trunkRadius: 0.5,
        trunkHeight: 4,
        canopyRadius: 3,
        canopyHeight: 6,
      };
      const mesh = createTreeMesh(scene, config);

      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      const min = bounds.minimumWorld;
      const max = bounds.maximumWorld;

      // Width should be ~canopyRadius*2 = 6m
      const width = max.x - min.x;
      expect(width).toBeCloseTo(6.0, 0);

      // Height should be ~trunkHeight + canopyHeight = 10m
      const height = max.y - min.y;
      expect(height).toBeCloseTo(10.0, 0);
    });
  });

  describe('dispose', () => {
    it('should dispose the mesh and its materials', () => {
      setup();
      const mesh = createTreeMesh(scene);

      // Mesh should be in the scene initially
      expect(scene.meshes.length).toBeGreaterThan(0);

      dispose(mesh);

      // After dispose, mesh should be removed from scene
      expect(mesh.isDisposed()).toBe(true);
    });

    it('should handle mesh without material gracefully', () => {
      setup();
      const mesh = createTreeMesh(scene);
      // Remove material before dispose
      mesh.material = null;

      // Should not throw
      expect(() => dispose(mesh)).not.toThrow();
      expect(mesh.isDisposed()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw error when scene is null', () => {
      expect(() => createTreeMesh(null as unknown as Scene)).toThrow(
        /scene is null/
      );
    });

    it('should throw error when scene is disposed', () => {
      setup();
      scene.dispose();

      expect(() => createTreeMesh(scene)).toThrow(/scene is.*disposed/);
    });
  });
});
