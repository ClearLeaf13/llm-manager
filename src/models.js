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
 * 预置模型。
 *
 * engine 决定用哪个引擎启动：
 *   'llamacpp' —— Windows 上的 llama-server.exe，file 是 models 目录下的 gguf 文件名
 *   'ninfer'   —— WSL 里的 ninfer-serve，file 是 WSL 内的 .ninfer 绝对路径
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
    engine: 'llamacpp',
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
    engine: 'llamacpp',
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
    engine: 'llamacpp',
  },
  {
    // NInfer 引擎的预置模型：跑在 WSL 里，file 是 WSL 内绝对路径。
    // 只有真正探测到该文件时才值得保留，否则用户可一键删掉。
    id: 'ninfer-qwen38',
    name: 'Qwen3.8-27B (NInfer)',
    alias: 'qwen3.8-27b',
    file: '/root/models/qwen3_8_27b.ninfer',
    mmproj: null,
    ctxK: 96,
    useMtp: false,
    port: 8090,
    vision: true,
    engine: 'ninfer',
    ninfer: {
      maxContext: 98304,
      kvDtype: 'q4',
      prefillChunk: 896,
      draftTokens: 3,
      thinkingBudget: 2048,
      vision: true,
      visionMaxTokens: 2048,
      embeddingHost: true,
      spec: 'mtp',
      noCudaGraph: true,
      extraArgs: '',
    },
  },
];

/**
 * 把「补充参数」文本切成参数数组。
 *
 * 支持双引号包裹的含空格参数（如 --chat-template-file "C:\my dir\t.jinja"），
 * 空串与纯空白返回空数组。
 *
 * @param {string} text 用户在界面上填的补充参数
 * @returns {string[]} 拆分后的参数
 */
function splitExtraArgs(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return out;
}

/** 原 exe 的 BuildArgs 模板，逐字保留默认采样参数。 */
function buildArgs(model, ctxK) {
  const file = model.filePath;
  const args = [
    '-m', file,
  ];

  // 视觉投影：--no-mmproj-offload 让 mmproj 留在 CPU 内存里，
  // 代价是 CPU 侧算视觉编码，收益是省下约 1 GB 显存（16 GB 卡上很关键）
  if (model.mmproj) {
    if (model.noMmprojOffload) args.push('--no-mmproj-offload');
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

  // 用户补充参数：排在 --host/--port 之前，保证端口不被用户覆盖坏
  args.push(...splitExtraArgs(model.extraArgs));

  args.push('--host', '127.0.0.1', '--port', String(model.port));

  return args;
}

/**
 * 把模型定义里的文件名解析成绝对路径。
 *
 * llama.cpp 引擎：file 是 gguf 文件名，拼到 modelsDir 下。
 * NInfer 引擎：file 是 WSL 内的绝对路径（/root/models/x.ninfer），
 *             原样保留 —— 那个路径是给 Linux 侧二进制用的，
 *             用 Windows 的 path.join 拼会得到错误结果。
 *
 * @param {string} modelsDir 模型目录（来自设置或自动探测）
 * @param {Array} [list] 模型数组；不传则用内置的 MODELS
 * @returns {Array} 新的模型数组，附带 filePath / mmprojPath
 */
function resolveModels(modelsDir, list) {
  const dir = modelsDir || MODELS_DIR;
  const src = Array.isArray(list) ? list : MODELS;
  return src.map((m) => {
    const isNinfer = m.engine === 'ninfer';
    const raw = String(m.file || '');
    // WSL 路径是 posix 绝对路径；Windows 侧的绝对路径也原样保留
    const isAbs = isNinfer
      ? raw.startsWith('/')
      : (path.isAbsolute(raw));

    return {
      ...m,
      filePath: isAbs ? raw : path.join(dir, raw),
      mmprojPath: m.mmproj ? path.join(dir, m.mmproj) : null,
    };
  });
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
  splitExtraArgs,
  resolveModels,
  detectLlamaDir,
};
