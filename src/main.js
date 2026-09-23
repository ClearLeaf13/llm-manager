'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');

const { SERVER_EXE, MODELS_DIR, MODELS, buildArgs } = require('./models');

const PROC_NAME = 'llama-server';

/** 默认设置；实际值持久化在 userData/settings.json */
const DEFAULT_SETTINGS = {
  theme: 'system',        // system | light | dark
  zoom: 1,                // 界面缩放
  defaultCtxK: 32,        // 默认上下文（K）
  readyTimeoutSec: 180,   // 就绪超时（秒）
  autoChatAfterStart: false,
  logLimit: 4000,         // 日志缓存行数
  logSysOnly: false,      // 默认只显示系统与错误
  serverExe: SERVER_EXE,  // llama-server 路径
  modelsDir: MODELS_DIR,  // 模型目录
};

let settings = { ...DEFAULT_SETTINGS };

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** @type {import('child_process').ChildProcess|null} */
let child = null;
let currentModel = null;
let logBuffer = [];
const LOG_HARD_CAP = 50000;

let win = null;

/* ------------------------------------------------------------------ *
 * GPU（nvidia-smi）
 * ------------------------------------------------------------------ */

let smiPath = null;
let smiChecked = false;

function resolveSmi() {
  if (smiChecked) return smiPath;
  smiChecked = true;
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files',
      'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { smiPath = c; return smiPath; }
  }
  smiPath = null;
  return null;
}

function queryGpu() {
  return new Promise((resolve) => {
    const exe = resolveSmi();
    if (!exe) return resolve(null);
    execFile(exe, [
      '--query-gpu=name,memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits',
    ], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = String(stdout).trim().split(/\r?\n/)[0];
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 4) return resolve(null);
      const usedMb = Number(parts[1]);
      const totalMb = Number(parts[2]);
      if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb)) return resolve(null);
      resolve({
        name: parts[0],
        usedGb: usedMb / 1024,
        totalGb: totalMb / 1024,
        util: Number(parts[3]) || 0,
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

function pushLog(line, stream = 'out') {
  // llama-server 输出会带 \r 进度条，按 \r 和 \n 都切开
  const parts = String(line).split(/\r?\n|\r/);
  for (const p of parts) {
    if (p.length === 0) continue;
    const entry = { t: Date.now(), stream, text: p };
    logBuffer.push(entry);
    const limit = Math.min(Number(settings.logLimit) || 4000, LOG_HARD_CAP);
    if (logBuffer.length > limit) logBuffer.splice(0, logBuffer.length - limit);
    if (win && !win.isDestroyed()) {
      win.webContents.send('log', entry);
    }
  }
}

function clearLogs() {
  logBuffer = [];
}

/* ------------------------------------------------------------------ *
 * 端口 / 进程状态
 * ------------------------------------------------------------------ */

function isPortOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(val);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function findLlamaProcesses() {
  return new Promise((resolve) => {
    // tasklist 在部分环境不可用，用 tasklist 读取 PID
    execFile('tasklist', ['/FI', `IMAGENAME eq ${PROC_NAME}.exe`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const pids = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)"/);
          if (m && m[1].toLowerCase() === `${PROC_NAME}.exe`) pids.push(Number(m[2]));
        }
        resolve(pids);
      });
  });
}

async function probeStatus() {
  const pids = await findLlamaProcesses();
  const ports = {};
  for (const m of MODELS) {
    ports[m.port] = await isPortOpen(m.port);
  }
  return {
    running: pids.length > 0,
    pids,
    ports,
    current: currentModel ? currentModel.id : null,
    starting: startingModel !== null,
  };
}

/** 查询 /v1/models 拿服务端真实模型 id */
function fetchModelId(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/v1/models', timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const id = j && j.data && j.data[0] && (j.data[0].id || j.data[0].name);
            resolve(id || null);
          } catch (_) { resolve(null); }
        });
      });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/* ------------------------------------------------------------------ *
 * 启动 / 停止
 * ------------------------------------------------------------------ */

let startingModel = null;

function killLlamaProcesses() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/IM', `${PROC_NAME}.exe`, '/T'],
      { windowsHide: true },
      () => resolve());
  });
}

async function startModel(modelId, ctxK) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) return { ok: false, error: `无效模型: ${modelId}` };

  // 前置校验：文件是否存在（路径可在设置里覆盖）
  const serverExe = settings.serverExe || SERVER_EXE;
  if (!fs.existsSync(serverExe)) {
    const msg = `找不到 llama-server: ${serverExe}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }
  if (!fs.existsSync(model.file)) {
    const msg = `找不到模型文件: ${model.file}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }
  if (model.mmproj && !fs.existsSync(model.mmproj)) {
    const msg = `找不到视觉投影文件: ${model.mmproj}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }

  // 一次只能运行一个模型
  const existing = await findLlamaProcesses();
  if (existing.length > 0) {
    const msg = `llama-server 已在运行 (PID ${existing.join(', ')})，请先停止`;
    pushLog(`[提示] ${msg}`, 'err');
    return { ok: false, error: msg };
  }

  // 输入框里的数字单位是 K，需要 ×1024 换成 token 数再传给 -c
  // （与原管理器 "启动 {1} ({2}K)" 的行为一致）
  const ctxKNum = Number(ctxK) > 0
    ? Number(ctxK)
    : (Number(settings.defaultCtxK) || model.ctxK);
  const ctxTokens = Math.round(ctxKNum * 1024);
  const args = buildArgs(model, ctxTokens);

  clearLogs();
  pushLog(`[启动] ${model.name}  —  ${ctxKNum}K 上下文 (${ctxTokens} tokens)`, 'sys');
  pushLog(`[命令] ${serverExe} ${args.join(' ')}`, 'sys');

  startingModel = model.id;
  currentModel = model;

  try {
    child = spawn(serverExe, args, {
      cwd: path.dirname(serverExe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    startingModel = null;
    const msg = `启动失败: ${e.message}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }

  child.stdout.on('data', (d) => pushLog(d.toString('utf8'), 'out'));
  child.stderr.on('data', (d) => pushLog(d.toString('utf8'), 'err'));

  child.on('error', (e) => {
    pushLog(`[错误] 进程错误: ${e.message}`, 'err');
  });

  child.on('exit', (code, signal) => {
    pushLog(`[进程退出] code=${code} signal=${signal || '-'}`, 'sys');
    pushLog(`[结束] ${currentModel ? currentModel.name : ''} 已停止`, 'sys');
    child = null;
    currentModel = null;
    startingModel = null;
    broadcastStatus();
  });

  const pid = child.pid;
  pushLog(`[已启动] 进程 PID: ${pid}`, 'sys');
  pushLog('[等待] 正在加载模型，30-120 秒，请稍候…', 'sys');

  broadcastStatus();

  // 轮询就绪
  const deadline = Date.now() + (Number(settings.readyTimeoutSec) || 180) * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (!child) break; // 进程已退出，放弃等待
    if (await isPortOpen(model.port)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  startingModel = null;

  if (!ready) {
    if (child) {
      const msg = `${Number(settings.readyTimeoutSec) || 180} 秒内未检测到服务就绪`;
      pushLog(`[警告] ${msg}`, 'err');
      broadcastStatus();
      return { ok: false, error: msg, pid };
    }
    broadcastStatus();
    return { ok: false, error: '进程在就绪前退出，请查看日志', pid };
  }

  const realId = await fetchModelId(model.port);
  pushLog('[OK] llama-server 已就绪', 'sys');
  pushLog(`[API] http://127.0.0.1:${model.port}/v1`, 'sys');
  if (realId) pushLog(`[模型 id] ${realId}${model.vision ? ' (多模态)' : ''}`, 'sys');

  broadcastStatus();
  return { ok: true, pid, port: model.port, modelId: realId, vision: model.vision };
}

async function stopModel() {
  pushLog('[停止] 正在关闭 llama-server …', 'sys');
  await killLlamaProcesses();
  await new Promise((r) => setTimeout(r, 600));

  const still = await findLlamaProcesses();
  if (still.length > 0) {
    pushLog('[警告] 进程仍在，强制结束…', 'err');
    await killLlamaProcesses();
    await new Promise((r) => setTimeout(r, 400));
  }

  const after = await findLlamaProcesses();
  if (after.length === 0) {
    pushLog('[OK] llama-server 已停止', 'sys');
    child = null;
    currentModel = null;
    startingModel = null;
    broadcastStatus();
    return { ok: true };
  }
  pushLog(`[错误] 仍有进程存活: ${after.join(', ')}`, 'err');
  broadcastStatus();
  return { ok: false, error: '无法停止 llama-server' };
}

function broadcastStatus() {
  probeStatus().then((s) => {
    if (win && !win.isDestroyed()) win.webContents.send('status', s);
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#fafafa',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));

  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

ipcMain.handle('get-models', () => MODELS.map((m) => ({
  id: m.id,
  name: m.name,
  alias: m.alias,
  ctxK: m.ctxK,
  port: m.port,
  vision: m.vision,
  useMtp: m.useMtp,
  file: m.file,
  fileExists: fs.existsSync(m.file),
  mmproj: m.mmproj,
  mmprojExists: m.mmproj ? fs.existsSync(m.mmproj) : null,
  sizeGb: fs.existsSync(m.file) ? fs.statSync(m.file).size / 1024 ** 3 : 0,
})));

ipcMain.handle('get-status', () => probeStatus());
ipcMain.handle('start', (_e, id, ctxK) => startModel(id, ctxK));
ipcMain.handle('stop', () => stopModel());
ipcMain.handle('get-logs', () => logBuffer);
ipcMain.handle('clear-logs', () => { clearLogs(); return true; });

ipcMain.handle('open-url', (_e, url) => { shell.openExternal(url); return true; });

ipcMain.handle('get-gpu', () => queryGpu());

ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (_e, patch) => {
  const res = saveSettings(patch || {});
  // 主题立即生效
  if (res.ok && 'theme' in (patch || {})) applyTheme(settings.theme);
  return res;
});
ipcMain.handle('reset-settings', () => {
  settings = { ...DEFAULT_SETTINGS };
  try { fs.unlinkSync(SETTINGS_FILE()); } catch (_) {}
  applyTheme(settings.theme);
  return { ok: true, settings };
});

/** 选择文件 / 目录 */
ipcMain.handle('pick-path', async (_e, kind) => {
  const isDir = kind === 'dir';
  const r = await dialog.showOpenDialog(win, {
    properties: [isDir ? 'openDirectory' : 'openFile'],
    filters: isDir ? [] : [{ name: '可执行文件', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

function applyTheme(mode) {
  nativeTheme.themeSource = ['light', 'dark'].includes(mode) ? mode : 'system';
}

ipcMain.handle('get-memory', () => new Promise((resolve) => {
  // 仅返回系统内存；显存留空由前端降级显示
  const os = require('os');
  resolve({
    totalGb: os.totalmem() / 1024 ** 3,
    freeGb: os.freemem() / 1024 ** 3,
  });
}));

ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win-close', () => win && win.close());

/* ------------------------------------------------------------------ *
 * 单实例锁
 * 必须在 app.whenReady() 之前调用。第二次启动时立即退出，
 * 并把已有窗口激活到前台，而不是再开一个新实例。
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // 已有实例在跑：本进程直接退出，由已运行的实例接管
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户重复执行了启动：把最初那个窗口唤到前台
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  // 没抢到锁的实例不建窗口
  if (!gotLock) return;

  loadSettings();
  applyTheme(settings.theme);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 定期刷新状态
  setInterval(() => {
    if (win && !win.isDestroyed()) broadcastStatus();
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前确保不留下孤儿进程（但不动用户手动启动的服务）
// 注意：没抢到单实例锁的进程 child 恒为 null，不会误杀在跑的 llama-server
app.on('before-quit', () => {
  if (!gotLock) return;
  if (child) {
    try { child.kill(); } catch (_) {}
  }
});
