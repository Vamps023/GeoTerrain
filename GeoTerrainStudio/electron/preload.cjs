"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    native: {
        getVersion: () => electron_1.ipcRenderer.invoke('native:getVersion'),
        planGeneration: (bounds, profile) => electron_1.ipcRenderer.invoke('native:planGeneration', bounds, profile),
        startGeneration: (sessionId, plan) => electron_1.ipcRenderer.invoke('native:startGeneration', sessionId, plan),
        cancelGeneration: (jobId) => electron_1.ipcRenderer.invoke('native:cancelGeneration', jobId),
        getProgress: (jobId) => electron_1.ipcRenderer.invoke('native:getProgress', jobId),
        exportPackage: (sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource) => electron_1.ipcRenderer.invoke('native:exportPackage', sessionId, outputPath, preset, bounds, heightmapFormat, albedoFormat, heightmapResolution, albedoResolution, imageryZoom, demSource, imagerySource),
    },
    dialog: {
        selectFolder: () => electron_1.ipcRenderer.invoke('dialog:selectFolder'),
        selectPackage: () => electron_1.ipcRenderer.invoke('dialog:selectPackage'),
        saveProject: () => electron_1.ipcRenderer.invoke('dialog:saveProject'),
        loadProject: () => electron_1.ipcRenderer.invoke('dialog:loadProject'),
    },
    fs: {
        readManifest: (packagePath) => electron_1.ipcRenderer.invoke('fs:readManifest', packagePath),
        writeManifest: (packagePath, manifest) => electron_1.ipcRenderer.invoke('fs:writeManifest', packagePath, manifest),
        saveProject: (filePath, data) => electron_1.ipcRenderer.invoke('fs:saveProject', filePath, data),
        loadProject: (filePath) => electron_1.ipcRenderer.invoke('fs:loadProject', filePath),
    },
    onProgressUpdate: (callback) => {
        const handler = (_event, progress) => callback(progress);
        electron_1.ipcRenderer.on('native:progressUpdate', handler);
        return () => electron_1.ipcRenderer.removeListener('native:progressUpdate', handler);
    },
};
electron_1.contextBridge.exposeInMainWorld('electronAPI', api);
