"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
var path = require("path");
var fs = require("fs");
// Native addon loader
var nativeAddon = null;
try {
    var addonPath = path.join(__dirname, '../native/geoterrain_native.node');
    if (fs.existsSync(addonPath)) {
        nativeAddon = require(addonPath);
        console.log('[Main] Native addon loaded successfully');
    }
    else {
        console.warn('[Main] Native addon not found at:', addonPath);
    }
}
catch (err) {
    console.error('[Main] Failed to load native addon:', err);
}
var mainWindow = null;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
            webSecurity: true,
        },
        show: false,
    });
    // Load Vite dev server or production build
    var devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    var distPath = path.join(__dirname, '../dist/index.html');
    // Check if we're in development mode (dist doesn't exist or VITE_DEV_SERVER_URL is set)
    if (process.env.VITE_DEV_SERVER_URL || !fs.existsSync(distPath)) {
        console.log('[Main] Loading Vite dev server:', devServerUrl);
        mainWindow.loadURL(devServerUrl);
        mainWindow.webContents.openDevTools();
    }
    else {
        console.log('[Main] Loading production build from:', distPath);
        mainWindow.loadFile(distPath);
    }
    mainWindow.once('ready-to-show', function () {
        mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.show();
    });
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}
electron_1.app.whenReady().then(function () {
    electron_1.nativeTheme.themeSource = 'dark';
    createWindow();
    electron_1.app.on('activate', function () {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', function () {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
// ─── IPC Handlers ─────────────────────────────────────────────
electron_1.ipcMain.handle('native:getVersion', function () {
    var _a, _b;
    return (_b = (_a = nativeAddon === null || nativeAddon === void 0 ? void 0 : nativeAddon.getVersion) === null || _a === void 0 ? void 0 : _a.call(nativeAddon)) !== null && _b !== void 0 ? _b : '0.0.0-dev';
});
electron_1.ipcMain.handle('native:planGeneration', function (_event, bounds, profile) { return __awaiter(void 0, void 0, void 0, function () {
    var width, height, tiles, rows, cols, r, c;
    return __generator(this, function (_a) {
        if (!nativeAddon) {
            console.warn('[Main] Native addon not loaded, using mock implementation');
            width = bounds.east - bounds.west;
            height = bounds.north - bounds.south;
            tiles = [];
            rows = Math.min(4, Math.max(1, Math.ceil(height * 2)));
            cols = Math.min(4, Math.max(1, Math.ceil(width * 2)));
            for (r = 0; r < rows; r++) {
                for (c = 0; c < cols; c++) {
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
            return [2 /*return*/, {
                    zoom: 12,
                    tiles: tiles,
                    estimatedMemoryMb: tiles.length * 256,
                    estimatedDurationSec: tiles.length * 45,
                }];
        }
        return [2 /*return*/, nativeAddon.planGeneration(bounds, profile)];
    });
}); });
electron_1.ipcMain.handle('native:startGeneration', function (_event, sessionId, plan) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        if (!nativeAddon) {
            console.warn('[Main] Native addon not loaded, using mock implementation');
            return [2 /*return*/, sessionId]; // Return the session ID as the job ID
        }
        return [2 /*return*/, nativeAddon.startGeneration(sessionId, plan)];
    });
}); });
electron_1.ipcMain.handle('native:cancelGeneration', function (_event, jobId) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        if (!nativeAddon) {
            console.warn('[Main] Native addon not loaded, using mock implementation');
            return [2 /*return*/];
        }
        return [2 /*return*/, nativeAddon.cancelGeneration(jobId)];
    });
}); });
electron_1.ipcMain.handle('native:getProgress', function (_event, jobId) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        if (!nativeAddon) {
            console.warn('[Main] Native addon not loaded, using mock implementation');
            return [2 /*return*/, {
                    jobId: jobId,
                    state: 'complete',
                    overallProgress: 1.0,
                    currentTile: 'chunk_0_0',
                    tileProgress: 1.0,
                    message: 'Generation complete (mock)',
                }];
        }
        return [2 /*return*/, nativeAddon.getProgress(jobId)];
    });
}); });
electron_1.ipcMain.handle('native:exportPackage', function (_event, sessionId, outputPath, preset) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        if (!nativeAddon) {
            console.warn('[Main] Native addon not loaded, using mock implementation');
            return [2 /*return*/, outputPath]; // Return the output path as the result
        }
        return [2 /*return*/, nativeAddon.exportPackage(sessionId, outputPath, preset)];
    });
}); });
electron_1.ipcMain.handle('dialog:selectFolder', function () { return __awaiter(void 0, void 0, void 0, function () {
    var result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, electron_1.dialog.showOpenDialog(mainWindow, {
                    properties: ['openDirectory'],
                    title: 'Select Output Folder',
                })];
            case 1:
                result = _a.sent();
                return [2 /*return*/, result.canceled ? null : result.filePaths[0]];
        }
    });
}); });
electron_1.ipcMain.handle('dialog:selectPackage', function () { return __awaiter(void 0, void 0, void 0, function () {
    var result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, electron_1.dialog.showOpenDialog(mainWindow, {
                    properties: ['openDirectory'],
                    title: 'Select Terrain Package',
                })];
            case 1:
                result = _a.sent();
                return [2 /*return*/, result.canceled ? null : result.filePaths[0]];
        }
    });
}); });
electron_1.ipcMain.handle('fs:readManifest', function (_event, packagePath) { return __awaiter(void 0, void 0, void 0, function () {
    var manifestPath, data;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                manifestPath = path.join(packagePath, 'manifest.json');
                return [4 /*yield*/, fs.promises.readFile(manifestPath, 'utf-8')];
            case 1:
                data = _a.sent();
                return [2 /*return*/, JSON.parse(data)];
        }
    });
}); });
electron_1.ipcMain.handle('fs:writeManifest', function (_event, packagePath, manifest) { return __awaiter(void 0, void 0, void 0, function () {
    var manifestPath;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                manifestPath = path.join(packagePath, 'manifest.json');
                return [4 /*yield*/, fs.promises.mkdir(packagePath, { recursive: true })];
            case 1:
                _a.sent();
                return [4 /*yield*/, fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2))];
            case 2:
                _a.sent();
                return [2 /*return*/, true];
        }
    });
}); });
