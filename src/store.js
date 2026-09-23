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

/** 允许写入的字段白名单，防止前端塞入任意键 */
const FIELDS = [
  'id', 'name', 'alias', 'file', 'mmproj',
  'ctxK', 'useMtp', 'port', 'vision',
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
  }));
}

function load() {
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models)) {
      cache = parsed.models;
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

  return out;
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
  genId, nextPort, resetToSeed, FIELDS,
};
