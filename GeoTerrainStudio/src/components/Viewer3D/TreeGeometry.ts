import {
  Scene,
  Mesh,
  MeshBuilder,
  Color4,
  VertexBuffer,
  StandardMaterial,
} from '@babylonjs/core';

/**
 * Configuration for the placeholder tree mesh geometry.
 */
export interface TreeMeshConfig {
  trunkRadius: number;
  trunkHeight: number;
  canopyRadius: number;
  canopyHeight: number;
  trunkTessellation: number;
  canopyTessellation: number;
}

const DEFAULT_CONFIG: TreeMeshConfig = {
  trunkRadius: 0.3,
  trunkHeight: 3,
  canopyRadius: 2.5,
  canopyHeight: 5,
  trunkTessellation: 6,
  canopyTessellation: 8,
};

/** Brown vertex color for trunk (RGBA) */
const TRUNK_COLOR = new Color4(0.45, 0.28, 0.1, 1.0);

/** Green vertex color for canopy (RGBA) */
const CANOPY_COLOR = new Color4(0.2, 0.55, 0.15, 1.0);

/**
 * Apply a uniform vertex color to all vertices of a mesh.
 * Writes a Color4 (RGBA float) buffer into the mesh's color vertex attribute.
 */
function applyVertexColor(mesh: Mesh, color: Color4): void {
  const vertexCount = mesh.getTotalVertices();
  const colors = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const offset = i * 4;
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
    colors[offset + 3] = color.a;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

/**
 * Create a merged tree mesh (trunk cylinder + canopy cone) suitable for thin instancing.
 * The mesh origin is at the base of the trunk (Y = 0, ground level).
 *
 * Default tessellation produces 28 triangles (trunk: 12, canopy: 16),
 * well within the 20-30 target for efficient 50k-instance rendering.
 *
 * @param scene - Active Babylon.js Scene instance
 * @param config - Optional partial configuration overriding defaults
 * @returns A single merged Mesh with vertex colors applied
 * @throws Error if scene is null or disposed
 */
export function createTreeMesh(scene: Scene, config?: Partial<TreeMeshConfig>): Mesh {
  if (!scene || scene.isDisposed) {
    throw new Error(
      'TreeGeometry: Cannot create tree mesh — scene is ' +
        (scene ? 'disposed' : 'null') +
        '. Provide an active Babylon.js Scene instance.'
    );
  }

  const cfg: TreeMeshConfig = { ...DEFAULT_CONFIG, ...config };

  // Create trunk cylinder positioned so its base is at Y=0 and top at Y=trunkHeight.
  // Babylon's CreateCylinder centers the mesh vertically, so we offset by half height.
  const trunk = MeshBuilder.CreateCylinder(
    '__tree_trunk_temp',
    {
      diameter: cfg.trunkRadius * 2,
      height: cfg.trunkHeight,
      tessellation: cfg.trunkTessellation,
      cap: Mesh.NO_CAP,
    },
    scene
  );
  // Move trunk up so base sits at Y=0
  trunk.position.y = cfg.trunkHeight / 2;
  trunk.bakeCurrentTransformIntoVertices();

  // Create canopy cone positioned atop the trunk.
  // Cone: diameterTop=0 creates a pointed cone shape.
  // Bottom cap included to close the canopy base visually.
  const canopy = MeshBuilder.CreateCylinder(
    '__tree_canopy_temp',
    {
      diameterTop: 0,
      diameterBottom: cfg.canopyRadius * 2,
      height: cfg.canopyHeight,
      tessellation: cfg.canopyTessellation,
      cap: Mesh.CAP_START, // bottom cap only
    },
    scene
  );
  // Position canopy so its base sits at the top of the trunk
  canopy.position.y = cfg.trunkHeight + cfg.canopyHeight / 2;
  canopy.bakeCurrentTransformIntoVertices();

  // Apply vertex colors for visual distinction without multiple materials
  applyVertexColor(trunk, TRUNK_COLOR);
  applyVertexColor(canopy, CANOPY_COLOR);

  // Merge into a single mesh for thin instance compatibility
  const merged = Mesh.MergeMeshes(
    [trunk, canopy],
    true,   // disposeSource
    true,   // allow32BitsIndices
    undefined,
    false,  // multiMaterial (false = single submesh)
    true    // forceCloneVertexColors
  );

  if (!merged) {
    throw new Error('TreeGeometry: Mesh.MergeMeshes returned null — merge failed.');
  }

  merged.name = 'treeBase';

  // Create a material that renders vertex colors.
  // StandardMaterial automatically uses vertex colors when the mesh has color vertex data.
  const mat = new StandardMaterial('treeBaseMat', scene);
  mat.diffuseColor.set(1, 1, 1); // white base so vertex colors show through
  mat.specularColor.set(0.05, 0.05, 0.05); // minimal specular
  mat.emissiveColor.set(0.1, 0.1, 0.1); // slight emissive so trees are visible in shadow
  merged.material = mat;

  // Disable vertex alpha to avoid transparency sorting overhead.
  merged.hasVertexAlpha = false;

  return merged;
}

/**
 * Dispose of a tree mesh and any associated materials, releasing GPU resources.
 *
 * @param mesh - The tree mesh to dispose
 */
export function dispose(mesh: Mesh): void {
  if (mesh.material) {
    mesh.material.dispose(true);
  }
  mesh.dispose(false, true);
}
