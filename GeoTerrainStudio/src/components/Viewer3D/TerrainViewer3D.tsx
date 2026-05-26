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
} from '@babylonjs/core';
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

export const TerrainViewer3D: React.FC<TerrainViewer3DProps> = ({ manifest, packagePath }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('Ready — Click to enable fly controls');
  const [controlsHint, setControlsHint] = useState(true);

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
  }, [manifest, packagePath]);

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
    tileSizeM: number
  ) => {
    const basePath = pkgPath.replace(/\\/g, '/');
    const heightmapPath = tile.files.heightmap ? `${basePath}/${tile.files.heightmap}` : null;
    const albedoPath    = tile.files.albedo    ? `${basePath}/${tile.files.albedo}`    : null;

    // Determine heightmap resolution from manifest
    const subDivs = manifest?.tileGrid?.heightmapResolution
      ? manifest.tileGrid.heightmapResolution - 1
      : 511; // default 512x512 mesh → 511 subdivisions

    const meshName = `tile_${tile.row}_${tile.col}`;
    const existing = scene.getMeshByName(meshName);
    if (existing) existing.dispose();

    let mesh: Mesh;

    if (heightmapPath) {
      try {
        // Read heightmap file and create blob URL
        const buf = await FsAPI.readFileBinary(heightmapPath);
        const isTiff = heightmapPath.toLowerCase().endsWith('.tif') || heightmapPath.toLowerCase().endsWith('.tiff');
        const blob = new Blob([buf], { type: isTiff ? 'image/tiff' : 'image/png' });
        const url = URL.createObjectURL(blob);

        // Use Babylon's native heightmap loader
        // Parameters: name, url, width, depth, subdivisions, minHeight, maxHeight, scene, onReady
        const elevationMin = tile.elevation.min;
        const elevationMax = tile.elevation.max;

        mesh = MeshBuilder.CreateGroundFromHeightMap(
          meshName,
          url,
          {
            width: tileSizeM,
            height: tileSizeM,
            subdivisions: Math.min(subDivs, 1024), // Cap at 1024 to prevent performance issues
            minHeight: elevationMin * HEIGHT_EXAGGERATION,
            maxHeight: elevationMax * HEIGHT_EXAGGERATION,
            onReady: () => {
              // Clean up blob URL after mesh is ready
              URL.revokeObjectURL(url);
            },
          },
          scene
        );
      } catch (e) {
        console.warn(`Tile ${tileIndex} heightmap failed, using flat ground:`, e);
        // Fallback to flat ground
        mesh = MeshBuilder.CreateGround(meshName, { width: tileSizeM, height: tileSizeM, subdivisions: 10 }, scene);
      }
    } else {
      // No heightmap — flat ground
      mesh = MeshBuilder.CreateGround(meshName, { width: tileSizeM, height: tileSizeM, subdivisions: 10 }, scene);
    }

    // Position the mesh at its world offset
    // CreateGroundFromHeightMap centers the mesh at origin, so we position after creation
    mesh.position.x = tile.worldOffset.x + tileSizeM / 2;
    mesh.position.z = tile.worldOffset.z + tileSizeM / 2;
    // Y position stays at 0 (heightmap handles vertical range via minHeight/maxHeight)

    // Apply albedo texture
    const mat = new StandardMaterial(`mat_${tileIndex}`, scene);
    if (albedoPath) {
      try {
        const albedoBuf = await FsAPI.readFileBinary(albedoPath);
        const isTiff = albedoPath.toLowerCase().endsWith('.tif') || albedoPath.toLowerCase().endsWith('.tiff');
        const blob = new Blob([albedoBuf], { type: isTiff ? 'image/tiff' : 'image/png' });
        const url = URL.createObjectURL(blob);
        mat.diffuseTexture = new Texture(url, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, () => {
          URL.revokeObjectURL(url);
        });
      } catch {
        mat.diffuseColor = new Color3(0.35, 0.45, 0.25);
      }
    } else {
      mat.diffuseColor = new Color3(0.35, 0.45, 0.25);
    }
    mat.specularColor = new Color3(0.04, 0.04, 0.04);
    mesh.material = mat;

    return mesh;
  };

  // ── Load all tiles from manifest ───────────────────────────────────
  const loadAllTiles = useCallback(
    async (manifest: TerrainManifest, pkgPath: string, scene: Scene) => {
      setIsLoading(true);
      setControlsHint(false);

      // Dispose old tile meshes
      scene.meshes.filter(m => m.name.startsWith('tile_')).forEach(m => m.dispose());

      const tiles = manifest.tiles;
      if (!tiles || tiles.length === 0) {
        setStatus('No tiles in manifest');
        setIsLoading(false);
        return;
      }

      // Read real tile size from manifest (in meters), fallback to default
      const tileSizeM = manifest.tileGrid?.chunkSizeM ?? DEFAULT_TILE_SIZE_M;
      const rows = manifest.tileGrid?.rows ?? 1;
      const cols = manifest.tileGrid?.cols ?? 1;
      const totalW = cols * tileSizeM;
      const totalD = rows * tileSizeM;

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
              x: (tile.col * tileSizeM) - totalW / 2,
              y: 0,
              z: (tile.row * tileSizeM) - totalD / 2,
            },
          };
          await buildTileMesh(scene, centeredTile, pkgPath, loaded, tileSizeM);
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
        camera.position = new Vector3(0, elevRange * 0.5 + viewDist * 0.3, -viewDist);
        camera.setTarget(new Vector3(0, 0, 0));
        camera.speed = Math.max(20, totalW / 100);
        camera.maxZ = totalW * 5;
      }

      setStatus(`✓ ${loaded} tile(s) loaded — WASD fly, Q/E up/down, mouse look, Shift sprint`);
      setIsLoading(false);
    },
    []
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
    </div>
  );
};
