'use strict';
/**
 * render-live.js 的 preload：把真实 ipcRenderer 换成桩数据，
 * 让 renderer.js 在**真实 Chromium** 里跑起来（而不是自建 DOM 桩）。
 *
 * 数据经 additionalArguments 传入（contextBridge 不能把函数传进页面）。
 */
const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--live-payload=')) || '';
let DATA = { models: [], scan: [], ninferFiles: [], status: {} };
try {
  DATA = JSON.parse(Buffer.from(arg.split('=')[1] || '', 'base64').toString('utf8'));
} catch (_) { /* 用默认空数据 */ }

const state = {
  models: DATA.models || [],
  scan: DATA.scan || [],
  ninferFiles: DATA.ninferFiles || [],
  status: DATA.status || { running: false, pids: [], ninferPids: [], ninfer: {}, engine: null, ports: {}, current: null, starting: false },
  patches: [],
  created: [],
};

contextBridge.exposeInMainWorld('api', {
  getSettings: async () => ({
    theme: 'dark', zoom: 1, defaultCtxK: 32, readyTimeoutSec: 180,
    logLimit: 4000, logSysOnly: false, serverExe: 'C:\\l\\llama-server.exe',
    modelsDir: 'C:\\m', closeToTray: true, modelsWidth: 300,
    ninferDistro: 'Ubuntu-24.04',
    ninferServe: '/root/ninfer-5080/build/apps/ninfer-serve',
    ninferCli: '/root/ninfer-5080/build/apps/ninfer',
    ninferModelsDir: '/root/models', ninferAutoScan: true,
  }),
  saveSettings: async () => ({ ok: true, settings: {} }),
  getModels: async () => state.models.map((m) => ({ ...m })),
  getStatus: async () => state.status,
  getLogs: async () => [],
  getMemory: async () => ({ totalGb: 31.1, freeGb: 14.0 }),
  getGpu: async () => ({ name: 'RTX 5080', usedGb: 15.4, totalGb: 15.9, util: 3 }),
  diskUsage: async () => ({ dir: 'C:\\', freeGb: 200, totalGb: 900, usedGb: 24.5 }),
  modelsList: async () => state.models.map((m) => ({ ...m })),
  modelsScan: async () => ({ ok: true, dir: 'C:\\m', files: state.scan }),
  modelsArgs: async (id, ctxK) => {
    const m = state.models.find((x) => x.id === id) || {};
    const k = Number(ctxK) || m.ctxK || 32;
    if (m.engine === 'ninfer') {
      return { ok: true, engine: 'ninfer', ctxK: k, ctxTokens: k * 1024,
        command: 'wsl -d Ubuntu-24.04 -u root -- ninfer-serve ' + m.file + ' --max-context ' + (k * 1024),
        ninfer: m.ninfer, hasMmproj: false, running: false };
    }
    return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
      command: 'llama-server.exe -m ' + m.file + ' -c ' + (k * 1024),
      hasMmproj: !!m.mmproj, noMmprojOffload: false, extraArgs: '', running: false };
  },
  modelsUpdate: async (id, patch) => { state.patches.push({ id, patch }); return { ok: true }; },
  modelsCreate: async (p) => { state.created.push(p); return { ok: true, model: p }; },
  modelsReset: async () => ({ ok: true }),
  modelsNextPort: async () => 8091,
  modelsDeletePreview: async () => ({ ok: true, items: [], totalGb: 0, warnings: [], running: [] }),
  modelsDeleteBatch: async () => ({ ok: true, removed: 0, trashed: 0, failed: [], skipped: [] }),
  ninferProbe: async () => ({ ok: true, wslAvailable: true,
    distros: [{ name: 'Ubuntu-24.04', state: 'stopped' }],
    cfg: { distro: 'Ubuntu-24.04' },
    runtime: { ok: true, distro: 'Ubuntu-24.04', hasServe: true, hasCli: true, hasModelsDir: true },
    available: true }),
  ninferScan: async () => ({ ok: true, errors: [], wsl: state.ninferFiles, local: [] }),
  ninferMeta: async () => ({ ok: true, meta: {} }),
  openUrl: async () => true,
  openDataDir: async () => true,
  autostartGet: async () => ({ ok: true, enabled: false, supported: true }),
  autostartSet: async () => ({ ok: true }),
  resetSettings: async () => ({ ok: true, settings: {} }),
  pickPath: async () => ({ ok: false }),
  winMinimize: () => {}, winMaximize: () => {}, winClose: () => {}, winHide: () => {},
  onLog: () => {}, onStatus: () => {}, onWindowState: () => {},
});

contextBridge.exposeInMainWorld('__LIVE_STATE__', state);
