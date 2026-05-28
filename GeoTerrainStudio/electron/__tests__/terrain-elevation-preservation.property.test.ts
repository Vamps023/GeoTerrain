/**
 * Preservation Property Tests: Flat Terrain Rendering and Extraction Logic
 *
 * Feature: building-road-3d-extraction (bugfix)
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 4.2, 4.5**
 *
 * These tests capture the EXISTING correct behavior on UNFIXED code.
 * They MUST PASS on unfixed code to confirm baseline behavior to preserve.
 *
 * Preservation scope:
 *   - Buildings on flat terrain (elevationMin=0, elevationMax=0): base at Y=0 + minLevelOffset + height
 *   - Roads on flat terrain without bridge tags: all vertices at Y=elevationOffset (0.1)
 *   - extractBuildings() produces correct height/floors/minLevel/roofShape/footprint
 *   - extractRoads() produces correct width/surface/highway/centerline
 *   - geoToLocal() produces correct local-space positions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Mock Babylon.js ───────────────────────────────────────────

interface MockMeshData {
  name: string;
  position: { x: number; y: number; z: number };
  material: unknown;
}

let createdMeshes: MockMeshData[] = [];
let ribbonPaths: Array<Array<{ x: number; y: number; z: number }[]>> = [];

vi.mock('@babylonjs/core', () => {
  class MockVector3 {
    x: number; y: number; z: number;
    constructor(x: number, y: number, z: number) {
      this.x = x; this.y = y; this.z = z;
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
    r: number; g: number; b: number;
    constructor(r: number, g: number, b: number) {
      this.r = r; this.g = g; this.b = b;
    }
  }

  const MockMeshBuilder = {
    CreateRibbon: (name: string, options: { pathArray: Array<MockVector3[]> }) => {
      const mesh = new MockMesh(name);
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
import {
  extractBuildings,
  extractRoads,
  estimateBuildingHeight,
  estimateRoadWidth,
} from '../osm-3d-extractor';
import type { OverpassFeature } from '../overpass-client';

// ─── Test Helpers ──────────────────────────────────────────────

function makeFlatTileContext(overrides: Partial<TileContext> = {}): TileContext {
  return {
    scene: {} as any,
    tileBounds: { west: 2.0, south: 48.0, east: 2.01, north: 48.01 },
    tileWidthM: 700,
    tileHeightM: 1100,
    tileOffsetX: 0,
    tileOffsetZ: 0,
    terrainMesh: {} as any, // terrain mesh present but flat
    elevationMin: 0,
    elevationMax: 0,
    heightExaggeration: 1.0,
    ...overrides,
  };
}

const defaultOptions: MeshBuilder3DOptions = {
  roadElevationOffset: 0.1,
};

// ─── Arbitraries ───────────────────────────────────────────────

/** Building footprint within tile bounds (≥4 points, closed polygon) */
const arbBuildingFootprint = fc.array(
  fc.record({
    lat: fc.double({ min: 48.002, max: 48.008, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: 2.002, max: 2.008, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 3, maxLength: 8 }
).map(pts => [...pts, pts[0]]);

/** Building height in valid range */
const arbBuildingHeight = fc.double({ min: 3, max: 50, noNaN: true, noDefaultInfinity: true });

/** Building minLevel */
const arbMinLevel = fc.integer({ min: 0, max: 5 });

/** Road centerline within tile bounds (≥2 points) */
const arbRoadCenterline = fc.array(
  fc.record({
    lat: fc.double({ min: 48.002, max: 48.008, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: 2.002, max: 2.008, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 2, maxLength: 6 }
);

/** Road width */
const arbRoadWidth = fc.double({ min: 2, max: 12, noNaN: true, noDefaultInfinity: true });

/** Valid height tag string */
const arbValidHeight = fc.double({ min: 0.1, max: 1000, noNaN: true, noDefaultInfinity: true })
  .map(v => String(v));

/** Valid building:levels tag string */
const arbValidLevels = fc.integer({ min: 1, max: 200 }).map(v => String(v));

/** Default building height */
const arbDefaultHeight = fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true });

/** Valid width tag string */
const arbValidWidth = fc.double({ min: 0.5, max: 50, noNaN: true, noDefaultInfinity: true })
  .map(v => String(v));

/** Valid lanes tag string */
const arbValidLanes = fc.integer({ min: 1, max: 20 }).map(v => String(v));

/** Known highway classifications */
const arbKnownHighway = fc.constantFrom(
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'service', 'footway', 'path', 'cycleway'
);

/** Surface tag values */
const arbSurface = fc.constantFrom(
  'asphalt', 'concrete', 'gravel', 'dirt', 'paved', 'unpaved', ''
);

/** Valid roof shapes */
const arbValidRoofShape = fc.constantFrom('flat', 'gabled', 'hipped', 'pyramidal');

/** Coordinate within valid geo range */
const arbLat = fc.double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true });
const arbLon = fc.double({ min: -179, max: 179, noNaN: true, noDefaultInfinity: true });

/** Valid polygon geometry for extraction (≥4 points) */
const arbValidGeometry = fc.array(
  fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 4, maxLength: 12 }
);

/** Valid road geometry for extraction (≥2 points) */
const arbValidRoadGeometry = fc.array(
  fc.record({
    lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
    lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 2, maxLength: 10 }
);

// ─── Tests ─────────────────────────────────────────────────────

describe('Property 2: Preservation - Flat Terrain Rendering', () => {
  beforeEach(() => {
    createdMeshes = [];
    ribbonPaths = [];
  });

  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For all buildings on flat terrain (elevationMin=0, elevationMax=0, no bridge/layer tags):
   * Building mesh position.y = minLevelOffset + height (terrain elevation is 0)
   */
  it('Buildings on flat terrain: position.y = minLevelOffset + height', () => {
    fc.assert(
      fc.property(
        arbBuildingFootprint,
        arbBuildingHeight,
        arbMinLevel,
        (footprint, height, minLevel) => {
          createdMeshes = [];
          ribbonPaths = [];

          const context = makeFlatTileContext();

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

          // On flat terrain (elevation=0), position.y = 0 + minLevelOffset + height
          expect(mesh.position.y).toBeCloseTo(minLevelOffset + height, 5);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.3, 3.4**
   *
   * For all roads on flat terrain without bridge tags:
   * All road vertices have Y = elevationOffset (0.1)
   */
  it('Roads on flat terrain without bridge tags: all vertices at Y=elevationOffset', () => {
    fc.assert(
      fc.property(
        arbRoadCenterline,
        arbRoadWidth,
        arbSurface,
        arbKnownHighway,
        (centerline, width, surface, highway) => {
          createdMeshes = [];
          ribbonPaths = [];

          const context = makeFlatTileContext();

          const road: RoadGeometry = {
            centerline,
            width,
            surface,
            highway,
            tags: { highway, surface },
          };

          createRoadMeshes([road], context, defaultOptions);

          expect(ribbonPaths.length).toBeGreaterThanOrEqual(1);

          // All vertices should be at Y = elevationOffset (0.1)
          const paths = ribbonPaths[0];
          for (const path of paths) {
            for (const vertex of path) {
              expect(vertex.y).toBeCloseTo(
                defaultOptions.roadElevationOffset, 5
              );
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.5**
   *
   * For all roads on flat terrain without terrain mesh:
   * All road vertices have Y = 0.1 (hardcoded fallback)
   */
  it('Roads without terrain mesh: all vertices at Y=0.1', () => {
    fc.assert(
      fc.property(
        arbRoadCenterline,
        arbRoadWidth,
        (centerline, width) => {
          createdMeshes = [];
          ribbonPaths = [];

          // No terrain mesh
          const context = makeFlatTileContext({ terrainMesh: undefined });

          const road: RoadGeometry = {
            centerline,
            width,
            surface: 'asphalt',
            highway: 'residential',
            tags: { highway: 'residential', surface: 'asphalt' },
          };

          createRoadMeshes([road], context, defaultOptions);

          expect(ribbonPaths.length).toBeGreaterThanOrEqual(1);

          const paths = ribbonPaths[0];
          for (const path of paths) {
            for (const vertex of path) {
              expect(vertex.y).toBeCloseTo(0.1, 5);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('Property 2: Preservation - Extraction Logic', () => {
  /**
   * **Validates: Requirements 3.1, 3.2, 3.7**
   *
   * For all building features: extractBuildings produces identical
   * height, floors, minLevel, roofShape, footprint as the current code.
   */
  it('extractBuildings: height estimation priority chain preserved', () => {
    const arbBuildingTags = fc.oneof(
      // Case 1: valid height tag
      arbValidHeight.map(h => ({ building: 'yes', height: h })),
      // Case 2: valid levels tag (no height)
      arbValidLevels.map(l => ({ building: 'yes', 'building:levels': l })),
      // Case 3: both height and levels
      fc.tuple(arbValidHeight, arbValidLevels).map(([h, l]) => ({
        building: 'yes', height: h, 'building:levels': l,
      })),
      // Case 4: no height or levels (default)
      fc.constant({ building: 'yes' } as Record<string, string>)
    );

    fc.assert(
      fc.property(
        arbBuildingTags,
        arbValidGeometry,
        arbDefaultHeight,
        (tags, geometry, defaultHeight) => {
          const feature: OverpassFeature = {
            type: 'way', id: 1, geometry, tags,
          };
          const result = extractBuildings([feature], defaultHeight);
          expect(result).toHaveLength(1);

          const { height, floors } = estimateBuildingHeight(tags, defaultHeight);
          expect(result[0].height).toBe(height);
          expect(result[0].floors).toBe(floors);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For all building features: extractBuildings preserves roofShape and minLevel.
   */
  it('extractBuildings: roofShape and minLevel extraction preserved', () => {
    fc.assert(
      fc.property(
        arbValidGeometry,
        arbValidRoofShape,
        fc.integer({ min: 0, max: 200 }),
        arbDefaultHeight,
        (geometry, roofShape, minLevel, defaultHeight) => {
          const tags: Record<string, string> = {
            building: 'yes',
            'roof:shape': roofShape,
            'building:min_level': String(minLevel),
          };
          const feature: OverpassFeature = {
            type: 'way', id: 1, geometry, tags,
          };
          const result = extractBuildings([feature], defaultHeight);
          expect(result).toHaveLength(1);
          expect(result[0].roofShape).toBe(roofShape);
          expect(result[0].minLevel).toBe(minLevel);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * For all building features: extractBuildings preserves footprint coordinates.
   */
  it('extractBuildings: footprint coordinates preserved in order', () => {
    fc.assert(
      fc.property(
        arbValidGeometry,
        arbDefaultHeight,
        (geometry, defaultHeight) => {
          const feature: OverpassFeature = {
            type: 'way', id: 1, geometry,
            tags: { building: 'yes' },
          };
          const result = extractBuildings([feature], defaultHeight);
          expect(result).toHaveLength(1);
          expect(result[0].footprint).toHaveLength(geometry.length);
          for (let i = 0; i < geometry.length; i++) {
            expect(result[0].footprint[i].lat).toBe(geometry[i].lat);
            expect(result[0].footprint[i].lon).toBe(geometry[i].lon);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.3, 3.4**
   *
   * For all road features: extractRoads produces identical width, surface,
   * highway, centerline as the current code.
   */
  it('extractRoads: width estimation priority chain preserved', () => {
    const arbRoadTags = fc.oneof(
      // Case 1: valid width tag
      fc.tuple(arbValidWidth, arbKnownHighway).map(([w, h]) => ({
        highway: h, width: w,
      })),
      // Case 2: valid lanes tag (no width)
      fc.tuple(arbValidLanes, arbKnownHighway).map(([l, h]) => ({
        highway: h, lanes: l,
      })),
      // Case 3: classification only
      arbKnownHighway.map(h => ({ highway: h } as Record<string, string>))
    );

    fc.assert(
      fc.property(
        arbRoadTags,
        arbValidRoadGeometry,
        (tags, geometry) => {
          const feature: OverpassFeature = {
            type: 'way', id: 1, geometry, tags,
          };
          const result = extractRoads([feature]);
          expect(result).toHaveLength(1);

          const expectedWidth = estimateRoadWidth(tags);
          expect(result[0].width).toBe(expectedWidth);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4, 3.5**
   *
   * For all road features: extractRoads preserves surface, highway, and centerline.
   */
  it('extractRoads: surface, highway, and centerline preserved', () => {
    fc.assert(
      fc.property(
        arbValidRoadGeometry,
        arbSurface,
        arbKnownHighway,
        (geometry, surface, highway) => {
          const tags: Record<string, string> = { highway, surface };
          const feature: OverpassFeature = {
            type: 'way', id: 1, geometry, tags,
          };
          const result = extractRoads([feature]);
          expect(result).toHaveLength(1);
          expect(result[0].surface).toBe(surface);
          expect(result[0].highway).toBe(highway);
          expect(result[0].centerline).toHaveLength(geometry.length);
          for (let i = 0; i < geometry.length; i++) {
            expect(result[0].centerline[i].lat).toBe(geometry[i].lat);
            expect(result[0].centerline[i].lon).toBe(geometry[i].lon);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.7**
   *
   * Buildings with fewer than 4 footprint points are excluded.
   * Roads with fewer than 2 centerline points are excluded.
   */
  it('extractBuildings: excludes buildings with < 4 footprint points', () => {
    const arbShortGeometry = fc.array(
      fc.record({
        lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
        lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 0, maxLength: 3 }
    );

    fc.assert(
      fc.property(arbShortGeometry, arbDefaultHeight, (geometry, defaultHeight) => {
        const feature: OverpassFeature = {
          type: 'way', id: 1, geometry,
          tags: { building: 'yes' },
        };
        const result = extractBuildings([feature], defaultHeight);
        expect(result).toHaveLength(0);
      }),
      { numRuns: 50 }
    );
  });

  it('extractRoads: excludes roads with < 2 centerline points', () => {
    const arbShortGeometry = fc.array(
      fc.record({
        lat: fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
        lon: fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 0, maxLength: 1 }
    );

    fc.assert(
      fc.property(arbShortGeometry, (geometry) => {
        const feature: OverpassFeature = {
          type: 'way', id: 1, geometry,
          tags: { highway: 'residential' },
        };
        const result = extractRoads([feature]);
        expect(result).toHaveLength(0);
      }),
      { numRuns: 50 }
    );
  });
});

describe('Property 2: Preservation - geoToLocal Coordinate Conversion', () => {
  /**
   * **Validates: Requirements 4.2, 4.5**
   *
   * For all valid coordinate inputs: geoToLocal produces identical local-space positions.
   * The formula is:
   *   x = ((lon - west) / (east - west)) * tileWidthM - tileWidthM / 2
   *   z = ((lat - south) / (north - south)) * tileHeightM - tileHeightM / 2
   */
  it('geoToLocal: produces correct local-space positions for all valid inputs', () => {
    const arbTileBounds = fc.record({
      west: fc.double({ min: -179, max: 0, noNaN: true, noDefaultInfinity: true }),
      south: fc.double({ min: -85, max: 0, noNaN: true, noDefaultInfinity: true }),
    }).chain(({ west, south }) => fc.record({
      west: fc.constant(west),
      south: fc.constant(south),
      east: fc.double({ min: west + 0.001, max: west + 1, noNaN: true, noDefaultInfinity: true }),
      north: fc.double({ min: south + 0.001, max: south + 1, noNaN: true, noDefaultInfinity: true }),
    }));

    const arbTileSize = fc.record({
      tileWidthM: fc.double({ min: 100, max: 10000, noNaN: true, noDefaultInfinity: true }),
      tileHeightM: fc.double({ min: 100, max: 10000, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(
        arbTileBounds,
        arbTileSize,
        arbLat,
        arbLon,
        (bounds, tileSize, lat, lon) => {
          const result = geoToLocal(
            lat, lon, bounds, tileSize.tileWidthM, tileSize.tileHeightM
          );

          // Expected computation
          const expectedX =
            ((lon - bounds.west) / (bounds.east - bounds.west)) * tileSize.tileWidthM -
            tileSize.tileWidthM / 2;
          const expectedZ =
            ((lat - bounds.south) / (bounds.north - bounds.south)) * tileSize.tileHeightM -
            tileSize.tileHeightM / 2;

          expect(result.x).toBeCloseTo(expectedX, 8);
          expect(result.z).toBeCloseTo(expectedZ, 8);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.2, 4.5**
   *
   * geoToLocal: tile center maps to (0, 0) in local space.
   */
  it('geoToLocal: tile center maps to origin (0, 0)', () => {
    const arbTileBounds = fc.record({
      west: fc.double({ min: -179, max: 0, noNaN: true, noDefaultInfinity: true }),
      south: fc.double({ min: -85, max: 0, noNaN: true, noDefaultInfinity: true }),
    }).chain(({ west, south }) => fc.record({
      west: fc.constant(west),
      south: fc.constant(south),
      east: fc.double({ min: west + 0.001, max: west + 1, noNaN: true, noDefaultInfinity: true }),
      north: fc.double({ min: south + 0.001, max: south + 1, noNaN: true, noDefaultInfinity: true }),
    }));

    const arbTileSize = fc.record({
      tileWidthM: fc.double({ min: 100, max: 10000, noNaN: true, noDefaultInfinity: true }),
      tileHeightM: fc.double({ min: 100, max: 10000, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(
        arbTileBounds,
        arbTileSize,
        (bounds, tileSize) => {
          const centerLat = (bounds.south + bounds.north) / 2;
          const centerLon = (bounds.west + bounds.east) / 2;

          const result = geoToLocal(
            centerLat, centerLon, bounds, tileSize.tileWidthM, tileSize.tileHeightM
          );

          expect(result.x).toBeCloseTo(0, 5);
          expect(result.z).toBeCloseTo(0, 5);
        }
      ),
      { numRuns: 50 }
    );
  });
});
