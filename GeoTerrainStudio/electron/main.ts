/**
 * GeoTerrain Studio — Electron Main Process
 *
 * Uses direct require() for Electron APIs to avoid TypeScript ES module
 * interop issues with Electron 34's CommonJS loader.
 */

const electron = require('electron');
const path = require('path');
const fs = require('fs');
const { executeExport } = require('./export-engine');

const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = electron;

// Native addon loader
let nativeAddon: any = null;
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

let mainWindow: any = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'GeoTerrain Studio',
    icon: path.join(__dirname, '../public/logo/logo.png'),
    darkTheme: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  // Load Vite dev server or production build
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const distPath = path.join(__dirname, '../dist/index.html');

  // Check if we're in development mode (dist doesn't exist or VITE_DEV_SERVER_URL is set)
  if (process.env.VITE_DEV_SERVER_URL || !fs.existsSync(distPath)) {
    console.log('[Main] Loading Vite dev server:', devServerUrl);
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools();
  } else {
    console.log('[Main] Loading production build from:', distPath);
    mainWindow.loadFile(distPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
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
) => {
  // Native export is currently a stub; keep exports on the fully implemented JS engine.
  try {
    const result = await executeExport({
      sessionId,
      outputPath,
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
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Output Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectPackage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Terrain Package',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:readManifest', async (_event: any, packagePath: string) => {
  const manifestPath = path.join(packagePath, 'manifest.json');
  const data = await fs.promises.readFile(manifestPath, 'utf-8');
  return JSON.parse(data);
});

ipcMain.handle('fs:writeManifest', async (_event: any, packagePath: string, manifest: object) => {
  const manifestPath = path.join(packagePath, 'manifest.json');
  await fs.promises.mkdir(packagePath, { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return true;
});

// ─── Project Save/Load ────────────────────────────────────────

ipcMain.handle('dialog:saveProject', async () => {
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
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
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
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
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Main] Failed to save project:', err);
    return false;
  }
});

ipcMain.handle('fs:loadProject', async (_event: any, filePath: string) => {
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
