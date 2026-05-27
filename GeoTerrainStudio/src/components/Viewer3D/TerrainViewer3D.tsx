import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  Engine,
  Scene,
  UniversalCamera,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  VertexData,
  StandardMaterial,
  Texture,
  Color3,
  Color4,
  HighlightLayer,
} from '@babylonjs/core';
import { fromArrayBuffer } from 'geotiff';
import type { TerrainManifest, TerrainTile } from '../../types/terrain';
import { FsAPI } from '../../core/ipc';

interface TerrainViewer3DProps {
  manifest: TerrainManifest | null;
  packagePath: string | null;
}

// Babylon.js best practice: 1 unit = 1 meter (real-world scale)
// Tile world size will be read from manifest.tileGrid.chunkSizeM at runtime
const DEFAULT_TILE_SIZE_M = 4000; // 4 km fallback
const HEIGHT_EXAGGERATION = 1.5;  // mild vertical scale for visual clarity (1.0 = true-to-life)

function tileCoordsFromPath(filePath?: string): { row: number; col: number } | null {
  if (!filePath) return null;
  // Try folder-based pattern first: tile_R_C/ or \tile_R_C\
  const folderMatch = filePath.match(/(?:^|[\\/])tile_(\d+)_(\d+)(?:[\\/]|$)/);
  if (folderMatch) return { row: Number(folderMatch[1]), col: Number(folderMatch[2]) };
  // Fallback: flat filename pattern like tile_0_1_heightmap.png
  const fileMatch = filePath.match(/tile_(\d+)_(\d+)_/);
  if (fileMatch) return { row: Number(fileMatch[1]), col: Number(fileMatch[2]) };
  return null;
}

/**
 * Detect heightmap format from file extension.
 */
function getHeightmapFormat(filePath: string): 'png' | 'tif' | 'r16' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'tif';
  if (lower.endsWith('.r16')) return 'r16';
  return 'png';
}

/**
 * Convert a grayscale pixel array (normalized 0–255) to a PNG Blob using an offscreen canvas.
 * @param grayscale - Uint8Array of grayscale values (width * height)
 * @param width - image width
 * @param height - image height
 */
async function grayscaleToPngBlob(grayscale: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  for (let i = 0; i < grayscale.length; i++) {
    const v = grayscale[i];
    const offset = i * 4;
    data[offset] = v;     // R
    data[offset + 1] = v; // G
    data[offset + 2] = v; // B
    data[offset + 3] = 255; // A
  }
  ctx.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode canvas as PNG'));
    }, 'image/png');
  });
}

/**
 * Parse a GeoTIFF buffer and return a normalized PNG Blob (0–255 grayscale).
 * Uses the `geotiff` library to extract raster data.
 */
async function geotiffToPngBlob(buffer: ArrayBuffer): Promise<{ blob: Blob; width: number; height: number }> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters();
  // Use the first band (elevation data)
  const band = rasters[0] as Float32Array | Float64Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

  // Find min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!isFinite(min) || !isFinite(max) || min === max) {
    min = 0;
    max = 1;
  }

  // Normalize to 0–255
  const range = max - min;
  const grayscale = new Uint8Array(width * height);
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    const normalized = isFinite(v) ? ((v - min) / range) * 255 : 0;
    grayscale[i] = Math.round(Math.max(0, Math.min(255, normalized)));
  }

  const blob = await grayscaleToPngBlob(grayscale, width, height);
  return { blob, width, height };
}

/**
 * Parse a raw 16-bit (R16) buffer and return a normalized PNG Blob (0–255 grayscale).
 * R16 format: raw 16-bit unsigned little-endian integers, square dimensions assumed.
 */
async function r16ToPngBlob(buffer: ArrayBuffer): Promise<{ blob: Blob; width: number; height: number }> {
  const uint16 = new Uint16Array(buffer);
  const pixelCount = uint16.length;
  // Assume square dimensions
  const side = Math.round(Math.sqrt(pixelCount));
  const width = side;
  const height = side;

  // Find min/max for normalization
  let min = 65535;
  let max = 0;
  for (let i = 0; i < pixelCount; i++) {
    const v = uint16[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    min = 0;
    max = 1;
  }

  // Normalize to 0–255
  const range = max - min;
  const grayscale = new Uint8Array(width * height);
  for (let i = 0; i < Math.min(pixelCount, width * height); i++) {
    const normalized = ((uint16[i] - min) / range) * 255;
    grayscale[i] = Math.round(Math.max(0, Math.min(255, normalized)));
  }

  const blob = await grayscaleToPngBlob(grayscale, width, height);
  return { blob, width, height };
}

/**
 * Convert a heightmap buffer to a PNG Blob URL suitable for Babylon.js CreateGroundFromHeightMap.
 * Detects format from file extension and applies appropriate conversion.
 * Returns the blob URL and optionally the detected resolution.
 */
async function heightmapToPngBlobUrl(
  buffer: ArrayBuffer,
  filePath: string
): Promise<{ url: string; width?: number; height?: number }> {
  const format = getHeightmapFormat(filePath);

  switch (format) {
    case 'tif': {
      const { blob, width, height } = await geotiffToPngBlob(buffer);
      const url = URL.createObjectURL(blob);
      return { url, width, height };
    }
    case 'r16': {
      const { blob, width, height } = await r16ToPngBlob(buffer);
      const url = URL.createObjectURL(blob);
      return { url, width, height };
    }
    case 'png':
    default: {
      // PNG: use existing path — create blob directly
      const blob = new Blob([buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      return { url };
    }
  }
}

export const TerrainViewer3D: React.FC<TerrainViewer3DProps> = ({ manifest, packagePath }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const highlightLayerRef = useRef<HighlightLayer | null>(null);
  const selectedMeshRef = useRef<Mesh | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('Ready — Click to enable fly controls');
  const [controlsHint, setControlsHint] = useState(true);
  const [selectedTile, setSelectedTile] = useState<TerrainTile | null>(null);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [tileRotation, setTileRotation] = useState(0);

  // Initialize engine + FPS camera
  useEffect(() => {
    if (!canvasRef.current || engineRef.current) return;

    const canvas = canvasRef.current;
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    engineRef.current = engine;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);
    sceneRef.current = scene;

    // ── UniversalCamera (FPS / Unreal-style) ─────────────────────────
    const camera = new UniversalCamera('flyCamera', new Vector3(0, 120, -300), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.fov = 1.1;
    camera.minZ = 0.5;
    camera.maxZ = 8000;

    // WASD + QE keys
    camera.keysUp    = [87]; // W
    camera.keysDown  = [83]; // S
    camera.keysLeft  = [65]; // A
    camera.keysRight = [68]; // D
    // Q = down, E = up
    (camera as UniversalCamera & { keysUpward: number[]; keysDownward: number[] }).keysUpward   = [69];
    (camera as UniversalCamera & { keysUpward: number[]; keysDownward: number[] }).keysDownward = [81];
    camera.speed = 8;
    camera.angularSensibility = 800; // mouse sensitivity
    camera.attachControl(canvas, true);

    // Shift = sprint
    scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.event.shiftKey) {
        camera.speed = 30;
      } else {
        camera.speed = 8;
      }
    });

    // Lights
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    hemi.groundColor = new Color3(0.15, 0.15, 0.2);

    const sun = new DirectionalLight('sun', new Vector3(-1, -2, -0.5), scene);
    sun.position = new Vector3(500, 1000, 500);
    sun.intensity = 1.0;

    // Highlight layer for tile selection
    const hl = new HighlightLayer('hl1', scene);
    hl.blurHorizontalSize = 0.8;
    hl.blurVerticalSize = 0.8;
    highlightLayerRef.current = hl;

    // Click handler for tile selection
    scene.onPointerDown = (_evt, pickResult) => {
      if (pickResult.hit && pickResult.pickedMesh) {
        const mesh = pickResult.pickedMesh as Mesh;
        const tileData = mesh.metadata as TerrainTile | undefined;
        if (tileData) {
          setSelectedTile(tileData);
          selectedMeshRef.current = mesh;
          setFlipX(false);
          setFlipY(false);
          setTileRotation(0);
          hl.removeAllMeshes();
          hl.addMesh(mesh, new Color3(1, 0.8, 0.2));
        } else {
          setSelectedTile(null);
          selectedMeshRef.current = null;
          setFlipX(false);
          setFlipY(false);
          setTileRotation(0);
          hl.removeAllMeshes();
        }
      } else {
        setSelectedTile(null);
        selectedMeshRef.current = null;
        setFlipX(false);
        setFlipY(false);
        setTileRotation(0);
        hl.removeAllMeshes();
      }
    };

    // Render loop
    engine.runRenderLoop(() => scene.render());
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);

    // Demo terrain until real data loaded
    buildDemoTerrain(scene);

    return () => {
      window.removeEventListener('resize', onResize);
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when manifest changes
  useEffect(() => {
    if (!manifest || !packagePath || !sceneRef.current) return;
    loadAllTiles(manifest, packagePath, sceneRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, packagePath]);

  // Apply flip transformations to selected mesh
  // Note: Default scaling.z is -1 for Babylon terrain orientation
  useEffect(() => {
    if (selectedMeshRef.current) {
      selectedMeshRef.current.scaling.x = flipX ? -1 : 1;
      selectedMeshRef.current.scaling.z = flipY ? 1 : -1;
    }
  }, [flipX, flipY]);

  // Apply rotation to selected mesh
  useEffect(() => {
    if (selectedMeshRef.current) {
      selectedMeshRef.current.rotation.y = tileRotation * (Math.PI / 180);
    }
  }, [tileRotation]);

  // ── Demo terrain ───────────────────────────────────────────────────
  const buildDemoTerrain = useCallback((scene: Scene) => {
    scene.meshes.filter(m => m.name.startsWith('tile_')).forEach(m => m.dispose());
    const W = 128, H = 128;
    const SIZE = 1000; // demo terrain is 1km wide
    const positions: number[] = [], indices: number[] = [], uvs: number[] = [], normals: number[] = [];
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const nx = x / W, nz = z / H;
        const elev = Math.sin(nx * Math.PI * 4) * Math.cos(nz * Math.PI * 4) * 30 + Math.sin(nx * Math.PI * 2) * 20;
        positions.push((nx - 0.5) * SIZE, elev, (nz - 0.5) * SIZE);
        uvs.push(nx, 1 - nz);
      }
    }
    for (let z = 0; z < H - 1; z++) for (let x = 0; x < W - 1; x++) {
      const a = z * W + x, b = a + 1, c = (z + 1) * W + x, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh('tile_demo', scene);
    const vd = new VertexData();
    vd.positions = positions; vd.indices = indices; vd.uvs = uvs; vd.normals = normals;
    vd.applyToMesh(mesh);
    const mat = new StandardMaterial('demoMat', scene);
    mat.diffuseColor = new Color3(0.3, 0.45, 0.25);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mesh.material = mat;
  }, []);

  // ── Build one tile using Babylon's native CreateGroundFromHeightMap ──
  // This is cleaner than manual VertexData and handles texture loading internally
  const buildTileMesh = async (
    scene: Scene,
    tile: TerrainTile,
    pkgPath: string,
    tileIndex: number,
    tileWidthM: number,
    tileHeightM: number
  ) => {
    const basePath = pkgPath.replace(/\\/g, '/');
    const heightmapPath = tile.files.heightmap ? `${basePath}/${tile.files.heightmap}` : null;
    const albedoPath    = tile.files.albedo    ? `${basePath}/${tile.files.albedo}`    : null;

    // Determine heightmap resolution from manifest
    const subDivs = manifest?.tileGrid?.heightmapResolution
      ? manifest.tileGrid.heightmapResolution - 1
      : 511; // default 512x512 mesh → 511 subdivisions

    const meshName = `tile_${tile.row}_${tile.col}_${tileIndex}`;
    const existing = scene.getMeshByName(meshName);
    if (existing) existing.dispose();

    let mesh: Mesh;

    if (heightmapPath) {
      // Track blob URL for cleanup on failure
      let heightmapBlobUrl: string | null = null;
      try {
        // Read heightmap file and convert to PNG blob URL
        // (handles .tif, .r16, and .png formats)
        const buf = await FsAPI.readFileBinary(heightmapPath);
        const { url } = await heightmapToPngBlobUrl(buf, heightmapPath);
        heightmapBlobUrl = url;

        // Use Babylon's native heightmap loader
        // Parameters: name, url, width, depth, subdivisions, minHeight, maxHeight, scene, onReady
        const elevationMin = Number.isFinite(tile.elevation.min) ? tile.elevation.min : 0;
        const elevationMax = Number.isFinite(tile.elevation.max) ? tile.elevation.max : 100;
        const elevationRange = Math.max(2, elevationMax - elevationMin);

        mesh = MeshBuilder.CreateGroundFromHeightMap(
          meshName,
          url,
          {
            width: tileWidthM,
            height: tileHeightM,
            subdivisions: Math.min(subDivs, 1024), // Cap at 1024 to prevent performance issues
            minHeight: 0,
            maxHeight: elevationRange * HEIGHT_EXAGGERATION,
            onReady: () => {
              // Clean up blob URL after mesh is ready
              URL.revokeObjectURL(url);
              heightmapBlobUrl = null;
            },
          },
          scene
        );
      } catch (e) {
        // Revoke blob URL on failure to prevent memory leak
        if (heightmapBlobUrl) URL.revokeObjectURL(heightmapBlobUrl);
        console.warn(`Tile ${tileIndex} heightmap failed, using flat ground:`, e);
        // Fallback to flat ground
        mesh = MeshBuilder.CreateGround(meshName, { width: tileWidthM, height: tileHeightM, subdivisions: 10 }, scene);
      }
    } else {
      // No heightmap — flat ground
      mesh = MeshBuilder.CreateGround(meshName, { width: tileWidthM, height: tileHeightM, subdivisions: 10 }, scene);
    }

    // Position the mesh at its world offset
    // CreateGroundFromHeightMap centers the mesh at origin, so we position after creation
    mesh.position.x = tile.worldOffset.x + tileWidthM / 2;
    mesh.position.z = tile.worldOffset.z + tileHeightM / 2;
    mesh.position.y = 0;

    // Apply albedo texture
    const mat = new StandardMaterial(`mat_${tileIndex}`, scene);
    if (albedoPath) {
      let albedoBlobUrl: string | null = null;
      try {
        const albedoBuf = await FsAPI.readFileBinary(albedoPath);
        const isTiff = albedoPath.toLowerCase().endsWith('.tif') || albedoPath.toLowerCase().endsWith('.tiff');
        const blob = new Blob([albedoBuf], { type: isTiff ? 'image/tiff' : 'image/png' });
        albedoBlobUrl = URL.createObjectURL(blob);
        const tex = new Texture(albedoBlobUrl, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, () => {
          URL.revokeObjectURL(albedoBlobUrl!);
          albedoBlobUrl = null;
        });
        // Flip V so albedo aligns correctly with terrain
        tex.vScale = -1;
        tex.vOffset = 1;
        mat.diffuseTexture = tex;
      } catch {
        // Revoke blob URL on failure to prevent memory leak
        if (albedoBlobUrl) URL.revokeObjectURL(albedoBlobUrl);
        mat.diffuseColor = new Color3(0.35, 0.45, 0.25);
      }
    } else {
      mat.diffuseColor = new Color3(0.35, 0.45, 0.25);
    }
    mat.specularColor = new Color3(0.04, 0.04, 0.04);
    mesh.material = mat;

    // Store tile data in mesh metadata for click detection
    mesh.metadata = tile;

    return mesh;
  };

  // ── Load all tiles from manifest ───────────────────────────────────
  const loadAllTiles = useCallback(
    async (manifest: TerrainManifest, pkgPath: string, scene: Scene) => {
      setIsLoading(true);
      setControlsHint(false);

      // Dispose old tile meshes
      scene.meshes.filter(m => m.name.startsWith('tile_')).forEach(m => m.dispose());

      const sourceTiles = manifest.tiles;
      if (!sourceTiles || sourceTiles.length === 0) {
        setStatus('No tiles in manifest');
        setIsLoading(false);
        return;
      }

      const seenTileKeys = new Set<string>();
      const hasDuplicateCoords = sourceTiles.some((tile) => {
        const key = `${tile.row},${tile.col}`;
        if (seenTileKeys.has(key)) return true;
        seenTileKeys.add(key);
        return false;
      });

      const tiles = sourceTiles.map((tile) => {
        if (!hasDuplicateCoords) return tile;
        const coords = tileCoordsFromPath(tile.files.heightmap) ?? tileCoordsFromPath(tile.files.albedo);
        return coords ? { ...tile, row: coords.row, col: coords.col } : tile;
      });

      // Read real tile size from manifest (in meters), fallback to default.
      // Tile folders can contain global row/col values even when only one tile is loaded.
      const tileSizeM = manifest.tileGrid?.chunkSizeM ?? DEFAULT_TILE_SIZE_M;
      const tileWidthM = manifest.tileGrid?.tileWidthM ?? tileSizeM;
      const tileHeightM = manifest.tileGrid?.tileHeightM ?? tileSizeM;
      const minRow = Math.min(...tiles.map((t) => t.row));
      const maxRow = Math.max(...tiles.map((t) => t.row));
      const minCol = Math.min(...tiles.map((t) => t.col));
      const maxCol = Math.max(...tiles.map((t) => t.col));
      const rows = Math.max(1, maxRow - minRow + 1);
      const cols = Math.max(1, maxCol - minCol + 1);
      const totalW = cols * tileWidthM;
      const totalD = rows * tileHeightM;
      // Global elevation range (for camera positioning only)
      let globalMinH = Infinity, globalMaxH = -Infinity;
      for (const t of tiles) {
        globalMinH = Math.min(globalMinH, t.elevation.min);
        globalMaxH = Math.max(globalMaxH, t.elevation.max);
      }
      if (!isFinite(globalMinH)) { globalMinH = 0; globalMaxH = 100; }

      setStatus(`Loading ${tiles.length} tile(s)...`);

      let loaded = 0;
      for (const tile of tiles) {
        try {
          // Offset so the whole grid is centered at origin
          const centeredTile: TerrainTile = {
            ...tile,
            worldOffset: {
              x: ((tile.col - minCol) * tileWidthM) - totalW / 2,
              y: 0,
              z: ((tile.row - minRow) * tileHeightM) - totalD / 2,
            },
          };
          await buildTileMesh(scene, centeredTile, pkgPath, loaded, tileWidthM, tileHeightM);
          loaded++;
          setStatus(`Loading tiles... ${loaded}/${tiles.length}`);
        } catch (e) {
          console.error('Tile load error:', e);
        }
      }

      // Camera positioned proportionally to terrain extent
      const camera = scene.getCameraByName('flyCamera') as UniversalCamera;
      if (camera) {
        const elevRange = (globalMaxH - globalMinH) * HEIGHT_EXAGGERATION;
        const viewDist = Math.max(totalW, totalD) * 0.8;
        const targetY = Math.max(1, elevRange * 0.5);
        camera.position = new Vector3(0, targetY + viewDist * 0.35, -viewDist);
        camera.setTarget(new Vector3(0, targetY, 0));
        camera.speed = Math.max(20, totalW / 100);
        camera.maxZ = Math.max(totalW, totalD, elevRange) * 8;
      }

      setStatus(`✓ ${loaded} tile(s) loaded — WASD fly, Q/E up/down, mouse look, Shift sprint`);
      setIsLoading(false);
    },
    [manifest, packagePath]
  );

  return (
    <div className="relative w-full h-full bg-[#080c10]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full outline-none"
        style={{ touchAction: 'none' }}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 gap-3">
          <div className="w-10 h-10 border-2 border-[#4a7c3f] border-t-transparent rounded-full animate-spin" />
          <div className="text-[#7ab86f] text-sm">{status}</div>
        </div>
      )}

      {/* Status bar */}
      {!isLoading && (
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between z-10">
          <div className="bg-black/70 text-[#c4a96b] text-[10px] px-2 py-1 rounded">
            {status}
          </div>
          {controlsHint && (
            <div className="bg-black/70 text-gray-400 text-[10px] px-3 py-1.5 rounded space-y-0.5 text-right">
              <div><span className="text-white font-mono">WASD</span> fly · <span className="text-white font-mono">Q/E</span> down/up</div>
              <div><span className="text-white font-mono">Shift</span> sprint · <span className="text-white font-mono">Mouse</span> look</div>
            </div>
          )}
        </div>
      )}

      {/* Selected tile info panel */}
      {selectedTile && !isLoading && (
        <div className="absolute top-3 right-3 bg-black/80 text-gray-300 text-[11px] px-3 py-2 rounded z-10 max-w-xs space-y-1">
          <div className="text-[#c4a96b] font-semibold mb-1">Tile Information</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span className="text-gray-500">Row:</span>
            <span className="text-white font-mono">{selectedTile.row}</span>
            <span className="text-gray-500">Col:</span>
            <span className="text-white font-mono">{selectedTile.col}</span>
            <span className="text-gray-500">Elevation:</span>
            <span className="text-white font-mono">{selectedTile.elevation.min.toFixed(1)}m - {selectedTile.elevation.max.toFixed(1)}m</span>
            <span className="text-gray-500">Offset X:</span>
            <span className="text-white font-mono">{selectedTile.worldOffset.x.toFixed(1)}m</span>
            <span className="text-gray-500">Offset Z:</span>
            <span className="text-white font-mono">{selectedTile.worldOffset.z.toFixed(1)}m</span>
          </div>
          <div className="mt-2 pt-2 border-t border-gray-700">
            <div className="text-gray-500 mb-1">Flip</div>
            <div className="flex gap-2">
              <button
                onClick={() => setFlipX(!flipX)}
                className={`flex-1 px-2 py-1 rounded text-[10px] ${flipX ? 'bg-[#4a7c3f] text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                Flip X
              </button>
              <button
                onClick={() => setFlipY(!flipY)}
                className={`flex-1 px-2 py-1 rounded text-[10px] ${flipY ? 'bg-[#4a7c3f] text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                Flip Y
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
