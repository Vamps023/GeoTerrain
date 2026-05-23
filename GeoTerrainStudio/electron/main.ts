import { app, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs';

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

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'GeoTerrain Studio',
    darkTheme: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Load Vite dev server or production build
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
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

ipcMain.handle('native:planGeneration', async (_event, bounds: GeoBounds, profile: TerrainProfile) => {
  if (!nativeAddon) throw new Error('Native addon not loaded');
  return nativeAddon.planGeneration(bounds, profile);
});

ipcMain.handle('native:startGeneration', async (_event, sessionId: string, plan: GenerationPlan) => {
  if (!nativeAddon) throw new Error('Native addon not loaded');
  return nativeAddon.startGeneration(sessionId, plan);
});

ipcMain.handle('native:cancelGeneration', async (_event, jobId: string) => {
  if (!nativeAddon) throw new Error('Native addon not loaded');
  return nativeAddon.cancelGeneration(jobId);
});

ipcMain.handle('native:getProgress', async (_event, jobId: string) => {
  if (!nativeAddon) return { progress: 0, state: 'idle' };
  return nativeAddon.getProgress(jobId);
});

ipcMain.handle('native:exportPackage', async (_event, sessionId: string, outputPath: string, preset: string) => {
  if (!nativeAddon) throw new Error('Native addon not loaded');
  return nativeAddon.exportPackage(sessionId, outputPath, preset);
});

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select Output Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectPackage', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select Terrain Package',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:readManifest', async (_event, packagePath: string) => {
  const manifestPath = path.join(packagePath, 'manifest.json');
  const data = await fs.promises.readFile(manifestPath, 'utf-8');
  return JSON.parse(data);
});

ipcMain.handle('fs:writeManifest', async (_event, packagePath: string, manifest: object) => {
  const manifestPath = path.join(packagePath, 'manifest.json');
  await fs.promises.mkdir(packagePath, { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return true;
});

// Type definitions for IPC (mirrored in preload)
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
