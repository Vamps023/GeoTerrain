import { contextBridge, ipcRenderer } from 'electron';

// Type-safe IPC API exposed to renderer
export interface ElectronAPI {
  native: {
    getVersion: () => Promise<string>;
    planGeneration: (bounds: GeoBounds, profile: TerrainProfile) => Promise<GenerationPlan>;
    startGeneration: (sessionId: string, plan: GenerationPlan) => Promise<string>;
    cancelGeneration: (jobId: string) => Promise<void>;
    getProgress: (jobId: string) => Promise<JobProgress>;
    exportPackage: (sessionId: string, outputPath: string, preset: string) => Promise<string>;
  };
  dialog: {
    selectFolder: () => Promise<string | null>;
    selectPackage: () => Promise<string | null>;
  };
  fs: {
    readManifest: (packagePath: string) => Promise<unknown>;
    writeManifest: (packagePath: string, manifest: object) => Promise<boolean>;
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
    exportPackage: (sessionId, outputPath, preset) => ipcRenderer.invoke('native:exportPackage', sessionId, outputPath, preset),
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    selectPackage: () => ipcRenderer.invoke('dialog:selectPackage'),
  },
  fs: {
    readManifest: (packagePath) => ipcRenderer.invoke('fs:readManifest', packagePath),
    writeManifest: (packagePath, manifest) => ipcRenderer.invoke('fs:writeManifest', packagePath, manifest),
  },
  onProgressUpdate: (callback) => {
    const handler = (_event: unknown, progress: JobProgress) => callback(progress);
    ipcRenderer.on('native:progressUpdate', handler);
    return () => ipcRenderer.removeListener('native:progressUpdate', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
