'use strict';

/**
 * 本地控制 API。
 *
 * 供外部程序（如 DSH 插件）以编程方式查询状态、启动/停止模型，
 * 免去用户在管理器界面手动点击。
 *
 * 安全边界：
 *   1. 只绑定 127.0.0.1 —— 不对局域网或外网暴露
 *   2. 每个进程启动时生成一次性随机 token，写入 api-token.txt
 *   3. 所有请求需带 Authorization: Bearer <token>
 *   4. 端口从 8765 起顺延，避免与其它程序冲突
 *
 * 不改变管理器现有行为：API 起不来时静默降级，不影响 GUI 使用。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_PORT = 8765;
const MAX_PORT_TRIES = 20;
const HOST = '127.0.0.1';
const TOKEN_FILE = 'api-token.txt';
const PORT_FILE = 'api-port.txt';

let server = null;
let token = null;
let actualPort = null;
let storeDir = null;

/** 读取请求体（带体积上限，防止恶意超大请求） */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 明确禁止被网页脚本跨源读取
    'Access-Control-Allow-Origin': 'null',
  });
  res.end(body);
}

/** 校验 Authorization 头 */
function authorized(req) {
  const raw = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(token);
  // 长度不同时 timingSafeEqual 会抛错，先挡掉
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/**
 * 建立 API 服务。
 * @param {object} deps 依赖注入，便于测试
 * @param {string} deps.userDataDir 令牌与端口的落盘目录
 * @param {() => Array} deps.listModels 返回模型数组（含 port）
 * @param {() => object} deps.getStatus 返回 probeStatus() 的结果
 * @param {(id:string, ctxK?:number) => Promise<object>} deps.start
 * @param {() => Promise<object>} deps.stop
 * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
 */
function start(deps) {
  return new Promise((resolve) => {
    try {
      storeDir = deps.userDataDir;
      token = crypto.randomBytes(32).toString('hex');

      server = http.createServer(async (req, res) => {
        // 只接受本机回环来源
        const remote = req.socket.remoteAddress || '';
        if (!/^127\.|^::1$|^::ffff:127\./.test(remote)) {
          return json(res, 403, { ok: false, error: '仅允许本机访问' });
        }

        if (!authorized(req)) {
          return json(res, 401, { ok: false, error: '令牌无效' });
        }

        const url = new URL(req.url, `http://${HOST}`);
        const route = `${req.method} ${url.pathname}`;

        try {
          if (route === 'GET /status') {
            const status = await deps.getStatus();
            const models = deps.listModels().map((m) => {
              // 引擎判定：NInfer 跑在 WSL 里，端口在 Windows 侧未必可见，
              // 所以以「是否正是当前运行的模型」+ NInfer 进程为准。
              const isCurrent = status.current === m.id;
              const ninferUp = !!(status.ninferPids && status.ninferPids.length);
              const running = (m.engine === 'ninfer')
                ? (isCurrent && (ninferUp || !!status.ports[m.port]))
                : !!status.ports[m.port];
              return {
                id: m.id,
                name: m.name,
                alias: m.alias,
                port: m.port,
                engine: m.engine || 'llamacpp',
                running,
              };
            });
            const anyRunning = models.some((m) => m.running) || !!status.anyRunning;
            return json(res, 200, {
              ok: true,
              models,
              anyRunning,
              current: status.current,
              engine: status.engine || null,
              starting: !!status.starting,
            });
          }

          if (route === 'POST /start') {
            const body = (await readBody(req)) || {};
            if (!body.id) return json(res, 400, { ok: false, error: '缺少 id' });
            const result = await deps.start(body.id, body.ctxK);
            return json(res, result && result.ok ? 200 : 500, result || { ok: false });
          }

          if (route === 'POST /stop') {
            const result = await deps.stop();
            return json(res, result && result.ok ? 200 : 500, result || { ok: false });
          }

          if (route === 'GET /health') {
            return json(res, 200, { ok: true, app: 'llm-manager', version: 2 });
          }

          return json(res, 404, { ok: false, error: '未知端点' });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message || String(e) });
        }
      });

      // 端口顺延：8765 被占就试 8766、8767……
      let attempt = 0;
      const tryListen = (port) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES) {
            attempt += 1;
            tryListen(BASE_PORT + attempt);
            return;
          }
          // 其它错误：放弃，不影响管理器主体
          try { server.close(); } catch (_) {}
          server = null;
          resolve({ ok: false, error: err.message });
        });

        server.listen(port, HOST, () => {
          actualPort = port;
          // 落盘端口与令牌，供外部程序发现
          try {
            fs.mkdirSync(storeDir, { recursive: true });
            fs.writeFileSync(path.join(storeDir, TOKEN_FILE), token, { encoding: 'utf8', mode: 0o600 });
            fs.writeFileSync(path.join(storeDir, PORT_FILE), String(port), 'utf8');
          } catch (_) { /* 写不了也不影响 API 本身 */ }
          resolve({ ok: true, port });
        });
      };

      tryListen(BASE_PORT);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function stop() {
  return new Promise((resolve) => {
    // 清理落盘的令牌，避免进程退出后凭据仍可用
    try {
      if (storeDir) {
        fs.unlinkSync(path.join(storeDir, TOKEN_FILE));
        fs.unlinkSync(path.join(storeDir, PORT_FILE));
      }
    } catch (_) { /* 文件不存在属正常 */ }

    if (!server) return resolve();
    server.close(() => { server = null; resolve(); });
  });
}

module.exports = { start, stop, TOKEN_FILE, PORT_FILE, BASE_PORT };
