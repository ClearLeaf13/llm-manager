'use strict';
/**
 * 在**真实 Electron 渲染进程**里检查界面状态。
 *
 * 前面的 tests/*.test.js 用的是自建 DOM 桩；这个脚本走真实 Chromium，
 * 用来确认桩没有掩盖问题（历史教训：桩本身出过 4 个 bug）。
 *
 *   运行：node_modules/electron/dist/electron.exe tests/render-live.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 必须用裸标识符 require('electron')：Electron 内部靠它注入 app/BrowserWindow。
// 写成 require(path.join(...)) 会解析到 npm 包，返回的只是一个 exe 路径字符串。
const { app, BrowserWindow } = require('electron');

const MODELS = [
  { id: 'reap', name: 'Qwen3.6-VL-REAP-26B', alias: 'REAP-26B', ctxK: 90, port: 8082,
    vision: true, useMtp: false, engine: 'llamacpp', ninfer: null,
    file: 'reap.gguf', filePath: 'C:\\m\\reap.gguf', fileExists: true,
    mmproj: 'mm.gguf', mmprojPath: 'C:\\m\\mm.gguf', mmprojExists: true,
    sizeGb: 13.59, noMmprojOffload: true, extraArgs: '' },
  { id: 'nf1', name: 'Qwen3.8-27B (NInfer)', alias: 'qwen3.8-27b', ctxK: 96, port: 8090,
    vision: true, useMtp: false, engine: 'ninfer',
    ninfer: { maxContext: 98304, kvDtype: 'q4', prefillChunk: 896, draftTokens: 3,
              thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
              embeddingHost: true, spec: 'mtp', noCudaGraph: true, extraArgs: '' },
    file: '/root/models/qwen3_8_27b.ninfer', filePath: '/root/models/qwen3_8_27b.ninfer',
    fileExists: true, mmproj: null, mmprojExists: null,
    sizeGb: 15.33, noMmprojOffload: false, extraArgs: '' },
];

const SCAN = [
  { file: 'reap.gguf', sizeGb: 13.59, mmproj: false, engine: 'llamacpp', quantization: 'IQ4_XS', meta: {} },
  { file: 'mm.gguf', sizeGb: 0.84, mmproj: true, engine: 'llamacpp', meta: null },
  { file: 'new-model-Q4_K_M.gguf', sizeGb: 4.2, mmproj: false, engine: 'llamacpp', quantization: 'Q4_K_M', meta: {} },
  { file: 'mmproj-extra-F16.gguf', sizeGb: 0.9, mmproj: true, engine: 'llamacpp', meta: null },
];

// 已配置的 WSL NInfer 模型（也应被扫描结果隐藏）
const NINFER_FILES = [
  { path: '/root/models/qwen3_8_27b.ninfer', file: 'qwen3_8_27b.ninfer',
    dir: '/root/models', sizeGb: 15.33, meta: { modelId: 'qwen3.8-27b' } },
];

const STATUS = {
  running: true, pids: [1234], ninferPids: [],
  ninfer: { distro: 'Ubuntu-24.04', distroState: 'stopped', pids: [] },
  engine: 'llamacpp', ports: { 8082: true }, current: 'reap', starting: false,
};

const PAYLOAD = Buffer.from(JSON.stringify({
  models: MODELS, scan: SCAN, ninferFiles: NINFER_FILES, status: STATUS,
}), 'utf8').toString('base64');

app.commandLine.appendSwitch('disable-gpu');

// 任何异常都要能看到，否则 Electron 会静默挂住
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', (e && e.stack) || e);
  app.exit(1);
});

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.error('[failed]', (e && e.stack) || e);
    app.exit(1);
  }
});

async function run() {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: {
      preload: path.join(ROOT, 'tests/live-preload.js'),
      contextIsolation: true, nodeIntegration: false,
      additionalArguments: ['--live-payload=' + PAYLOAD],
    },
  });

  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) console.error('[renderer]', msg);
  });

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const script = `(async () => {
    const out = {};
    const $ = (id) => document.getElementById(id);
    const txt = (el) => (el ? el.textContent.trim() : null);

    const cards = [...document.querySelectorAll('#model-list .card')];
    out.cards = cards.map(c => ({
      name: txt(c.querySelector('.card-name')),
      badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
      meta: txt(c.querySelector('.card-meta')),
      inputs: c.querySelectorAll('input').length,
    }));

    document.querySelector('.rail-btn[data-view="manage"]').click();
    await new Promise(r => setTimeout(r, 500));
    out.manageVisible = !$('pane-manage').classList.contains('hidden');
    out.paramsVisible = !$('pane-params').classList.contains('hidden');

    const rows = [...document.querySelectorAll('#manage-list .mrow')];
    out.rows = rows.map(r => ({
      name: txt(r.querySelector('.mrow-name')),
      badges: [...r.querySelectorAll('.badge')].map(b => b.textContent.trim()),
      buttons: [...r.querySelectorAll('button')].map(b => b.textContent.trim()),
      selected: r.classList.contains('selected'),
    }));

    const nfRow = rows.find(r => r.textContent.includes('NInfer'));
    if (!nfRow) { out.error = 'no NInfer row'; return out; }
    nfRow.click();
    await new Promise(r => setTimeout(r, 500));

    out.afterRowClick = {
      engineTag: txt($('p-engine-tag')),
      ctxValue: $('p-ctx').value,
      ctxNote: txt($('p-ctx-note')),
      ctxDisabled: $('p-ctx').disabled,
      ninferGroupHidden: $('p-ninfer-group').hidden,
      mmprojRowHidden: $('p-row-nommproj').hidden,
      saveDisabled: $('p-save').disabled,
      cmdPrefix: txt($('p-cmd')).slice(0, 42),
      selectedRows: document.querySelectorAll('#manage-list .mrow.selected').length,
    };

    $('p-ctx').value = '48';
    $('p-ctx').dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    out.ctxAfterEdit = { note: txt($('p-ctx-note')) };

    $('btn-scan').click();
    await new Promise(r => setTimeout(r, 900));
    out.scan = {
      title: txt($('scan-title')),
      items: [...document.querySelectorAll('#scan-list .scan-item')].map(i => ({
        name: txt(i.querySelector('.sname')),
        btn: txt(i.querySelector('.sadd')),
      })),
    };

    return out;
  })()`;

  const result = await win.webContents.executeJavaScript(script);
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
}
