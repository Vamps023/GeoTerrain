import { Scene, Mesh, Ray, Vector3 } from '@babylonjs/core';
import { MaskData, sampleAt } from './MaskSampler';
import { createTreeMesh } from './TreeGeometry';

/**
 * Configuration for the tree scattering algorithm.
 */
export interface ScatterConfig {
  /** Trees per square meter (default: 0.01 = 1 tree per 100m²) */
  density: number;
  /** Minimum random scale factor (default: 0.6) */
  minScale: number;
  /** Maximum random scale factor (default: 1.4) */
  maxScale: number;
  /** Apply random Y-axis rotation (default: true) */
  randomRotation: boolean;
  /** Random seed for reproducible placement (default: 42) */
  seed: number;
  /** Mask pixel threshold for placement (default: 128) */
  vegetationThreshold: number;
  /** Safety cap on instances per tile (default: 50000) */
  maxInstancesPerTile: number;
  /** Must match terrain HEIGHT_EXAGGERATION (default: 1.5) */
  heightExaggeration: number;
  /** Position jitter as fraction of grid spacing (default: 0.7) */
  jitterAmount: number;
}

/**
 * Result of a scatter operation.
 */
export interface ScatterResult {
  /** The base mesh with thin instances applied */
  mesh: Mesh;
  /** Number of trees actually placed */
  instanceCount: number;
  /** Time taken to scatter in milliseconds */
  generationTimeMs: number;
}

/**
 * A 2D candidate position on the tile (XZ plane).
 */
export interface CandidatePosition {
  x: number;
  z: number;
}

/**
 * Default scatter configuration values.
 */
export const DEFAULT_SCATTER_CONFIG: ScatterConfig = {
  density: 0.01,
  minScale: 0.6,
  maxScale: 1.4,
  randomRotation: true,
  seed: 42,
  vegetationThreshold: 128,
  maxInstancesPerTile: 50000,
  heightExaggeration: 1.5,
  jitterAmount: 0.7,
};

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Produces deterministic sequences — same seed always yields same output.
 *
 * @param seed - Integer seed value
 * @returns A function that returns the next pseudo-random number in [0, 1)
 */
export function createPRNG(seed: number): () => number {
  let s = seed | 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate jittered grid candidate positions covering the tile area.
 *
 * Grid spacing = 1 / sqrt(density). Each candidate is offset by a random
 * jitter within [-jitterAmount * spacing / 2, +jitterAmount * spacing / 2]
 * per axis. Positions are clamped to tile bounds [0, tileWidthM] x [0, tileHeightM].
 *
 * @param tileWidthM - Tile width in meters
 * @param tileHeightM - Tile height in meters
 * @param config - Scatter configuration (density, jitterAmount, seed)
 * @returns Array of candidate positions within tile bounds
 */
export function generateCandidates(
  tileWidthM: number,
  tileHeightM: number,
  config: ScatterConfig
): CandidatePosition[] {
  const spacing = 1 / Math.sqrt(config.density);
  const rng = createPRNG(config.seed);
  const candidates: CandidatePosition[] = [];

  const halfJitter = (config.jitterAmount * spacing) / 2;

  // Generate grid cells covering the tile
  const cols = Math.ceil(tileWidthM / spacing);
  const rows = Math.ceil(tileHeightM / spacing);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Grid center position
      const baseX = (col + 0.5) * spacing;
      const baseZ = (row + 0.5) * spacing;

      // Apply jitter: random offset in [-halfJitter, +halfJitter] per axis
      const jitterX = (rng() * 2 - 1) * halfJitter;
      const jitterZ = (rng() * 2 - 1) * halfJitter;

      // Clamp to tile bounds [0, tileWidthM] x [0, tileHeightM]
      const x = Math.max(0, Math.min(tileWidthM, baseX + jitterX));
      const z = Math.max(0, Math.min(tileHeightM, baseZ + jitterZ));

      candidates.push({ x, z });
    }
  }

  return candidates;
}

/**
 * Filter candidate positions against the vegetation mask.
 *
 * Converts each world position to mask UV coordinates using linear mapping
 * (u = x / tileWidthM, v = z / tileHeightM) and accepts only positions
 * where the mask pixel value is at or above the vegetation threshold.
 *
 * @param candidates - Array of candidate positions to filter
 * @param maskData - Decoded vegetation mask data
 * @param tileWidthM - Tile width in meters (for UV conversion)
 * @param tileHeightM - Tile height in meters (for UV conversion)
 * @param vegetationThreshold - Pixel value threshold (>= means vegetation)
 * @returns Filtered array of positions that pass the mask test
 */
export function filterByMask(
  candidates: CandidatePosition[],
  maskData: MaskData,
  tileWidthM: number,
  tileHeightM: number,
  vegetationThreshold: number
): CandidatePosition[] {
  const filtered: CandidatePosition[] = [];

  for (const pos of candidates) {
    // Convert world position to UV coordinates
    const u = pos.x / tileWidthM;
    const v = pos.z / tileHeightM;

    // Sample mask and check against threshold
    const pixelValue = sampleAt(maskData, u, v);
    if (pixelValue >= vegetationThreshold) {
      filtered.push(pos);
    }
  }

  return filtered;
}

/**
 * Height grid extracted from terrain mesh vertex data for fast O(1) height lookups.
 */
interface HeightGrid {
  heights: Float32Array;
  subdivisions: number;
  width: number;
  height: number;
  offsetX: number;
  offsetZ: number;
}

/**
 * Extract a height grid from the terrain mesh's vertex positions.
 * The terrain mesh (from CreateGroundFromHeightMap) has a regular grid of vertices.
 *
 * @param terrainMesh - The ground mesh with vertex data
 * @param tileWidthM - Tile width in meters
 * @param tileHeightM - Tile height in meters
 * @returns HeightGrid for fast lookups, or null if vertex data is unavailable
 */
export function extractHeightGrid(terrainMesh: Mesh, tileWidthM: number, tileHeightM: number): HeightGrid | null {
  const positions = terrainMesh.getVerticesData('position');
  if (!positions || positions.length === 0) {
    return null;
  }

  const vertexCount = positions.length / 3;
  // For a ground mesh with N subdivisions, there are (N+1)^2 vertices
  const subdivisions = Math.round(Math.sqrt(vertexCount)) - 1;
  if (subdivisions < 1) return null;

  const gridSize = subdivisions + 1;
  const heights = new Float32Array(gridSize * gridSize);

  // Extract Y values from vertex positions
  for (let i = 0; i < vertexCount && i < gridSize * gridSize; i++) {
    heights[i] = positions[i * 3 + 1]; // Y component
  }

  return {
    heights,
    subdivisions,
    width: tileWidthM,
    height: tileHeightM,
    offsetX: 0,
    offsetZ: 0,
  };
}

/**
 * Sample terrain height from the height grid using bilinear interpolation.
 * O(1) per lookup — no ray casting needed.
 *
 * @param grid - Pre-extracted height grid
 * @param worldX - World X coordinate
 * @param worldZ - World Z coordinate
 * @returns Interpolated height at the given position
 */
export function sampleHeightFromGrid(grid: HeightGrid, worldX: number, worldZ: number): number {
  // Convert world position to normalized grid coordinates [0, 1]
  const localX = worldX - grid.offsetX;
  const localZ = worldZ - grid.offsetZ;
  const u = localX / grid.width;
  const v = localZ / grid.height;

  // Clamp to grid bounds
  const cu = Math.max(0, Math.min(1, u));
  const cv = Math.max(0, Math.min(1, v));

  // Convert to grid indices
  const gridSize = grid.subdivisions + 1;
  const gx = cu * grid.subdivisions;
  const gz = cv * grid.subdivisions;

  const x0 = Math.min(Math.floor(gx), grid.subdivisions - 1);
  const z0 = Math.min(Math.floor(gz), grid.subdivisions - 1);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const fx = gx - x0;
  const fz = gz - z0;

  // Bilinear interpolation
  const h00 = grid.heights[z0 * gridSize + x0];
  const h10 = grid.heights[z0 * gridSize + x1];
  const h01 = grid.heights[z1 * gridSize + x0];
  const h11 = grid.heights[z1 * gridSize + x1];

  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;

  return h0 * (1 - fz) + h1 * fz;
}

/**
 * Maximum number of retry attempts for terrain height sampling.
 */
const HEIGHT_SAMPLE_MAX_RETRIES = 3;

/**
 * Delay in milliseconds between height sampling retries.
 */
const HEIGHT_SAMPLE_RETRY_DELAY_MS = 100;

/**
 * Sample the terrain height at a given XZ position using ray-based picking.
 * This is the fallback method when vertex data is not available.
 *
 * Casts a ray downward from (x, 10000, z) and picks against the
 * terrain mesh. If the ray misses, retries up to 3 times with 100ms delay.
 * Falls back to Y=0 if all retries fail.
 *
 * @param scene - Active Babylon.js Scene
 * @param terrainMesh - The ground mesh to pick against
 * @param x - World X coordinate
 * @param z - World Z coordinate
 * @returns The Y coordinate of the terrain at (x, z), or 0 if sampling fails
 */
export async function sampleTerrainHeight(
  scene: Scene,
  terrainMesh: Mesh,
  x: number,
  z: number
): Promise<number> {
  const origin = new Vector3(x, 10000, z);
  const direction = new Vector3(0, -1, 0);
  const ray = new Ray(origin, direction);

  for (let attempt = 0; attempt < HEIGHT_SAMPLE_MAX_RETRIES; attempt++) {
    const pickResult = scene.pickWithRay(ray, (mesh) => mesh === terrainMesh);

    if (pickResult && pickResult.hit && pickResult.pickedPoint) {
      return pickResult.pickedPoint.y;
    }

    // Wait before retrying (mesh geometry may not be ready yet)
    if (attempt < HEIGHT_SAMPLE_MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, HEIGHT_SAMPLE_RETRY_DELAY_MS));
    }
  }

  // All retries failed — fallback to Y=0
  return 0;
}

/**
 * Enforce the instance cap by randomly selecting positions using Fisher-Yates shuffle.
 *
 * If the positions array length exceeds maxCount, uses the seeded PRNG to
 * perform a partial Fisher-Yates shuffle and returns exactly maxCount positions.
 * Logs a console warning when the cap is reached.
 *
 * @param positions - Array of valid candidate positions
 * @param maxCount - Maximum number of positions to keep
 * @param rng - Seeded PRNG function returning values in [0, 1)
 * @returns Array of at most maxCount positions (randomly selected if capped)
 */
export function enforceInstanceCap(
  positions: CandidatePosition[],
  maxCount: number,
  rng: () => number
): CandidatePosition[] {
  if (positions.length <= maxCount) {
    return positions;
  }

  console.warn(
    `TreeScatterer: Instance cap reached (${positions.length} candidates, cap: ${maxCount}). Randomly selecting ${maxCount} positions.`
  );

  // Fisher-Yates partial shuffle: shuffle first maxCount elements
  const arr = [...positions];
  for (let i = 0; i < maxCount; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    // Swap arr[i] and arr[j]
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }

  return arr.slice(0, maxCount);
}

/**
 * Generate 4x4 transformation matrices for all tree instances.
 *
 * Each matrix encodes: Translation (terrain position) + Uniform Scale + Y-axis Rotation.
 * Uses manual matrix composition to avoid stack overflow from creating thousands of objects.
 *
 * Yields to the event loop every 16ms of processing to avoid blocking the render thread.
 *
 * @param positions - Array of 3D positions (x, y, z) for each tree instance
 * @param config - Scatter configuration (minScale, maxScale, randomRotation)
 * @param rng - Seeded PRNG function returning values in [0, 1)
 * @returns Float32Array of length positions.length * 16 containing all matrices
 */
export async function generateTransformMatrices(
  positions: Array<{ x: number; y: number; z: number }>,
  config: ScatterConfig,
  rng: () => number
): Promise<Float32Array> {
  const count = positions.length;
  const matrices = new Float32Array(count * 16);

  let lastYieldTime = performance.now();

  for (let i = 0; i < count; i++) {
    const pos = positions[i];
    const offset = i * 16;

    // Uniform random scale in [minScale, maxScale]
    const s = config.minScale + rng() * (config.maxScale - config.minScale);

    // Y-axis rotation angle
    const angle = config.randomRotation ? rng() * Math.PI * 2 : 0;
    const cosA = config.randomRotation ? Math.cos(angle) : 1;
    const sinA = config.randomRotation ? Math.sin(angle) : 0;

    // Build column-major 4x4 matrix: Scale * RotationY * Translation
    // Column 0 (X axis)
    matrices[offset + 0] = s * cosA;
    matrices[offset + 1] = 0;
    matrices[offset + 2] = s * sinA;
    matrices[offset + 3] = 0;
    // Column 1 (Y axis)
    matrices[offset + 4] = 0;
    matrices[offset + 5] = s;
    matrices[offset + 6] = 0;
    matrices[offset + 7] = 0;
    // Column 2 (Z axis)
    matrices[offset + 8] = config.randomRotation ? s * -sinA : 0;
    matrices[offset + 9] = 0;
    matrices[offset + 10] = s * cosA;
    matrices[offset + 11] = 0;
    // Column 3 (Translation)
    matrices[offset + 12] = pos.x;
    matrices[offset + 13] = pos.y;
    matrices[offset + 14] = pos.z;
    matrices[offset + 15] = 1;

    // Yield to event loop every 16ms to avoid blocking the render thread
    if (i % 5000 === 0 && i > 0) {
      const now = performance.now();
      if (now - lastYieldTime >= 16) {
        await new Promise<void>((r) => setTimeout(r, 0));
        lastYieldTime = performance.now();
      }
    }
  }

  return matrices;
}

/**
 * Validate that all values in a Float32Array are finite (no NaN or Infinity).
 *
 * @param buffer - The Float32Array to validate
 * @returns true if all values are finite, false otherwise
 */
export function validateMatrixBuffer(buffer: Float32Array): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (!isFinite(buffer[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Scatter trees across a terrain tile based on the vegetation mask.
 * Uses jittered grid sampling for even distribution.
 *
 * This function generates candidate positions, filters them against the mask,
 * computes terrain heights, generates transform matrices, and registers
 * thin instances on the base tree mesh for GPU-efficient rendering.
 *
 * @param scene - Active Babylon.js Scene
 * @param terrainMesh - The ground mesh for height sampling
 * @param maskData - Decoded vegetation mask data
 * @param tileWidthM - Tile width in meters
 * @param tileHeightM - Tile height in meters
 * @param elevationMin - Minimum elevation value in the tile
 * @param elevationMax - Maximum elevation value in the tile
 * @param config - Optional partial scatter configuration
 * @returns ScatterResult with mesh, instance count, and generation time
 */
export async function scatter(
  scene: Scene,
  terrainMesh: Mesh,
  maskData: MaskData,
  tileWidthM: number,
  tileHeightM: number,
  _elevationMin: number,
  _elevationMax: number,
  config?: Partial<ScatterConfig>
): Promise<ScatterResult> {
  const startTime = performance.now();
  const cfg: ScatterConfig = { ...DEFAULT_SCATTER_CONFIG, ...config };

  // Step 1: Generate jittered grid candidates
  const candidates = generateCandidates(tileWidthM, tileHeightM, cfg);

  // Step 2: Filter candidates against vegetation mask
  const validPositions = filterByMask(
    candidates,
    maskData,
    tileWidthM,
    tileHeightM,
    cfg.vegetationThreshold
  );

  // Step 3: Enforce instance cap via seeded random selection
  const capRng = createPRNG(cfg.seed + 1); // Use offset seed to avoid correlation with jitter
  const cappedPositions = enforceInstanceCap(validPositions, cfg.maxInstancesPerTile, capRng);

  // Step 4: Sample terrain height at each valid position
  // Use fast vertex-data-based height sampling (O(1) per position) instead of ray casting
  const terrainPos = terrainMesh.position;
  const terrainScaling = terrainMesh.scaling;
  const heightGrid = extractHeightGrid(terrainMesh, tileWidthM, tileHeightM);

  if (heightGrid) {
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < heightGrid.heights.length; i++) {
      if (heightGrid.heights[i] < minH) minH = heightGrid.heights[i];
      if (heightGrid.heights[i] > maxH) maxH = heightGrid.heights[i];
    }
    console.log(`TreeScatterer: Height grid extracted (${heightGrid.subdivisions + 1}x${heightGrid.subdivisions + 1}), height range: ${minH.toFixed(1)} to ${maxH.toFixed(1)}`);
  } else {
    console.warn('TreeScatterer: Could not extract height grid from terrain mesh — trees will be at Y=0');
  }

  const positionsWithHeight: Array<{ x: number; y: number; z: number }> = [];
  let lastYieldTime = performance.now();

  for (const pos of cappedPositions) {
    // Convert local tile position [0, tileWidthM] to world position
    // Account for terrain mesh scaling (e.g., scaling.z = -1 for Z flip)
    const localX = (pos.x - tileWidthM / 2) * terrainScaling.x;
    const localZ = (pos.z - tileHeightM / 2) * terrainScaling.z;
    const worldX = localX + terrainPos.x;
    const worldZ = localZ + terrainPos.z;

    let y = 0;
    if (heightGrid) {
      // The vegetation mask has v=0 at the top (north), but the height grid
      // has row 0 at Z=-height/2 (south). Flip Z to align height with mask.
      const gridZ = tileHeightM - pos.z;
      y = sampleHeightFromGrid(heightGrid, pos.x, gridZ);
    }

    positionsWithHeight.push({ x: worldX, y, z: worldZ });

    // Yield to event loop every 16ms during processing
    const now = performance.now();
    if (now - lastYieldTime >= 16) {
      await new Promise<void>((r) => setTimeout(r, 0));
      lastYieldTime = performance.now();
    }
  }

  // Step 5: Handle zero candidates — return early with instanceCount 0
  if (positionsWithHeight.length === 0) {
    const generationTimeMs = performance.now() - startTime;
    // Create the base mesh but don't register any instances
    const baseMesh = createTreeMesh(scene);
    return {
      mesh: baseMesh,
      instanceCount: 0,
      generationTimeMs,
    };
  }

  // Step 6: Generate transform matrices (position + scale + rotation)
  const transformRng = createPRNG(cfg.seed + 2); // Offset seed to avoid correlation
  const matrices = await generateTransformMatrices(positionsWithHeight, cfg, transformRng);

  // Step 7: Validate all matrix values are finite
  if (!validateMatrixBuffer(matrices)) {
    console.warn('TreeScatterer: Matrix buffer contains non-finite values. Skipping instance registration.');
    const baseMesh = createTreeMesh(scene);
    return {
      mesh: baseMesh,
      instanceCount: 0,
      generationTimeMs: performance.now() - startTime,
    };
  }

  // Step 8: Create tree base mesh and register thin instances
  const baseMesh = createTreeMesh(scene);
  baseMesh.thinInstanceSetBuffer('matrix', matrices, 16);

  const generationTimeMs = performance.now() - startTime;

  return {
    mesh: baseMesh,
    instanceCount: positionsWithHeight.length,
    generationTimeMs,
  };
}

/**
 * Remove all scattered trees from the scene.
 *
 * @param result - The ScatterResult to clean up
 */
export function clear(result: ScatterResult): void {
  if (result.mesh && !result.mesh.isDisposed()) {
    result.mesh.thinInstanceCount = 0;
  }
}
