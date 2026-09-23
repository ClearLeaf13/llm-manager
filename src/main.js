'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');

const { SERVER_EXE, MODELS_DIR, MODELS, buildArgs, resolveModels, detectLlamaDir } = require('./models');
const store = require('./store');
const scanner = require('./scanner');
const trash = require('./trash');
const apiServer = require('./api-server');

/** 开机自启在注册表 Run 项里的名称 */
const AUTOSTART_KEY = 'llama.cpp-manager';

/** 当前生效的模型目录（设置可覆盖；否则自动探测） */
function currentModelsDir() {
  if (settings.modelsDir && fs.existsSync(settings.modelsDir)) return settings.modelsDir;
  const detected = detectLlamaDir();
  if (detected) return path.join(detected, 'models');
  return settings.modelsDir || MODELS_DIR;
}

/**
 * 取带绝对路径的模型列表。
 * 数据来源是 store（userData/models.json），首次启动时由 models.js
 * 的预置数据播种，之后完全由界面上的增删改维护。
 */
function modelsWithPaths() {
  return resolveModels(currentModelsDir(), store.all());
}

/** 取单个带绝对路径的模型 */
function modelWithPath(id) {
  const m = store.find(id);
  if (!m) return null;
  return resolveModels(currentModelsDir(), [m])[0];
}

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
  closeToTray: true,      // 点关闭时隐藏到托盘而非退出
};

let settings = { ...DEFAULT_SETTINGS };

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch (_) {
    parsed = {};
  }

  // 自动探测本机的 llama.cpp 目录
  const detectedRoot = detectLlamaDir();
  const detectedModelsDir = detectedRoot ? path.join(detectedRoot, 'models') : null;

  settings = { ...DEFAULT_SETTINGS, ...parsed };

  // 换机器后 settings.json 里的旧绝对路径会失效，此时回退到自动探测值
  if (!settings.serverExe || !fs.existsSync(settings.serverExe)) {
    if (detectedRoot) settings.serverExe = path.join(detectedRoot, 'llama-server.exe');
  }
  if (!settings.modelsDir || !fs.existsSync(settings.modelsDir)) {
    if (detectedModelsDir) settings.modelsDir = detectedModelsDir;
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
  for (const m of store.all()) {
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
  const model = modelWithPath(modelId);
  if (!model) return { ok: false, error: `无效模型: ${modelId}` };

  // 前置校验：文件是否存在（路径可在设置里覆盖）
  const serverExe = settings.serverExe || SERVER_EXE;
  if (!fs.existsSync(serverExe)) {
    const msg = `找不到 llama-server: ${serverExe}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }
  if (!fs.existsSync(model.filePath)) {
    const msg = `找不到模型文件: ${model.filePath}`;
    pushLog(`[错误] ${msg}`, 'err');
    return { ok: false, error: msg };
  }
  if (model.mmprojPath && !fs.existsSync(model.mmprojPath)) {
    const msg = `找不到视觉投影文件: ${model.mmprojPath}`;
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
 * 窗口 + 托盘
 * ------------------------------------------------------------------ */

/** 真正退出时置为 true，用于区分"关窗"与"退出应用" */
let quitting = false;

/** 托盘是否可用；不可用时"关闭到托盘"要降级为直接退出 */
let trayReady = false;

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

  // 关闭窗口 = 隐藏到托盘，应用与 llama-server 继续运行
  win.on('close', (e) => {
    if (quitting) return;                          // 真正退出，放行
    if (settings.closeToTray === false) return;    // 用户关掉了该行为
    if (!trayReady) {                              // 托盘不可用则正常退出
      quitting = true;
      return;
    }
    e.preventDefault();
    win.hide();
    notifyTray('已最小化到托盘，llama-server 继续运行');
  });

  win.on('closed', () => { win = null; });
}

let tray = null;

function notifyTray(msg) {
  if (tray && process.platform === 'win32') {
    try { tray.displayBalloon({ title: 'llama.cpp 管理器', content: msg }); } catch (_) {}
  }
}

/** 生成托盘图标：16x16 的圆角方块 + 中间亮点 */
function makeTrayIcon() {
  const { nativeImage } = require('electron');
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = x - 7.5;
      const cy = y - 7.5;
      const d = Math.sqrt(cx * cx + cy * cy);

      let a = 0;                    // 透明度
      let r = 47, g = 111, b = 235; // 主题蓝

      if (d < 6.5) {
        a = 255;                    // 实心圆
      } else if (d < 7.5) {
        a = Math.round((7.5 - d) * 255); // 边缘抗锯齿
      }

      // 中心挖一个小孔，让图标更易辨识
      if (d < 2.2) { a = 0; }

      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  if (tray) return;
  try {
    const { Tray, Menu } = require('electron');
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('llama.cpp 管理器');

    const menu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showWindow() },
      { type: 'separator' },
      { label: '打开数据目录', click: () => { shell.openPath(app.getPath('userData')); } },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]);
    tray.setContextMenu(menu);

    tray.on('double-click', () => showWindow());
    tray.on('click', () => showWindow());
    trayReady = true;
  } catch (e) {
    // 托盘不可用时降级：关闭窗口即退出，避免变成找不到的幽灵进程
    trayReady = false;
    console.warn('[tray] 托盘创建失败，关闭窗口将直接退出:', e.message);
  }
}

/** 把窗口显示出来并聚焦 */
function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 真正退出应用 */
function quitApp() {
  quitting = true;
  app.quit();
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

ipcMain.handle('get-models', () => modelsWithPaths().map((m) => ({
  id: m.id,
  name: m.name,
  alias: m.alias,
  ctxK: m.ctxK,
  port: m.port,
  vision: m.vision,
  useMtp: m.useMtp,
  file: m.filePath,
  fileExists: fs.existsSync(m.filePath),
  mmproj: m.mmprojPath,
  mmprojExists: m.mmprojPath ? fs.existsSync(m.mmprojPath) : null,
  sizeGb: fs.existsSync(m.filePath) ? fs.statSync(m.filePath).size / 1024 ** 3 : 0,
})));

ipcMain.handle('get-status', () => probeStatus());
ipcMain.handle('start', (_e, id, ctxK) => startModel(id, ctxK));
ipcMain.handle('stop', () => stopModel());
ipcMain.handle('get-logs', () => logBuffer);
ipcMain.handle('clear-logs', () => { clearLogs(); return true; });

/* --- 模型管理 --- */

/** 模型列表，附带解析后的元信息（供管理界面用） */
ipcMain.handle('models-list', () => modelsWithPaths().map((m) => ({
  id: m.id,
  name: m.name,
  alias: m.alias,
  ctxK: m.ctxK,
  port: m.port,
  vision: m.vision,
  useMtp: m.useMtp,
  file: m.file,
  mmproj: m.mmproj,
  filePath: m.filePath,
  mmprojPath: m.mmprojPath,
  fileExists: fs.existsSync(m.filePath),
  mmprojExists: m.mmprojPath ? fs.existsSync(m.mmprojPath) : null,
  sizeGb: fs.existsSync(m.filePath) ? fs.statSync(m.filePath).size / 1024 ** 3 : 0,
})));

/** 扫描模型目录 */
ipcMain.handle('models-scan', (_e, dir) => scanner.scan(dir || currentModelsDir()));

/** 新增模型（自动分配 id 与端口） */
ipcMain.handle('models-create', (_e, input) => {
  const payload = { ...(input || {}) };
  if (payload.port === undefined || payload.port === null || payload.port === '') {
    payload.port = store.nextPort();
  }
  const res = store.create(payload);
  if (res.ok) broadcastStatus();
  return res;
});

/** 修改模型；运行中的模型不允许改端口/文件 */
ipcMain.handle('models-update', (_e, id, patch) => {
  const running = currentModel && currentModel.id === id;
  if (running) {
    const touched = ['file', 'mmproj', 'port'].some(
      (k) => patch && Object.prototype.hasOwnProperty.call(patch, k),
    );
    if (touched) {
      return { ok: false, error: '模型正在运行，请先停止再修改文件与端口' };
    }
  }
  const res = store.update(id, patch || {});
  if (res.ok) broadcastStatus();
  return res;
});

/** 删除模型（仅从列表移除，不动文件）—— 保留给单条删除用 */
ipcMain.handle('models-delete', (_e, id) => {
  if (currentModel && currentModel.id === id) {
    return { ok: false, error: '模型正在运行，请先停止再删除' };
  }
  const res = store.remove(id);
  if (res.ok) broadcastStatus();
  return res;
});

/** 批量删除预览：列出将被删除的文件与总大小 */
ipcMain.handle('models-delete-preview', (_e, ids) => {
  const list = Array.isArray(ids) ? ids : [ids];
  const models = list
    .map((id) => modelWithPath(id))
    .filter(Boolean);

  if (!models.length) return { ok: false, error: '未找到要删除的模型' };

  const running = models.filter((m) => currentModel && currentModel.id === m.id);
  const pv = trash.preview(models, currentModelsDir());

  return {
    ok: true,
    items: pv.items,
    totalGb: pv.totalGb,
    warnings: pv.warnings,
    running: running.map((m) => m.name),
  };
});

/**
 * 批量删除模型：移入回收站 + 从配置移除。
 * @param {string[]} ids 模型 id
 * @param {boolean} withFiles 是否同时删除文件
 */
ipcMain.handle('models-delete-batch', async (_e, ids, withFiles) => {
  const list = Array.isArray(ids) ? ids : [ids];
  const models = list.map((id) => modelWithPath(id)).filter(Boolean);
  if (!models.length) return { ok: false, error: '未找到要删除的模型' };

  // 运行中的模型一律拒绝
  const running = models.filter((m) => currentModel && currentModel.id === m.id);
  if (running.length) {
    return {
      ok: false,
      error: `以下模型正在运行，请先停止：${running.map((m) => m.name).join('、')}`,
    };
  }

  const dir = currentModelsDir();
  let trashed = 0;
  const failed = [];
  const skipped = [];

  if (withFiles) {
    for (const m of models) {
      const { files, outside } = trash.collectFiles(m, dir);
      for (const o of outside) skipped.push({ name: m.name, path: o });

      const targets = files.filter((f) => f.exists).map((f) => f.path);
      for (const t of targets) {
        try {
          await shell.trashItem(t);
          trashed += 1;
        } catch (e) {
          failed.push({ name: path.basename(t), error: e.message || String(e) });
        }
      }
    }
  }

  // 文件处理完再改配置；配置写入失败也不回滚已删文件（文件已进回收站，可恢复）
  const removedIds = [];
  for (const m of models) {
    const r = store.remove(m.id);
    if (r.ok) removedIds.push(m.id);
    else failed.push({ name: m.name, error: r.error });
  }

  broadcastStatus();

  return {
    ok: true,
    removed: removedIds.length,
    trashed,
    failed,
    skipped,
  };
});

/* --- 开机自启 --- */

ipcMain.handle('autostart-get', () => {
  if (process.platform !== 'win32') return { ok: true, enabled: false, supported: false };
  try {
    const r = require('child_process').execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', AUTOSTART_KEY,
    ], { windowsHide: true, encoding: 'utf8' });
    return { ok: true, enabled: /REG_SZ/.test(r), supported: true };
  } catch (_) {
    // 查询失败通常表示该项不存在
    return { ok: true, enabled: false, supported: true };
  }
});

ipcMain.handle('autostart-set', (_e, enable) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: '仅支持 Windows' };
  }
  const exe = app.getPath('exe');
  try {
    if (enable) {
      require('child_process').execFileSync('reg', [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', AUTOSTART_KEY,
        '/t', 'REG_SZ',
        '/d', `"${exe}"`,
        '/f',
      ], { windowsHide: true });
    } else {
      require('child_process').execFileSync('reg', [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', AUTOSTART_KEY,
        '/f',
      ], { windowsHide: true });
    }
    return { ok: true, enabled: !!enable };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

/** 恢复预置模型（保留自定义的） */
ipcMain.handle('models-reset', () => {
  const res = store.resetToSeed();
  broadcastStatus();
  return res.ok ? { ok: true } : res;
});

/** 取下一个可用端口（新增表单预填用） */
ipcMain.handle('models-next-port', () => store.nextPort());

/** 磁盘占用：模型目录所在盘的空闲/总量，以及模型文件合计大小 */
ipcMain.handle('disk-usage', () => {
  const dir = currentModelsDir();
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  const drive = stat ? dir : path.parse(dir).root;

  let freeGb = 0;
  let totalGb = 0;
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(drive);
      freeGb = (s.bfree * s.bsize) / 1024 ** 3;
      totalGb = (s.blocks * s.bsize) / 1024 ** 3;
    }
  } catch (_) { /* 取不到就留 0 */ }

  // 已配置模型的文件合计
  let usedGb = 0;
  for (const m of modelsWithPaths()) {
    try {
      if (fs.existsSync(m.filePath)) usedGb += fs.statSync(m.filePath).size / 1024 ** 3;
      if (m.mmprojPath && fs.existsSync(m.mmprojPath)) {
        usedGb += fs.statSync(m.mmprojPath).size / 1024 ** 3;
      }
    } catch (_) { /* 忽略 */ }
  }

  return {
    dir: drive,
    freeGb,
    totalGb,
    usedGb,
  };
});

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
ipcMain.on('win-close', () => { if (win) win.close(); });
ipcMain.on('win-hide', () => { if (win) win.hide(); });

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
    // 用户重复执行了启动：把窗口唤到前台（可能在托盘里藏着）
    showWindow();
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
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

  // 模型配置存储：首次启动用预置数据播种
  store.init(app.getPath('userData'));

  // 先建托盘，再建窗口 —— 窗口的 close 处理依赖 trayReady
  createTray();
  createWindow();

  // 本地控制 API：供外部程序（如 DSH 插件）查询与启停模型。
  // 起不来不影响管理器本身，静默降级即可。
  apiServer.start({
    userDataDir: app.getPath('userData'),
    listModels: () => store.all(),
    getStatus: () => probeStatus(),
    start: (id, ctxK) => startModel(id, ctxK),
    stop: () => stopModel(),
  }).then((r) => {
    if (r.ok) console.log(`[api] 控制接口已就绪: http://127.0.0.1:${r.port}`);
    else console.warn('[api] 控制接口未启动:', r.error);
  });

  app.on('activate', () => {
    showWindow();
  });

  // 定期刷新状态
  setInterval(() => {
    if (win && !win.isDestroyed()) broadcastStatus();
  }, 5000);
});

// 关闭窗口不退出应用 —— 留在托盘继续跑（llama-server 不受影响）
app.on('window-all-closed', () => {
  // 显式退出时才会走到这里（quitting=true 由 quitApp 设置）
  if (quitting && process.platform !== 'darwin') app.quit();
});

// 退出前确保不留下孤儿进程（但不动用户手动启动的服务）
// 注意：没抢到单实例锁的进程 child 恒为 null，不会误杀在跑的 llama-server
app.on('before-quit', () => {
  quitting = true;
  // 关闭控制接口并清理落盘令牌
  apiServer.stop().catch(() => {});
  if (!gotLock) return;
  if (child) {
    try { child.kill(); } catch (_) {}
  }
});
