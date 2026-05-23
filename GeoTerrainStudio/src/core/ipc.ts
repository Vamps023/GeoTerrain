/**
 * Type-safe IPC wrapper for the Electron API exposed via contextBridge.
 * Provides fallback implementations for development without the native addon.
 */

import type { ElectronAPI, GeoBounds, TerrainProfile, GenerationPlan, JobProgress } from '../types/terrain';

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

  async exportPackage(sessionId: string, outputPath: string, preset: string): Promise<string> {
    if (!isElectron()) {
      console.log('[Mock] Export package:', { sessionId, outputPath, preset });
      return outputPath;
    }
    return window.electronAPI!.native.exportPackage(sessionId, outputPath, preset);
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
