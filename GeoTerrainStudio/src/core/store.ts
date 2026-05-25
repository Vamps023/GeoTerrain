import { create } from 'zustand';
import type { AppState, GeoBounds, TerrainProfile, GenerationPlan, JobProgress, ExportPreset, TerrainManifest, HeightmapFormat, AlbedoFormat } from '../types/terrain';

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
  setActiveTab: (tab) => set({ activeTab: tab }),
  setExportedData: (manifest, packagePath) => set({ exportedManifest: manifest, exportedPackagePath: packagePath }),
  resetGeneration: () => set({
    generationPlan: null,
    activeJobId: null,
    jobProgress: null,
  }),
}));
