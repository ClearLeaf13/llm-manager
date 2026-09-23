'use strict';

const path = require('path');

/**
 * 模型与运行时配置。
 * 注：目录已于迁移后统一到 C:\Users\Administrator\llama.cpp\
 * （llama-server 与 models 同级），原位置在 Documents\默认工作区\ 下。
 */

const LLAMA_DIR = 'C:\\Users\\Administrator\\llama.cpp';
const MODELS_DIR = path.join(LLAMA_DIR, 'models');

const SERVER_EXE = path.join(LLAMA_DIR, 'llama-server.exe');

/**
 * 三个模型，顺序与原管理器菜单一致。
 * name      原菜单显示名
 * alias     传给 --alias 的模型 id（原 exe 的 ShortName）
 * file      gguf 主文件
 * mmproj    视觉投影文件（多模态才有）
 * ctxK      默认上下文长度（K tokens）
 * useMtp    是否启用 MTP 投机解码
 * port      服务端口
 */
const MODELS = [
  {
    id: 'balanced',
    name: 'Qwen3.6-35B-A3B I-Balanced',
    alias: 'Qwen3.6-35B-A3B-Balanced',
    file: path.join(MODELS_DIR, 'Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf'),
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
    file: path.join(MODELS_DIR, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'),
    mmproj: path.join(MODELS_DIR, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'),
    ctxK: 32,
    useMtp: false,
    port: 8081,
    vision: true,
  },
  {
    id: 'reap',
    name: 'Qwen3.6-VL-REAP-26B-A3B 视觉',
    alias: 'Qwen3.6-VL-REAP-26B-A3B',
    file: path.join(MODELS_DIR, 'Qwen3.6-VL-REAP-26B-A3B-text-IQ4_XS.gguf'),
    mmproj: path.join(MODELS_DIR, 'mmproj-REAP-26B-F16.gguf'),
    ctxK: 32,
    useMtp: false,
    port: 8082,
    vision: true,
  },
];

/** 原 exe 的 BuildArgs 模板，逐字保留默认采样参数。 */
function buildArgs(model, ctxK) {
  const args = [
    '-m', model.file,
  ];

  if (model.mmproj) {
    args.push('--mmproj', model.mmproj);
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

module.exports = { LLAMA_DIR, MODELS_DIR, SERVER_EXE, MODELS, buildArgs };
