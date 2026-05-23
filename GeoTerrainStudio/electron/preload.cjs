const { contextBridge, ipcRenderer } = require('electron');

const api = {
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
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('native:progressUpdate', handler);
    return () => ipcRenderer.removeListener('native:progressUpdate', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
