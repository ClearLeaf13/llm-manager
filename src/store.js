'use strict';

/**
 * 模型配置的持久化存储。
 *
 * 数据落在 <userData>/models.json，结构：
 *   { version: 1, models: [ {...}, ... ] }
 *
 * 首次启动（文件不存在）时，用 models.js 里的 MODELS 作为初始数据导入，
 * 之后完全以文件为准 —— 界面上的增删改都会写回这里。
 */

const path = require('path');
const fs = require('fs');
const { MODELS } = require('./models');

const SCHEMA_VERSION = 1;

/** 支持的推理引擎 */
const ENGINES = ['llamacpp', 'ninfer'];

/** 允许写入的字段白名单，防止前端塞入任意键 */
const FIELDS = [
  'id', 'name', 'alias', 'file', 'mmproj',
  'ctxK', 'useMtp', 'port', 'vision',
  // 启动参数：mmproj 不卸载到 GPU（省显存）；补充参数（本版本未内置的 flag 走这里）
  'noMmprojOffload', 'extraArgs',
  // 可在界面上开关的启动选项（默认值见 models.js 的 PARAM_DEFAULTS）
  'jinja', 'flashAttn', 'ctxShift', 'loadMode',
  // 显存与卸载 / 性能 / 模板 / 采样（同上，分类见 PARAM_GROUPS）
  'gpuLayers', 'kvOffload', 'splitMode',
  'threads', 'threadsBatch', 'ubatch', 'batch', 'fits',
  'chatTemplateFile', 'reasoningFormat',
  'temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'presencePenalty',
  'parallel', 'cacheTypeK', 'cacheTypeV', 'noOpOffload', 'metrics', 'noWebui', 'timeout',
  // kvmem-llama.cpp 的分层 KV 内存开关
  'kvmem',
  // 手改过的启动命令（覆盖选项拼出来的命令行，见 models.js applyCmdOverride）
  'cmdOverride',
  // 引擎与 NInfer 专属参数
  'engine', 'ninfer',
];

let storeFile = null;
let cache = null;

/** 由 main.js 在 app ready 后调用，注入 userData 路径 */
function init(userDataDir) {
  storeFile = path.join(userDataDir, 'models.json');
  return load();
}

/** 把预置模型转成存储格式（file 已是文件名） */
function seed() {
  return MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    alias: m.alias,
    file: m.file,
    mmproj: m.mmproj || null,
    ctxK: m.ctxK,
    useMtp: !!m.useMtp,
    port: m.port,
    vision: !!m.vision,
    // 启动参数（预置模型默认关掉 mmproj 卸载、无补充参数）
    noMmprojOffload: !!m.noMmprojOffload,
    extraArgs: m.extraArgs || '',
    engine: m.engine || 'llamacpp',
    ninfer: m.ninfer ? { ...m.ninfer } : undefined,
  }));
}

function load() {
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models)) {
      // 落盘的数据也要过一遍 sanitize：老配置缺新字段时补默认值，
      // 类型写坏时也在这里被纠正（否则 undefined 会一路传到启动参数里）
      cache = parsed.models
        .filter((m) => m && typeof m === 'object' && m.id)
        .map((m) => sanitize(m, { keepId: m.id }));
      return cache;
    }
    throw new Error('models 字段不是数组');
  } catch (e) {
    // 文件不存在或损坏 —— 用预置数据重建
    if (e.code !== 'ENOENT') {
      console.warn('[store] models.json 读取失败，已用预置数据重建:', e.message);
    }
    cache = seed();
    persist();
    return cache;
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const payload = { version: SCHEMA_VERSION, models: cache };
    // 先写临时文件再改名，避免中途崩溃留下半截 JSON
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, storeFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 返回所有模型（副本，避免外部直接改到 cache） */
function all() {
  return cache.map((m) => ({ ...m }));
}

function find(id) {
  const m = cache.find((x) => x.id === id);
  return m ? { ...m } : null;
}

/** 只保留白名单字段并做类型归一 */
function sanitize(input, { keepId = null } = {}) {
  const out = {};
  for (const k of FIELDS) {
    if (input[k] === undefined) continue;
    out[k] = input[k];
  }

  if (keepId !== null) out.id = keepId;

  if (typeof out.name === 'string') out.name = out.name.trim();
  if (typeof out.alias === 'string') out.alias = out.alias.trim();
  if (typeof out.file === 'string') out.file = out.file.trim();
  if (out.mmproj === '' || out.mmproj === undefined) out.mmproj = null;
  if (typeof out.mmproj === 'string') out.mmproj = out.mmproj.trim();

  out.ctxK = Number(out.ctxK) > 0 ? Math.round(Number(out.ctxK)) : 32;
  out.port = Number(out.port) > 0 ? Math.round(Number(out.port)) : 8080;
  out.useMtp = !!out.useMtp;
  out.vision = !!out.vision;
  // 启动参数：缺省即关闭/空串，保证老配置文件读进来也有值
  out.noMmprojOffload = !!out.noMmprojOffload;
  out.extraArgs = typeof out.extraArgs === 'string' ? out.extraArgs.trim().slice(0, 2000) : '';

  // 可选启动开关：缺省一律视为「开」，与从前写死的命令行一致，
  // 这样老配置文件读进来行为不变（真正的默认值见 models.js PARAM_DEFAULTS）
  out.jinja = out.jinja === undefined ? true : !!out.jinja;
  out.flashAttn = out.flashAttn === undefined ? true : !!out.flashAttn;
  out.ctxShift = out.ctxShift === undefined ? true : !!out.ctxShift;
  out.loadMode = ['mlock', 'mmap', 'none'].includes(out.loadMode) ? out.loadMode : 'mlock';

  // 显存与卸载：gpuLayers 负数表示「不指定 -ngl」，交给 --fit 自动决定
  out.gpuLayers = Number.isFinite(Number(out.gpuLayers)) ? Math.round(Number(out.gpuLayers)) : -1;
  out.kvOffload = out.kvOffload === undefined ? true : !!out.kvOffload;
  out.splitMode = ['none', 'layer', 'row'].includes(out.splitMode) ? out.splitMode : 'layer';

  // 性能与批处理：线程 -1 = 自动（不写进命令行）
  out.threads = Number.isFinite(Number(out.threads)) ? Math.round(Number(out.threads)) : -1;
  out.threadsBatch = Number.isFinite(Number(out.threadsBatch)) ? Math.round(Number(out.threadsBatch)) : -1;
  out.ubatch = posInt(out.ubatch, 512, 1, 8192);
  out.batch = posInt(out.batch, 2048, 1, 65536);
  out.fits = out.fits === undefined ? true : !!out.fits;

  // 对话模板
  out.chatTemplateFile = typeof out.chatTemplateFile === 'string'
    ? out.chatTemplateFile.trim().slice(0, 500) : '';
  out.reasoningFormat = ['auto', 'none', 'deepseek', 'deepseek-legacy'].includes(out.reasoningFormat)
    ? out.reasoningFormat : 'auto';

  // 采样：按字符串存，保住 0.0 / 1.0 的写法（见 models.js numOr）
  out.temperature = numStr(out.temperature, '0.6');
  out.topP = numStr(out.topP, '0.95');
  out.topK = posInt(out.topK, 20, 0, 1000);
  out.minP = numStr(out.minP, '0.0');
  out.repeatPenalty = numStr(out.repeatPenalty, '1.0');
  out.presencePenalty = numStr(out.presencePenalty, '0.0');

  // 高级
  out.parallel = posInt(out.parallel, 1, 1, 64);
  out.cacheTypeK = cacheType(out.cacheTypeK, 'q8_0');
  out.cacheTypeV = cacheType(out.cacheTypeV, 'q8_0');
  out.noOpOffload = !!out.noOpOffload;
  out.metrics = !!out.metrics;
  out.noWebui = !!out.noWebui;
  out.timeout = posInt(out.timeout, 0, 0, 86400);
  out.kvmem = !!out.kvmem;

  // 手改的启动命令：整行文本，长度上限防止误粘一大坨进来
  out.cmdOverride = typeof out.cmdOverride === 'string'
    ? out.cmdOverride.trim().slice(0, 4000) : '';

  // 引擎：老配置没有这个字段，一律按 llama.cpp 处理（向后兼容）
  out.engine = ENGINES.includes(out.engine) ? out.engine : 'llamacpp';

  // NInfer 专属参数：只在 ninfer 引擎下保留，llama.cpp 模型不带这坨
  if (out.engine === 'ninfer') {
    out.ninfer = sanitizeNinfer(out.ninfer);
    // 视觉能力对 NInfer 只有一个真相来源：ninfer.vision
    // （编码器内建在 .ninfer 文件里，没有独立的 mmproj）。
    // 顶层 vision 仅作展示用的镜像，这里强制同步，
    // 否则历史配置里两处可能一个 true 一个 false，界面就会显示错。
    out.ninfer.vision = out.ninfer.vision !== false;
    out.vision = out.ninfer.vision;
  } else {
    delete out.ninfer;
  }

  return out;
}

/** 正整数归一：非法值/越界收敛到 [lo, hi] */
function posInt(v, d, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return d;
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

/** 采样参数：存字符串，保住 0.0 / 1.0 这类小数位 */
function numStr(v, d) {
  if (v === undefined || v === null || v === '') return String(d);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(d);
  return String(v).trim();
}

/** KV 缓存精度白名单 */
function cacheType(v, d) {
  const ok = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'];
  return ok.includes(v) ? v : d;
}

/** NInfer 参数归一：类型纠正 + 越界收敛 + 枚举校验 */
function sanitizeNinfer(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const n = (v, d, lo, hi) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return d;
    return Math.max(lo, Math.min(hi, Math.round(x)));
  };

  return {
    maxContext: n(src.maxContext, 32768, 1024, 1048576),
    kvDtype: ['bf16', 'int8', 'q4'].includes(src.kvDtype) ? src.kvDtype : 'q4',
    prefillChunk: n(src.prefillChunk, 512, 64, 8192),
    draftTokens: n(src.draftTokens, 3, 1, 16),
    thinkingBudget: n(src.thinkingBudget, 2048, 0, 131072),
    vision: src.vision === undefined ? true : !!src.vision,
    visionMaxTokens: n(src.visionMaxTokens, 2048, 0, 32768),
    embeddingHost: src.embeddingHost === undefined ? true : !!src.embeddingHost,
    spec: ['mtp', 'dflash', 'dflash2', ''].includes(src.spec) ? src.spec : 'mtp',
    noCudaGraph: src.noCudaGraph === undefined ? true : !!src.noCudaGraph,
    extraArgs: typeof src.extraArgs === 'string' ? src.extraArgs.trim().slice(0, 2000) : '',
  };
}

/** 生成不会与现有模型冲突的 id */
function genId(name) {
  const base = String(name || 'model')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'model';

  let id = base;
  let n = 2;
  while (cache.some((m) => m.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

/** 选一个没被占用的端口 */
function nextPort() {
  const used = new Set(cache.map((m) => m.port));
  for (let p = 8080; p < 8200; p += 1) {
    if (!used.has(p)) return p;
  }
  return 8090;
}

function validate(model, { excludeId = null } = {}) {
  if (!model.name) return '名称不能为空';
  if (!model.file) return '模型文件名不能为空';
  if (!Number.isFinite(model.port) || model.port < 1 || model.port > 65535) {
    return '端口需在 1-65535 之间';
  }
  const clash = cache.find((m) => m.port === model.port && m.id !== excludeId);
  if (clash) return `端口 ${model.port} 已被「${clash.name}」占用`;

  return null;
}

function create(input) {
  const model = sanitize(input);
  model.id = input.id && !cache.some((m) => m.id === input.id)
    ? input.id
    : genId(model.name);
  if (!input.alias) model.alias = model.name;

  const err = validate(model);
  if (err) return { ok: false, error: err };

  cache.push(model);
  const w = persist();
  if (!w.ok) {
    cache.pop();
    return { ok: false, error: '写入失败：' + w.error };
  }
  return { ok: true, model: { ...model } };
}

function update(id, patch) {
  const idx = cache.findIndex((m) => m.id === id);
  if (idx < 0) return { ok: false, error: '模型不存在' };

  const merged = sanitize({ ...cache[idx], ...patch }, { keepId: id });
  const err = validate(merged, { excludeId: id });
  if (err) return { ok: false, error: err };

  const backup = cache[idx];
  cache[idx] = merged;
  const w = persist();
  if (!w.ok) {
    cache[idx] = backup;
    return { ok: false, error: '写入失败：' + w.error };
  }
  return { ok: true, model: { ...merged } };
}

function remove(id) {
  const idx = cache.findIndex((m) => m.id === id);
  if (idx < 0) return { ok: false, error: '模型不存在' };
  const [removed] = cache.splice(idx, 1);
  const w = persist();
  if (!w.ok) {
    cache.splice(idx, 0, removed);
    return { ok: false, error: '写入失败：' + w.error };
  }
  return { ok: true };
}

/** 恢复成预置数据 */
function resetToSeed() {
  cache = seed();
  return persist();
}

module.exports = {
  init, all, find, create, update, remove,
  genId, nextPort, resetToSeed, sanitize, sanitizeNinfer, FIELDS, ENGINES,
};
