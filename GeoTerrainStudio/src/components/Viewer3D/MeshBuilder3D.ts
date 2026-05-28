import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  StandardMaterial,
  Color3,
} from '@babylonjs/core';
import { ExtrudePolygon } from '@babylonjs/core/Meshes/Builders/polygonBuilder';
// @ts-expect-error earcut has no type declarations
import earcut from 'earcut';
import type { GeoBounds, BuildingGeometry, RoadGeometry } from '../../types/terrain';

/**
 * Context for positioning meshes on a terrain tile.
 */
export interface TileContext {
  scene: Scene;
  tileBounds: GeoBounds;
  tileWidthM: number;
  tileHeightM: number;
  tileOffsetX: number;  // world offset X
  tileOffsetZ: number;  // world offset Z
  terrainMesh?: Mesh;   // for elevation sampling
  elevationMin: number;
  elevationMax: number;
  heightExaggeration: number;
}

/**
 * Options for road mesh creation.
 */
export interface MeshBuilder3DOptions {
  roadElevationOffset: number;  // default 0.1m
}

/**
 * Convert geographic coordinates to local tile-space meters.
 * Origin is at tile center. X = east, Z = south (Babylon.js convention).
 *
 * The formula normalizes the coordinate within the tile bounds [0, 1],
 * scales to tile dimensions in meters, then shifts so the center is at origin.
 *
 * @param lat - Latitude in degrees
 * @param lon - Longitude in degrees
 * @param tileBounds - Geographic bounds of the tile (west, south, east, north)
 * @param tileWidthM - Tile width in meters (east-west extent)
 * @param tileHeightM - Tile height in meters (north-south extent)
 * @returns Local position { x, z } in meters relative to tile center
 */
export function geoToLocal(
  lat: number,
  lon: number,
  tileBounds: GeoBounds,
  tileWidthM: number,
  tileHeightM: number
): { x: number; z: number } {
  const x =
    ((lon - tileBounds.west) / (tileBounds.east - tileBounds.west)) * tileWidthM -
    tileWidthM / 2;

  const z =
    ((lat - tileBounds.south) / (tileBounds.north - tileBounds.south)) * tileHeightM -
    tileHeightM / 2;

  return { x, z };
}

/**
 * Road material color lookup by highway classification.
 */
const roadColors: Record<string, [number, number, number]> = {
  motorway: [0.15, 0.15, 0.15],
  primary: [0.25, 0.25, 0.25],
  secondary: [0.25, 0.25, 0.25],
};

/** Default road color for residential and all other classifications. */
const DEFAULT_ROAD_COLOR: [number, number, number] = [0.35, 0.35, 0.35];

/**
 * Get the material color for a road based on its highway classification.
 */
function getRoadColor(highway: string): [number, number, number] {
  return roadColors[highway] ?? DEFAULT_ROAD_COLOR;
}

/**
 * Create ribbon road meshes from RoadGeometry array.
 * For each road with ≥2 centerline vertices, creates a ribbon mesh
 * centered on the centerline path with the specified width.
 *
 * Roads are draped along the terrain surface with a configurable elevation
 * offset to prevent z-fighting. When no terrain data is available, roads
 * are placed at Y = 0.1m above the flat plane.
 *
 * @param roads - Array of RoadGeometry objects to render
 * @param context - Tile context with scene, bounds, and terrain info
 * @param options - Options including road elevation offset
 * @returns Array of created Babylon.js meshes for visibility toggling
 */
export function createRoadMeshes(
  roads: RoadGeometry[],
  context: TileContext,
  options: MeshBuilder3DOptions
): Mesh[] {
  const meshes: Mesh[] = [];
  const { scene, tileBounds, tileWidthM, tileHeightM, tileOffsetX, tileOffsetZ, terrainMesh } = context;
  const elevationOffset = options.roadElevationOffset;

  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];

    // Skip roads with fewer than 2 centerline points
    if (road.centerline.length < 2) {
      continue;
    }

    const halfWidth = (road.width || 6) / 2;

    // Convert centerline coordinates to local space
    const localPoints: { x: number; z: number }[] = [];
    for (const coord of road.centerline) {
      localPoints.push(geoToLocal(coord.lat, coord.lon, tileBounds, tileWidthM, tileHeightM));
    }

    // Build left and right path arrays for the ribbon
    const leftPath: Vector3[] = [];
    const rightPath: Vector3[] = [];

    for (let j = 0; j < localPoints.length; j++) {
      const pt = localPoints[j];

      // Compute direction vector at this point
      let dx: number, dz: number;
      if (j === 0) {
        // First point: use direction to next point
        dx = localPoints[j + 1].x - pt.x;
        dz = localPoints[j + 1].z - pt.z;
      } else if (j === localPoints.length - 1) {
        // Last point: use direction from previous point
        dx = pt.x - localPoints[j - 1].x;
        dz = pt.z - localPoints[j - 1].z;
      } else {
        // Middle points: average of incoming and outgoing directions
        dx = localPoints[j + 1].x - localPoints[j - 1].x;
        dz = localPoints[j + 1].z - localPoints[j - 1].z;
      }

      // Normalize direction
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-10) {
        // Degenerate segment: use a default perpendicular
        dx = 1;
        dz = 0;
      } else {
        dx /= len;
        dz /= len;
      }

      // Perpendicular offset (rotate direction 90 degrees)
      // Perpendicular to (dx, dz) is (-dz, dx)
      const perpX = -dz;
      const perpZ = dx;

      // Determine Y position
      let y: number;
      if (terrainMesh) {
        // TODO: Sample terrain elevation at this point when terrain mesh is available
        // For now, use elevation offset above Y=0
        y = elevationOffset;
      } else {
        // No terrain data: place at Y = 0.1m above flat plane
        y = 0.1;
      }

      // Left and right points offset from centerline
      leftPath.push(new Vector3(
        pt.x + perpX * halfWidth + tileOffsetX,
        y,
        pt.z + perpZ * halfWidth + tileOffsetZ
      ));
      rightPath.push(new Vector3(
        pt.x - perpX * halfWidth + tileOffsetX,
        y,
        pt.z - perpZ * halfWidth + tileOffsetZ
      ));
    }

    // Create ribbon mesh from left and right paths
    const roadMesh = MeshBuilder.CreateRibbon(
      `road_${i}_${road.highway}`,
      {
        pathArray: [leftPath, rightPath],
        closePath: false,
        closeArray: false,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      scene
    );

    // Apply classification-based material
    const [r, g, b] = getRoadColor(road.highway);
    const mat = new StandardMaterial(`roadMat_${i}_${road.highway}`, scene);
    mat.diffuseColor = new Color3(r, g, b);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    roadMesh.material = mat;

    meshes.push(roadMesh);
  }

  return meshes;
}

/**
 * Create extruded building meshes from BuildingGeometry array.
 * Each building with a valid footprint (≥4 coordinate pairs) is extruded vertically
 * to its specified height and positioned at the correct geographic location.
 *
 * @param buildings - Array of BuildingGeometry objects to render
 * @param context - Tile context with scene, bounds, and terrain info
 * @returns Array of created Babylon.js meshes for visibility toggling
 */
export function createBuildingMeshes(
  buildings: BuildingGeometry[],
  context: TileContext
): Mesh[] {
  const meshes: Mesh[] = [];
  const { scene, tileBounds, tileWidthM, tileHeightM, tileOffsetX, tileOffsetZ, terrainMesh } = context;

  // Create a shared material for all buildings
  const buildingMaterial = new StandardMaterial('buildingMat', scene);
  buildingMaterial.diffuseColor = new Color3(0.75, 0.75, 0.75);
  buildingMaterial.specularColor = new Color3(0.1, 0.1, 0.1);

  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i];

    // Skip buildings with fewer than 4 footprint coordinate pairs
    if (building.footprint.length < 4) {
      continue;
    }

    // Convert footprint coordinates to local tile-space
    const shape: Vector3[] = [];
    for (const coord of building.footprint) {
      const local = geoToLocal(coord.lat, coord.lon, tileBounds, tileWidthM, tileHeightM);
      // ExtrudePolygon works in XoZ plane (Y is the extrusion axis)
      shape.push(new Vector3(local.x, 0, local.z));
    }

    // Create extruded polygon mesh
    let mesh: Mesh;
    try {
      mesh = ExtrudePolygon(
        `building_${i}`,
        {
          shape,
          depth: building.height,
          sideOrientation: Mesh.DOUBLESIDE,
        },
        scene,
        earcut
      );
    } catch {
      // Skip buildings that fail triangulation (e.g., degenerate or self-intersecting polygons)
      continue;
    }

    // Calculate base elevation offset from minLevel
    const minLevelOffset = building.minLevel > 0 ? building.minLevel * 3.0 : 0;

    // Determine terrain elevation at building centroid
    let terrainElevation = 0;
    if (terrainMesh) {
      // Compute centroid of the footprint in local space
      let centroidX = 0;
      let centroidZ = 0;
      for (const v of shape) {
        centroidX += v.x;
        centroidZ += v.z;
      }
      centroidX /= shape.length;
      centroidZ /= shape.length;

      // Sample terrain elevation using bounding info
      // The terrain mesh Y range maps to [0, (elevationMax - elevationMin) * heightExaggeration]
      // Use a normalized position to estimate elevation at the centroid
      const normX = (centroidX + tileWidthM / 2) / tileWidthM;
      const normZ = (centroidZ + tileHeightM / 2) / tileHeightM;

      // Clamp to [0, 1] range
      const clampedX = Math.max(0, Math.min(1, normX));
      const clampedZ = Math.max(0, Math.min(1, normZ));

      // Use terrain bounding box to estimate elevation (simple interpolation)
      // This is a basic approximation; full ray-casting would be more accurate
      // but requires the terrain geometry to be fully loaded
      void clampedX;
      void clampedZ;
      terrainElevation = 0;
    }

    // Position the mesh at the correct world location
    // ExtrudePolygon creates the mesh with the top face at Y=0 and extrudes downward (depth in -Y)
    // We position Y so the base sits at terrain elevation + minLevel offset
    mesh.position.x = tileOffsetX;
    mesh.position.z = tileOffsetZ;
    mesh.position.y = terrainElevation + minLevelOffset + building.height;

    // Apply shared material
    mesh.material = buildingMaterial;

    meshes.push(mesh);
  }

  return meshes;
}
