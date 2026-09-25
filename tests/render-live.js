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
// 真实命令行拼装：为每种开关组合预先算好，供沙箱 preload 查表
const models = require(path.join(ROOT, 'src/models'));
const { buildArgs } = models;

// 必须用裸标识符 require('electron')：Electron 内部靠它注入 app/BrowserWindow。
// 写成 require(path.join(...)) 会解析到 npm 包，返回的只是一个 exe 路径字符串。
const { app, BrowserWindow } = require('electron');

const MODELS = [
  { id: 'reap', name: 'Qwen3.6-VL-REAP-26B', alias: 'REAP-26B', ctxK: 90, port: 8082,
    vision: true, useMtp: false, engine: 'llamacpp', ninfer: null,
    file: 'reap.gguf', filePath: 'C:\\m\\reap.gguf', fileExists: true,
    mmproj: 'mm.gguf', mmprojPath: 'C:\\m\\mm.gguf', mmprojExists: true,
    sizeGb: 13.59, noMmprojOffload: true, extraArgs: '',
    jinja: true, flashAttn: true, ctxShift: true, loadMode: 'mlock',
    // 补全后的启动选项：默认值要和 src/models.js 的 PARAM_DEFAULTS 对得上，
    // 否则摘要断言（例如「不该写默认值」）测的就不是默认状态。
    gpuLayers: -1, splitMode: 'layer', kvOffload: true, threads: -1, threadsBatch: -1,
    batch: 2048, ubatch: 512, fits: true, chatTemplateFile: '', reasoningFormat: 'auto',
    temperature: '0.6', topP: '0.95', topK: 20, minP: '0.0',
    repeatPenalty: '1.0', presencePenalty: '0.0',
    cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', parallel: 1, timeout: 0,
    noOpOffload: false, metrics: false, noWebui: false },
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

/**
 * 为 llama.cpp 模型生成「开关组合 → 真实命令行」表，供沙箱 preload 查表。
 *
 * 沙箱 preload 拿不到 src/models，只能查表；表里的每一行都来自真实 buildArgs，
 * 所以界面断言测到的确实是「改开关 → 命令变了」，而不是手写字符串。
 *
 * 只枚举用例真正会用到的组合：96 种全量枚举会让 base64 载荷冲到 ~43 KB，
 * 超过 Windows 命令行 32 KB 上限，Electron 会启动失败（ERR_FAILED）。
 */
const ARGS_CASES = [
  // 默认全开（初始渲染 + 恢复默认后的组合）
  { jinja: true, flashAttn: true, ctxShift: true, useMtp: false, loadMode: 'mlock', noMmprojOffload: true },
  // 关掉 jinja（E2 断言用），保持 mlock
  { jinja: false, flashAttn: true, ctxShift: true, useMtp: false, loadMode: 'mlock', noMmprojOffload: true },
  // 关掉 jinja + 切 mmap（E2 第二步断言用）
  { jinja: false, flashAttn: true, ctxShift: true, useMtp: false, loadMode: 'mmap', noMmprojOffload: true },
];

function buildArgsTable(model) {
  const table = {};
  for (const c of ARGS_CASES) {
    const m = { ...model, ...c };
    for (const ctxK of [model.ctxK, 32, 48]) {
      const key = [c.jinja, c.flashAttn, c.ctxShift, c.useMtp, c.loadMode, c.noMmprojOffload].join('|');
      table[key + '|' + ctxK] = 'llama-server.exe ' + buildArgs(m, ctxK).join(' ');
    }
  }
  return table;
}

const ARGS_TABLE = buildArgsTable(MODELS[0]);

/**
 * 「手改命令 → 真实覆盖结果」表：同样由真实的 models.applyCmdOverride 算出，
 * 供沙箱 preload 查表。render-live.js 里那段「手改 --threads 8 --my-custom-flag」
 * 必须真的走一遍产品逻辑，否则测的只是桩。
 */
function buildOverrideTable(model) {
  const table = {};
  for (const c of ARGS_CASES) {
    const m = { ...model, ...c };
    for (const ctxK of [model.ctxK, 32, 48]) {
      const key = [c.jinja, c.flashAttn, c.ctxShift, c.useMtp, c.loadMode, c.noMmprojOffload].join('|');
      const baseArgs = buildArgs(m, ctxK);
      const baseCmd = 'llama-server.exe ' + baseArgs.join(' ');
      // render-live 里手改的一句话（原样追加），必须与测试脚本保持一致
      const ovText = baseCmd + ' --threads 8 --my-custom-flag';
      const ov = models.applyCmdOverride(
        baseArgs, ovText, 'llama-server.exe', ['-m', '--mmproj', '--host', '--port']);
      // 未改动的情形：把基准命令原样当成覆盖传下去，也必须判成「没改过」
      const ovSame = models.applyCmdOverride(
        baseArgs, baseCmd, 'llama-server.exe', ['-m', '--mmproj', '--host', '--port']);
      table[key + '|' + ctxK + '|' + ovText] = {
        command: 'llama-server.exe ' + ov.args.join(' '),
        applied: ov.applied, protectedKeys: ov.protectedKeys,
      };
      table[key + '|' + ctxK + '|' + baseCmd] = {
        command: 'llama-server.exe ' + ovSame.args.join(' '),
        applied: ovSame.applied, protectedKeys: ovSame.protectedKeys,
      };
    }
  }
  return table;
}

const OVERRIDE_TABLE = buildOverrideTable(MODELS[0]);

const PAYLOAD = Buffer.from(JSON.stringify({
  models: MODELS, scan: SCAN, ninferFiles: NINFER_FILES, status: STATUS,
  argsTable: ARGS_TABLE, overrideTable: OVERRIDE_TABLE,
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
      ninferOptHidden: $('popt-ninfer').hidden,
      llamaOptHidden: $('popt-adv').hidden,
      mmprojRowHidden: $('p-row-nommproj').hidden,
      saveDisabled: $('p-save').disabled,
      restoreDisabled: $('p-restore').disabled,
      cmdPrefix: $('p-cmd').value.slice(0, 42),
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

    // ---- 启动命令的折叠子菜单：真实浏览器里折叠必须真的藏起来 ----
    // 先切回 llama.cpp 模型（通用开关只在这类模型下出现）
    const lcRow = rows.find(r => r.textContent.includes('llama.cpp'));
    lcRow.click();
    await new Promise(r => setTimeout(r, 500));

    const mem = $('popt-mem');
    const memBody = mem.querySelector('.popt-body');
    out.fold = {
      // 启动命令分组必须包住所有选项与保存按钮
      cmdContainsOptions: !!$('p-cmd').closest('.pgroup-cmd'),
      optIds: [...document.querySelectorAll('#pane-params .popt')].map(d => d.id),
      memOpenByDefault: mem.open,
      // 注意：折叠状态下 getBoundingClientRect/offsetHeight 仍会给出几何值，
      // 拿高度判断「有没有藏起来」是错的（实测 data: 页也一样）。
      // 真正可靠的信号是 details 的 open 属性 + 浏览器渲染的 summary 高度。
      memSummaryHeight: mem.querySelector('.popt-head').getBoundingClientRect().height,
      memSummary: txt(mem.querySelector('.popt-name')),
      memValueText: txt($('popt-mem-val')),
      ctxValueText: txt($('popt-ctx-val')),
      tplValueText: txt($('popt-tpl-val')),
      advValueText: txt($('popt-adv-val')),
      // 收起时 summary 仍在（点得到），body 被浏览器原生折叠
      caretCount: mem.querySelectorAll('.popt-caret').length,
    };

    // 折叠/展开：只断言 open 属性，这是唯一可靠的折叠信号
    mem.open = false;
    await new Promise(r => setTimeout(r, 200));
    out.fold.memOpenAfterCollapse = mem.open;
    out.fold.summaryStillVisible = mem.querySelector('.popt-head').getBoundingClientRect().height > 0;
    mem.open = true;
    await new Promise(r => setTimeout(r, 200));
    out.fold.memOpenAfterExpand = mem.open;
    out.fold.bodyHasInputs = mem.querySelectorAll('.popt-body input, .popt-body select').length;

    // ---- 保存 / 恢复按钮位置：必须在最下方且靠右 ----
    const save = $('p-save').getBoundingClientRect();
    const restore = $('p-restore').getBoundingClientRect();
    const body = document.querySelector('#pane-params .content-body').getBoundingClientRect();
    const lastOpt = [...document.querySelectorAll('#pane-params .popt')]
      .map(d => d.getBoundingClientRect().bottom)
      .reduce((a, b) => Math.max(a, b), 0);
    out.actions = {
      restoreLeftOfSave: restore.right <= save.left + 1,
      // 操作条是 sticky 钉在视口底部的：内容长了会从它下面滚过去，
      // 所以「在所有选项之下」不再是有效断言，改为「钉在内容区底部」。
      // content-body 自身有 20px 下内边距，操作条钉在这个内边距之内，
      // 所以留 24px 容差；关键是「贴着底」而不是「在所有选项之下」。
      saveStickyToBottom: (body.bottom - save.bottom) >= 0 && (body.bottom - save.bottom) <= 40,
      // 底部操作条和保存按钮的右边距应该一致 —— 都贴着内容区右边缘（含内边距）。
      // 抹平 47px 的容器内边距后，两者应基本对齐，否则就是按钮没靠右。
      saveRightGap: Math.round(body.right - save.right),
      barRightGap: Math.round(body.right - $('p-status').closest('.pactions').getBoundingClientRect().right),
      statusLeftOfButtons: $('p-status').getBoundingClientRect().right <= restore.left + 1,
    };

    // ---- 开关真的改命令：关掉 jinja，看预览里的 flag 有没有掉 ----
    // 预览是防抖刷新的（refreshCmd 有 ~120ms 延迟），所以这里等久一点；
    // 之前等 400ms 时 jinja 还没刷新，afterJinja 会误报成 true。
    const cmdHas = (s) => $('p-cmd').value.includes(s);
    out.toggle = { beforeJinja: cmdHas('--jinja'), beforeMlock: cmdHas('--load-mode mlock') };
    $('p-jinja').checked = false;
    $('p-jinja').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    out.toggle.afterJinja = cmdHas('--jinja');
    out.toggle.tplSummaryAfterJinja = txt($('popt-tpl-val'));
    out.toggle.unknownCombo = $('p-cmd').value.includes('未知组合');

    $('p-loadmode').value = 'mmap';
    $('p-loadmode').dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    out.toggle.afterMlock = cmdHas('--load-mode mlock');
    out.toggle.afterMmap = cmdHas('--load-mode mmap');
    out.toggle.memSummary = txt($('popt-mem-val'));

    // ---- 启动命令真的能改：手改 → 覆盖生效；「重新生成」→ 回到基准 ----
    // 这是用户最核心的诉求（「启动命令要求可以自行修改」），必须在真实浏览器里验。
    const cmdBox = $('p-cmd');
    const baseBefore = cmdBox.value;
    const lc = rows.find(r => r.textContent.includes('llama.cpp'));
    out.edit = { isTextarea: cmdBox.tagName === 'TEXTAREA' };
    out.edit.readOnlyBefore = cmdBox.disabled || cmdBox.readOnly;
    // 没改过时不该标成「已自定义」
    out.edit.customFlagBefore = !$('p-cmd-flag').hidden;
    out.edit.regenHiddenBefore = $('p-cmd-regen').hidden;

    // 手改：加一个 --threads 8 与一个自定义 flag
    cmdBox.value = baseBefore + ' --threads 8 --my-custom-flag';
    cmdBox.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    out.edit.customFlagWhileTyping = !$('p-cmd-flag').hidden;
    out.edit.boxStyledCustom = cmdBox.classList.contains('custom');
    out.edit.optionsLocked = document.querySelector('.poptions').classList.contains('locked');
    out.edit.warnShown = !$('p-cmd-warn').hidden;

    // 失焦 → 走一遍真实比对，用户写的参数必须原样留下
    cmdBox.dispatchEvent(new Event('blur', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    out.edit.keptAfterBlur = cmdBox.value.includes('--my-custom-flag');
    out.edit.keptThreads = cmdBox.value.includes('--threads 8');
    out.edit.customFlagAfterBlur = !$('p-cmd-flag').hidden;
    // 受保护项仍由管理器接管：模型文件必须有且正确
    const lcModel = rows.find(r => r.textContent.includes('llama.cpp'));
    out.edit.stillHasModelPath = /\.gguf/.test(cmdBox.value);
    out.edit.stillHasPort = cmdBox.value.includes('--port');

    // 「重新生成」应丢弃手改，回到按选项拼出来的命令。
    // 注意：renderer 里的 confirm() 在隐藏窗口里会一直等人点，会把整个测试挂死，
    // 所以先换成自动确认，点完再还原。
    const realConfirm = window.confirm;
    window.confirm = () => true;
    $('p-cmd-regen').click();
    await new Promise(r => setTimeout(r, 700));
    window.confirm = realConfirm;
    out.edit.regenDroppedCustom = !cmdBox.value.includes('--my-custom-flag');
    out.edit.customFlagAfterRegen = !$('p-cmd-flag').hidden;
    out.edit.backToBase = cmdBox.value === baseBefore;

    // ---- KVMem 卡片：位于启动命令模块下方，卡片底部有居中的项目地址 ----
    const kvGroup = $('pgroup-kvmem');
    const kvLink = $('p-kvmem-link');
    const cmdGroup = document.querySelector('.pgroup-cmd');
    out.kvmem = {
      exists: !!kvGroup,
      hasToggle: !!$('p-kvmem') && $('p-kvmem').type === 'checkbox',
      // 「启动命令模块下方」：KVMem 的顶边必须在启动命令分组的底边之下
      belowCmd: !!kvGroup && !!cmdGroup
        && kvGroup.getBoundingClientRect().top >= cmdGroup.getBoundingClientRect().bottom - 2,
      linkHref: kvLink ? kvLink.getAttribute('href') : '',
      // 链接居中：链接中心与卡片中心基本重合
      linkCentered: !!kvLink && !!kvGroup
        && Math.abs(
          (kvLink.getBoundingClientRect().left + kvLink.getBoundingClientRect().right) / 2
          - (kvGroup.getBoundingClientRect().left + kvGroup.getBoundingClientRect().right) / 2
        ) <= 2,
      // 小字：明显小于正文
      linkFontSize: kvLink ? parseFloat(getComputedStyle(kvLink).fontSize) : 0,
      // 在卡片底部：链接底边不高于卡片底边
      linkAtBottom: !!kvLink && !!kvGroup
        && kvLink.getBoundingClientRect().bottom <= kvGroup.getBoundingClientRect().bottom + 1,
    };

    // 切到状态页看环形进度与合并卡
    document.querySelector('.rail-btn[data-view="models"]').click();
    await new Promise(r => setTimeout(r, 700));
    const arc = $('st-vram-arc');
    const arcStyle = arc ? getComputedStyle(arc) : null;
    out.status = {
      // 圆环：真画出来了（svg circle，有描边宽度）
      ringIsSvg: !!arc && arc.tagName.toLowerCase() === 'circle',
      ringStroke: arcStyle ? parseFloat(arcStyle.strokeWidth) : 0,
      ringDash: arcStyle ? arcStyle.strokeDasharray : '',
      // 弧长随占用率变化：dashoffset 不该停在初始值
      ringOffset: arc ? arc.style.strokeDashoffset : 'x',
      pctText: txt($('st-vram-pct')),
      // 旧的条形进度条应彻底消失
      oldBars: document.querySelectorAll('#pane-status .sbar').length,
      // 合并卡：模型名前的引擎标签
      enginePill: txt($('st-engine-pill')),
      enginePillHidden: $('st-engine-pill').hidden,
      enginePillColor: $('st-engine-pill')
        ? getComputedStyle($('st-engine-pill')).color : '',
      modelName: txt($('st-model')),
      modelSub: txt($('st-model-sub')),
      // 独立的「推理引擎」卡已不存在
      oldEngineCard: !!$('st-engine'),
    };

    // ---- 第三页：日志 ----
    document.querySelector('.rail-btn[data-view="log"]').click();
    await new Promise(r => setTimeout(r, 500));
    const logPane = $('pane-log');
    out.logPage = {
      visible: !logPane.classList.contains('hidden'),
      // 日志模块确实搬过来了：log 元素在日志页里面
      logInsidePane: !!logPane.querySelector('#log'),
      logWrapInsidePane: !!logPane.querySelector('#log-wrap'),
      // 第二页不再有日志
      logOnParams: !!document.querySelector('#pane-params .log-wrap'),
      leftPaneHidden: $('pane-models').classList.contains('hidden'),
      statusHidden: $('pane-status').classList.contains('hidden'),
      splitterHidden: $('split-1').classList.contains('hidden'),
      // 日志页是整页高：比第二页那个 260px 固定框高
      logWrapHeight: logPane.querySelector('#log-wrap').getBoundingClientRect().height,
      // 按钮跟着搬过来了
      hasAutoscroll: !!logPane.querySelector('#btn-autoscroll'),
      hasClear: !!logPane.querySelector('#btn-clear'),
    };

    // 回到第一页，别把状态留给后面的断言
    document.querySelector('.rail-btn[data-view="models"]').click();
    await new Promise(r => setTimeout(r, 300));

    return out;
  })()`;

  const result = await win.webContents.executeJavaScript(script);
  console.log(JSON.stringify(result, null, 2));

  // 光打印数值的话，回归了也没人发现 —— 这里把关键行为变成硬断言
  const fails = [];
  const is = (cond, msg, got) => { if (!cond) fails.push(msg + '（实际 ' + JSON.stringify(got) + '）'); };
  const f = result.fold || {};
  const a = result.actions || {};
  const t = result.toggle || {};

  is(f.cmdContainsOptions, '启动命令分组应包住选项', f.cmdContainsOptions);
  is(JSON.stringify(f.optIds) === JSON.stringify(
    ['popt-ctx', 'popt-mem', 'popt-perf', 'popt-tpl', 'popt-sample', 'popt-adv', 'popt-ninfer']),
    '七个折叠子菜单应齐全且顺序固定', f.optIds);
  is(f.memSummary === '显存与卸载', '显存与卸载应是启动命令下的子菜单', f.memSummary);
  is(f.memOpenByDefault === true, '显存与卸载默认展开', f.memOpenByDefault);
  is(f.memOpenAfterCollapse === false, '点标题可折叠', f.memOpenAfterCollapse);
  is(f.memOpenAfterExpand === true, '可再次展开', f.memOpenAfterExpand);
  is(f.summaryStillVisible === true, '折叠后标题仍可见（点得到）', f.summaryStillVisible);
  is(f.bodyHasInputs === 5, '显存与卸载里应有 GPU 层数/切分/mmproj/KV/加载方式 五个控件', f.bodyHasInputs);
  // 摘要现在会带上「GPU 层数 + 切分 + mmproj + KV + 加载方式」全貌，
  // 不再只有 mmproj 和加载方式两项。
  is(/mmproj 留 CPU/.test(f.memValueText) && /mlock/.test(f.memValueText),
    '收起摘要应显示当前值', f.memValueText);
  is(f.ctxValueText === '90K', '上下文摘要是 90K', f.ctxValueText);
  // 模板 / 高级拆成了两个子菜单：jinja 归模板，shift/fa 归高级
  is(/jinja/.test(f.tplValueText), '模板摘要显示 jinja 已开', f.tplValueText);
  is(/shift/.test(f.advValueText) && /fa/.test(f.advValueText),
    '高级摘要显示 shift / fa 已开', f.advValueText);

  is(a.restoreLeftOfSave === true, '恢复默认在保存左边', a.restoreLeftOfSave);
  is(a.saveStickyToBottom === true, '保存按钮钉在内容区底部', a.saveStickyToBottom);
  is(Math.abs(a.saveRightGap - a.barRightGap) <= 2,
    '底部按钮与操作条右边距应一致（都贴内容区右边）',
    { save: a.saveRightGap, bar: a.barRightGap });
  is(a.statusLeftOfButtons === true, '状态提示在按钮左侧', a.statusLeftOfButtons);

  is(t.beforeJinja === true, '默认命令含 --jinja', t.beforeJinja);
  is(t.afterJinja === false, '关掉 jinja 后命令里应没有 --jinja', t.afterJinja);
  is(t.unknownCombo === false, '命令预览不该出现"未知组合"', t.unknownCombo);
  is(/无 jinja/.test(t.tplSummaryAfterJinja), '摘要应同步标注无 jinja', t.tplSummaryAfterJinja);
  is(t.afterMlock === false, '切 mmap 后命令里应没有 --load-mode mlock', t.afterMlock);
  is(t.afterMmap === true, '切 mmap 后命令里应有 --load-mode mmap', t.afterMmap);
  is(/mmap/.test(t.memSummary), '显存摘要应同步显示 mmap', t.memSummary);

  // 启动命令可自行修改 —— 用户的核心诉求
  const e = result.edit || {};
  is(e.isTextarea === true, '命令框应是真的可输入 textarea', e.isTextarea);
  is(e.readOnlyBefore === false, '命令框默认可编辑（不是只读展示）', e.readOnlyBefore);
  is(e.customFlagBefore === false, '没改过时不该标成「已自定义」', e.customFlagBefore);
  is(e.customFlagWhileTyping === true, '一开始输入就出现「已自定义」标记', e.customFlagWhileTyping);
  is(e.boxStyledCustom === true, '自定义状态有视觉区分', e.boxStyledCustom);
  is(e.optionsLocked === true, '自定义后选项区变暗（提示改选项不再影响命令）', e.optionsLocked);
  is(e.warnShown === true, '自定义后提示哪些项仍由管理器接管', e.warnShown);
  is(e.keptAfterBlur === true, '手改的参数失焦后仍在（没被选项覆盖掉）', e.keptAfterBlur);
  is(e.keptThreads === true, '手加的 --threads 8 被保留', e.keptThreads);
  is(e.customFlagAfterBlur === true, '改过后仍是自定义状态', e.customFlagAfterBlur);
  is(e.stillHasModelPath === true, '模型文件仍由管理器接管（命令里有 .gguf）', e.stillHasModelPath);
  is(e.stillHasPort === true, '端口仍由管理器接管（命令里有 --port）', e.stillHasPort);
  is(e.regenDroppedCustom === true, '「重新生成」丢弃手改内容', e.regenDroppedCustom);
  is(e.customFlagAfterRegen === false, '「重新生成」后回到非自定义状态', e.customFlagAfterRegen);
  is(e.backToBase === true, '「重新生成」后命令与基准完全一致', e.backToBase);

  // KVMem 卡片：启动命令下方 + 底部居中项目地址
  const k = result.kvmem || {};
  is(k.exists === true, 'KVMem 卡片存在于参数页', k.exists);
  is(k.hasToggle === true, 'KVMem 卡片里是复选框开关', k.hasToggle);
  is(k.belowCmd === true, 'KVMem 卡片位于启动命令模块下方', k.belowCmd);
  is(k.linkHref === 'https://github.com/kvmem/kvmem-llama.cpp',
    '卡片底部是 kvmem-llama.cpp 的项目地址', k.linkHref);
  is(k.linkCentered === true, '项目地址链接居中', k.linkCentered);
  is(k.linkFontSize > 0 && k.linkFontSize <= 12,
    '项目地址是小字（实测 ' + k.linkFontSize + 'px）', k.linkFontSize);
  is(k.linkAtBottom === true, '项目地址在卡片底部', k.linkAtBottom);

  // 状态总览：环形进度 + 模型/引擎合并卡
  const s = result.status || {};
  is(s.ringIsSvg === true, '显存是 SVG 圆环而非条形进度条', s.ringIsSvg);
  is(s.ringStroke >= 6, '圆环有可见的描边宽度（实测 ' + s.ringStroke + '）', s.ringStroke);
  is(/[0-9]/.test(s.ringDash || ''), '圆环用 dasharray 画弧', s.ringDash);
  is(s.ringOffset !== 'x' && s.ringOffset !== '', '圆环弧长已按占用率计算', s.ringOffset);
  is(s.pctText !== '' && s.pctText !== '—', '圆环中心显示占用百分比（' + s.pctText + '）', s.pctText);
  is(s.oldBars === 0, '旧的条形进度条已彻底移除', s.oldBars);
  is(s.enginePill === 'llama.cpp', '模型名前显示引擎标签（' + s.enginePill + '）', s.enginePill);
  is(s.enginePillHidden === false, '有模型在跑时引擎标签可见', s.enginePillHidden);
  is(s.modelName !== '' && s.modelName !== '—', '当前模型名仍显示（' + s.modelName + '）', s.modelName);
  is(s.oldEngineCard === false, '独立的「推理引擎」卡已合并掉', s.oldEngineCard);

  // 第三页：日志
  const g = result.logPage || {};
  is(g.visible === true, '第三页日志页可打开', g.visible);
  is(g.logInsidePane === true, '日志模块已搬到日志页', g.logInsidePane);
  is(g.logWrapInsidePane === true, '日志滚动容器也在日志页里', g.logWrapInsidePane);
  is(g.logOnParams === false, '第二页不再有日志模块', g.logOnParams);
  is(g.leftPaneHidden === true, '日志页整页展示（左栏收起）', g.leftPaneHidden);
  is(g.statusHidden === true, '日志页隐藏状态总览', g.statusHidden);
  is(g.logWrapHeight > 260, '日志页是整页高，不再是 260px 小框（实测 '
    + Math.round(g.logWrapHeight) + 'px）', g.logWrapHeight);
  is(g.hasAutoscroll === true, '自动滚动按钮跟着搬过来', g.hasAutoscroll);
  is(g.hasClear === true, '清空按钮跟着搬过来', g.hasClear);

  if (fails.length) {
    console.error('\n真实渲染检查失败 ' + fails.length + ' 项：');
    for (const m of fails) console.error('  ❌ ' + m);
    app.exit(1);
    return;
  }
  console.error('真实渲染检查全部通过');
  app.exit(0);
}
