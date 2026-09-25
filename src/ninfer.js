'use strict';

/**
 * NInfer 推理引擎支持。
 *
 * NInfer 是跑在 WSL 里的独立推理引擎，和 llama.cpp 完全不同：
 *   - 二进制是 Linux ELF，必须经 wsl.exe 调用
 *   - 模型是 .ninfer 单文件（含自身 JSON 头），不是 gguf
 *   - 参数体系不同：--max-context / --kv-capacity / --kv-dtype / --prefill-chunk …
 *
 * 本模块只负责「探测 + 组命令 + 读元数据」，不做进程管理
 * （进程启停统一在 main.js，因为要复用日志与状态广播）。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 默认设置；用户可在「设置 → NInfer」里覆盖 */
const NINFER_DEFAULTS = {
  distro: 'Ubuntu-24.04',                                  // WSL 发行版
  servePath: '/root/ninfer-5080/build/apps/ninfer-serve',   // 服务端二进制
  cliPath: '/root/ninfer-5080/build/apps/ninfer',           // 单次问答二进制
  modelsDir: '/root/models',                               // WSL 内模型目录
  port: 8080,
};

/** WSL 内常见的模型目录候选（自动扫描用） */
const WSL_MODEL_DIRS = [
  '/root/models',
  '/root/ninfer-models',
  '/models',
  '/opt/models',
  '/home/models',
];

/* ------------------------------------------------------------------ *
 * WSL 调用
 * ------------------------------------------------------------------ */

/**
 * 跑一条 wsl 命令，返回 { ok, stdout, stderr, code }。
 *
 * 全程不抛异常 —— WSL 不可用是常见情况（没装、发行版没起来），
 * 调用方一律按「拿不到数据」降级处理。
 *
 * @param {string[]} args 传给 wsl.exe 的参数
 * @param {object} [opts] timeout 毫秒
 */
function runWsl(args, opts = {}) {
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 15000;
  return new Promise((resolve) => {
    execFile('wsl.exe', args, {
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: err.code,
          error: err.message || String(err),
        });
        return;
      }
      resolve({
        ok: true,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: 0,
      });
    });
  });
}

/**
 * 在指定发行版里执行 bash 脚本。
 *
 * 关键点：脚本必须以**单个参数**原样传给 bash -lc，
 * 中间的 `$1`、`$(...)`、`$((...))` 绝不能被 PowerShell/cmd 提前展开。
 * 之前用 `wsl -- bash -lc "..."` 传参时，外层 shell 会先吃掉这些变量，
 * 导致 awk '{print $1}' 变成 awk '{print }'、$((n+1)) 变成空 —— 
 * kill 循环静默失败却仍报 ok。
 *
 * 走 stdin（bash -s）可以彻底绕开这层引号地狱。
 *
 * @param {string} distro
 * @param {string} script bash 脚本正文
 */
function runBash(distro, script, opts = {}) {
  return runWslStdin(['-d', distro, '-u', 'root', '--', 'bash', '-s'], script, opts);
}

/**
 * 跑一条 wsl 命令并把 script 从 stdin 灌进去。
 * execFile 的 input 选项不经过任何 shell，变量原样抵达 bash。
 */
function runWslStdin(args, input, opts = {}) {
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 15000;
  return new Promise((resolve) => {
    const cp = execFile('wsl.exe', args, {
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: err.code,
          error: err.message || String(err),
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0 });
    });
    if (cp.stdin) {
      cp.stdin.on('error', () => { /* 进程早退时忽略 EPIPE */ });
      cp.stdin.end(String(input));
    }
  });
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 列出所有 WSL 发行版名。
 *
 * `wsl -l -v` 输出是 UTF-16LE（Windows 侧），execFile 按 utf8 读会得到
 * 带 \0 的乱码，所以这里统一把 \0 去掉再解析。
 */
async function listDistros() {
  const r = await runWsl(['-l', '-v'], { timeout: 8000 });
  if (!r.ok && !r.stdout) return [];

  // utf16le 被当 utf8 读后，每个 ASCII 字符后面会多一个 \0
  const text = String(r.stdout || '').replace(/\0/g, '');
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(Running|Stopped|Installed|Installing)\b/i);
    if (m) out.push({ name: m[1], state: m[2].toLowerCase() });
  }
  return out;
}

/**
 * 探测某个发行版里的 NInfer 运行时。
 * @param {string} distro
 * @param {{servePath:string, cliPath:string, modelsDir:string}} cfg
 */
async function probeRuntime(distro, cfg) {
  const serve = cfg.servePath;
  const cli = cfg.cliPath;

  const script = [
    `[ -x ${JSON.stringify(serve)} ] && echo "serve:1" || echo "serve:0"`,
    `[ -x ${JSON.stringify(cli)} ] && echo "cli:1" || echo "cli:0"`,
    `[ -d ${JSON.stringify(cfg.modelsDir)} ] && echo "dir:1" || echo "dir:0"`,
    // 顺带取版本/构建时间，界面上能看出用的是哪个构建
    `${JSON.stringify(serve)} --version 2>/dev/null | head -1 || true`,
  ].join('; ');

  const r = await runBash(distro, script, { timeout: 12000 });
  if (!r.ok) return { ok: false, error: r.error || '无法访问 WSL' };

  const text = r.stdout;
  const flag = (k) => new RegExp(`^${k}:1$`, 'm').test(text);

  return {
    ok: true,
    distro,
    servePath: serve,
    hasServe: flag('serve'),
    hasCli: flag('cli'),
    hasModelsDir: flag('dir'),
    modelsDir: cfg.modelsDir,
  };
}

/* ------------------------------------------------------------------ *
 * 模型扫描
 * ------------------------------------------------------------------ */

/**
 * 扫描 WSL 里的 .ninfer 模型文件。
 *
 * 走 `find` 而不是逐层 ls，一次调用拿全（含大小与 mtime），
 * 避免每个候选目录一次 wsl 往返 —— WSL 冷启动一次要 1-3 秒。
 *
 * @param {string} distro
 * @param {string[]} dirs 要扫的目录（不存在会被 find 跳过）
 */
async function scanWsl(distro, dirs) {
  const list = (Array.isArray(dirs) && dirs.length ? dirs : WSL_MODEL_DIRS);
  // 只对存在的目录 find，且限制深度避免扫爆整个文件系统
  const parts = list
    .map((d) => `[ -d ${JSON.stringify(d)} ] && find ${JSON.stringify(d)} -maxdepth 3 -type f -name '*.ninfer' -printf '%p\\t%s\\t%T@\\n' 2>/dev/null`)
    .join('; ');

  const r = await runBash(distro, parts, { timeout: 20000 });
  if (!r.ok && !r.stdout) {
    return { ok: false, error: r.error || '扫描失败', files: [] };
  }

  const files = [];
  const seen = new Set();
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [p, sizeStr, mtimeStr] = t.split('\t');
    if (!p || seen.has(p)) continue;
    seen.add(p);

    const size = Number(sizeStr);
    const mtime = Number(mtimeStr);
    files.push({
      // WSL 内路径原样保留 —— 启动时直接交给 linux 侧二进制
      path: p,
      file: path.posix.basename(p),
      dir: path.posix.dirname(p),
      sizeGb: Number.isFinite(size) ? size / 1024 ** 3 : 0,
      mtimeMs: Number.isFinite(mtime) ? mtime * 1000 : null,
    });
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: true, files, dirs: list };
}

/** Windows 侧扫描 .ninfer（有些人会把模型放本地盘） */
function scanLocal(dir) {
  if (!dir) return { ok: false, error: '未指定目录', files: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `无法读取目录：${e.message}`, files: [] };
  }

  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.ninfer$/i.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    let size = 0;
    let mtimeMs = null;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (_) { continue; }
    files.push({
      path: full,
      file: ent.name,
      dir,
      sizeGb: size / 1024 ** 3,
      mtimeMs,
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: true, files, dir };
}

/* ------------------------------------------------------------------ *
 * .ninfer 元数据
 * ------------------------------------------------------------------ */

/**
 * 读 .ninfer 头部元数据。
 *
 * 头部布局（对真实文件逐字节核对过）：
 *   偏移 0    6 字节   magic 'NINFER'
 *   偏移 6    2 字节   LE uint16 版本号（实测 0x0200）
 *   偏移 8    4 字节   LE uint32 JSON 段长度
 *   偏移 12   4 字节   保留 / 对齐填充
 *   偏移 16   变长     UTF-8 JSON：{ identity:{model_id,weights_id}, objects:[…] }
 *
 * JSON 段实测约 185 KB（1190 个 objects 条目），所以不能只读 4 KB；
 * 这里按头部里声明的长度精确读取，读不到再退回括号配平。
 *
 * @param {string} file 绝对路径（Windows 侧）
 * @returns {object|null}
 */
function readNinferMeta(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const fileSize = fs.statSync(file).size;

    const pre = Buffer.alloc(16);
    if (fs.readSync(fd, pre, 0, 16, 0) < 16) return null;
    if (pre.toString('latin1', 0, 6) !== 'NINFER') return null;

    const version = pre.readUInt16LE(6);
    const jsonLen = pre.readUInt32LE(8);
    const jsonStart = 16;

    // 长度不合理就不信它，退回「最多读 1 MB 后配平括号」
    const sane = jsonLen > 2 && jsonLen < 8 * 1024 * 1024 && jsonStart + jsonLen <= fileSize;
    const readLen = Math.min(sane ? jsonLen : 1024 * 1024, fileSize - jsonStart);
    if (readLen <= 0) return null;

    const buf = Buffer.alloc(readLen);
    const got = fs.readSync(fd, buf, 0, readLen, jsonStart);
    const body = buf.subarray(0, got);

    let jsonText = null;
    if (sane) {
      jsonText = body.toString('utf8');
    } else {
      // 兜底：从 0 起找第一个配平的 { ... }（考虑字符串与转义）
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let i = 0; i < body.length; i += 1) {
        const c = body[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === 0x5c) esc = true;
          else if (c === 0x22) inStr = false;
          continue;
        }
        if (c === 0x22) { inStr = true; continue; }
        if (c === 0x7b) depth += 1;
        else if (c === 0x7d) {
          depth -= 1;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      if (end < 0) return null;
      jsonText = body.toString('utf8', 0, end);
    }

    const json = JSON.parse(jsonText);
    const identity = json.identity || {};
    const objects = Array.isArray(json.objects) ? json.objects : [];

    // 权重分片体积：objects 里 kind 为权重类的条目字节数合计
    let weightsBytes = 0;
    let resourceBytes = 0;
    for (const o of objects) {
      if (!o) continue;
      const b = Number(o.bytes) || 0;
      if (o.kind === 'weights' || o.kind === 'tensor' || o.kind === 'shard') weightsBytes += b;
      else resourceBytes += b;
    }

    return {
      version,
      headerJsonBytes: jsonLen,
      modelId: identity.model_id || null,
      weightsId: identity.weights_id || null,
      objectCount: objects.length,
      weightsGb: weightsBytes ? weightsBytes / 1024 ** 3 : null,
      resourceGb: resourceBytes ? resourceBytes / 1024 ** 3 : null,
    };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/* ------------------------------------------------------------------ *
 * 启动参数
 * ------------------------------------------------------------------ */

/** NInfer 模型上可调的参数（存进 store 的 ninfer 字段） */
const NINFER_PARAM_DEFAULTS = {
  maxContext: 32768,      // --max-context / --kv-capacity
  kvDtype: 'q4',          // --kv-dtype bf16|int8|q4
  prefillChunk: 512,      // --prefill-chunk
  draftTokens: 3,         // --spec mtp --draft-tokens N
  thinkingBudget: 2048,   // --default-thinking-budget
  vision: true,           // --vision
  visionMaxTokens: 2048,  // --vision-max-tokens
  embeddingHost: true,    // --embedding-host
  spec: 'mtp',            // --spec mtp|dflash|dflash2|（空=关）
  noCudaGraph: true,      // --no-cuda-graph
  extraArgs: '',
};

/**
 * 把模型配置组装成 ninfer-serve 的参数数组。
 *
 * @param {object} model 带 ninfer 参数字段与 filePath 的模型
 * @param {number} [ctxK] 界面传入的上下文，单位是 K（会 ×1024 换成 token）
 * @returns {string[]}
 */
function buildArgs(model, ctxK) {
  const p = { ...NINFER_PARAM_DEFAULTS, ...(model.ninfer || {}) };
  const n = (v, d) => (Number(v) > 0 ? Math.round(Number(v)) : d);

  // 模型路径：resolveModels 给的是 filePath；未解析时退回 file
  const modelPath = model.filePath || model.file;

  // 上下文统一按 token 处理：
  //   界面上填的是 K（如 96），要 ×1024；
  //   ninfer.maxContext 存的已经是 token（如 98304），直接用。
  const ctxTokens = Number(ctxK) > 0
    ? Math.round(Number(ctxK) * 1024)
    : n(p.maxContext, NINFER_PARAM_DEFAULTS.maxContext);

  const kv = ['bf16', 'int8', 'q4'].includes(p.kvDtype) ? p.kvDtype : 'q4';
  const prefill = n(p.prefillChunk, 512);

  const args = [
    modelPath,
    '--host', '0.0.0.0',
    '--port', String(Number(model.port) || NINFER_DEFAULTS.port),
    '--model-id', model.alias || 'ninfer',
    '--max-context', String(ctxTokens),
    '--kv-capacity', String(ctxTokens),
    '--prefill-chunk', String(prefill),
    '--kv-dtype', kv,
    '--max-concurrency', '1',
    '--default-thinking-budget', String(n(p.thinkingBudget, 2048)),
  ];

  // 投机解码
  if (p.spec && ['mtp', 'dflash', 'dflash2'].includes(p.spec)) {
    args.push('--spec', p.spec, '--draft-tokens', String(n(p.draftTokens, 3)));
  }

  if (p.vision) {
    args.push('--vision', '--vision-max-tokens', String(n(p.visionMaxTokens, 2048)));
  }
  if (p.embeddingHost) args.push('--embedding-host');
  if (p.noCudaGraph) args.push('--no-cuda-graph');

  // 补充参数排在最后（端口等关键项已在前，不会被覆盖）
  args.push(...splitExtraArgs(p.extraArgs));
  return args;
}

/** 与 llama.cpp 侧同款的引号感知拆分 */
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

/**
 * 组装「可读的」完整命令 —— 给界面预览用。
 * 界面展示的是用户在 Windows 终端里能直接粘的那条 wsl 命令。
 *
 * servePathOverride：用户手改过命令时，可执行文件可能被换了，用他给的那个。
 */
function formatCommand(cfg, model, args, servePathOverride) {
  const quote = (s) => {
    const v = String(s);
    return /[\s"]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v;
  };
  const bin = servePathOverride || cfg.servePath;
  const inner = [bin, ...args].map(quote).join(' ');
  return `wsl -d ${cfg.distro} -u root -- ${inner}`;
}

/** 启动模式：服务 / 单次问答 */
const NINFER_MODES = ['serve', 'cli'];

/**
 * NInfer 侧「不许在命令里改」的参数。
 *
 * 模型路径（第一个位置参数）没法按名字识别，由 applyCmdOverride 之外的
 * 校验兜住；这里列的是按名字能认出来的关键项：端口决定界面怎么探测状态、
 * 开 WebUI，model-id 是界面显示的名字。
 */
const NINFER_PROTECTED = ['--port', '--model-id', '--host'];

module.exports = {
  NINFER_DEFAULTS,
  NINFER_PARAM_DEFAULTS,
  NINFER_PROTECTED,
  WSL_MODEL_DIRS,
  NINFER_MODES,
  runWsl,
  runWslStdin,
  runBash,
  listDistros,
  probeRuntime,
  scanWsl,
  scanLocal,
  readNinferMeta,
  buildArgs,
  splitExtraArgs,
  formatCommand,
};
