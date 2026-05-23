import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Mesh,
  VertexData,
  StandardMaterial,
  Texture,
  Color3,
  Color4,
} from '@babylonjs/core';
import { fromUrl } from 'geotiff';
import type { TerrainManifest, TerrainTile } from '../../types/terrain';

interface TerrainViewer3DProps {
  manifest: TerrainManifest | null;
  packagePath: string | null;
}

export const TerrainViewer3D: React.FC<TerrainViewer3DProps> = ({ manifest, packagePath }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('Ready');

  // Initialize Babylon.js engine and scene
  useEffect(() => {
    if (!canvasRef.current || engineRef.current) return;

    const engine = new Engine(canvasRef.current, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    engineRef.current = engine;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);
    sceneRef.current = scene;

    // Camera
    const camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,
      Math.PI / 3,
      200,
      Vector3.Zero(),
      scene
    );
    camera.attachControl(canvasRef.current, true);
    camera.lowerRadiusLimit = 10;
    camera.upperRadiusLimit = 1000;
    camera.wheelPrecision = 50;

    // Lights
    const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemiLight.intensity = 0.6;
    hemiLight.groundColor = new Color3(0.1, 0.1, 0.15);

    const dirLight = new DirectionalLight('dir', new Vector3(-1, -2, -1), scene);
    dirLight.position = new Vector3(100, 200, 100);
    dirLight.intensity = 0.8;

    // Render loop
    engine.runRenderLoop(() => {
      scene.render();
    });

    // Resize handler
    const handleResize = () => engine.resize();
    window.addEventListener('resize', handleResize);

    // Demo terrain on first load
    buildDemoTerrain(scene);
    setStatus('Demo terrain loaded');

    return () => {
      window.removeEventListener('resize', handleResize);
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  // Build terrain when manifest changes
  useEffect(() => {
    if (!manifest || !packagePath || !sceneRef.current) return;
    loadTerrainFromManifest(manifest, packagePath, sceneRef.current);
  }, [manifest, packagePath]);

  const buildDemoTerrain = useCallback((scene: Scene) => {
    // Clear existing terrain meshes
    const existing = scene.getMeshByName('terrain');
    if (existing) existing.dispose();

    const width = 128;
    const height = 128;
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const nz = z / height;
        const elevation =
          Math.sin(nx * Math.PI * 4) * Math.cos(nz * Math.PI * 4) * 15 +
          Math.sin(nx * Math.PI * 8 + 1) * Math.cos(nz * Math.PI * 8 + 1) * 5 +
          Math.sin(nx * Math.PI * 2) * 10;

        positions.push(x - width / 2, elevation, z - height / 2);
        uvs.push(nx, 1 - nz);
      }
    }

    for (let z = 0; z < height - 1; z++) {
      for (let x = 0; x < width - 1; x++) {
        const a = z * width + x;
        const b = z * width + x + 1;
        const c = (z + 1) * width + x;
        const d = (z + 1) * width + x + 1;
        indices.push(a, b, d);
        indices.push(a, d, c);
      }
    }

    VertexData.ComputeNormals(positions, indices, normals);

    const terrain = new Mesh('terrain', scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.normals = normals;
    vertexData.applyToMesh(terrain);

    const material = new StandardMaterial('terrainMat', scene);
    material.diffuseColor = new Color3(0.4, 0.5, 0.3);
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    material.wireframe = false;
    terrain.material = material;

    // Camera target
    const camera = scene.getCameraByName('camera') as ArcRotateCamera;
    if (camera) {
      camera.setTarget(Vector3.Zero());
      camera.radius = 150;
    }
  }, []);

  const loadTerrainFromManifest = useCallback(
    async (manifest: TerrainManifest, pkgPath: string, scene: Scene) => {
      setIsLoading(true);
      setStatus('Loading terrain...');

      try {
        // For now, use the first tile
        const tile: TerrainTile | undefined = manifest.tiles[0];
        if (!tile) {
          setStatus('No tiles in manifest');
          setIsLoading(false);
          return;
        }

        const heightmapPath = tile.files.heightmap
          ? `${pkgPath.replace(/\\/g, '/')}/${tile.files.heightmap}`
          : null;
        const albedoPath = tile.files.albedo
          ? `${pkgPath.replace(/\\/g, '/')}/${tile.files.albedo}`
          : null;

        if (!heightmapPath) {
          setStatus('No heightmap found, using demo terrain');
          buildDemoTerrain(scene);
          setIsLoading(false);
          return;
        }

        // In web mode, file:// URLs are blocked by CSP, so use demo terrain
        if (typeof window !== 'undefined' && window.location.protocol === 'http:') {
          setStatus('Web mode: using demo terrain (file access restricted)');
          buildDemoTerrain(scene);
          setIsLoading(false);
          return;
        }

        // Read GeoTIFF
        setStatus('Reading heightmap...');
        const tiff = await fromUrl(`file://${heightmapPath}`).catch(() => null);
        let elevations: Float32Array | null = null;
        let imgWidth = 128;
        let imgHeight = 128;

        if (tiff) {
          const image = await tiff.getImage();
          const data = await image.readRasters();
          elevations = data[0] as Float32Array;
          imgWidth = image.getWidth();
          imgHeight = image.getHeight();
        } else {
          // Fallback: try loading as image
          setStatus('GeoTIFF read failed, using demo terrain');
          buildDemoTerrain(scene);
          setIsLoading(false);
          return;
        }

        // Build mesh
        setStatus('Building mesh...');
        buildTerrainMesh(scene, imgWidth, imgHeight, elevations, albedoPath);
        setStatus(`Terrain loaded: ${imgWidth}x${imgHeight}`);
      } catch (err) {
        console.error('Failed to load terrain:', err);
        setStatus('File access blocked, using demo terrain');
        buildDemoTerrain(scene);
      } finally {
        setIsLoading(false);
      }
    },
    [buildDemoTerrain]
  );

  const buildTerrainMesh = (
    scene: Scene,
    width: number,
    height: number,
    elevations: Float32Array | null,
    albedoPath: string | null
  ) => {
    const existing = scene.getMeshByName('terrain');
    if (existing) existing.dispose();

    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];

    // Min/max elevation for normalization
    let minH = 0;
    let maxH = 100;
    if (elevations) {
      minH = Infinity;
      maxH = -Infinity;
      for (let i = 0; i < elevations.length; i++) {
        const v = elevations[i];
        if (!isNaN(v) && v !== Infinity && v !== -Infinity) {
          minH = Math.min(minH, v);
          maxH = Math.max(maxH, v);
        }
      }
      if (minH === Infinity) { minH = 0; maxH = 100; }
    }

    const scaleXZ = Math.max(width, height) / 2;
    const heightScale = (maxH - minH) * 0.5;

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        let h = 0;
        if (elevations && idx < elevations.length) {
          h = ((elevations[idx] - minH) / (maxH - minH || 1)) * heightScale;
        }
        positions.push(
          (x / (width - 1)) * scaleXZ * 2 - scaleXZ,
          h,
          (z / (height - 1)) * scaleXZ * 2 - scaleXZ
        );
        uvs.push(x / (width - 1), 1 - z / (height - 1));
      }
    }

    for (let z = 0; z < height - 1; z++) {
      for (let x = 0; x < width - 1; x++) {
        const a = z * width + x;
        const b = z * width + x + 1;
        const c = (z + 1) * width + x;
        const d = (z + 1) * width + x + 1;
        indices.push(a, b, d);
        indices.push(a, d, c);
      }
    }

    VertexData.ComputeNormals(positions, indices, normals);

    const terrain = new Mesh('terrain', scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.uvs = uvs;
    vertexData.normals = normals;
    vertexData.applyToMesh(terrain);

    const material = new StandardMaterial('terrainMat', scene);

    if (albedoPath) {
      try {
        const tex = new Texture(`file://${albedoPath}`, scene);
        material.diffuseTexture = tex;
      } catch {
        material.diffuseColor = new Color3(0.4, 0.5, 0.3);
      }
    } else {
      material.diffuseColor = new Color3(0.4, 0.5, 0.3);
    }

    material.specularColor = new Color3(0.05, 0.05, 0.05);
    terrain.material = material;

    // Camera target at center, adjusted for height
    const camera = scene.getCameraByName('camera') as ArcRotateCamera;
    if (camera) {
      camera.setTarget(new Vector3(0, heightScale * 0.3, 0));
      camera.radius = scaleXZ * 3;
      camera.beta = Math.PI / 3;
    }
  };

  return (
    <div className="relative w-full h-full bg-[#0a0a0f]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full outline-none"
        style={{ touchAction: 'none' }}
      />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
          <div className="text-white text-sm animate-pulse">{status}</div>
        </div>
      )}
      {!isLoading && status && (
        <div className="absolute bottom-3 left-3 bg-black/60 text-white text-[10px] px-2 py-1 rounded z-10">
          {status}
        </div>
      )}
    </div>
  );
};
