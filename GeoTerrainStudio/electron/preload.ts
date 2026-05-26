import { contextBridge, ipcRenderer } from 'electron';

// Type-safe IPC API exposed to renderer
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
    ) => Promise<string>;
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
    exportPackage: (sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource) =>
      ipcRenderer.invoke('native:exportPackage', sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource),
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
