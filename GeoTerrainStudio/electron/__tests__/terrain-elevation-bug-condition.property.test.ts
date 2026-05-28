/**
 * Bug Condition Exploration Property Test: Terrain Elevation Sampling and Bridge Elevation
 *
 * Feature: building-road-3d-extraction (bugfix)
 * **Validates: Requirements 3.6, 4.4**
 *
 * This test is EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT fix the test or the code when it fails.
 *
 * Bug Condition:
 *   isBugCondition(input) =
 *     (input.meshType == 'building' AND input.terrainMesh != undefined AND input.terrainHasElevation == true)
 *     OR (input.meshType == 'road' AND input.terrainMesh != undefined AND input.terrainHasElevation == true)
 *     OR (input.isBridge == true)
 *     OR (input.layerTag > 0)
 *
 * Expected Behavior (assertions for when fix is applied):
 *   - Building: position.y >= terrainElevationAtCentroid + minLevelOffset
 *   - Road (non-bridge): each vertex y == terrainElevationAtVertex + elevationOffset
 *   - Bridge/layer: each vertex y >= terrainElevationAtVertex + bridgeClearance * max(1, layerTag)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Mock Babylon.js ───────────────────────────────────────────
// We mock Babylon.js to isolate the mesh positioning logic from the 3D renderer.
// The mocks capture position assignments and ribbon path arrays so we can assert
// on the Y values computed by createBuildingMeshes and createRoadMeshes.

// Track created meshes and their positions
interface MockMeshData {
  name: string;
  position: { x: number; y: number; z: number };
  material: unknown;
}

let createdMeshes: MockMeshData[] = [];
let ribbonPaths: Array<Array<{ x: number; y: number; z: number }[]>> = [];

vi.mock('@babylonjs/core', () => {
  class MockVector3 {
    x: number;
    y: number;
    z: number;
    constructor(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
  }

  class MockMesh {
    name: string;
    position: { x: number; y: number; z: number };
    material: unknown;
    static DOUBLESIDE = 2;
    constructor(name: string) {
      this.name = name;
      this.position = { x: 0, y: 0, z: 0 };
      this.material = null;
    }
  }

  class MockStandardMaterial {
    diffuseColor: unknown;
    specularColor: unknown;
    constructor() {
      this.diffuseColor = null;
      this.specularColor = null;
    }
  }

  class MockColor3 {
    r: number;
    g: number;
    b: number;
    constructor(r: number, g: number, b: number) {
      this.r = r;
      this.g = g;
      this.b = b;
    }
  }

  const MockMeshBuilder = {
    CreateRibbon: (name: string, options: { pathArray: Array<MockVector3[]> }) => {
      const mesh = new MockMesh(name);
      // Capture the path arrays for Y-value inspection
      ribbonPaths.push(options.pathArray.map(path =>
        path.map(v => ({ x: v.x, y: v.y, z: v.z }))
      ));
      createdMeshes.push(mesh as unknown as MockMeshData);
      return mesh;
    },
  };

  return {
    Scene: class {},
    Mesh: MockMesh,
    MeshBuilder: MockMeshBuilder,
    Vector3: MockVector3,
    StandardMaterial: MockStandardMaterial,
    Color3: MockColor3,
  };
});

vi.mock('@babylonjs/core/Meshes/Builders/polygonBuilder', () => {
  return {
    ExtrudePolygon: (name: string, _options: unknown, _scene: unknown, _earcut: unknown) => {
      const mesh = {
        name,
        position: { x: 0, y: 0, z: 0 },
        material: null,
      };
      createdMeshes.push(mesh as MockMeshData);
      return mesh;
    },
  };
});

vi.mock('earcut', () => {
  return { default: () => [] };
});

// ─── Import after mocks ────────────────────────────────────────

import {
  createBuildingMeshes,
  createRoadMeshes,
  geoToLocal,
  type TileContext,
  type MeshBuilder3DOptions,
} from '../../src/components/Viewer3D/MeshBuilder3D';
import type { BuildingGeometry, RoadGeometry } from '../../src/types/terrain';

// ─── Test Helpers ──────────────────────────────────────────────

function makeTileContext(overrides: Partial<TileContext> = {}): TileContext {
  return {
    scene: {} as any,
    tileBounds: { west: 2.0, south: 48.0, east: 2.01, north: 48.01 },
    tileWidthM: 700,
    tileHeightM: 1100,
    tileOffsetX: 0,
    tileOffsetZ: 0,
    terrainMesh: {} as any, // non-undefined = terrain is available
    elevationMin: 50,
    elevationMax: 100,
    heightExaggeration: 1.0,
    ...overrides,
  };
}

const defaultOptions: MeshBuilder3DOptions = {
  roadElevationOffset: 0.1,
};

// ─── Arbitraries ───────────────────────────────────────────────

/** Arbitrary for terrain elevation range with non-zero values */
const arbElevationRange = fc.record({
  elevationMin: fc.double({ min: 10, max: 500, noNaN: true, noDefaultInfinity: true }),
  elevationMax: fc.double({ min: 501, max: 2000, noNaN: true, noDefaultInfinity: true }),
});

/** Arbitrary for a valid building footprint within tile bounds */
const arbBuildingFootprint = fc.array(
  fc.record({
    lat: fc.double({ min: 48.002, max: 48.008, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: 2.002, max: 2.008, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 3, maxLength: 8 }
).map(pts => [...pts, pts[0]]); // close polygon (≥4 points)

/** Arbitrary for building height */
const arbBuildingHeight = fc.double({ min: 3, max: 50, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for building minLevel */
const arbMinLevel = fc.integer({ min: 0, max: 5 });

/** Arbitrary for a valid road centerline within tile bounds */
const arbRoadCenterline = fc.array(
  fc.record({
    lat: fc.double({ min: 48.002, max: 48.008, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: 2.002, max: 2.008, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 2, maxLength: 6 }
);

/** Arbitrary for road width */
const arbRoadWidth = fc.double({ min: 2, max: 12, noNaN: true, noDefaultInfinity: true });

// ─── Tests ─────────────────────────────────────────────────────

describe('Property 1: Bug Condition - Terrain Elevation Sampling and Bridge Elevation', () => {
  beforeEach(() => {
    createdMeshes = [];
    ribbonPaths = [];
  });

  /**
   * **Validates: Requirements 3.6, 4.4**
   *
   * Bug Condition: Building on terrain with non-zero elevation.
   * Expected: building base position.y >= terrainElevation + minLevelOffset
   * Actual (unfixed): building position.y = minLevelOffset + height (ignores terrain)
   */
  it('Building on elevated terrain: position.y should account for terrain elevation', () => {
    fc.assert(
      fc.property(
        arbElevationRange,
        arbBuildingFootprint,
        arbBuildingHeight,
        arbMinLevel,
        (elevation, footprint, height, minLevel) => {
          // Reset state
          createdMeshes = [];
          ribbonPaths = [];

          const context = makeTileContext({
            elevationMin: elevation.elevationMin,
            elevationMax: elevation.elevationMax,
          });

          const building: BuildingGeometry = {
            footprint,
            height,
            floors: Math.max(1, Math.round(height / 3)),
            minLevel,
            tags: { building: 'yes' },
          };

          createBuildingMeshes([building], context);

          expect(createdMeshes.length).toBeGreaterThanOrEqual(1);

          const mesh = createdMeshes[0];
          const minLevelOffset = minLevel > 0 ? minLevel * 3.0 : 0;

          // The terrain has non-zero elevation. The building's Y position should
          // be at least terrainElevation + minLevelOffset.
          // With elevationMin >= 10, the terrain elevation at any point should be >= elevationMin.
          // Therefore position.y should be >= elevationMin + minLevelOffset + height
          // (since ExtrudePolygon places top at Y=0 and extrudes down, the mesh is positioned
          // so the base is at terrainElevation + minLevelOffset)
          expect(mesh.position.y).toBeGreaterThanOrEqual(
            elevation.elevationMin + minLevelOffset + height
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 3.6, 4.4**
   *
   * Bug Condition: Road on terrain with non-zero elevation.
   * Expected: road vertex Y values follow terrain surface (y >= elevationMin + elevationOffset)
   * Actual (unfixed): all road vertices at Y = 0.1 (elevationOffset)
   */
  it('Road on elevated terrain: vertex Y should follow terrain elevation', () => {
    fc.assert(
      fc.property(
        arbElevationRange,
        arbRoadCenterline,
        arbRoadWidth,
        (elevation, centerline, width) => {
          // Reset state
          createdMeshes = [];
          ribbonPaths = [];

          const context = makeTileContext({
            elevationMin: elevation.elevationMin,
            elevationMax: elevation.elevationMax,
          });

          const road: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'residential',
            layer: 0,
            tags: { highway: 'residential', surface: 'asphalt' },
          };

          createRoadMeshes([road], context, defaultOptions);

          expect(ribbonPaths.length).toBeGreaterThanOrEqual(1);

          // Check all vertices in the ribbon paths
          const paths = ribbonPaths[0];
          for (const path of paths) {
            for (const vertex of path) {
              // Each vertex Y should be at least elevationMin + elevationOffset
              // because the terrain has non-zero elevation everywhere
              expect(vertex.y).toBeGreaterThanOrEqual(
                elevation.elevationMin + defaultOptions.roadElevationOffset
              );
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 3.6, 4.4**
   *
   * Bug Condition: Road with bridge=yes tag.
   * Expected: bridge road vertices elevated above ground-level by bridgeClearance (5m)
   * Actual (unfixed): bridge-tagged roads render at same Y as non-bridge roads
   */
  it('Bridge-tagged road: vertex Y should be elevated above ground-level roads', () => {
    fc.assert(
      fc.property(
        arbRoadCenterline,
        arbRoadWidth,
        (centerline, width) => {
          // Reset state
          createdMeshes = [];
          ribbonPaths = [];

          // Use flat terrain (elevation=0) to isolate bridge elevation effect
          const context = makeTileContext({
            elevationMin: 0,
            elevationMax: 0,
          });

          const bridgeClearance = 5.0; // default bridge clearance height

          // Create a bridge road and a normal road with same centerline
          const bridgeRoad: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'primary',
            bridge: 'yes',
            layer: 0,
            tags: { highway: 'primary', surface: 'asphalt', bridge: 'yes' },
          };

          const normalRoad: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'primary',
            layer: 0,
            tags: { highway: 'primary', surface: 'asphalt' },
          };

          // Render normal road first
          createRoadMeshes([normalRoad], context, defaultOptions);
          const normalPaths = ribbonPaths[0];

          // Reset and render bridge road
          createdMeshes = [];
          ribbonPaths = [];
          createRoadMeshes([bridgeRoad], context, defaultOptions);
          const bridgePaths = ribbonPaths[0];

          // Bridge vertices should be elevated above normal road vertices
          // by at least bridgeClearance (5m)
          for (let pathIdx = 0; pathIdx < bridgePaths.length; pathIdx++) {
            for (let vertIdx = 0; vertIdx < bridgePaths[pathIdx].length; vertIdx++) {
              const bridgeY = bridgePaths[pathIdx][vertIdx].y;
              const normalY = normalPaths[pathIdx][vertIdx].y;
              expect(bridgeY).toBeGreaterThanOrEqual(normalY + bridgeClearance);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 3.6, 4.4**
   *
   * Bug Condition: Roads with layer=1 and layer=2 at same location.
   * Expected: different Y positions (layer * bridgeClearance)
   * Actual (unfixed): identical Y positions for all layers
   */
  it('Layered roads: layer=1 and layer=2 should have different Y positions', () => {
    fc.assert(
      fc.property(
        arbRoadCenterline,
        arbRoadWidth,
        (centerline, width) => {
          // Reset state
          createdMeshes = [];
          ribbonPaths = [];

          // Use flat terrain to isolate layer elevation effect
          const context = makeTileContext({
            elevationMin: 0,
            elevationMax: 0,
          });

          const layer1Road: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'motorway',
            layer: 1,
            tags: { highway: 'motorway', surface: 'asphalt', layer: '1' },
          };

          const layer2Road: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'motorway',
            layer: 2,
            tags: { highway: 'motorway', surface: 'asphalt', layer: '2' },
          };

          // Render layer 1 road
          createRoadMeshes([layer1Road], context, defaultOptions);
          const layer1Paths = ribbonPaths[0];

          // Reset and render layer 2 road
          createdMeshes = [];
          ribbonPaths = [];
          createRoadMeshes([layer2Road], context, defaultOptions);
          const layer2Paths = ribbonPaths[0];

          // Layer 2 vertices should be higher than layer 1 vertices
          for (let pathIdx = 0; pathIdx < layer2Paths.length; pathIdx++) {
            for (let vertIdx = 0; vertIdx < layer2Paths[pathIdx].length; vertIdx++) {
              const layer2Y = layer2Paths[pathIdx][vertIdx].y;
              const layer1Y = layer1Paths[pathIdx][vertIdx].y;
              expect(layer2Y).toBeGreaterThan(layer1Y);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
