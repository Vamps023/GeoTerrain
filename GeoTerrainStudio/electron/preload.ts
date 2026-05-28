import { contextBridge, ipcRenderer } from 'electron';

// Type-safe IPC API exposed to renderer
export interface MaskSettings {
  generateRoadMask: boolean;
  generateWaterMask: boolean;
  generateVegetationMask: boolean;
  generateBuildingMask: boolean;
  generateCliffMask: boolean;
  cliffThresholdDegrees: number;
  roadLineWidthPx: number;
}

export interface Extract3DSettings {
  extractBuildings: boolean;
  extractRoads: boolean;
  defaultBuildingHeight: number;
  roadElevationOffset: number;
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
      heightmapFormat: string,
      albedoFormat: string,
      heightmapResolution?: number,
      albedoResolution?: number,
      imageryZoom?: number,
      demSource?: string,
      imagerySource?: string,
      apiKeys?: { opentopography?: string; mapbox?: string; maptiler?: string },
      tileRow?: number,
      tileCol?: number,
      maskSettings?: MaskSettings,
      extract3DSettings?: Extract3DSettings,
    ) => Promise<string>;
  };
  settings: {
    getApiKeys: () => Promise<{ opentopography?: string; mapbox?: string; maptiler?: string }>;
    setApiKeys: (apiKeys: { opentopography?: string; mapbox?: string; maptiler?: string }) => Promise<boolean>;
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
    saveProject: (filePath: string, data: object) => Promise<boolean>;
    loadProject: (filePath: string) => Promise<object | null>;
    readFileBinary: (filePath: string) => Promise<Buffer>;
  };
  onProgressUpdate: (callback: (progress: JobProgress) => void) => () => void;
}

export interface MaskSettings {
  generateRoadMask: boolean;
  generateWaterMask: boolean;
  generateVegetationMask: boolean;
  generateBuildingMask: boolean;
  generateCliffMask: boolean;
  cliffThresholdDegrees: number;  // 0-90, default 45
  roadLineWidthPx: number;        // 1-10, default 3
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TerrainProfile {
  name: string;
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
  processing: {
    normalizeHeights: boolean;
    heightScale: number;
    seamStitching: boolean;
  };
}

export interface GenerationPlan {
  zoom: number;
  tiles: Array<{ row: number; col: number; bounds: GeoBounds }>;
  estimatedMemoryMb: number;
  estimatedDurationSec: number;
}

export interface JobProgress {
  jobId: string;
  state: 'idle' | 'planning' | 'downloading' | 'processing' | 'exporting' | 'complete' | 'cancelled' | 'error';
  overallProgress: number; // 0.0 - 1.0
  currentTile?: string;
  tileProgress?: number;
  message?: string;
  error?: string;
}

const api: ElectronAPI = {
  native: {
    getVersion: () => ipcRenderer.invoke('native:getVersion'),
    planGeneration: (bounds, profile) => ipcRenderer.invoke('native:planGeneration', bounds, profile),
    startGeneration: (sessionId, plan) => ipcRenderer.invoke('native:startGeneration', sessionId, plan),
    cancelGeneration: (jobId) => ipcRenderer.invoke('native:cancelGeneration', jobId),
    getProgress: (jobId) => ipcRenderer.invoke('native:getProgress', jobId),
    exportPackage: (sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource, apiKeys, tileRow, tileCol, maskSettings, extract3DSettings) =>
      ipcRenderer.invoke('native:exportPackage', sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource, apiKeys, tileRow, tileCol, maskSettings, extract3DSettings),
  },
  settings: {
    getApiKeys: () => ipcRenderer.invoke('settings:getApiKeys'),
    setApiKeys: (apiKeys) => ipcRenderer.invoke('settings:setApiKeys', apiKeys),
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    selectPackage: () => ipcRenderer.invoke('dialog:selectPackage'),
    saveProject: () => ipcRenderer.invoke('dialog:saveProject'),
    loadProject: () => ipcRenderer.invoke('dialog:loadProject'),
  },
  fs: {
    readManifest: (packagePath) => ipcRenderer.invoke('fs:readManifest', packagePath),
    writeManifest: (packagePath, manifest) => ipcRenderer.invoke('fs:writeManifest', packagePath, manifest),
    saveProject: (filePath, data) => ipcRenderer.invoke('fs:saveProject', filePath, data),
    loadProject: (filePath) => ipcRenderer.invoke('fs:loadProject', filePath),
    readFileBinary: (filePath) => ipcRenderer.invoke('fs:readFileBinary', filePath),
  },
  onProgressUpdate: (callback) => {
    const handler = (_event: unknown, progress: JobProgress) => callback(progress);
    ipcRenderer.on('native:progressUpdate', handler);
    return () => ipcRenderer.removeListener('native:progressUpdate', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
