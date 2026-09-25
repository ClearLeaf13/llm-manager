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
  openDataDir: () => ipcRenderer.invoke('open-datadir'),

  // 模型管理
  modelsList: () => ipcRenderer.invoke('models-list'),
  modelsScan: (dir) => ipcRenderer.invoke('models-scan', dir),
  modelsCreate: (input) => ipcRenderer.invoke('models-create', input),
  modelsUpdate: (id, patch) => ipcRenderer.invoke('models-update', id, patch),
  modelsDelete: (id) => ipcRenderer.invoke('models-delete', id),
  modelsDeletePreview: (ids) => ipcRenderer.invoke('models-delete-preview', ids),
  modelsDeleteBatch: (ids, withFiles) => ipcRenderer.invoke('models-delete-batch', ids, withFiles),
  modelsReset: () => ipcRenderer.invoke('models-reset'),
  modelsNextPort: () => ipcRenderer.invoke('models-next-port'),
  // opts：界面上尚未保存的启动选项，用于让命令预览实时反映改动
  modelsArgs: (id, ctxK, opts) => ipcRenderer.invoke('model-args', id, ctxK, opts),
  modelDefaults: (id) => ipcRenderer.invoke('model-defaults', id),
  // 启动选项的分类表（界面据此渲染可折叠子菜单，加参数只改主进程一处）
  paramGroups: (engine) => ipcRenderer.invoke('param-groups', engine),
  // 把整条启动命令拆成参数数组（编辑命令后用来做差异分析）
  parseCommand: (text, engine) => ipcRenderer.invoke('parse-command', text, engine),

  // NInfer（WSL 里的第二引擎）
  ninferProbe: () => ipcRenderer.invoke('ninfer-probe'),
  ninferScan: () => ipcRenderer.invoke('ninfer-scan'),
  ninferMeta: (p) => ipcRenderer.invoke('ninfer-meta', p),

  // 磁盘占用
  diskUsage: () => ipcRenderer.invoke('disk-usage'),

  // 开机自启
  autostartGet: () => ipcRenderer.invoke('autostart-get'),
  autostartSet: (enable) => ipcRenderer.invoke('autostart-set', enable),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  pickPath: (kind) => ipcRenderer.invoke('pick-path', kind),

  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winHide: () => ipcRenderer.send('win-hide'),

  onLog: (cb) => ipcRenderer.on('log', (_e, entry) => cb(entry)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, s) => cb(s)),
});
