/**
 * GeoTerrain Studio — Electron Main Process
 *
 * Uses direct require() for Electron APIs to avoid TypeScript ES module
 * interop issues with Electron 34's CommonJS loader.
 */

import type { BrowserWindow as BrowserWindowType } from 'electron';

const electron = require('electron');
const path = require('path');
const fs = require('fs');
const { executeExport } = require('./export-engine');

const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = electron;

// ─── Path Validation Utility ──────────────────────────────────

/**
 * Tracks the last output folder used during export.
 * Updated each time native:exportPackage is called successfully.
 */
let lastOutputFolder: string | null = null;

/**
 * Validates that a requested file path is within one of the allowed base directories.
 * Prevents arbitrary file reads from a compromised renderer process.
 *
 * Handles edge cases:
 * - Path traversal (../)
 * - Null bytes
 * - Case sensitivity on Windows (uses lowercase comparison)
 * - Trailing separators
 */
function validatePath(requestedPath: string, allowedBasePaths: string[]): boolean {
  // Reject paths containing null bytes (poison null byte attack)
  if (requestedPath.includes('\0')) {
    return false;
  }

  // Resolve and normalize the requested path
  const resolved = path.resolve(requestedPath);

  for (const basePath of allowedBasePaths) {
    if (!basePath) continue;

    // Resolve and normalize the base path, ensure trailing separator
    const resolvedBase = path.resolve(basePath) + path.sep;

    if (process.platform === 'win32') {
      // Case-insensitive comparison on Windows
      if (resolved.toLowerCase().startsWith(resolvedBase.toLowerCase()) ||
          resolved.toLowerCase() === resolvedBase.slice(0, -1).toLowerCase()) {
        return true;
      }
    } else {
      if (resolved.startsWith(resolvedBase) || resolved === resolvedBase.slice(0, -1)) {
        return true;
      }
    }
  }

  return false;
}

// Native addon interface based on usage in IPC handlers
interface NativeAddon {
  getVersion(): string;
  planGeneration(bounds: GeoBounds, profile: TerrainProfile): GenerationPlan;
  startGeneration(sessionId: string, plan: GenerationPlan): string;
  cancelGeneration(jobId: string): void;
  getProgress(jobId: string): {
    jobId: string;
    state: string;
    overallProgress: number;
    currentTile: string;
    tileProgress: number;
    message: string;
  };
}

// Native addon loader
let nativeAddon: NativeAddon | null = null;
try {
  const addonPath = path.join(__dirname, '../native/geoterrain_native.node');
  if (fs.existsSync(addonPath)) {
    nativeAddon = require(addonPath);
    console.log('[Main] Native addon loaded successfully');
  } else {
    console.warn('[Main] Native addon not found at:', addonPath);
  }
} catch (err) {
  console.error('[Main] Failed to load native addon:', err);
}

let mainWindow: BrowserWindowType | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'GeoTerrain Studio',
    icon: path.join(__dirname, '../public/logo/logo.png'),
    darkTheme: true,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  mainWindow = win;

  // Load Vite dev server or production build
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const distPath = path.join(__dirname, '../dist/index.html');

  // Check if we're in development mode (dist doesn't exist or VITE_DEV_SERVER_URL is set)
  if (process.env.VITE_DEV_SERVER_URL || !fs.existsSync(distPath)) {
    console.log('[Main] Loading Vite dev server:', devServerUrl);
    win.loadURL(devServerUrl);
    win.webContents.openDevTools();
  } else {
    console.log('[Main] Loading production build from:', distPath);
    win.loadFile(distPath);
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('native:getVersion', () => {
  return nativeAddon?.getVersion?.() ?? '0.0.0-dev';
});

ipcMain.handle('native:planGeneration', async (_event: any, bounds: GeoBounds, profile: TerrainProfile) => {
  if (!nativeAddon) {
    console.warn('[Main] Native addon not loaded, using mock implementation');
    const width = bounds.east - bounds.west;
    const height = bounds.north - bounds.south;
    const tiles: GenerationPlan['tiles'] = [];
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
  return nativeAddon.planGeneration(bounds, profile);
});

ipcMain.handle('native:startGeneration', async (_event: any, sessionId: string, plan: GenerationPlan) => {
  if (!nativeAddon) {
    console.warn('[Main] Native addon not loaded, using mock implementation');
    return sessionId;
  }
  return nativeAddon.startGeneration(sessionId, plan);
});

ipcMain.handle('native:cancelGeneration', async (_event: any, jobId: string) => {
  if (!nativeAddon) {
    console.warn('[Main] Native addon not loaded, using mock implementation');
    return;
  }
  return nativeAddon.cancelGeneration(jobId);
});

ipcMain.handle('native:getProgress', async (_event: any, jobId: string) => {
  if (!nativeAddon) {
    console.warn('[Main] Native addon not loaded, using mock implementation');
    return {
      jobId,
      state: 'complete',
      overallProgress: 1.0,
      currentTile: 'chunk_0_0',
      tileProgress: 1.0,
      message: 'Generation complete (mock)',
    };
  }
  return nativeAddon.getProgress(jobId);
});

ipcMain.handle('native:exportPackage', async (_event: any,
  sessionId: string,
  outputPath: string,
  preset: string,
  bounds: GeoBounds,
  heightmapFormat: string,
  albedoFormat: string,
  heightmapResolution = 1024,
  albedoResolution = 1024,
  imageryZoom = 0,
  demSource = 'aws-terrarium',
  imagerySource = 'arcgis',
  apiKeys?: { opentopography?: string; mapbox?: string; maptiler?: string },
  tileRow = 0,
  tileCol = 0,
  maskSettings?: { generateRoadMask: boolean; generateWaterMask: boolean; generateVegetationMask: boolean; generateBuildingMask: boolean; generateCliffMask: boolean; cliffThresholdDegrees: number; roadLineWidthPx: number },
) => {
  // Construct tile output path server-side using path.join (avoids deprecated navigator.platform in renderer)
  const tileOutputPath = path.join(outputPath, `tile_${tileRow}_${tileCol}`);

  // Track the output folder for path validation in fs:readFileBinary
  lastOutputFolder = path.resolve(outputPath);

  // Native export is currently a stub; keep exports on the fully implemented JS engine.
  try {
    const result = await executeExport({
      sessionId,
      outputPath: tileOutputPath,
      preset,
      bounds,
      heightmapFormat: heightmapFormat as any,
      albedoFormat: albedoFormat as any,
      heightmapSize: heightmapResolution,
      albedoSize: albedoResolution,
      imageryZoom,
      demSource: demSource as any,
      imagerySource: imagerySource as any,
      opentopographyApiKey: apiKeys?.opentopography,
      mapboxAccessToken: apiKeys?.mapbox,
      maptilerApiKey: apiKeys?.maptiler,
      tileRow,
      tileCol,
      maskSettings,
    });
    return result.manifestPath;
  } catch (err) {
    console.error('[Main] Export failed:', err);
    throw err;
  }
});

// ─── Settings (API Keys) ────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('settings:getApiKeys', async () => {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = await fs.promises.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(data);
      return settings.apiKeys || {};
    }
  } catch (err) {
    console.error('[Main] Failed to read settings:', err);
  }
  return {};
});

ipcMain.handle('settings:setApiKeys', async (_event: any, apiKeys: { opentopography?: string; mapbox?: string; maptiler?: string }) => {
  try {
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      const data = await fs.promises.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(data);
    }
    settings.apiKeys = { ...(settings.apiKeys || {}), ...apiKeys };
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Main] Failed to save settings:', err);
    return false;
  }
});

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined, {
    properties: ['openDirectory'],
    title: 'Select Output Folder',
  });
  if (result.canceled) return null;
  // Track the selected output folder for path validation
  lastOutputFolder = path.resolve(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectPackage', async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined, {
    properties: ['openDirectory'],
    title: 'Select Terrain Package',
  });
  if (result.canceled) return null;
  // Track the selected package folder for path validation (3D viewer reads from here)
  lastOutputFolder = path.resolve(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle('fs:readManifest', async (_event: any, packagePath: string) => {
  try {
    // Path validation: only allow reading manifests from allowed directories
    const allowedBasePaths: string[] = [app.getPath('userData')];
    if (lastOutputFolder) allowedBasePaths.push(lastOutputFolder);
    allowedBasePaths.push(app.getPath('documents'));
    allowedBasePaths.push(app.getPath('desktop'));
    allowedBasePaths.push(app.getPath('home'));

    if (!validatePath(packagePath, allowedBasePaths)) {
      console.error('[Main] Failed to read manifest:', packagePath, 'Path validation failed');
      return { error: `Path validation failed: "${packagePath}" is not within allowed directories.` };
    }

    const manifestPath = path.join(packagePath, 'manifest.json');
    const data = await fs.promises.readFile(manifestPath, 'utf-8');
    return JSON.parse(data);
  } catch (err: any) {
    console.error('[Main] Failed to read manifest:', packagePath, err?.message);
    return { error: err?.message || 'Failed to read manifest' };
  }
});

ipcMain.handle('fs:writeManifest', async (_event: any, packagePath: string, manifest: object) => {
  // Path validation: only allow writing manifests to allowed directories
  const allowedBasePaths: string[] = [app.getPath('userData')];
  if (lastOutputFolder) allowedBasePaths.push(lastOutputFolder);
  allowedBasePaths.push(app.getPath('documents'));
  allowedBasePaths.push(app.getPath('desktop'));
  allowedBasePaths.push(app.getPath('home'));

  if (!validatePath(packagePath, allowedBasePaths)) {
    throw new Error(`[Security] Path validation failed: "${packagePath}" is not within allowed directories.`);
  }

  const manifestPath = path.join(packagePath, 'manifest.json');
  await fs.promises.mkdir(packagePath, { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return true;
});

// ─── Project Save/Load ────────────────────────────────────────

ipcMain.handle('dialog:saveProject', async () => {
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined, {
    title: 'Save Project',
    defaultPath: 'project.gtp',
    filters: [
      { name: 'GeoTerrain Project', extensions: ['gtp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:loadProject', async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined, {
    properties: ['openFile'],
    title: 'Load Project',
    filters: [
      { name: 'GeoTerrain Project', extensions: ['gtp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:saveProject', async (_event: any, filePath: string, data: object) => {
  // Path validation: only allow saving projects to allowed directories
  const allowedBasePaths: string[] = [app.getPath('userData')];
  if (lastOutputFolder) allowedBasePaths.push(lastOutputFolder);
  allowedBasePaths.push(app.getPath('documents'));
  allowedBasePaths.push(app.getPath('desktop'));
  allowedBasePaths.push(app.getPath('home'));

  if (!validatePath(filePath, allowedBasePaths)) {
    throw new Error(`[Security] Path validation failed: "${filePath}" is not within allowed directories.`);
  }

  // Validate .gtp extension for project files
  if (!filePath.endsWith('.gtp')) {
    throw new Error(`[Security] Project files must have .gtp extension`);
  }

  try {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Main] Failed to save project:', err);
    return false;
  }
});

ipcMain.handle('fs:loadProject', async (_event: any, filePath: string) => {
  // Path validation: only allow loading projects from user-accessible directories
  const allowedBasePaths: string[] = [app.getPath('userData')];
  if (lastOutputFolder) allowedBasePaths.push(lastOutputFolder);
  allowedBasePaths.push(app.getPath('documents'));
  allowedBasePaths.push(app.getPath('desktop'));
  allowedBasePaths.push(app.getPath('home'));

  if (!validatePath(filePath, allowedBasePaths)) {
    throw new Error(`[Security] Path validation failed: "${filePath}" is not within allowed directories.`);
  }

  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[Main] Failed to load project:', err);
    return null;
  }
});

// ─── Binary File Reading for 3D Viewer ────────────────────────

ipcMain.handle('fs:readFileBinary', async (_event: any, filePath: string) => {
  // Build allowed paths list for validation
  const allowedBasePaths: string[] = [app.getPath('userData')];
  if (lastOutputFolder) {
    allowedBasePaths.push(lastOutputFolder);
  }
  allowedBasePaths.push(app.getPath('documents'));
  allowedBasePaths.push(app.getPath('desktop'));
  allowedBasePaths.push(app.getPath('home'));

  if (!validatePath(filePath, allowedBasePaths)) {
    const error = new Error(
      `[Security] Path validation failed: "${filePath}" is not within allowed directories. ` +
      `Allowed: ${allowedBasePaths.filter(Boolean).join(', ')}`
    );
    console.error('[Main]', error.message);
    throw error;
  }

  try {
    const buffer = await fs.promises.readFile(filePath);
    return buffer;
  } catch (err) {
    console.error('[Main] Failed to read file:', filePath, err);
    throw err;
  }
});

// ─── Type Definitions ─────────────────────────────────────────

interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface TerrainProfile {
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

interface GenerationPlan {
  zoom: number;
  tiles: Array<{ row: number; col: number; bounds: GeoBounds }>;
  estimatedMemoryMb: number;
  estimatedDurationSec: number;
}
