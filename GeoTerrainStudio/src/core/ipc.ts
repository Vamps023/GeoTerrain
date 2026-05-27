/**
 * Type-safe IPC wrapper for the Electron API exposed via contextBridge.
 * Provides fallback implementations for development without the native addon.
 */

import type { ElectronAPI, GeoBounds, TerrainProfile, GenerationPlan, JobProgress, HeightmapFormat, AlbedoFormat, ProjectData, DEMSource, ImagerySource, ApiKeys, MaskSettings } from '../types/terrain';

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

const isElectron = (): boolean => !!window.electronAPI;

export const Native = {
  async getVersion(): Promise<string> {
    if (!isElectron()) return '0.0.0-dev (web)';
    return window.electronAPI!.native.getVersion();
  },

  async planGeneration(bounds: GeoBounds, profile: TerrainProfile): Promise<GenerationPlan> {
    if (!isElectron()) {
      // Mock implementation for web development
      return mockPlanGeneration(bounds, profile);
    }
    return window.electronAPI!.native.planGeneration(bounds, profile);
  },

  async startGeneration(sessionId: string, plan: GenerationPlan): Promise<string> {
    if (!isElectron()) return 'mock-job-' + Date.now();
    return window.electronAPI!.native.startGeneration(sessionId, plan);
  },

  async cancelGeneration(jobId: string): Promise<void> {
    if (!isElectron()) return;
    return window.electronAPI!.native.cancelGeneration(jobId);
  },

  async getProgress(jobId: string): Promise<JobProgress> {
    if (!isElectron()) return mockProgress(jobId);
    return window.electronAPI!.native.getProgress(jobId);
  },

  async exportPackage(
    sessionId: string,
    outputPath: string,
    preset: string,
    bounds: GeoBounds,
    heightmapFormat: HeightmapFormat,
    albedoFormat: AlbedoFormat,
    heightmapResolution = 1024,
    albedoResolution = 1024,
    imageryZoom = 0,
    demSource: DEMSource = 'aws-terrarium',
    imagerySource: ImagerySource = 'arcgis',
    apiKeys?: ApiKeys,
    tileRow = 0,
    tileCol = 0,
    maskSettings?: MaskSettings,
  ): Promise<string> {
    if (!isElectron()) {
      console.log('[Mock] Export package:', { sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, maskSettings });
      return outputPath;
    }
    return window.electronAPI!.native.exportPackage(
      sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat,
      heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource, apiKeys, tileRow, tileCol, maskSettings
    );
  },
};

export const Dialog = {
  async selectFolder(): Promise<string | null> {
    if (!isElectron()) {
      // In web mode, return null to indicate no folder selected
      return null;
    }
    return window.electronAPI!.dialog.selectFolder();
  },

  async selectPackage(): Promise<string | null> {
    if (!isElectron()) return null;
    return window.electronAPI!.dialog.selectPackage();
  },

  async saveProject(): Promise<string | null> {
    if (!isElectron()) {
      console.log('[Mock] Save project dialog');
      return 'mock-project.gtp';
    }
    return window.electronAPI!.dialog.saveProject();
  },

  async loadProject(): Promise<string | null> {
    if (!isElectron()) {
      console.log('[Mock] Load project dialog');
      return null;
    }
    return window.electronAPI!.dialog.loadProject();
  },
};

export const Settings = {
  async getApiKeys(): Promise<ApiKeys> {
    if (!isElectron()) {
      // Read from localStorage in web mode
      try {
        const stored = localStorage.getItem('geoterrain-api-keys');
        return stored ? JSON.parse(stored) : {};
      } catch {
        return {};
      }
    }
    return window.electronAPI!.settings.getApiKeys();
  },

  async setApiKeys(apiKeys: ApiKeys): Promise<boolean> {
    if (!isElectron()) {
      try {
        localStorage.setItem('geoterrain-api-keys', JSON.stringify(apiKeys));
        return true;
      } catch {
        return false;
      }
    }
    return window.electronAPI!.settings.setApiKeys(apiKeys);
  },
};

export const FsAPI = {
  async readManifest(packagePath: string): Promise<unknown> {
    if (!isElectron()) {
      throw new Error('Cannot read manifest in web mode');
    }
    return window.electronAPI!.fs.readManifest(packagePath);
  },

  async writeManifest(packagePath: string, manifest: object): Promise<boolean> {
    if (!isElectron()) {
      console.log('[Mock] Write manifest:', packagePath, manifest);
      return true;
    }
    return window.electronAPI!.fs.writeManifest(packagePath, manifest);
  },

  async saveProject(filePath: string, data: ProjectData): Promise<boolean> {
    if (!isElectron()) {
      console.log('[Mock] Save project:', filePath, data);
      return true;
    }
    return window.electronAPI!.fs.saveProject(filePath, data);
  },

  async loadProject(filePath: string): Promise<ProjectData | null> {
    if (!isElectron()) {
      console.log('[Mock] Load project:', filePath);
      return null;
    }
    return window.electronAPI!.fs.loadProject(filePath);
  },

  async readFileBinary(filePath: string): Promise<ArrayBuffer> {
    if (!isElectron()) {
      throw new Error('Cannot read binary files in web mode');
    }
    const buffer = await window.electronAPI!.fs.readFileBinary(filePath);
    // Convert Node Buffer to ArrayBuffer for the renderer
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  },
};

export function onProgressUpdate(callback: (progress: JobProgress) => void): () => void {
  if (!isElectron()) {
    // Mock progress updates for web development
    const interval = setInterval(() => {
      callback(mockProgress('mock-job'));
    }, 1000);
    return () => clearInterval(interval);
  }
  return window.electronAPI!.onProgressUpdate(callback);
}

// ─── Mock Helpers ─────────────────────────────────────────────

function mockPlanGeneration(bounds: GeoBounds, _profile: TerrainProfile): GenerationPlan {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const tiles: GenerationPlan['tiles'] = [];
  // Calculate tiles based on actual area - use smaller multiplier for better performance
  const rows = Math.min(4, Math.max(1, Math.ceil(height * 2)));
  const cols = Math.min(4, Math.max(1, Math.ceil(width * 2)));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        row: r,
        col: c,
        bounds: {
          west: bounds.west + (c / cols) * width,
          east: bounds.west + ((c + 1) / cols) * width,
          south: bounds.south + (r / rows) * height,
          north: bounds.south + ((r + 1) / rows) * height,
        },
      });
    }
  }

  return {
    zoom: 12,
    tiles,
    estimatedMemoryMb: tiles.length * 256,
    estimatedDurationSec: tiles.length * 45,
  };
}

function mockProgress(jobId: string): JobProgress {
  return {
    jobId,
    state: 'complete',
    overallProgress: 1.0,
    currentTile: 'chunk_0_0',
    tileProgress: 1.0,
    message: 'Generation complete',
  };
}
