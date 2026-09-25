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
  modelsArgs: async (id, ctxK, opts) => {
    const stored = state.models.find((x) => x.id === id) || {};
    const m = { ...stored, ...(opts || {}) };
    const k = Number(ctxK) || m.ctxK || 32;
    const ovText = (opts && typeof opts.cmdOverride === 'string') ? opts.cmdOverride.trim() : '';
    if (stored.engine === 'ninfer') {
      const cmd = 'wsl -d Ubuntu-24.04 -u root -- ninfer-serve ' + stored.file + ' --max-context ' + (k * 1024);
      return { ok: true, engine: 'ninfer', ctxK: k, ctxTokens: k * 1024,
        command: cmd, baseCommand: cmd, cmdOverride: ovText, cmdOverridden: false,
        ninfer: stored.ninfer, hasMmproj: false, running: false };
    }
    // 沙箱 preload 只能 require('electron')，拿不到 buildArgs。
    // render-live.js 用真实 buildArgs 为用例涉及的开关组合预先算好命令行存进 argsTable，
    // 这里按当前值查表 —— 查到的就是真实拼装结果，不是手写的字符串。
    const key = [m.jinja !== false, m.flashAttn !== false, m.ctxShift !== false,
                 !!m.useMtp, m.loadMode || 'mlock', !!m.noMmprojOffload].join('|');
    const hit = (DATA.argsTable || {})[key + '|' + k];
    const base = hit || ('llama-server.exe（未知组合 ' + key + '|' + k + '）');
    // 命令覆盖的产品语义在 models.applyCmdOverride 里，render-live.js 已经算出
    // 「未改动 / 改过」两种结果并放进 DATA.overrideTable，这里照查表结果返回。
    if (ovText) {
      const ovKey = key + '|' + k + '|' + ovText;
      const ovHit = (DATA.overrideTable || {})[ovKey];
      if (ovHit) {
        return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
          command: ovHit.command, baseCommand: base, cmdOverride: ovText,
          cmdOverridden: ovHit.applied, protectedKeys: ovHit.protectedKeys,
          hasMmproj: !!m.mmproj, noMmprojOffload: !!m.noMmprojOffload, running: false };
      }
      // 表里没有（例如用户临时敲了个新 flag）：按「原样保留、受保护项补回」的
      // 产品语义近似处理，保证 renderer 侧链路仍能验证。
      const tokens = ovText.split(/\s+/);
      const exe0 = tokens.shift() || 'llama-server.exe';
      const kept = tokens.filter((t2) => !['-m', '--mmproj', '--host', '--port'].includes(t2));
      return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
        command: exe0 + ' ' + kept.concat(['-m', m.filePath || m.file || '', '--host', '127.0.0.1', '--port', String(m.port || 8080)]).join(' '),
        baseCommand: base, cmdOverride: ovText, cmdOverridden: true,
        protectedKeys: ['-m', '--host', '--port'],
        hasMmproj: !!m.mmproj, noMmprojOffload: !!m.noMmprojOffload, running: false };
    }
    return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
      command: base, baseCommand: base, cmdOverride: '', cmdOverridden: false,
      hasMmproj: !!m.mmproj, noMmprojOffload: !!m.noMmprojOffload,
      extraArgs: m.extraArgs || '', running: false };
  },
  modelDefaults: async (id) => {
    const m = state.models.find((x) => x.id === id) || {};
    if (m.engine === 'ninfer') {
      return { ok: true, engine: 'ninfer', ctxK: 96, ninfer: {
        kvDtype: 'q4', spec: 'mtp', prefillChunk: 512, draftTokens: 3,
        thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
        embeddingHost: true, noCudaGraph: true } };
    }
    return { ok: true, engine: 'llamacpp', ctxK: 32, noMmprojOffload: false,
      useMtp: false, jinja: true, flashAttn: true, ctxShift: true, loadMode: 'mlock',
      gpuLayers: -1, splitMode: 'layer', kvOffload: true, threads: -1, threadsBatch: -1,
      batch: 2048, ubatch: 512, fits: true, chatTemplateFile: '', reasoningFormat: 'auto',
      temperature: '0.6', topP: '0.95', topK: 20, minP: '0.0',
      repeatPenalty: '1.0', presencePenalty: '0.0', parallel: 1, timeout: 0,
      cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', noOpOffload: false, metrics: false,
      noWebui: false };
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
