'use strict';

const path = require('path');

/**
 * 模型与运行时配置。
 *
 * 目录按以下优先级自动解析，无需改代码即可换机器：
 *   1. 环境变量 LLM_MANAGER_DIR（指向 llama.cpp 根目录）
 *   2. 常见候选路径（见 LLAMA_DIR_CANDIDATES）
 *   3. 兜底：<用户主目录>\llama.cpp
 * 运行时也可在界面「设置」里手动覆盖 serverExe / modelsDir。
 */

const os = require('os');
const fs = require('fs');

/** 候选根目录：按顺序取第一个存在 llama-server.exe 的（由近及远，自动去重） */
const LLAMA_DIR_CANDIDATES = [...new Set([
  process.env.LLM_MANAGER_DIR,                              // 1. 环境变量优先
  path.join(os.homedir(), 'llama.cpp'),                     // 2. 用户主目录下
  path.join(os.homedir(), 'Documents', '默认工作区', 'llama-cpp'), // 3. 历史位置
].filter(Boolean).map((p) => path.resolve(p)))];

/** 兜底目录（都不存在时使用，便于界面提示用户手动指定） */
const LLAMA_DIR = LLAMA_DIR_CANDIDATES[0] || path.join(os.homedir(), 'llama.cpp');

const MODELS_DIR = path.join(LLAMA_DIR, 'models');

const SERVER_EXE = path.join(LLAMA_DIR, 'llama-server.exe');

/**
 * 三个模型，顺序与原管理器菜单一致。
 * name      原菜单显示名
 * alias     传给 --alias 的模型 id（原 exe 的 ShortName）
 * file      gguf 主文件名（相对 MODELS_DIR，运行时解析成绝对路径）
 * mmproj    视觉投影文件名（多模态才有，可为 null）
 * ctxK      默认上下文长度（K tokens）
 * useMtp    是否启用 MTP 投机解码
 * port      服务端口
 */
const MODELS = [
  {
    id: 'balanced',
    name: 'Qwen3.6-35B-A3B I-Balanced',
    alias: 'Qwen3.6-35B-A3B-Balanced',
    file: 'Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf',
    mmproj: null,
    ctxK: 32,
    useMtp: true,
    port: 8080,
    vision: false,
  },
  {
    id: 'vl8b',
    name: 'Qwen3-VL-8B-Instruct 视觉',
    alias: 'Qwen3-VL-8B',
    file: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    mmproj: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    ctxK: 32,
    useMtp: false,
    port: 8081,
    vision: true,
  },
  {
    id: 'reap',
    name: 'Qwen3.6-VL-REAP-26B-A3B 视觉',
    alias: 'Qwen3.6-VL-REAP-26B-A3B',
    file: 'Qwen3.6-VL-REAP-26B-A3B-text-IQ4_XS.gguf',
    mmproj: 'mmproj-REAP-26B-F16.gguf',
    ctxK: 32,
    useMtp: false,
    port: 8082,
    vision: true,
  },
];

/** 原 exe 的 BuildArgs 模板，逐字保留默认采样参数。 */
function buildArgs(model, ctxK) {
  const file = model.filePath;
  const args = [
    '-m', file,
  ];

  if (model.mmproj) {
    args.push('--mmproj', model.mmprojPath);
  }

  args.push(
    '--alias', model.alias,
    '-c', String(ctxK),
    '--fit', 'on',
    '--fit-target', '512',
    '--context-shift',
    '-fa', 'on',
    '--jinja',
    '-np', '1',
    '-t', '16',
    '-tbd', '16',
    '-ub', '512',
    '-b', '2048',
    '-ctk', 'q8_0',
    '-ctv', 'q8_0',
    '--temp', '0.6',
    '--top-p', '0.95',
    '--top-k', '20',
    '--min-p', '0.0',
    '--presence-penalty', '0.0',
    '--repeat-penalty', '1.0',
    '--load-mode', 'mlock',
  );

  // MTP 投机解码（仅 35B 模型）
  if (model.useMtp) {
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2');
  }

  args.push('--host', '127.0.0.1', '--port', String(model.port));

  return args;
}

/**
 * 把模型定义里的文件名解析成绝对路径。
 * @param {string} modelsDir 模型目录（来自设置或自动探测）
 * @param {Array} [list] 模型数组；不传则用内置的 MODELS
 * @returns {Array} 新的模型数组，附带 filePath / mmprojPath
 */
function resolveModels(modelsDir, list) {
  const dir = modelsDir || MODELS_DIR;
  const src = Array.isArray(list) ? list : MODELS;
  return src.map((m) => ({
    ...m,
    filePath: path.join(dir, m.file),
    mmprojPath: m.mmproj ? path.join(dir, m.mmproj) : null,
  }));
}

/** 自动探测 llama.cpp 根目录：返回第一个含 llama-server.exe 的候选 */
function detectLlamaDir() {
  for (const c of LLAMA_DIR_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(c, 'llama-server.exe'))) return c;
    } catch (_) { /* 忽略无权限路径 */ }
  }
  return null;
}

module.exports = {
  LLAMA_DIR,
  MODELS_DIR,
  SERVER_EXE,
  MODELS,
  LLAMA_DIR_CANDIDATES,
  buildArgs,
  resolveModels,
  detectLlamaDir,
};
