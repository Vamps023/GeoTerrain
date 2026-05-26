import { create } from 'zustand';
import type { AppState, GeoBounds, TerrainProfile, GenerationPlan, JobProgress, ExportPreset, TerrainManifest, HeightmapFormat, AlbedoFormat, DEMSource, ImagerySource, TileGrid } from '../types/terrain';

const defaultProfile: TerrainProfile = {
  id: 'balanced',
  name: 'Balanced',
  description: 'Good quality with reasonable download sizes',
  resolution: {
    heightmapSize: 1024,
    albedoSize: 1024,
    pixelSizeM: 10,
  },
  sources: {
    demSource: 'aws-terrain',
    imagerySource: 'arcgis-world-imagery',
    enableOSM: true,
  },
  processing: {
    normalizeHeights: true,
    heightScale: 1.0,
    seamStitching: true,
    fillNodata: true,
    generateRoadMasks: true,
    generateWaterMasks: true,
    generateVegetationMasks: false,
    generateBuildingMasks: false,
    generateCliffMasks: true,
    cliffThresholdDegrees: 45.0,
  },
};

export const useTerrainStore = create<AppState & {
  // Actions
  setSelectedBounds: (bounds: GeoBounds | null) => void;
  setActiveProfile: (profile: TerrainProfile) => void;
  setGenerationPlan: (plan: GenerationPlan | null) => void;
  setActiveJobId: (jobId: string | null) => void;
  setJobProgress: (progress: JobProgress | null) => void;
  setOutputPath: (path: string | null) => void;
  setSelectedPreset: (preset: ExportPreset) => void;
  setHeightmapFormat: (format: HeightmapFormat) => void;
  setAlbedoFormat: (format: AlbedoFormat) => void;
  setDEMSource: (source: DEMSource) => void;
  setImagerySource: (source: ImagerySource) => void;
  setImageryZoom: (zoom: number) => void;
  setHeightmapResolution: (res: number) => void;
  setAlbedoResolution: (res: number) => void;
  setTileSizeKm: (size: number) => void;
  setTileGrid: (grid: TileGrid | null) => void;
  toggleTileSelection: (row: number, col: number) => void;
  selectAllTiles: () => void;
  deselectAllTiles: () => void;
  setSelectedTiles: (tiles: Set<string>) => void;
  setActiveTab: (tab: AppState['activeTab']) => void;
  setExportedData: (manifest: TerrainManifest | null, packagePath: string | null) => void;
  resetGeneration: () => void;
}>((set) => ({
  // Initial state
  selectedBounds: null,
  activeProfile: defaultProfile,
  generationPlan: null,
  activeJobId: null,
  jobProgress: null,
  outputPath: null,
  selectedPreset: 'unigine',
  heightmapFormat: 'geotiff',
  albedoFormat: 'png',
  exportedManifest: null,
  exportedPackagePath: null,
  demSource: 'aws-terrarium',
  imagerySource: 'arcgis-world-imagery',
  imageryZoom: 0,
  heightmapResolution: 1024,
  albedoResolution: 1024,
  tileSizeKm: 4,
  tileGrid: null,
  selectedTiles: new Set<string>(),
  activeTab: 'map',

  // Actions
  setSelectedBounds: (bounds) => set({ selectedBounds: bounds }),
  setActiveProfile: (profile) => set({ activeProfile: profile }),
  setGenerationPlan: (plan) => set({ generationPlan: plan }),
  setActiveJobId: (jobId) => set({ activeJobId: jobId }),
  setJobProgress: (progress) => set({ jobProgress: progress }),
  setOutputPath: (path) => set({ outputPath: path }),
  setSelectedPreset: (preset) => set({ selectedPreset: preset }),
  setHeightmapFormat: (format) => set({ heightmapFormat: format }),
  setAlbedoFormat: (format) => set({ albedoFormat: format }),
  setDEMSource: (source) => set({ demSource: source }),
  setImagerySource: (source) => set({ imagerySource: source }),
  setImageryZoom: (zoom) => set({ imageryZoom: zoom }),
  setHeightmapResolution: (res) => set({ heightmapResolution: res }),
  setAlbedoResolution: (res) => set({ albedoResolution: res }),
  setTileSizeKm: (size) => set({ tileSizeKm: size }),
  setTileGrid: (grid) => set({ tileGrid: grid }),
  toggleTileSelection: (row, col) => set((state) => {
    const key = `${row},${col}`;
    const newSet = new Set(state.selectedTiles);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    return { selectedTiles: newSet };
  }),
  selectAllTiles: () => set((state) => {
    if (!state.tileGrid) return {};
    const all = new Set<string>();
    for (const tile of state.tileGrid.tiles) {
      all.add(`${tile.row},${tile.col}`);
    }
    return { selectedTiles: all };
  }),
  deselectAllTiles: () => set({ selectedTiles: new Set<string>() }),
  setSelectedTiles: (tiles) => set({ selectedTiles: tiles }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setExportedData: (manifest, packagePath) => set({ exportedManifest: manifest, exportedPackagePath: packagePath }),
  resetGeneration: () => set({
    generationPlan: null,
    activeJobId: null,
    jobProgress: null,
  }),
}));
