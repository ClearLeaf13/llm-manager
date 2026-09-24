'use strict';
/**
 * 渲染层结构回归：用最小 DOM 桩加载真实 index.html + renderer.js。
 *
 * 覆盖本轮改动的结构性要求（元素是否存在、旧结构是否已移除）。
 * 行为类断言见 renderer-behavior.test.js。
 *
 *   运行：node tests/renderer-structure.test.js
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
    // 解析出所有元素（不只是带 id 的）：renderer 会用 .card-foot 这类 class 选择器
    const re = /<(\w+)([^>]*?)>/g;
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const tag = m[1];
      // 去掉尾部的 "/"（自闭合写法），但 input/img 这类仍要建成节点 ——
      // renderer 会查询 input / .unit / .card-foot 这类选择器并绑事件
      const attrs = (m[2] || '').replace(/\/\s*$/, '');
      const child = new El(tag);
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
      if (/^input$/i.test(tag)) child.tagName = 'INPUT';
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
          const camel = key.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
          dv = el.dataset[camel];
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
    // 侧栏宽度从 style 读；否则 railW 会等于整个窗口宽，把拖动值压到最小值
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

// index.html 里带 id 的元素全部注册
for (const m of html.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*?)>/g)) {
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
  if (m[3] === 'rail') el.style.width = '48px';
  root.appendChild(el);
}
// 标题栏圆点没有 id，靠 class 找；缺了 renderStatus 第一行就抛错
const dotEl = new El('span'); dotEl.className = 'dot';
root.appendChild(dotEl);
// shell 容器（拖动计算用）
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

const winListeners = {};
global.window = {
  api: {
    getSettings: async () => ({ theme: 'dark', zoom: 1, defaultCtxK: 32, readyTimeoutSec: 180,
      logLimit: 4000, logSysOnly: false, serverExe: 'C:\\l\\llama-server.exe', modelsDir: 'C:\\m',
      closeToTray: true, modelsWidth: 300, ninferDistro: 'Ubuntu-24.04',
      ninferServe: '/root/ninfer-5080/build/apps/ninfer-serve',
      ninferCli: '/root/ninfer-5080/build/apps/ninfer',
      ninferModelsDir: '/root/models', ninferAutoScan: true }),
    saveSettings: async (p) => ({ ok: true, settings: { ...p } }),
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
      const k = Number(ctxK) || m.ctxK;
      if (m.engine === 'ninfer') {
        return { ok: true, engine: 'ninfer', ctxK: k, ctxTokens: k * 1024,
          command: 'wsl -d Ubuntu-24.04 -u root -- ninfer-serve ' + m.file + ' --max-context ' + (k * 1024),
          ninfer: m.ninfer, hasMmproj: false, running: false };
      }
      return { ok: true, engine: 'llamacpp', ctxK: k, ctxTokens: k * 1024,
        command: 'llama-server.exe -m ' + m.file + ' -c ' + (k * 1024), hasMmproj: !!m.mmproj,
        noMmprojOffload: !!m.noMmprojOffload, extraArgs: '', running: false };
    },
    modelsUpdate: async () => ({ ok: true }),
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
  },
  addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
  dispatchEvent: (e) => { (winListeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
};

global.confirm = () => false;
global.clearTimeout = clearTimeout;
global.setInterval = () => 0;   // 关掉轮询，避免测试进程不退出

// 侧栏视图按钮（HTML 里结构特殊，手动建）
['models', 'manage'].forEach((v) => {
  const b = new El('button');
  b.className = 'rail-btn' + (v === 'models' ? ' active' : '');
  b.dataset.view = v;
  root.appendChild(b);
});

/* ---------------- 跑真实 renderer.js ---------------- */

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
const run = new Function('document', 'window', 'navigator', 'confirm', 'setTimeout',
  'clearTimeout', 'setInterval', 'console', src);
run(global.document, global.window, NAV_STUB, global.confirm, setTimeout,
  clearTimeout, () => 0, console);

/* ---------------- 断言 ---------------- */

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label); }
};
const $ = (id) => elById.get(id);

(async () => {
  await new Promise((r) => setTimeout(r, 150));

  console.log('\n【1】只有两页，切换时左右栏正确');
  ok(!$('pane-log'), '第三页 pane-log 已删除');
  ok(!/data-view="log"/.test(html), '侧边栏没有「日志」入口');
  ok(!$('pane-models').classList.contains('hidden'), '第一页显示左栏');
  ok(!$('pane-status').classList.contains('hidden'), '第一页显示状态总览');
  ok($('pane-params').classList.contains('hidden'), '第一页隐藏启动参数');

  console.log('\n【2】状态总览「推理引擎」卡');
  ok(!!$('st-engine'), '存在 #st-engine 元素');
  ok(!!$('st-engine-sub'), '存在 #st-engine-sub 元素');

  console.log('\n【3】参数页：上下文 + NInfer 参数');
  ok(!!$('p-ctx'), '存在上下文输入框（唯一可改上下文的地方）');
  ok(!!$('p-ctx-note'), '存在上下文换算提示');
  ok(!!$('p-ninfer-group'), '存在 NInfer 参数分组');
  ok(!!$('p-nf-kvdtype') && !!$('p-nf-spec'), '存在 KV / 投机解码下拉');
  ok(!!$('p-nf-prefill') && !!$('p-nf-draft'), '存在预填充块 / 草稿 token');
  ok(!!$('p-nf-thinking') && !!$('p-nf-visiontokens'), '存在思考预算 / 视觉 token 上限');
  ok(!!$('p-nf-vision') && !!$('p-nf-embedding') && !!$('p-nf-nocudagraph'), '存在三个 NInfer 开关');
  ok(!!$('p-row-nommproj'), 'mmproj 行可整行隐藏');
  ok(!!$('p-engine-tag'), '存在引擎徽标元素');

  console.log('\n【4】设置里的 NInfer 分组');
  ok(!!$('set-nf-distro'), '发行版下拉');
  ok(!!$('set-nf-serve'), 'serve 路径');
  ok(!!$('set-nf-cli'), 'CLI 路径');
  ok(!!$('set-nf-modelsdir'), '模型目录');
  ok(!!$('set-nf-autoscan'), '自动扫描开关');
  ok(!!$('nf-badge') && !!$('nf-status'), '状态徽标与状态区');

  console.log('\n【5】设置齿轮图标');
  const gear = html.match(/id="rail-settings"[\s\S]*?<\/svg>/);
  ok(!!gear, '找到设置按钮 svg');
  if (gear) {
    ok(!/M10 2\.6v2\.1/.test(gear[0]), '不再是放射线（太阳）图标');
    ok(/<circle/.test(gear[0]), '含中心圆（齿轮特征）');
    ok((gear[0].match(/<path/g) || []).length >= 1, '含外齿路径');
  }

  console.log('\n【6】弹窗引擎选择');
  ok(!!$('f-engine'), '存在引擎下拉');
  ok(!!$('f-file-text'), '存在 NInfer 路径文本框');
  ok(!!$('f-mmproj-row'), 'mmproj 行可隐藏');

  console.log('\n【7】应用改名');
  ok(/<title>本地 ?LLM ?聚合管理<\/title>/.test(html), '标题已改为「本地 LLM 聚合管理」');
  ok(/app-name">本地 ?LLM ?聚合管理/.test(html), '标题栏应用名已更新');

  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
