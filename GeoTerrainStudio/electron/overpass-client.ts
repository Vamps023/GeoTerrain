/**
 * Overpass API Client for GeoTerrain Studio
 *
 * Fetches road, water, vegetation, and building data from OpenStreetMap
 * via the Overpass API. Constructs Overpass QL queries, handles HTTP POST
 * requests, parses JSON responses into normalized OverpassFeature arrays,
 * and implements retry logic with exponential backoff.
 *
 * Runs in the Electron main process (Node.js).
 */

import * as https from 'https';

// ─── Types (local definitions matching src/types/terrain.ts) ───

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OverpassFeature {
  type: 'way' | 'relation';
  id: number;
  geometry: Array<{ lat: number; lon: number }>;
  tags: Record<string, string>;
}

export interface OverpassQueryResult {
  features: OverpassFeature[];
  queryTimeMs: number;
  featureCount: number;
}

// ─── Constants ─────────────────────────────────────────────────

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK_ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';
const QUERY_TIMEOUT_SECONDS = 60;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024; // 100 MB
const RETRY_DELAYS_MS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s
const HTTP_TIMEOUT_MS = QUERY_TIMEOUT_SECONDS * 1000 + 10000; // Query timeout + 10s buffer

// ─── Concurrency Limiter ───────────────────────────────────────

let activeRequests = 0;
const requestQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    requestQueue.push(resolve);
  });
}

function releaseSlot(): void {
  activeRequests--;
  if (requestQueue.length > 0) {
    activeRequests++;
    const next = requestQueue.shift()!;
    next();
  }
}

// ─── Query Templates ───────────────────────────────────────────

/**
 * Formats a GeoBounds into the Overpass bbox string: south,west,north,east
 */
function formatBbox(bounds: GeoBounds): string {
  return `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
}

function buildRoadQuery(bounds: GeoBounds): string {
  const bbox = formatBbox(bounds);
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(way["highway"](${bbox}););out geom;`;
}

function buildWaterQuery(bounds: GeoBounds): string {
  const bbox = formatBbox(bounds);
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(way["natural"="water"](${bbox});relation["natural"="water"](${bbox});way["waterway"](${bbox});way["landuse"="reservoir"](${bbox}););out geom;`;
}

function buildVegetationQuery(bounds: GeoBounds): string {
  const bbox = formatBbox(bounds);
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(way["landuse"="forest"](${bbox});way["natural"="wood"](${bbox});way["landuse"="grass"](${bbox});way["leisure"="park"](${bbox});relation["landuse"="forest"](${bbox}););out geom;`;
}

function buildBuildingQuery(bounds: GeoBounds): string {
  const bbox = formatBbox(bounds);
  return `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(way["building"](${bbox});relation["building"](${bbox}););out geom;`;
}

// ─── HTTP Request with Retry ───────────────────────────────────

interface OverpassRawResponse {
  elements: Array<{
    type: string;
    id: number;
    geometry?: Array<{ lat: number; lon: number }>;
    members?: Array<{
      type: string;
      geometry?: Array<{ lat: number; lon: number }>;
    }>;
    tags?: Record<string, string>;
  }>;
}

/**
 * Sends an HTTP POST request to the Overpass API with the given query body.
 * Returns the raw JSON response string.
 * Throws on HTTP errors, timeouts, or responses exceeding MAX_RESPONSE_BYTES.
 */
function postOverpassRequest(queryBody: string, endpoint: string = OVERPASS_ENDPOINT): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const postData = `data=${encodeURIComponent(queryBody)}`;
    const url = new URL(endpoint);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'GeoTerrainStudio/2.0',
        'Accept': '*/*',
      },
      timeout: HTTP_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      const statusCode = res.statusCode ?? 0;

      // Rate limited — signal for retry
      if (statusCode === 429) {
        res.resume(); // Drain the response
        reject(new OverpassRateLimitError('Overpass API rate limit (HTTP 429)'));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`Overpass API returned HTTP ${statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new OverpassResponseTooLargeError(
            `Overpass response exceeds ${MAX_RESPONSE_BYTES / (1024 * 1024)}MB limit`
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new OverpassTimeoutError('Overpass API request timed out'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// ─── Custom Error Classes ──────────────────────────────────────

class OverpassRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassRateLimitError';
  }
}

class OverpassTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassTimeoutError';
  }
}

class OverpassResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassResponseTooLargeError';
  }
}

// ─── Response Parsing ──────────────────────────────────────────

/**
 * Parses raw Overpass JSON response into normalized OverpassFeature array.
 * Extracts geometry from ways directly and from relation members.
 */
function parseOverpassResponse(jsonStr: string): OverpassFeature[] {
  const data: OverpassRawResponse = JSON.parse(jsonStr);
  const features: OverpassFeature[] = [];

  if (!data.elements || !Array.isArray(data.elements)) {
    return features;
  }

  for (const element of data.elements) {
    if (element.type === 'way' && element.geometry && element.geometry.length > 0) {
      features.push({
        type: 'way',
        id: element.id,
        geometry: element.geometry.map((pt) => ({ lat: pt.lat, lon: pt.lon })),
        tags: element.tags ?? {},
      });
    } else if (element.type === 'relation') {
      // For relations, collect geometry from all members that have geometry
      const combinedGeometry: Array<{ lat: number; lon: number }> = [];
      if (element.members) {
        for (const member of element.members) {
          if (member.geometry) {
            for (const pt of member.geometry) {
              combinedGeometry.push({ lat: pt.lat, lon: pt.lon });
            }
          }
        }
      }
      // Also use top-level geometry if present (some queries return it)
      if (element.geometry) {
        for (const pt of element.geometry) {
          combinedGeometry.push({ lat: pt.lat, lon: pt.lon });
        }
      }
      if (combinedGeometry.length > 0) {
        features.push({
          type: 'relation',
          id: element.id,
          geometry: combinedGeometry,
          tags: element.tags ?? {},
        });
      }
    }
  }

  return features;
}

// ─── Retry Logic ───────────────────────────────────────────────

/**
 * Determines if an error is retryable (rate limit or timeout).
 */
function isRetryableError(err: unknown): boolean {
  return (
    err instanceof OverpassRateLimitError ||
    err instanceof OverpassTimeoutError
  );
}

/**
 * Executes an Overpass query with retry logic.
 * Retries up to 3 times with exponential backoff (2s, 4s, 8s) on
 * HTTP 429 and timeout errors. Non-retryable errors are thrown immediately.
 * Response size is capped at 100MB.
 */
async function executeWithRetry(query: string): Promise<OverpassFeature[]> {
  let lastError: unknown;

  // Try primary endpoint with retries
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const responseStr = await postOverpassRequest(query, OVERPASS_ENDPOINT);
      return parseOverpassResponse(responseStr);
    } catch (err) {
      lastError = err;

      // Response too large — not retryable, reject immediately
      if (err instanceof OverpassResponseTooLargeError) {
        throw err;
      }

      // Only retry on rate limit or timeout
      if (!isRetryableError(err)) {
        // For non-retryable errors (like 406), try fallback endpoint once
        break;
      }

      // If we have retries left, wait with exponential backoff
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  // Try fallback endpoint
  try {
    console.log(`[Overpass] Primary endpoint failed, trying fallback: ${OVERPASS_FALLBACK_ENDPOINT}`);
    const responseStr = await postOverpassRequest(query, OVERPASS_FALLBACK_ENDPOINT);
    return parseOverpassResponse(responseStr);
  } catch (fallbackErr) {
    // If fallback also fails, throw the original error
    console.warn(`[Overpass] Fallback endpoint also failed:`, (fallbackErr as Error).message);
    throw lastError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Bounding Box Splitting ────────────────────────────────────

const MAX_AREA_DEGREES = 0.25;

/**
 * Calculates the area of a bounding box in square degrees.
 */
function calculateAreaDegrees(bounds: GeoBounds): number {
  return (bounds.north - bounds.south) * (bounds.east - bounds.west);
}

/**
 * Splits a bounding box into sub-regions each with area ≤ maxAreaDegrees.
 * Ensures full coverage without gaps by dividing evenly along latitude and longitude.
 * Exported for testing.
 */
export function splitBounds(bounds: GeoBounds, maxAreaDegrees: number = MAX_AREA_DEGREES): GeoBounds[] {
  const area = calculateAreaDegrees(bounds);

  if (area <= maxAreaDegrees) {
    return [bounds];
  }

  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;

  // Determine how many splits we need along each axis.
  // We want each sub-region to have area ≤ maxAreaDegrees.
  // subLatSpan * subLonSpan ≤ maxAreaDegrees
  // We split proportionally: find the minimum number of divisions
  // such that (latSpan / latDivisions) * (lonSpan / lonDivisions) ≤ maxAreaDegrees
  const totalDivisionsNeeded = Math.ceil(area / maxAreaDegrees);

  // Distribute divisions proportionally between lat and lon axes
  // to keep sub-regions roughly square
  const ratio = latSpan / lonSpan;
  let latDivisions = Math.max(1, Math.round(Math.sqrt(totalDivisionsNeeded * ratio)));
  let lonDivisions = Math.max(1, Math.round(Math.sqrt(totalDivisionsNeeded / ratio)));

  // Ensure we have enough divisions to meet the area constraint
  while ((latSpan / latDivisions) * (lonSpan / lonDivisions) > maxAreaDegrees) {
    // Increase the axis with the larger sub-span
    if (latSpan / latDivisions >= lonSpan / lonDivisions) {
      latDivisions++;
    } else {
      lonDivisions++;
    }
  }

  const subLatSpan = latSpan / latDivisions;
  const subLonSpan = lonSpan / lonDivisions;

  const subBounds: GeoBounds[] = [];

  for (let latIdx = 0; latIdx < latDivisions; latIdx++) {
    for (let lonIdx = 0; lonIdx < lonDivisions; lonIdx++) {
      const south = bounds.south + latIdx * subLatSpan;
      const north = latIdx === latDivisions - 1 ? bounds.north : bounds.south + (latIdx + 1) * subLatSpan;
      const west = bounds.west + lonIdx * subLonSpan;
      const east = lonIdx === lonDivisions - 1 ? bounds.east : bounds.west + (lonIdx + 1) * subLonSpan;

      subBounds.push({ south, west, north, east });
    }
  }

  return subBounds;
}

/**
 * Fetches features using bounding box splitting for large areas.
 * If the area exceeds MAX_AREA_DEGREES, splits into sub-regions, queries each,
 * and merges results with deduplication by feature ID.
 * Each sub-query goes through the concurrency limiter independently.
 */
async function fetchWithSplitting(
  bounds: GeoBounds,
  queryBuilder: (b: GeoBounds) => string
): Promise<OverpassQueryResult> {
  const startTime = Date.now();
  const subRegions = splitBounds(bounds);

  // Query each sub-region (each goes through concurrency limiter)
  const subResults: OverpassFeature[][] = [];
  for (const region of subRegions) {
    await acquireSlot();
    try {
      const query = queryBuilder(region);
      const features = await executeWithRetry(query);
      subResults.push(features);
    } finally {
      releaseSlot();
    }
  }

  // Merge and deduplicate by feature type + ID
  const seen = new Set<string>();
  const mergedFeatures: OverpassFeature[] = [];

  for (const features of subResults) {
    for (const feature of features) {
      const key = `${feature.type}:${feature.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        mergedFeatures.push(feature);
      }
    }
  }

  return {
    features: mergedFeatures,
    queryTimeMs: Date.now() - startTime,
    featureCount: mergedFeatures.length,
  };
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Fetches road features (ways tagged with "highway") from the Overpass API.
 * Automatically splits large bounding boxes (>0.25 sq degrees) into sub-regions.
 */
export async function fetchRoads(bounds: GeoBounds): Promise<OverpassQueryResult> {
  return fetchWithSplitting(bounds, buildRoadQuery);
}

/**
 * Fetches water features (natural=water, waterway, landuse=reservoir) from the Overpass API.
 * Automatically splits large bounding boxes (>0.25 sq degrees) into sub-regions.
 */
export async function fetchWater(bounds: GeoBounds): Promise<OverpassQueryResult> {
  return fetchWithSplitting(bounds, buildWaterQuery);
}

/**
 * Fetches vegetation features (forest, wood, grass, park) from the Overpass API.
 * Automatically splits large bounding boxes (>0.25 sq degrees) into sub-regions.
 */
export async function fetchVegetation(bounds: GeoBounds): Promise<OverpassQueryResult> {
  return fetchWithSplitting(bounds, buildVegetationQuery);
}

/**
 * Fetches building features (ways and relations tagged with "building") from the Overpass API.
 * Automatically splits large bounding boxes (>0.25 sq degrees) into sub-regions.
 */
export async function fetchBuildings(bounds: GeoBounds): Promise<OverpassQueryResult> {
  return fetchWithSplitting(bounds, buildBuildingQuery);
}

// ─── Exported Utilities (for testing and mask-generator) ───────

export {
  buildRoadQuery,
  buildWaterQuery,
  buildVegetationQuery,
  buildBuildingQuery,
  formatBbox,
  parseOverpassResponse,
  OverpassRateLimitError,
  OverpassTimeoutError,
  OverpassResponseTooLargeError,
};
