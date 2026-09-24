'use strict';
/**
 * 端到端验证「运行中改上下文」这条路径。
 *
 * 复刻 main.js 里 models-update 的守卫逻辑，确认：
 *   1. 模型运行中改 ctxK 不被拦截（这是原来"被锁住"的地方）
 *   2. 改完立即落盘
 *   3. 下一次启动时新上下文真的进了命令
 *
 * 用临时目录，不碰用户配置。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlock-'));
const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'src/store'));
const models = require(path.join(ROOT, 'src/models'));
const ninfer = require(path.join(ROOT, 'src/ninfer'));

store.init(tmp);

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fail++; console.log('  ❌ ' + l); } };

// 造一个 NInfer 模型（和真实那台一致）；端口用空闲的，避开预置模型
const made = store.create({
  id: 'nf1', name: 'Qwen3.8-27B (NInfer)', alias: 'qwen3.8-27b',
  file: '/root/models/qwen3_8_27b.ninfer', engine: 'ninfer', port: 8095, ctxK: 96,
  ninfer: { maxContext: 98304, kvDtype: 'q4', prefillChunk: 896, draftTokens: 3,
            thinkingBudget: 2048, vision: true, visionMaxTokens: 2048,
            embeddingHost: true, spec: 'mtp', noCudaGraph: true, extraArgs: '' },
});
if (!made.ok) {
  console.error('准备测试数据失败：' + made.error);
  process.exit(1);
}

// 复刻 main.js 的 models-update 守卫
const normMmproj = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
function modelsUpdate(id, patch, running) {
  const cur = store.find(id);
  if (!cur) return { ok: false, error: '模型不存在' };
  if (running) {
    const next = { ...cur, ...(patch || {}) };
    const blocked = ['file', 'mmproj', 'port'].filter((k) => {
      if (k === 'port') return Number(next.port) !== Number(cur.port);
      if (k === 'mmproj') return normMmproj(next.mmproj) !== normMmproj(cur.mmproj);
      return String(next.file ?? '') !== String(cur.file ?? '');
    });
    if (blocked.length) return { ok: false, error: '模型正在运行，请先停止再修改文件与端口' };
    if (patch && patch.engine && patch.engine !== cur.engine) {
      return { ok: false, error: '模型正在运行，请先停止再切换推理引擎' };
    }
  }
  return store.update(id, patch || {});
}

console.log('【1】运行中改上下文（原先被锁的场景）');
const r1 = modelsUpdate('nf1', {
  ctxK: 48,
  ninfer: { ...store.find('nf1').ninfer, prefillChunk: 896, extraArgs: '' },
}, true /* running */);
ok(r1.ok, '运行中改 ctxK 成功（未被守卫拦截）' + (r1.ok ? '' : '：' + r1.error));
ok(store.find('nf1').ctxK === 48, 'store 里 ctxK 已是 48（实际 ' + store.find('nf1').ctxK + '）');

console.log('\n【2】立即落盘');
const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'models.json'), 'utf8'));
const onDisk = disk.models.find((m) => m.id === 'nf1');
ok(onDisk.ctxK === 48, 'models.json 里已是 48（实际 ' + onDisk.ctxK + '）');

console.log('\n【3】重启进程后仍是新值');
store.init(tmp);
ok(store.find('nf1').ctxK === 48, '重载后 ctxK 仍为 48（实际 ' + store.find('nf1').ctxK + '）');

console.log('\n【4】新上下文进了启动命令');
const resolved = models.resolveModels('C:\\m', [store.find('nf1')])[0];
const args = ninfer.buildArgs(resolved, resolved.ctxK);
const mc = args[args.indexOf('--max-context') + 1];
const kc = args[args.indexOf('--kv-capacity') + 1];
ok(mc === '49152', '--max-context = 49152（实际 ' + mc + '）');
ok(kc === '49152', '--kv-capacity = 49152（实际 ' + kc + '）');

console.log('\n【5】运行中改其他参数也不被拦');
const r2 = modelsUpdate('nf1', { extraArgs: '--seed 7' }, true);
ok(r2.ok, '运行中改补充参数成功');
const r3 = modelsUpdate('nf1', { port: 8099 }, true);
ok(!r3.ok, '运行中改端口仍被正确拦截（预期行为）');
const r4 = modelsUpdate('nf1', { port: 8095 }, true);
ok(r4.ok, '运行中提交未变的端口不被误拦（值比较而非键存在）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
