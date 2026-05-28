/**
 * OSM 3D Geometry Extractor for GeoTerrain Studio
 *
 * Transforms raw Overpass features into structured 3D geometry data
 * (buildings and roads) with real-world dimensional attributes.
 *
 * Runs in the Electron main process (Node.js).
 */

import type { GeoBounds, OverpassFeature } from './overpass-client';
import { fetchBuildings as fetchBuildingsFromAPI, fetchRoads as fetchRoadsFromAPI } from './overpass-client';

// ─── Types ─────────────────────────────────────────────────────

export interface BuildingGeometry {
  footprint: Array<{ lat: number; lon: number }>;
  height: number;       // meters, >= 0
  floors: number;       // integer, >= 0
  minLevel: number;     // integer, >= 0
  roofShape?: string;   // 'flat' | 'gabled' | 'hipped' | 'pyramidal' | undefined
  tags: Record<string, string>;
}

export interface RoadGeometry {
  centerline: Array<{ lat: number; lon: number }>;
  width: number;        // meters, >= 0
  surface: string;      // raw surface tag or ''
  highway: string;      // highway classification tag
  tags: Record<string, string>;
}

export interface Extraction3DOptions {
  bounds: GeoBounds;
  defaultBuildingHeight: number;  // meters, 1-100, default 9
  roadElevationOffset: number;    // meters, 0-1, default 0.1
}

export interface Extraction3DResult {
  buildings: BuildingGeometry[];
  roads: RoadGeometry[];
  extractionTimeMs: number;
}

// ─── Constants ─────────────────────────────────────────────────

const VALID_ROOF_SHAPES = new Set(['flat', 'gabled', 'hipped', 'pyramidal']);

const MIN_HEIGHT = 0.1;
const MAX_HEIGHT = 1000;
const MIN_LEVELS = 1;
const MAX_LEVELS = 200;
const METERS_PER_LEVEL = 3.0;
const MIN_POLYGON_POINTS = 4;

const MIN_MIN_LEVEL = 0;
const MAX_MIN_LEVEL = 200;

// Road-specific constants
const MIN_ROAD_WIDTH = 0.5;
const MAX_ROAD_WIDTH = 50;
const METERS_PER_LANE = 3.5;
const MIN_ROAD_POINTS = 2;

/** Classification-based default road widths (meters) */
const ROAD_WIDTH_BY_CLASSIFICATION: Record<string, number> = {
  motorway: 12,
  trunk: 10,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  residential: 5,
  service: 3.5,
  footway: 2,
  path: 2,
  cycleway: 2,
};
const ROAD_WIDTH_DEFAULT = 4;

// ─── Building Extraction ───────────────────────────────────────

/**
 * Parse a numeric value from a tag string.
 * Returns NaN if the value is not a valid finite number.
 */
function parseNumericTag(value: string | undefined): number {
  if (value === undefined || value === '') return NaN;
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return num;
}

/**
 * Determine building height using the priority chain:
 *   1. Explicit `height` tag (0.1-1000m)
 *   2. `building:levels` * 3.0m (1-200 levels)
 *   3. Configurable default height
 *
 * Invalid tag values (non-numeric, out-of-range) fall back to the next priority level.
 */
export function estimateBuildingHeight(
  tags: Record<string, string>,
  defaultHeight: number
): { height: number; floors: number } {
  // Priority 1: explicit height tag
  const heightValue = parseNumericTag(tags['height']);
  if (!Number.isNaN(heightValue) && heightValue >= MIN_HEIGHT && heightValue <= MAX_HEIGHT) {
    // Derive floors from levels tag if available, otherwise estimate from height
    const levelsValue = parseNumericTag(tags['building:levels']);
    const floors = (!Number.isNaN(levelsValue) && Number.isInteger(levelsValue) && levelsValue >= MIN_LEVELS && levelsValue <= MAX_LEVELS)
      ? levelsValue
      : Math.max(1, Math.round(heightValue / METERS_PER_LEVEL));
    return { height: heightValue, floors };
  }

  // Priority 2: building:levels tag
  const levelsValue = parseNumericTag(tags['building:levels']);
  if (!Number.isNaN(levelsValue) && Number.isInteger(levelsValue) && levelsValue >= MIN_LEVELS && levelsValue <= MAX_LEVELS) {
    return { height: levelsValue * METERS_PER_LEVEL, floors: levelsValue };
  }

  // Priority 3: default height
  const floors = Math.max(1, Math.round(defaultHeight / METERS_PER_LEVEL));
  return { height: defaultHeight, floors };
}

/**
 * Extract the optional roof:shape tag if it matches a supported type.
 */
function extractRoofShape(tags: Record<string, string>): string | undefined {
  const roofShape = tags['roof:shape'];
  if (roofShape !== undefined && VALID_ROOF_SHAPES.has(roofShape)) {
    return roofShape;
  }
  return undefined;
}

/**
 * Extract the optional building:min_level tag if it's a valid integer in [0, 200].
 */
function extractMinLevel(tags: Record<string, string>): number {
  const value = parseNumericTag(tags['building:min_level']);
  if (!Number.isNaN(value) && Number.isInteger(value) && value >= MIN_MIN_LEVEL && value <= MAX_MIN_LEVEL) {
    return value;
  }
  return 0;
}

/**
 * Extract 3D building geometry from raw Overpass features.
 * Applies height estimation priority chain:
 *   1. Explicit `height` tag (0.1-1000m)
 *   2. `building:levels` * 3.0m (1-200 levels)
 *   3. Configurable default height
 *
 * Buildings require a minimum of 4 coordinate pairs for a valid polygon.
 * For relation geometry, the coordinates are already collected from outer ring members
 * by the Overpass client's parseOverpassResponse function.
 */
export function extractBuildings(
  features: OverpassFeature[],
  defaultHeight: number
): BuildingGeometry[] {
  const buildings: BuildingGeometry[] = [];

  for (const feature of features) {
    // Filter: require minimum 4 coordinate pairs for valid polygon
    if (!feature.geometry || feature.geometry.length < MIN_POLYGON_POINTS) {
      continue;
    }

    const tags = feature.tags ?? {};

    // Determine height and floors
    const { height, floors } = estimateBuildingHeight(tags, defaultHeight);

    // Extract optional fields
    const roofShape = extractRoofShape(tags);
    const minLevel = extractMinLevel(tags);

    // Build the geometry object
    const building: BuildingGeometry = {
      footprint: feature.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon })),
      height,
      floors,
      minLevel,
      tags,
    };

    // Only include roofShape if it's a valid supported type
    if (roofShape !== undefined) {
      building.roofShape = roofShape;
    }

    buildings.push(building);
  }

  return buildings;
}

// ─── Road Extraction ───────────────────────────────────────────

/**
 * Estimate road width using the priority chain:
 *   1. Explicit `width` tag (0.5-50m)
 *   2. `lanes` * 3.5m (positive integer lanes)
 *   3. Classification-based lookup table
 *
 * Invalid width tag values (non-numeric, <0.5, >50) fall back to lanes-based
 * or classification-based estimation.
 */
export function estimateRoadWidth(tags: Record<string, string>): number {
  // Priority 1: explicit width tag
  const widthValue = parseNumericTag(tags['width']);
  if (!Number.isNaN(widthValue) && widthValue >= MIN_ROAD_WIDTH && widthValue <= MAX_ROAD_WIDTH) {
    return widthValue;
  }

  // Priority 2: lanes-based estimation
  const lanesValue = parseNumericTag(tags['lanes']);
  if (!Number.isNaN(lanesValue) && Number.isInteger(lanesValue) && lanesValue > 0) {
    return lanesValue * METERS_PER_LANE;
  }

  // Priority 3: classification-based lookup
  const highway = tags['highway'] ?? '';
  if (highway in ROAD_WIDTH_BY_CLASSIFICATION) {
    return ROAD_WIDTH_BY_CLASSIFICATION[highway];
  }

  return ROAD_WIDTH_DEFAULT;
}

/**
 * Extract 3D road geometry from raw Overpass features.
 * Applies width estimation priority chain:
 *   1. Explicit `width` tag (0.5-50m)
 *   2. `lanes` * 3.5m
 *   3. Classification-based lookup table
 *
 * Roads require a minimum of 2 coordinate points for a valid centerline.
 */
export function extractRoads(
  features: OverpassFeature[]
): RoadGeometry[] {
  const roads: RoadGeometry[] = [];

  for (const feature of features) {
    // Filter: require minimum 2 coordinate points
    if (!feature.geometry || feature.geometry.length < MIN_ROAD_POINTS) {
      continue;
    }

    const tags = feature.tags ?? {};

    // Determine width using priority chain
    const width = estimateRoadWidth(tags);

    // Extract surface tag (raw value or empty string)
    const surface = tags['surface'] ?? '';

    // Extract highway classification tag
    const highway = tags['highway'] ?? '';

    roads.push({
      centerline: feature.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon })),
      width,
      surface,
      highway,
      tags,
    });
  }

  return roads;
}

// ─── Full Extraction Pipeline ──────────────────────────────────

/**
 * Full extraction pipeline: fetch from Overpass + transform.
 * Non-fatal: returns empty arrays on API failure, logs warning.
 */
export async function extract3DGeometry(
  options: Extraction3DOptions
): Promise<Extraction3DResult> {
  const startTime = Date.now();

  // Fetch buildings from Overpass API (non-fatal on failure)
  let buildingFeatures: OverpassFeature[] = [];
  try {
    const buildingResult = await fetchBuildingsFromAPI(options.bounds);
    buildingFeatures = buildingResult.features;
  } catch (err) {
    console.warn(
      '[osm-3d-extractor] Failed to fetch buildings from Overpass API:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // Fetch roads from Overpass API (non-fatal on failure)
  let roadFeatures: OverpassFeature[] = [];
  try {
    const roadResult = await fetchRoadsFromAPI(options.bounds);
    roadFeatures = roadResult.features;
  } catch (err) {
    console.warn(
      '[osm-3d-extractor] Failed to fetch roads from Overpass API:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // Transform raw features into structured 3D geometry
  const buildings = extractBuildings(buildingFeatures, options.defaultBuildingHeight);
  const roads = extractRoads(roadFeatures);

  const extractionTimeMs = Date.now() - startTime;

  return {
    buildings,
    roads,
    extractionTimeMs,
  };
}
