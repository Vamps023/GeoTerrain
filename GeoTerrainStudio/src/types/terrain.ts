/**
 * Shared TypeScript type definitions for GeoTerrain Studio.
 * Mirrors the C++ domain model and the Terrain Package manifest.
 */

export interface ApiKeys {
  opentopography?: string;
  mapbox?: string;
  maptiler?: string;
}

export interface ElectronAPI {
  native: {
    getVersion: () => Promise<string>;
    planGeneration: (bounds: GeoBounds, profile: TerrainProfile) => Promise<GenerationPlan>;
    startGeneration: (sessionId: string, plan: GenerationPlan) => Promise<string>;
    cancelGeneration: (jobId: string) => Promise<void>;
    getProgress: (jobId: string) => Promise<JobProgress>;
    exportPackage: (
      sessionId: string,
      outputPath: string,
      preset: string,
      bounds: GeoBounds,
      heightmapFormat: HeightmapFormat,
      albedoFormat: AlbedoFormat,
      heightmapResolution?: number,
      albedoResolution?: number,
      imageryZoom?: number,
      demSource?: string,
      imagerySource?: string,
      apiKeys?: ApiKeys,
    ) => Promise<string>;
  };
  settings: {
    getApiKeys: () => Promise<ApiKeys>;
    setApiKeys: (apiKeys: ApiKeys) => Promise<boolean>;
  };
  dialog: {
    selectFolder: () => Promise<string | null>;
    selectPackage: () => Promise<string | null>;
    saveProject: () => Promise<string | null>;
    loadProject: () => Promise<string | null>;
  };
  fs: {
    readManifest: (packagePath: string) => Promise<unknown>;
    writeManifest: (packagePath: string, manifest: object) => Promise<boolean>;
    saveProject: (filePath: string, data: ProjectData) => Promise<boolean>;
    loadProject: (filePath: string) => Promise<ProjectData | null>;
    readFileBinary: (filePath: string) => Promise<Buffer>;
  };
  onProgressUpdate: (callback: (progress: JobProgress) => void) => () => void;
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileCoords {
  row: number;
  col: number;
}

export interface WorldOffset {
  x: number;
  y: number;
  z: number;
}

export interface TileFileSet {
  heightmap?: string;
  albedo?: string;
  roadMask?: string;
  waterMask?: string;
  vegetationMask?: string;
  buildingMask?: string;
  cliffMask?: string;
  splat?: string;
}

export interface ElevationRange {
  min: number;
  max: number;
  units: 'meters' | 'feet';
}

export interface TerrainTile {
  row: number;
  col: number;
  bounds: GeoBounds;
  worldOffset: WorldOffset;
  files: TileFileSet;
  elevation: ElevationRange;
}

export interface TileGridConfig {
  rows: number;
  cols: number;
  chunkSizeM: number;
  heightmapResolution: number;
  albedoResolution: number;
  pixelSizeM?: number;
}

export interface DataSourceInfo {
  id: string;
  name: string;
  attribution: string;
  queryDate?: string;
}

export interface ProcessingOptions {
  normalizeHeights: boolean;
  heightScale: number;
  seamStitching: boolean;
  fillNodata: boolean;
  generateRoadMasks: boolean;
  generateWaterMasks: boolean;
  generateVegetationMasks: boolean;
  generateBuildingMasks: boolean;
  generateCliffMasks: boolean;
  cliffThresholdDegrees: number;
}

export type ExportPreset = 'unigine' | 'unreal' | 'unity' | 'godot' | 'generic' | 'babylon';

export type HeightmapFormat = 'dem' | 'geotiff' | 'r16' | 'png' | 'float32';
export type AlbedoFormat = 'png' | 'geotiff';

export interface ExportPresetConfig {
  id: ExportPreset;
  name: string;
  description: string;
  fileFormats: {
    heightmap: string;
    albedo: string;
    masks: string;
  };
  heightmapBitDepth: 16 | 32;
  // Engine-specific options
  unigineOptions?: {
    lmapResolution: number;
    enableStreaming: boolean;
  };
  unrealOptions?: {
    zScale: number;
  };
}

export interface TerrainManifest {
  version: string;
  createdBy: string;
  createdAt: string;
  terrainName: string;
  description?: string;
  bounds: GeoBounds;
  crs: string;
  tileGrid: TileGridConfig;
  tiles: TerrainTile[];
  sources: {
    dem: DataSourceInfo;
    imagery: DataSourceInfo;
    osm?: DataSourceInfo;
  };
  exportPreset: ExportPreset;
  processing: ProcessingOptions;
}

export interface TerrainProfile {
  id: string;
  name: string;
  description: string;
  resolution: {
    heightmapSize: number;
    albedoSize: number;
    pixelSizeM: number;
  };
  sources: {
    demSource: string;
    imagerySource: string;
    enableOSM: boolean;
  };
  processing: ProcessingOptions;
}

export type DEMSource =
  | 'aws-terrarium'
  | 'mapzen'
  | 'mapbox-terrain-rgb'
  | 'opentopo-srtmgl1'
  | 'opentopo-srtmgl3'
  | 'opentopo-aw3d30'
  | 'opentopo-cop30'
  | 'opentopo-nasadem'
  | 'opentopo-usgs10m';
export type ImagerySource = 'arcgis' | 'mapbox' | 'maptiler';

export interface GenerationPlan {
  zoom: number;
  tiles: Array<{
    row: number;
    col: number;
    bounds: GeoBounds;
  }>;
  estimatedMemoryMb: number;
  estimatedDurationSec: number;
}

export interface JobProgress {
  jobId: string;
  state: 'idle' | 'planning' | 'downloading' | 'processing' | 'exporting' | 'complete' | 'cancelled' | 'error';
  overallProgress: number;
  currentTile?: string;
  tileProgress?: number;
  message?: string;
  error?: string;
}

export interface AppState {
  // Selection
  selectedBounds: GeoBounds | null;

  // Profile
  activeProfile: TerrainProfile;

  // Generation
  generationPlan: GenerationPlan | null;
  activeJobId: string | null;
  jobProgress: JobProgress | null;

  // Export
  outputPath: string | null;
  selectedPreset: ExportPreset;
  heightmapFormat: HeightmapFormat;
  albedoFormat: AlbedoFormat;
  exportedManifest: TerrainManifest | null;
  exportedPackagePath: string | null;

  // Quality settings
  demSource: DEMSource;
  imagerySource: ImagerySource;
  imageryZoom: number; // 0 = auto, or 10-19
  heightmapResolution: number;
  albedoResolution: number;

  // Tile-based export (new)
  tileSizeKm: number; // Size of each tile in km (1, 2, 4, 8)
  tileGrid: TileGrid | null; // Computed tile grid from selected bounds
  selectedTiles: Set<string>; // Set of "row,col" strings for selected tiles

  // UI
  activeTab: 'map' | 'layers' | 'jobs' | 'export' | 'view3d';
}

export interface TileGrid {
  rows: number;
  cols: number;
  tileSizeKm: number;
  tiles: TileDefinition[];
}

export interface TileDefinition {
  row: number;
  col: number;
  bounds: GeoBounds;
  center: { lng: number; lat: number };
  selected: boolean;
}

// ─── Project Save/Load ────────────────────────────────────────

export interface ProjectData {
  version: string;
  savedAt: string;
  // Selection bounds
  selectedBounds: GeoBounds | null;
  // Tile grid config
  tileSizeKm: number;
  tileGrid: TileGrid | null;
  selectedTiles: string[]; // Array of "row,col" strings (Set can't be JSON serialized)
  // Shapefile data (GeoJSON FeatureCollection)
  shapefileGeoJSON: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: {
        type: 'Polygon';
        coordinates: number[][][][];
      };
      properties: Record<string, unknown>;
    }>;
  } | null;
  shapefileBounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
  // Map view state
  mapCenter: { lng: number; lat: number };
  mapZoom: number;
}
