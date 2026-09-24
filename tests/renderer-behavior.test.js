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
  get scrollTop() { return 0; }
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
  { id: 'reap', name: 'Qwen3.6-VL-REAP-26B', alias: 'REAP-26B', ctxK: 90, port: 8082,
    vision: true, useMtp: false, engine: 'llamacpp', ninfer: null,
    file: 'C:\\m\\reap.gguf', fileExists: true, mmproj: 'C:\\m\\mm.gguf', mmprojExists: true,
    sizeGb: 13.6, noMmprojOffload: true, extraArgs: '' },
  { id: 'nf1', name: 'Qwen3.8-27B (NInfer)', alias: 'qwen3.8-27b', ctxK: 96, port: 8090,
    vision: true, useMtp: false, engine: 'ninfer',
    ninfer: { maxContext: 98304, kvDtype: 'q4', prefillChunk: 896, draftTokens: 3,
              thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
              embeddingHost: true, spec: 'mtp', noCudaGraph: true, extraArgs: '' },
    file: '/root/models/qwen3_8_27b.ninfer', fileExists: true, mmproj: null, mmprojExists: null,
    sizeGb: 15.33, noMmprojOffload: false, extraArgs: '' },
];
const STATUS_STUB = { running: true, pids: [1234], ninferPids: [],
  ninfer: { distro: 'Ubuntu-24.04', distroState: 'stopped', pids: [] },
  engine: 'llamacpp', ports: { 8082: true }, current: 'reap', starting: false };
let lastPatch = null;

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
  modelsScan: async () => ({ ok: true, dir: 'C:\\m', files: [] }),
  modelsArgs: async (id, ctxK) => {
    const m = MODELS_STUB.find((x) => x.id === id);
    const k = Number(ctxK) || (m ? m.ctxK : 32);
    if (m && m.engine === 'ninfer') {
      return { ok: true, engine: 'ninfer', ctxK: k, ctxTokens: k * 1024,
        command: 'wsl -d Ubuntu-24.04 -u root -- ninfer-serve ' + m.file + ' --max-context ' + (k * 1024),
        ninfer: m.ninfer, hasMmproj: false, running: false };
    }
    return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
      command: 'llama-server.exe -m ' + (m ? m.file : '') + ' -c ' + (k * 1024),
      hasMmproj: !!(m && m.mmproj), noMmprojOffload: !!(m && m.noMmprojOffload),
      extraArgs: '', running: false };
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

global.confirm = () => false;
global.clearTimeout = clearTimeout;
global.setInterval = () => 0;   // 关掉轮询，避免测试进程不退出

// 侧栏按钮（HTML 里结构特殊，手动建）
const railViews = ['models', 'manage'].map((v) => {
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

  console.log('\n【A】两页切换：左右栏显示');
  railViews[1].dispatchEvent('click');
  await wait(150);
  ok($('pane-models').classList.contains('hidden'), '第二页隐藏「快速启用」左栏');
  ok(!$('pane-manage').classList.contains('hidden'), '第二页显示「模型管理」左栏');
  ok($('pane-status').classList.contains('hidden'), '第二页隐藏「状态总览」');
  ok(!$('pane-params').classList.contains('hidden'), '第二页显示「启动参数 + 日志」');

  railViews[0].dispatchEvent('click');
  await wait(150);
  ok(!$('pane-models').classList.contains('hidden'), '第一页显示「快速启用」左栏');
  ok($('pane-manage').classList.contains('hidden'), '第一页隐藏「模型管理」左栏');
  ok(!$('pane-status').classList.contains('hidden'), '第一页显示「状态总览」');
  ok($('pane-params').classList.contains('hidden'), '第一页隐藏「启动参数」');

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

  console.log('\n【C】状态总览：推理引擎卡');
  const eng = $('st-engine').textContent;
  ok(eng === 'llama.cpp', '当前 llama.cpp 模型 → 引擎显示 "' + eng + '"');
  ok(/进程/.test($('st-engine-sub').textContent),
     '副标题含进程信息："' + $('st-engine-sub').textContent + '"');

  console.log('\n【D】首页卡片的上下文标注（只写 xxK）');
  const cardsHtml = $('model-list').innerHTML;
  ok(!/tokens/.test(cardsHtml), '卡片里不再出现 "tokens" 字样');
  ok(!/=\s*\d+/.test(cardsHtml.replace(/value="\d+"/g, '')), '不再有 "= xxx" 的换算写法');
  // syncUnit() 会把初始的 <span class="unit">K</span> 改写成 "<数字>K"
  const units = $('model-list').querySelectorAll('.unit');
  ok(units.length === 2, '两张卡片都有单位标注（实际 ' + units.length + '）');
  ok(units.every((u) => /^\d+K$/.test(u.textContent)),
     '单位文本形如 "90K"/"96K"：' + units.map((u) => u.textContent).join(', '));
  ok(units.every((u) => !/token/i.test(u.textContent)), '单位文本不含 token 字样');

  console.log('\n【E】参数面板：按引擎切换');
  railViews[1].dispatchEvent('click');
  await wait(200);
  ok(/llama\.cpp/.test($('p-engine-tag').innerHTML), '默认选中 llama.cpp 模型时徽标正确');
  ok($('p-ninfer-group').hidden === true, 'llama.cpp 模型下 NInfer 分组隐藏');
  ok($('p-row-nommproj').hidden === false, 'llama.cpp 模型下 mmproj 行可见');
  ok($('p-cmd').textContent.indexOf('llama-server') === 0, 'llama.cpp 模型命令预览是 llama-server');

  const rows = $('manage-list').children.filter((r) => r._classes && r._classes.has('mrow'));
  ok(rows.length === 2, '管理列表渲染出 2 行（实际 ' + rows.length + '）');
  const nfRow = rows.filter((r) => /NInfer/.test(r.innerHTML))[0];
  ok(!!nfRow, '找到 NInfer 那一行');
  if (nfRow) {
    const btn = nfRow.querySelectorAll('button').filter((b) => b.textContent === '启动参数')[0];
    ok(!!btn, 'NInfer 行有「启动参数」按钮');
    btn.dispatchEvent('click');
    await wait(300);

    ok(/NInfer/.test($('p-engine-tag').innerHTML), '引擎徽标切到 NInfer');
    ok($('p-ninfer-group').hidden === false, 'NInfer 参数分组已展开');
    ok($('p-row-nommproj').hidden === true, 'llama.cpp 的 mmproj 行已隐藏');
    ok($('p-cmd').textContent.indexOf('wsl -d') === 0,
       '命令预览是 wsl 命令："' + $('p-cmd').textContent.slice(0, 46) + '…"');
    ok($('p-nf-kvdtype').value === 'q4', 'KV 精度回填 q4（实际 ' + $('p-nf-kvdtype').value + '）');
    ok(String($('p-nf-prefill').value) === '896', '预填充块回填 896（实际 ' + $('p-nf-prefill').value + '）');
    ok($('p-nf-vision').checked === true, '视觉开关回填为开');

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
  }

  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
