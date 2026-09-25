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

/* ------------------------------------------------------------------ *
 * 启动选项（可在界面上直接改的 flag）
 *
 * llama.cpp 的命令模板以前写死在 buildArgs 里，用户只能靠「补充参数」
 * 去追加或覆盖，看不到也改不了已有的开关。现在把「有哪些选项、默认值
 * 是多少」抽成这份清单：
 *   - 界面据此渲染启动命令下的选项分组；
 *   - 「恢复默认参数」据此把模型还原成出厂值；
 *   - buildArgs 只负责把选中值拼成命令行。
 * 改一个选项只需改这里 + buildArgs 里对应的一行。
 * ------------------------------------------------------------------ */

/** 一个启动选项的默认值（按引擎分组） */
const PARAM_DEFAULTS = {
  llamacpp: {
    // ① 上下文
    ctxK: 32,                    // -c
    // ② 显存与卸载
    noMmprojOffload: false,      // --no-mmproj-offload
    loadMode: 'mlock',           // --load-mode mlock|mmap|none
    gpuLayers: -1,               // -ngl（-1 = 全部层放显存；0 = 全 CPU）
    kvOffload: true,             // -kvo（false 时加 --no-kv-offload）
    splitMode: 'layer',          // -sm
    // ③ 性能与批处理
    threads: -1,                 // -t（-1 = 自动）
    threadsBatch: -1,            // -tb（-1 = 同 -t）
    ubatch: 512,                 // -ub
    batch: 2048,                 // -b
    fits: true,                  // --fit on：自动按显存调整未设置的参数
    // ④ 对话模板
    jinja: true,                 // --jinja
    chatTemplateFile: '',        // --chat-template-file <路径>
    reasoningFormat: 'auto',     // --reasoning-format
    // ⑤ 采样
    temperature: 0.6,            // --temp
    topP: '0.95',                // --top-p
    topK: 20,                    // --top-k
    minP: '0.0',                 // --min-p
    repeatPenalty: '1.0',        // --repeat-penalty
    presencePenalty: '0.0',      // --presence-penalty
    // ⑥ 高级
    useMtp: false,               // --spec-type draft-mtp
    ctxShift: true,              // --context-shift
    flashAttn: true,             // -fa on
    parallel: 1,                 // -np
    cacheTypeK: 'q8_0',          // -ctk
    cacheTypeV: 'q8_0',          // -ctv
    noOpOffload: false,          // --no-op-offload（H2D/D2H 不走 GPU）
    metrics: false,              // --metrics
    noWebui: false,              // --no-webui
    timeout: 0,                  // -to（0 = 用引擎默认 3600s，不写进命令行）
    // ⑦ KVMem（kvmem-llama.cpp 打的分层 KV 内存补丁）
    kvmem: false,                // --kvmem
  },
  ninfer: {
    ctxK: 96,
    kvDtype: 'q4',               // --kv-dtype
    spec: 'mtp',                 // --spec
    prefillChunk: 512,           // --prefill-chunk
    draftTokens: 3,              // --draft-tokens
    thinkingBudget: 2048,        // --default-thinking-budget
    vision: true,                // --vision
    visionMaxTokens: 2048,       // --vision-max-tokens
    embeddingHost: true,         // --embedding-host
    noCudaGraph: true,           // --no-cuda-graph
  },
};

/**
 * 启动选项的分类与显示信息。
 *
 * 界面按这份表渲染「启动命令」下的折叠子菜单，所以加一个新参数只要：
 *   1) PARAM_DEFAULTS 里给它一个默认值
 *   2) buildArgs 里拼进命令行
 *   3) 这里给它一个位置和标签
 * 顺序即界面顺序。
 */
const PARAM_GROUPS = {
  llamacpp: [
    { id: 'ctx', name: '上下文', fields: ['ctxK'] },
    { id: 'mem', name: '显存与卸载', fields: ['gpuLayers', 'noMmprojOffload', 'kvOffload', 'loadMode', 'splitMode'] },
    { id: 'perf', name: '性能与批处理', fields: ['threads', 'threadsBatch', 'ubatch', 'batch', 'fits'] },
    { id: 'tpl', name: '对话模板', fields: ['jinja', 'chatTemplateFile', 'reasoningFormat'] },
    { id: 'sample', name: '采样', fields: ['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'presencePenalty'] },
    { id: 'adv', name: '高级', fields: ['useMtp', 'ctxShift', 'flashAttn', 'parallel', 'cacheTypeK', 'cacheTypeV', 'noOpOffload', 'metrics', 'noWebui', 'timeout'] },
    { id: 'kvmem', name: 'KVMem', fields: ['kvmem'] },
  ],
  ninfer: [
    { id: 'ctx', name: '上下文', fields: ['ctxK'] },
    { id: 'nf', name: 'NInfer 参数（WSL）', fields: ['kvDtype', 'spec', 'prefillChunk', 'draftTokens', 'thinkingBudget', 'visionMaxTokens', 'vision', 'embeddingHost', 'noCudaGraph'] },
  ],
};

/**
 * 解析用户手改过的启动命令文本。
 *
 * 界面把整条命令当成一个文本框，用户直接改。存下来的是一整行字符串，
 * 启动时要还原成 exe + 参数数组，所以这里要按 shell 规则拆分：
 * 支持双引号、单引号，以及引号内的空格。
 *
 * 返回值里的 exe 只有在用户把开头的程序名也改掉时才会不同；
 * 一般情况下用户改的只是后面的参数。
 *
 * @param {string} text 用户填写的完整命令行
 * @returns {{exe: string|null, args: string[]}}
 */
function parseCommandLine(text) {
  const parts = splitExtraArgs(text);
  if (!parts.length) return { exe: null, args: [] };
  return { exe: parts[0], args: parts.slice(1) };
}

/**
 * 把用户手改的命令行套到基准参数上。
 *
 * 语义：用户改过的命令**整体替换**基准命令行，不是逐项合并 ——
 * 用户看到什么就启动什么，这比「猜他想改哪一项」可预期得多。
 *
 * 但要保护几项，否则模型根本起不来或界面控件失灵：
 *   - -m / --mmproj：模型文件路径由「模型管理」决定，不该在命令里改；
 *   - --host / --port：界面用端口探测状态、开 WebUI，改了就对不上；
 *   这些项的基准值会被强制追加回去（用户写的同项会被覆盖）。
 *
 * 支持 `--flag=value` 写法：受保护项按 `=` 拆分后识别。
 *
 * @param {string[]} baseArgs buildArgs 拼出来的基准参数
 * @param {string} override 用户手改的整条命令（含程序名）
 * @param {string} exe 基准程序路径
 * @param {string[]} [protectedKeys] 受保护的参数名（默认 llama.cpp 那组）
 * @returns {{args: string[], exe: string, applied: boolean, protectedKeys: string[]}}
 */
function applyCmdOverride(baseArgs, override, exe, protectedKeys) {
  const text = String(override || '').trim();
  const PROTECTED = Array.isArray(protectedKeys) && protectedKeys.length
    ? protectedKeys
    : ['-m', '--mmproj', '--host', '--port'];
  const protSet = new Set(PROTECTED);
  if (!text) return { args: baseArgs, exe, applied: false, protectedKeys: [] };

  // 基准参数里理论上不该有空洞，但真出现（模型字段缺失）也不能让这里抛错，
  // 否则整个参数页会因为一个 undefined 直接打不开。
  const base = baseArgs.filter((a) => typeof a === 'string');

  const parsed = parseCommandLine(text);
  if (!parsed.args.length) return { args: base, exe, applied: false, protectedKeys: [] };

  // 受保护的键：从基准参数里原样取回（--flag=value 形式也认）
  const protectedPairs = [];
  for (let i = 0; i < base.length; i += 1) {
    const a = base[i];
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && protSet.has(a.slice(0, eq))) {
      protectedPairs.push([a.slice(0, eq), a.slice(eq + 1)]);
      continue;
    }
    if (protSet.has(a) && i + 1 < base.length) {
      protectedPairs.push([a, base[i + 1]]);
      i += 1;
    }
  }

  // 用户参数里去掉同名的受保护键（连同它的值），再把基准值接到末尾
  const kept = [];
  const parsedArgs = parsed.args.filter((a) => typeof a === 'string');
  for (let i = 0; i < parsedArgs.length; i += 1) {
    const a = parsedArgs[i];
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && protSet.has(a.slice(0, eq))) continue;
    if (protSet.has(a)) {
      i += 1; // 跳过它后面那个值
      continue;
    }
    kept.push(a);
  }

  // 「用户到底改没改」只看非受保护项：受保护项无论如何都会被管理器接管，
  // 它们在命令里的位置也一定会被挪到末尾，拿整条命令去比对必然不等，
  // 那样每条命令都会被标成「已自定义」，而用户其实一个字都没动。
  const baseFree = [];
  for (let i = 0; i < base.length; i += 1) {
    const a = base[i];
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && protSet.has(a.slice(0, eq))) continue;
    if (protSet.has(a)) {
      i += 1; // 跳过它后面那个值
      continue;
    }
    baseFree.push(a);
  }
  const sameAsBase = kept.length === baseFree.length
    && kept.every((a, i) => a === baseFree[i])
    && (!parsed.exe || parsed.exe === exe);

  for (const [k, v] of protectedPairs) kept.push(k, v);

  return {
    args: sameAsBase ? base : kept,
    exe: parsed.exe || exe,
    applied: !sameAsBase,
    protectedKeys: protectedPairs.map(([k]) => k),
  };
}

/** 取某引擎的分类表（副本） */
function paramGroups(engine) {
  const g = PARAM_GROUPS[engine === 'ninfer' ? 'ninfer' : 'llamacpp'];
  return g.map((x) => ({ ...x, fields: [...x.fields] }));
}

/**
 * 取某个引擎的启动选项默认值（副本，调用方随便改）。
 *
 * @param {string} engine 'llamacpp' | 'ninfer'
 * @returns {object}
 */
function paramDefaults(engine) {
  const d = PARAM_DEFAULTS[engine === 'ninfer' ? 'ninfer' : 'llamacpp'];
  return { ...d };
}

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
  );

  // 可选开关：只有界面里选中的才拼进命令行。
  // 缺省视为开启（老配置没有这些字段时行为与从前一致）。
  if (model.ctxShift !== false) args.push('--context-shift');
  if (model.flashAttn !== false) args.push('-fa', 'on');
  if (model.jinja !== false) args.push('--jinja');

  // 对话模板：只在用户填了外部模板文件时才加（否则用模型内置模板）
  const tplFile = String(model.chatTemplateFile || '').trim();
  if (tplFile) args.push('--chat-template-file', tplFile);
  const rf = String(model.reasoningFormat || '').trim();
  if (rf && rf !== 'auto') args.push('--reasoning-format', rf);

  // 线程数：-1（自动）时不写，交给 llama.cpp 自己决定
  const threads = intOr(model.threads, -1);
  if (threads > 0) args.push('-t', String(threads));
  const threadsBatch = intOr(model.threadsBatch, -1);
  if (threadsBatch > 0) args.push('-tb', String(threadsBatch));

  args.push(
    '-np', String(intOr(model.parallel, 1)),
    '-ub', String(intOr(model.ubatch, 512)),
    '-b', String(intOr(model.batch, 2048)),
  );

  // KV 缓存精度
  const ctk = cacheTypeOf(model.cacheTypeK, 'q8_0');
  const ctv = cacheTypeOf(model.cacheTypeV, 'q8_0');
  args.push('-ctk', ctk, '-ctv', ctv);

  // 采样参数
  args.push(
    '--temp', numOr(model.temperature, '0.6'),
    '--top-p', numOr(model.topP, '0.95'),
    '--top-k', String(intOr(model.topK, 20)),
    '--min-p', numOr(model.minP, '0.0'),
    '--presence-penalty', numOr(model.presencePenalty, '0.0'),
    '--repeat-penalty', numOr(model.repeatPenalty, '1.0'),
  );

  // 显存与卸载
  const gl = intOr(model.gpuLayers, -1);
  if (gl >= 0) args.push('-ngl', String(gl));
  if (model.kvOffload === false) args.push('--no-kv-offload');
  const sm = String(model.splitMode || '').trim();
  if (sm && sm !== 'layer') args.push('-sm', sm);

  // 权重加载方式：mlock 常驻物理内存，none 表示不锁定
  const loadMode = ['mlock', 'mmap', 'none'].includes(model.loadMode)
    ? model.loadMode
    : 'mlock';
  if (loadMode !== 'none') args.push('--load-mode', loadMode);

  // --fit on 让 llama.cpp 按显存自动下调未设置的参数；关掉就完全按手填的值来
  if (model.fits === false) args.push('--fit', 'off');

  // MTP 投机解码（仅 35B 模型）
  if (model.useMtp) {
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2');
  }

  if (model.noOpOffload) args.push('--no-op-offload');
  if (model.metrics) args.push('--metrics');
  if (model.noWebui) args.push('--no-webui');
  const timeout = intOr(model.timeout, 0);
  if (timeout > 0) args.push('-to', String(timeout));

  // KVMem：kvmem-llama.cpp 的开关。
  // 标准 llama-server 不认这个参数，所以只在用户明确打开时才写进命令行 ——
  // 这样没装 kvmem 的人一切照旧，装了的人开一下就能用。
  if (model.kvmem) args.push('--kvmem');

  // 用户补充参数：排在 --host/--port 之前，保证端口不被用户覆盖坏
  args.push(...splitExtraArgs(model.extraArgs));

  args.push('--host', '127.0.0.1', '--port', String(model.port));

  return args;
}

/** 取整（带下限保护）：非法值回落默认 */
function intOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : d;
}

/**
 * 采样用的数字字段。
 *
 * 默认值按字符串写（0.0 / 1.0），这里原样返回默认值的字面写法，
 * 免得数字 0 被 String() 丢成 "0"、命令预览跟老版本对不上。
 * 0 和 0.0 对 llama.cpp 完全等价，这里只为「和以前一模一样」。
 */
function numOr(v, d) {
  if (v === undefined || v === null || v === '') return String(d);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(d);
  if (n === Number(d)) return String(d);
  return String(v).trim();
}

/** KV 缓存类型白名单 */
function cacheTypeOf(v, d) {
  const t = String(v || '').trim();
  const ok = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'];
  return ok.includes(t) ? t : d;
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
  PARAM_DEFAULTS,
  PARAM_GROUPS,
  paramDefaults,
  paramGroups,
  parseCommandLine,
  applyCmdOverride,
  buildArgs,
  splitExtraArgs,
  resolveModels,
  detectLlamaDir,
};
