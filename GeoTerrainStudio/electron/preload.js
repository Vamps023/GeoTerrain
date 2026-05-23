"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
var api = {
    native: {
        getVersion: function () { return electron_1.ipcRenderer.invoke('native:getVersion'); },
        planGeneration: function (bounds, profile) { return electron_1.ipcRenderer.invoke('native:planGeneration', bounds, profile); },
        startGeneration: function (sessionId, plan) { return electron_1.ipcRenderer.invoke('native:startGeneration', sessionId, plan); },
        cancelGeneration: function (jobId) { return electron_1.ipcRenderer.invoke('native:cancelGeneration', jobId); },
        getProgress: function (jobId) { return electron_1.ipcRenderer.invoke('native:getProgress', jobId); },
        exportPackage: function (sessionId, outputPath, preset) { return electron_1.ipcRenderer.invoke('native:exportPackage', sessionId, outputPath, preset); },
    },
    dialog: {
        selectFolder: function () { return electron_1.ipcRenderer.invoke('dialog:selectFolder'); },
        selectPackage: function () { return electron_1.ipcRenderer.invoke('dialog:selectPackage'); },
    },
    fs: {
        readManifest: function (packagePath) { return electron_1.ipcRenderer.invoke('fs:readManifest', packagePath); },
        writeManifest: function (packagePath, manifest) { return electron_1.ipcRenderer.invoke('fs:writeManifest', packagePath, manifest); },
    },
    onProgressUpdate: function (callback) {
        var handler = function (_event, progress) { return callback(progress); };
        electron_1.ipcRenderer.on('native:progressUpdate', handler);
        return function () { return electron_1.ipcRenderer.removeListener('native:progressUpdate', handler); };
    },
};
electron_1.contextBridge.exposeInMainWorld('electronAPI', api);
