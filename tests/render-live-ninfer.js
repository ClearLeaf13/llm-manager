'use strict';
/**
 * 在真实 Electron 渲染进程里检查「NInfer 运行时」的状态显示。
 *
 * 覆盖本轮修复：
 *   - 运行状态卡显示 ninfer-serve 的 PID（不再是 llama-server）
 *   - 当前模型副标题按 ninfer.vision 显示「多模态」
 *   - 推理引擎卡显示 NInfer
 *
 *   运行：node_modules/electron/dist/electron.exe tests/render-live-ninfer.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { app, BrowserWindow } = require('electron');

const MODELS = [
  { id: 'reap', name: 'Qwen3.6-VL-REAP-26B', alias: 'REAP-26B', ctxK: 90, port: 8082,
    vision: true, useMtp: false, engine: 'llamacpp', ninfer: null,
    file: 'reap.gguf', fileExists: true, mmproj: 'mm.gguf', mmprojExists: true, sizeGb: 13.59,
    noMmprojOffload: true, extraArgs: '' },
  // 顶层 vision 故意写成 false，模拟历史遗留的不一致配置
  { id: 'nf1', name: 'Qwen3.8-27B (NInfer)', alias: 'qwen3.8-27b', ctxK: 96, port: 8090,
    vision: false, useMtp: false, engine: 'ninfer',
    ninfer: { maxContext: 98304, kvDtype: 'q4', prefillChunk: 896, draftTokens: 3,
              thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
              embeddingHost: true, spec: 'mtp', noCudaGraph: true, extraArgs: '' },
    file: '/root/models/qwen3_8_27b.ninfer', fileExists: true, mmproj: null, mmprojExists: null,
    sizeGb: 15.33, noMmprojOffload: false, extraArgs: '' },
];

// NInfer 正在跑：llama 侧无进程，ninfer 侧有 PID
const STATUS = {
  running: true, pids: [], ninferPids: [4242],
  ninfer: { distro: 'Ubuntu-24.04', distroState: 'running', pids: [4242] },
  engine: 'ninfer',
  ports: { 8090: true }, current: 'nf1', starting: false,
};

const PAYLOAD = Buffer.from(JSON.stringify({
  models: MODELS, scan: [], ninferFiles: [], status: STATUS,
}), 'utf8').toString('base64');

app.commandLine.appendSwitch('disable-gpu');

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

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const $ = (id) => document.getElementById(id);
    const txt = (el) => (el ? el.textContent.trim() : null);
    const o = {};
    o.state = txt($('st-state'));
    o.model = txt($('st-model'));
    o.modelSub = txt($('st-model-sub'));
    o.engine = txt($('st-engine'));
    o.engineSub = txt($('st-engine-sub'));
    o.pid = txt($('st-pid'));
    o.pidSub = txt($('st-pid-sub'));
    o.cards = [...document.querySelectorAll('#model-list .card')].map(c => ({
      name: txt(c.querySelector('.card-name')),
      badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
    }));
    return o;
  })()`);

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
}
