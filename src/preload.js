'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getModels: () => ipcRenderer.invoke('get-models'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  start: (id, ctxK) => ipcRenderer.invoke('start', id, ctxK),
  stop: () => ipcRenderer.invoke('stop'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  getMemory: () => ipcRenderer.invoke('get-memory'),
  getGpu: () => ipcRenderer.invoke('get-gpu'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  pickPath: (kind) => ipcRenderer.invoke('pick-path', kind),

  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),

  onLog: (cb) => ipcRenderer.on('log', (_e, entry) => cb(entry)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, s) => cb(s)),
});
