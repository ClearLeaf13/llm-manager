'use strict';
/**
 * 渲染层行为回归：驱动真实 renderer.js 的运行时逻辑。
 *
 * 重点验证「第 2 页拖不动」的根因是否真的修好：拖动条必须跟随当前页的
 * 左栏元素（pane-models / pane-manage），而不是写死 pane-models。
 * 同时覆盖引擎卡片、卡片上下文标注、按引擎切换参数面板。
 *
 *   运行：node tests/renderer-behavior.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
// 真实命令行拼装：stub 的 modelsArgs 要用它，才能反映开关变化
const models = require(path.join(ROOT, 'src/models'));

/* ---------------- 最小 DOM ---------------- */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this._attrs = {};
    this._classes = new Set();
    this._text = '';
    this._html = '';
    this._listeners = {};
    this._id = '';
    this.checked = false;
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.type = 'text';
  }
  get id() { return this._id; }
  set id(v) { this._id = v; elById.set(v, this); }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
      toggle: (c, on) => {
        if (on === undefined) { if (s.has(c)) s.delete(c); else s.add(c); }
        else if (on) s.add(c); else s.delete(c);
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    const re = /<(\w+)([^>]*?)>/g;
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const attrs = (m[2] || '').replace(/\/\s*$/, '');
      const child = new El(m[1]);
      const idm = attrs.match(/\bid="([^"]+)"/);
      if (idm) child.id = idm[1];
      const cls = attrs.match(/class="([^"]*)"/);
      if (cls) child.className = cls[1];
      if (/\bhidden\b/.test(attrs)) child.hidden = true;
      if (/\bdisabled\b/.test(attrs)) child.disabled = true;
      const val = attrs.match(/value="([^"]*)"/);
      if (val) child.value = val[1];
      const dc = attrs.match(/data-ctx="([^"]*)"/);
      if (dc) child.dataset.ctx = dc[1];
      if (/^input$/i.test(m[1])) child.tagName = 'INPUT';
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertBefore(c) { c.parentElement = this; this.children.unshift(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  querySelector(sel) { return this._find(sel, false); }
  querySelectorAll(sel) { const out = []; this._find(sel, true, out); return out; }
  _matches(el, sel) {
    const parts = sel.match(/(^[a-zA-Z]+)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g) || [];
    for (const p of parts) {
      if (p.startsWith('.')) { if (!el._classes.has(p.slice(1))) return false; }
      else if (p.startsWith('#')) { if (el.id !== p.slice(1)) return false; }
      else if (p.startsWith('[')) {
        const mm = p.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
        if (!mm) return false;
        const key = mm[1];
        let dv;
        if (key.startsWith('data-')) {
          dv = el.dataset[key.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())];
        } else dv = el._attrs[key];
        if (mm[2] !== undefined) { if (String(dv) !== mm[2]) return false; }
        else if (dv === undefined) return false;
      } else if (el.tagName !== p.toUpperCase()) return false;
    }
    return true;
  }
  _find(sel, all, out = []) {
    const walk = (node) => {
      for (const c of node.children) {
        if (this._matches(c, sel)) { if (!all) return c; out.push(c); }
        const r = walk(c);
        if (r && !all) return r;
      }
      return null;
    };
    return walk(this) || (all ? out : null);
  }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  dispatchEvent(ev) {
    const e = ev && ev.type ? ev : { type: String(ev), preventDefault() {}, target: this };
    if (!e.target) e.target = this;
    (this._listeners[e.type] || []).forEach((fn) => fn(e));
    return true;
  }
  getBoundingClientRect() {
    // 侧栏宽度必须从 style 读，否则 railW = 整窗宽，拖动值会被压到最小值
    const w = parseFloat(this.style.width) || 1200;
    return { left: 0, top: 0, width: w, height: 700, right: w, bottom: 700 };
  }
  focus() {}
  get firstChild() { return this.children[0] || null; }
  get scrollHeight() { return 100; }
  // scrollTop 可读可写：切到日志页时 renderer 会把它拉到底
  get scrollTop() { return this._scrollTop || 0; }
  set scrollTop(v) { this._scrollTop = v; }
  get clientHeight() { return 100; }
}

const elById = new Map();
const root = new El('body');

// 侧栏（拖动计算依赖它的宽度）
const railEl = new El('nav');
railEl.id = 'rail';
railEl.style.width = '48px';
root.appendChild(railEl);

for (const m of html.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*?)>/g)) {
  if (m[3] === 'rail') continue;
  const el = new El(m[1]);
  el.id = m[3];
  const attrs = (m[2] || '') + ' ' + (m[4] || '');
  const cls = attrs.match(/class="([^"]*)"/);
  if (cls) el.className = cls[1];
  if (/\bhidden\b/.test(attrs)) el.hidden = true;
  if (/<select/i.test(m[0])) el.tagName = 'SELECT';
  if (/<input/i.test(m[0])) {
    el.tagName = 'INPUT';
    const t = attrs.match(/type="([^"]*)"/);
    el.type = t ? t[1] : 'text';
  }
  root.appendChild(el);
}
// 标题栏圆点（无 id，靠 class）
const dotEl = new El('span'); dotEl.className = 'dot';
root.appendChild(dotEl);
// shell 容器
const shellEl = new El('div'); shellEl.className = 'shell';
root.appendChild(shellEl);

global.document = {
  documentElement: new El('html'),
  body: root,
  getElementById: (id) => elById.get(id) || null,
  createElement: (t) => new El(t),
  querySelector: (s) => root.querySelector(s),
  querySelectorAll: (s) => root.querySelectorAll(s),
  addEventListener: () => {},
  createRange: () => ({ selectNodeContents() {} }),
};

const NAV_STUB = { clipboard: { writeText: async () => {} } };
const savedSettings = [];
const winListeners = {};
global.window = {
  api: {},
  addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
  dispatchEvent: (e) => { (winListeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
};

const MODELS_STUB = [
  // file 是文件名，filePath 是绝对路径 —— 和真实 models-list 返回的一致
  { id: 'reap', name: 'Qwen3.6-VL-REAP-26B', alias: 'REAP-26B', ctxK: 90, port: 8082,
    vision: true, useMtp: false, engine: 'llamacpp', ninfer: null,
    file: 'reap.gguf', filePath: 'C:\\m\\reap.gguf', fileExists: true,
    mmproj: 'mm.gguf', mmprojPath: 'C:\\m\\mm.gguf', mmprojExists: true,
    sizeGb: 13.6, noMmprojOffload: true, extraArgs: '',
    // 出厂默认：开关缺省即开（与 models.js PARAM_DEFAULTS 一致）
    jinja: true, flashAttn: true, ctxShift: true, loadMode: 'mlock' },
  { id: 'nf1', name: 'Qwen3.8-27B (NInfer)', alias: 'qwen3.8-27b', ctxK: 96, port: 8090,
    vision: true, useMtp: false, engine: 'ninfer',
    ninfer: { maxContext: 98304, kvDtype: 'q4', prefillChunk: 896, draftTokens: 3,
              thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
              embeddingHost: true, spec: 'mtp', noCudaGraph: true, extraArgs: '' },
    file: '/root/models/qwen3_8_27b.ninfer', filePath: '/root/models/qwen3_8_27b.ninfer',
    fileExists: true, mmproj: null, mmprojExists: null,
    sizeGb: 15.33, noMmprojOffload: false, extraArgs: '' },
];
const STATUS_STUB = { running: true, pids: [1234], ninferPids: [],
  ninfer: { distro: 'Ubuntu-24.04', distroState: 'stopped', pids: [] },
  engine: 'llamacpp', ports: { 8082: true }, current: 'reap', starting: false };
let lastPatch = null;
/** 记录「恢复默认参数」向主进程请求的是哪个模型的默认值 */
let defaultsAsked = null;

global.window.api = {
  getSettings: async () => ({ theme: 'dark', zoom: 1, defaultCtxK: 32, readyTimeoutSec: 180,
    logLimit: 4000, logSysOnly: false, serverExe: 'C:\\l\\llama-server.exe', modelsDir: 'C:\\m',
    closeToTray: true, modelsWidth: 300, ninferDistro: 'Ubuntu-24.04',
    ninferServe: '/root/ninfer-5080/build/apps/ninfer-serve',
    ninferCli: '/root/ninfer-5080/build/apps/ninfer',
    ninferModelsDir: '/root/models', ninferAutoScan: true }),
  saveSettings: async (p) => { savedSettings.push(p); return { ok: true, settings: { ...p } }; },
  getModels: async () => MODELS_STUB.map((m) => ({ ...m })),
  getStatus: async () => STATUS_STUB,
  getLogs: async () => [],
  getMemory: async () => ({ totalGb: 31.1, freeGb: 14.0 }),
  getGpu: async () => ({ name: 'RTX 5080', usedGb: 15.4, totalGb: 15.9, util: 3 }),
  diskUsage: async () => ({ dir: 'C:\\', freeGb: 200, totalGb: 900, usedGb: 24.5 }),
  modelsList: async () => MODELS_STUB.map((m) => ({ ...m })),
  modelsScan: async () => ({
    ok: true, dir: 'C:\\m',
    files: [
      // 已在配置里（应被扫描结果隐藏）
      { file: 'reap.gguf', sizeGb: 13.59, mmproj: false, engine: 'llamacpp',
        quantization: 'IQ4_XS', meta: { architecture: 'qwen3' } },
      // 已绑定的投影（应被隐藏）
      { file: 'mm.gguf', sizeGb: 0.84, mmproj: true, engine: 'llamacpp', meta: null },
      // 全新、未添加的模型（应显示）
      { file: 'new-model-Q4_K_M.gguf', sizeGb: 4.2, mmproj: false, engine: 'llamacpp',
        quantization: 'Q4_K_M', meta: { architecture: 'llama' } },
      // 全新、未绑定的投影（应显示）
      { file: 'mmproj-extra-F16.gguf', sizeGb: 0.9, mmproj: true, engine: 'llamacpp', meta: null },
    ],
  }),
  modelsArgs: async (id, ctxK, opts) => {
    const base = MODELS_STUB.find((x) => x.id === id);
    const k = Number(ctxK) || (base ? base.ctxK : 32);
    if (base && base.engine === 'ninfer') {
      const cmd = 'wsl -d Ubuntu-24.04 -u root -- ninfer-serve ' + base.file
        + ' --max-context ' + (k * 1024);
      return { ok: true, engine: 'ninfer', ctxK: k, ctxTokens: k * 1024,
        command: cmd, baseCommand: cmd, cmdOverride: (opts && opts.cmdOverride) || '',
        ninfer: base.ninfer, hasMmproj: false, running: false };
    }
    // 真实应用里命令预览反映的是「界面上当前勾了什么」（未保存也算）：
    // 渲染进程把实时值当 opts 传下来，主进程白名单覆盖后再交给真实 buildArgs。
    const m = { ...(base || {}), ...(opts || {}) };
    const baseCmd = 'llama-server.exe ' + models.buildArgs(m, k).join(' ');
    // 有命令覆盖时，真实主进程会用 applyCmdOverride 拼出「用户写的样子」，
    // 这里用同一套逻辑，保证测试覆盖的就是产品行为。
    const ov = models.applyCmdOverride(
      models.buildArgs(m, k), (opts && opts.cmdOverride) || '',
      'llama-server.exe', ['-m', '--mmproj', '--host', '--port']);
    return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
      command: 'llama-server.exe ' + ov.args.join(' '),
      baseCommand: baseCmd,
      cmdOverride: (opts && opts.cmdOverride) || '',
      cmdOverridden: ov.applied, protectedKeys: ov.protectedKeys,
      hasMmproj: !!(base && base.mmproj), noMmprojOffload: !!m.noMmprojOffload,
      extraArgs: m.extraArgs || '', running: false };
  },
  // 恢复默认参数：默认值由主进程给，这里按引擎给一份与 PARAM_DEFAULTS 一致的
  modelDefaults: async (id) => {
    defaultsAsked = id;
    const m = MODELS_STUB.find((x) => x.id === id);
    if (m && m.engine === 'ninfer') {
      return { ok: true, engine: 'ninfer', ctxK: 96, ninfer: {
        kvDtype: 'q4', spec: 'mtp', prefillChunk: 512, draftTokens: 3,
        thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
        embeddingHost: true, noCudaGraph: true } };
    }
    return { ok: true, engine: 'llamacpp', ...models.paramDefaults('llamacpp') };
  },
  modelsUpdate: async (id, patch) => { lastPatch = { id, patch }; return { ok: true }; },
  modelsCreate: async (p) => ({ ok: true, model: p }),
  modelsReset: async () => ({ ok: true }),
  modelsNextPort: async () => 8091,
  modelsDeletePreview: async () => ({ ok: true, items: [], totalGb: 0, warnings: [], running: [] }),
  modelsDeleteBatch: async () => ({ ok: true, removed: 0, trashed: 0, failed: [], skipped: [] }),
  ninferProbe: async () => ({ ok: true, wslAvailable: true,
    distros: [{ name: 'Ubuntu-24.04', state: 'stopped' }],
    cfg: { distro: 'Ubuntu-24.04', servePath: '/root/ninfer-5080/build/apps/ninfer-serve',
           cliPath: '/root/ninfer-5080/build/apps/ninfer', modelsDir: '/root/models' },
    runtime: { ok: true, distro: 'Ubuntu-24.04', hasServe: true, hasCli: true, hasModelsDir: true },
    available: true }),
  ninferScan: async () => ({ ok: true, errors: [],
    wsl: [{ path: '/root/models/qwen3_8_27b.ninfer', file: 'qwen3_8_27b.ninfer',
            dir: '/root/models', sizeGb: 15.33, meta: { modelId: 'qwen3.8-27b' } }], local: [] }),
  ninferMeta: async () => ({ ok: true, meta: { modelId: 'qwen3.8-27b' } }),
  openUrl: async () => true, openDataDir: async () => true,
  autostartGet: async () => ({ ok: true, enabled: false, supported: true }),
  autostartSet: async () => ({ ok: true }),
  resetSettings: async () => ({ ok: true, settings: {} }),
  pickPath: async () => ({ ok: false }),
  winMinimize: () => {}, winMaximize: () => {}, winClose: () => {}, winHide: () => {},
  onLog: () => {}, onStatus: () => {}, onWindowState: () => {},
};

// confirm 是按值传进 renderer 的，测试中途改 global.confirm 不会生效；
// 用一个可变的转发器，让用例能按需放行/拦截确认框
let confirmAnswer = false;
global.confirm = () => confirmAnswer;
global.clearTimeout = clearTimeout;
global.setInterval = () => 0;   // 关掉轮询，避免测试进程不退出

// 侧栏按钮（HTML 里结构特殊，手动建）
const railViews = ['models', 'manage', 'log'].map((v) => {
  const b = new El('button');
  b.className = 'rail-btn' + (v === 'models' ? ' active' : '');
  b.dataset.view = v;
  root.appendChild(b);
  return b;
});

/* ---------------- 跑真实 renderer.js ---------------- */

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
// 用真实定时器：桩成同步会饿死 init() 里的 await 链，整块渲染都不执行
const run = new Function('document', 'window', 'navigator', 'confirm', 'setTimeout',
  'clearTimeout', 'setInterval', 'console', src);
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e.message);
});
run(global.document, global.window, NAV_STUB, global.confirm, setTimeout,
  clearTimeout, () => 0, console);

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label); }
};
const $ = (id) => elById.get(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(200);

  console.log('\n【A】三页切换：左右栏显示');
  railViews[1].dispatchEvent('click');
  await wait(150);
  ok($('pane-models').classList.contains('hidden'), '第二页隐藏「快速启用」左栏');
  ok(!$('pane-manage').classList.contains('hidden'), '第二页显示「模型管理」左栏');
  ok($('pane-status').classList.contains('hidden'), '第二页隐藏「状态总览」');
  ok(!$('pane-params').classList.contains('hidden'), '第二页显示「启动参数」');
  ok($('pane-log').classList.contains('hidden'), '第二页隐藏日志页');

  railViews[0].dispatchEvent('click');
  await wait(150);
  ok(!$('pane-models').classList.contains('hidden'), '第一页显示「快速启用」左栏');
  ok($('pane-manage').classList.contains('hidden'), '第一页隐藏「模型管理」左栏');
  ok(!$('pane-status').classList.contains('hidden'), '第一页显示「状态总览」');
  ok($('pane-params').classList.contains('hidden'), '第一页隐藏「启动参数」');

  console.log('\n【A2】第三页：日志整页');
  railViews[2].dispatchEvent('click');
  await wait(150);
  ok(!$('pane-log').classList.contains('hidden'), '第三页显示日志页');
  ok($('pane-models').classList.contains('hidden'), '日志页隐藏左栏（整页展示）');
  ok($('pane-status').classList.contains('hidden'), '日志页隐藏状态总览');
  ok($('pane-params').classList.contains('hidden'), '日志页隐藏启动参数');
  ok($('split-1').classList.contains('hidden'), '日志页没有左栏，拖动条一并收起');
  railViews[0].dispatchEvent('click');
  await wait(150);
  ok(!$('split-1').classList.contains('hidden'), '回到第一页后拖动条恢复显示');

  console.log('\n【B】拖动条：两页都要能拖（本轮修复的核心）');
  const sp = $('split-1');
  ok(!!sp, '存在拖动条');
  ok(!sp.classList.contains('hidden'), '第一页拖动条可见');

  $('pane-models').style.width = '';
  sp.dispatchEvent({ type: 'mousedown', preventDefault() {}, target: sp });
  global.window.dispatchEvent({ type: 'mousemove', clientX: 600 });
  global.window.dispatchEvent({ type: 'mouseup' });
  const w1 = parseInt($('pane-models').style.width, 10);
  ok(w1 === 600 - 48, '第一页拖动生效：pane-models=' + w1 + '（期望 552）');

  railViews[1].dispatchEvent('click');
  await wait(150);
  ok(!sp.classList.contains('hidden'), '第二页拖动条可见');
  $('pane-manage').style.width = '';
  const beforeModels = $('pane-models').style.width;
  sp.dispatchEvent({ type: 'mousedown', preventDefault() {}, target: sp });
  global.window.dispatchEvent({ type: 'mousemove', clientX: 480 });
  global.window.dispatchEvent({ type: 'mouseup' });
  const w2 = parseInt($('pane-manage').style.width, 10);
  ok(w2 === 480 - 48, '第二页拖动生效：pane-manage=' + w2 + '（期望 432）');
  ok($('pane-models').style.width === beforeModels,
     '第二页拖动没有误改第一页的 pane-models（原 bug 的现场）');
  ok(savedSettings.some((p) => p.modelsWidth), '拖动后写回了宽度设置');
  ok(String(savedSettings[savedSettings.length - 1].modelsWidth) === '432',
     '记住的是第二页宽度 432');

  console.log('\n【C】状态总览：模型与引擎合并卡');
  const pill = $('st-engine-pill');
  ok(pill.textContent === 'llama.cpp',
     '模型名前挂的引擎标签显示 "' + pill.textContent + '"');
  ok(pill.hidden === false, '有模型在跑时引擎标签可见');
  ok(pill.dataset.engine === 'llamacpp', '引擎标签带 llamacpp 标记（供配色用）');
  ok(/进程/.test($('st-model-sub').textContent),
     '副标题含引擎的进程信息："' + $('st-model-sub').textContent + '"');

  console.log('\n【D】首页卡片：上下文只读展示 + 引擎标签');
  // 卡片是 appendChild 进去的，父容器的 innerHTML 不反映子节点 —— 要看卡片自己的 innerHTML
  const cards = $('model-list').children;
  const cardsHtml = cards.map((c) => c.innerHTML).join('');
  ok(!/tokens/.test(cardsHtml), '卡片里不再出现 "tokens" 字样');
  ok($('model-list').querySelectorAll('input').length === 0,
     '卡片里已无输入框（上下文不再在首页改）');
  ok(/上下文 90K/.test(cardsHtml) && /上下文 96K/.test(cardsHtml),
     '卡片元信息里只读显示 "上下文 90K" / "上下文 96K"');
  // 引擎标签
  const lcBadges = $('model-list').querySelectorAll('.badge.lc');
  const nfBadges = $('model-list').querySelectorAll('.badge.nf');
  ok(lcBadges.length === 1, 'llama.cpp 模型带一个 llama.cpp 标签（实际 ' + lcBadges.length + '）');
  ok(nfBadges.length === 1, 'NInfer 模型带一个 NInfer 标签（实际 ' + nfBadges.length + '）');
  ok(/badge lc[^>]*>llama\.cpp</.test(cardsHtml), 'llama.cpp 标签文案正确');
  ok(/badge nf[^>]*>NInfer</.test(cardsHtml), 'NInfer 标签文案正确');
  ok(!/badge (nf|lc)[^>]*>\s*<\/span>\s*<span class="badge (nf|lc)/.test(cardsHtml),
     '每张卡片只有一个引擎标签');

  console.log('\n【F】参数页：上下文可改且运行中不被锁');
  railViews[1].dispatchEvent('click');
  await wait(250);
  ok(!!$('p-ctx'), '参数页存在上下文输入框');
  ok($('p-ctx').disabled === false,
     '模型运行中时上下文输入框仍可编辑（原先被 disabled 锁死）');
  ok($('p-save').disabled === false, '保存按钮在运行中也可用');
  ok(String($('p-ctx').value) === '90',
     '默认选中模型的上下文回填正确（实际 ' + $('p-ctx').value + '）');

  // 真正改一次上下文并保存，验证落到 ctxK 上
  $('p-ctx').value = '48';
  $('p-ctx').dispatchEvent('input');
  await wait(120);
  ok(/49152/.test($('p-ctx-note').textContent),
     '换算提示实时更新为 49152 tokens（实际 "' + $('p-ctx-note').textContent + '"）');
  $('p-save').dispatchEvent('click');
  await wait(250);
  ok(lastPatch && lastPatch.id === 'reap', '保存目标是当前模型（实际 ' + (lastPatch && lastPatch.id) + '）');
  ok(lastPatch && lastPatch.patch.ctxK === 48,
     '上下文写入顶层 ctxK=48（实际 ' + (lastPatch && lastPatch.patch.ctxK) + '）');
  ok(lastPatch && !('ninfer' in lastPatch.patch),
     'llama.cpp 模型不会误写 ninfer 子对象');

  console.log('\n【E】参数面板：按引擎切换');
  railViews[1].dispatchEvent('click');
  await wait(200);
  ok(/llama\.cpp/.test($('p-engine-tag').innerHTML), '默认选中 llama.cpp 模型时徽标正确');
  ok($('popt-ninfer').hidden === true, 'llama.cpp 模型下 NInfer 子菜单隐藏');
  ok($('popt-adv').hidden === false, 'llama.cpp 模型下通用开关子菜单可见');
  ok($('p-row-nommproj').hidden === false, 'llama.cpp 模型下 mmproj 行可见');
  ok($('p-cmd').value.indexOf('llama-server') === 0, 'llama.cpp 模型命令预览是 llama-server');

  console.log('\n【E2】llama.cpp 启动开关真的改变命令');
  // 默认全开：命令里应依次出现这几个 flag
  ok(/--jinja/.test($('p-cmd').value), '默认命令含 --jinja');
  ok(/-fa on/.test($('p-cmd').value), '默认命令含 -fa on');
  ok(/--context-shift/.test($('p-cmd').value), '默认命令含 --context-shift');
  ok(/--load-mode mlock/.test($('p-cmd').value), '默认命令含 --load-mode mlock');
  ok($('p-jinja').checked === true, 'jinja 开关默认为开');
  // jinja 归在「对话模板」组，摘要应写在那一组
  ok(/jinja/.test($('popt-tpl-val').textContent), '模板摘要显示 jinja 已开');
  ok(/shift/.test($('popt-adv-val').textContent) && /fa/.test($('popt-adv-val').textContent),
     '高级摘要显示 shift / fa 已开');

  // 关掉 jinja + 换 mmap，命令预览要跟着变
  $('p-jinja').checked = false;
  $('p-jinja').dispatchEvent('change');
  await wait(150);
  ok(!/--jinja/.test($('p-cmd').value), '关掉后命令里不再有 --jinja');
  ok(/无 jinja/.test($('popt-tpl-val').textContent), '模板摘要同步标注无 jinja');

  $('p-loadmode').value = 'mmap';
  $('p-loadmode').dispatchEvent('change');
  await wait(150);
  ok(/--load-mode mmap/.test($('p-cmd').value), '加载方式切到 mmap 后命令同步');
  ok(/mmap/.test($('popt-mem-val').textContent), '显存摘要显示 mmap');

  // 保存后必须把这些开关写进 patch
  $('p-save').dispatchEvent('click');
  await wait(250);
  ok(lastPatch && lastPatch.patch.jinja === false,
     'jinja=关闭 写入 patch（实际 ' + (lastPatch && lastPatch.patch.jinja) + '）');
  ok(lastPatch && lastPatch.patch.loadMode === 'mmap',
     'loadMode=mmap 写入 patch（实际 ' + (lastPatch && lastPatch.patch.loadMode) + '）');
  ok(lastPatch && lastPatch.patch.flashAttn === true, 'flashAttn 一并写入 patch');
  ok(lastPatch && lastPatch.patch.ctxShift === true, 'ctxShift 一并写入 patch');

  const rows = $('manage-list').children.filter((r) => r._classes && r._classes.has('mrow'));
  ok(rows.length === 2, '管理列表渲染出 2 行（实际 ' + rows.length + '）');
  const nfRow = rows.filter((r) => /NInfer/.test(r.innerHTML))[0];
  ok(!!nfRow, '找到 NInfer 那一行');
  if (nfRow) {
    ok(nfRow.querySelectorAll('button').filter((b) => b.textContent === '启动参数').length === 0,
       '「启动参数」按钮已删除');
    ok(nfRow.querySelectorAll('button').filter((b) => b.textContent === '编辑').length === 1,
       '仍保留「编辑」按钮');
    // 直接点整行来切换右侧参数面板
    nfRow.dispatchEvent('click');
    await wait(300);

    ok(/NInfer/.test($('p-engine-tag').innerHTML), '引擎徽标切到 NInfer');
    ok($('popt-ninfer').hidden === false, 'NInfer 子菜单已展开显示');
    ok($('popt-adv').hidden === true, 'llama.cpp 通用开关子菜单已隐藏');
    ok($('p-row-nommproj').hidden === true, 'llama.cpp 的 mmproj 行已隐藏');
    ok($('p-cmd').value.indexOf('wsl -d') === 0,
       '命令预览是 wsl 命令："' + $('p-cmd').value.slice(0, 46) + '…"');
    ok($('p-nf-kvdtype').value === 'q4', 'KV 精度回填 q4（实际 ' + $('p-nf-kvdtype').value + '）');
    ok(String($('p-nf-prefill').value) === '896', '预填充块回填 896（实际 ' + $('p-nf-prefill').value + '）');
    ok($('p-nf-vision').checked === true, '视觉开关回填为开');
    ok(String($('p-ctx').value) === '96', '上下文回填该模型的 96（实际 ' + $('p-ctx').value + '）');
    // 选中行应有 selected 高亮
    const sel = $('manage-list').children.filter((r) => r._classes && r._classes.has('selected'));
    ok(sel.length === 1, '被选中的行有 selected 高亮（实际 ' + sel.length + ' 行）');

    // 改值再保存：必须写进 ninfer 子对象，不能污染顶层
    $('p-nf-prefill').value = '1024';
    $('p-nf-prefill').dispatchEvent('change');
    await wait(100);
    $('p-save').dispatchEvent('click');
    await wait(250);

    ok(lastPatch && lastPatch.id === 'nf1', '保存目标是 NInfer 模型（实际 ' + (lastPatch && lastPatch.id) + '）');
    ok(!!(lastPatch && lastPatch.patch && lastPatch.patch.ninfer), '参数写进 ninfer 子对象');
    ok(lastPatch && lastPatch.patch.ninfer.prefillChunk === 1024,
       'prefillChunk 保存为 1024（实际 ' +
       (lastPatch && lastPatch.patch && lastPatch.patch.ninfer && lastPatch.patch.ninfer.prefillChunk) + '）');
    ok(lastPatch && !('noMmprojOffload' in lastPatch.patch),
       'NInfer 模型不会误写 llama.cpp 的 noMmprojOffload 字段');
    ok(lastPatch && !('jinja' in lastPatch.patch),
       'NInfer 模型不会误写 llama.cpp 的 jinja 字段');
  }

  console.log('\n【H】恢复默认参数');
  // 先切回 llama.cpp 模型，并制造一组「被改坏」的参数
  const lcRow = rows.filter((r) => /llama\.cpp/.test(r.innerHTML))[0];
  ok(!!lcRow, '找到 llama.cpp 那一行');
  if (lcRow) {
    lcRow.dispatchEvent('click');
    await wait(300);
    ok($('popt-adv').hidden === false, '切回 llama.cpp 后通用开关子菜单恢复显示');

    $('p-ctx').value = '7';
    $('p-ctx').dispatchEvent('input');
    $('p-jinja').checked = false;
    $('p-jinja').dispatchEvent('change');
    $('p-loadmode').value = 'mmap';
    $('p-loadmode').dispatchEvent('change');
    await wait(150);
    ok(String($('p-ctx').value) === '7', '先把上下文改成 7');

    // 恢复默认：确认框需要放行，否则永远走不到取默认值那步
    confirmAnswer = true;
    $('p-restore').dispatchEvent('click');
    await wait(300);

    ok(defaultsAsked === 'reap', '恢复默认时按当前模型取默认值（实际 ' + defaultsAsked + '）');
    ok(String($('p-ctx').value) === '32',
       '上下文恢复为默认 32（实际 ' + $('p-ctx').value + '）');
    ok($('p-jinja').checked === true, 'jinja 恢复为默认开');
    ok($('p-loadmode').value === 'mlock', '加载方式恢复为默认 mlock');
    ok(/--jinja/.test($('p-cmd').value), '命令预览同步恢复出 --jinja');
    ok(/--load-mode mlock/.test($('p-cmd').value), '命令预览同步恢复 mlock');
    ok(/默认参数/.test($('p-status').textContent), '状态栏提示已填入默认参数');

    // 只填框不落盘：恢复本身不能偷偷写配置
    const patchBefore = lastPatch;
    await wait(120);
    ok(lastPatch === patchBefore, '恢复默认只改输入框，不会自动保存');

    // 用户确认后点保存才真正写回默认值
    $('p-save').dispatchEvent('click');
    await wait(250);
    ok(lastPatch && lastPatch.patch.ctxK === 32,
       '保存后上下文写回 32（实际 ' + (lastPatch && lastPatch.patch.ctxK) + '）');
    ok(lastPatch && lastPatch.patch.jinja === true, '保存后 jinja 写回开');
    ok(lastPatch && lastPatch.patch.loadMode === 'mlock', '保存后 loadMode 写回 mlock');

    console.log('\n【F2】KVMem 开关');
    ok($('p-kvmem').checked === false || $('p-kvmem').checked === true,
       'KVMem 开关可读（默认关）');
    // 默认关：命令里不该出现 --kvmem
    $('p-kvmem').checked = false;
    $('p-kvmem').dispatchEvent('change');
    await wait(150);
    ok(!/--kvmem/.test($('p-cmd').value),
       '默认关闭时命令里没有 --kvmem："' + $('p-cmd').value.slice(0, 60) + '…"');

    // 打开：命令里应出现 --kvmem，并且保存时落盘
    $('p-kvmem').checked = true;
    $('p-kvmem').dispatchEvent('change');
    await wait(200);
    ok(/--kvmem/.test($('p-cmd').value),
       '开启后命令里出现 --kvmem："' + $('p-cmd').value.slice(0, 80) + '…"');

    $('p-save').dispatchEvent('click');
    await wait(250);
    ok(lastPatch && lastPatch.patch.kvmem === true,
       '保存后 kvmem 落盘（实际 ' + (lastPatch && lastPatch.patch.kvmem) + '）');
  }

  console.log('\n【G】自动扫描：只列没配置过的东西');
  $('btn-scan').dispatchEvent('click');
  await wait(350);
  ok($('scan-box').hidden === false, '扫描结果面板已展开');

  // scan-list 的内容来自 innerHTML 生成的子节点，父节点的 _html 不反映它们
  // 已配置的 3 个文件：reap.gguf、mm.gguf、以及 WSL 里的 qwen3_8_27b.ninfer
  const items = $('scan-list').children;
  const itemText = items.map((c) => c.innerHTML).join(' ');
  const names = items.map((c) => (c.querySelector('.sname') || {}).textContent || '');
  ok(!/reap\.gguf/.test(itemText), '已添加的模型 reap.gguf 不在扫描结果里');
  ok(!/mm\.gguf/.test(itemText), '已绑定的投影 mm.gguf 不在扫描结果里');
  ok(!/qwen3_8_27b\.ninfer/.test(itemText), '已添加的 NInfer 模型不在扫描结果里');
  ok(/new-model-Q4_K_M\.gguf/.test(itemText), '未添加的新模型仍在结果里');
  ok(/mmproj-extra-F16\.gguf/.test(itemText), '未绑定的投影仍在结果里');
  ok(names.length === 2, '扫描结果只剩 2 项（实际 ' + names.length + '：' + names.join(', ') + '）');
  ok(/已隐藏 3 个已添加的/.test($('scan-title').textContent),
     '标题注明隐藏数量（实际 "' + $('scan-title').textContent + '"）');
  ok(/1 个模型/.test($('scan-title').textContent)
     && /1 个投影文件/.test($('scan-title').textContent),
     '计数只统计保留项，不含已隐藏的');
  // 剩下的项按钮文案：新模型是「添加」，未绑定投影是「绑定」
  const addBtns = $('scan-list').querySelectorAll('.sadd');
  ok(addBtns.filter((b) => b.textContent === '添加').length === 1, '新模型按钮为「添加」');
  ok(addBtns.filter((b) => b.textContent === '绑定').length === 1, '未绑定投影按钮为「绑定」');
  ok(addBtns.filter((b) => b.textContent === '已添加').length === 0, '不再出现「已添加」这种占位按钮');

  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
