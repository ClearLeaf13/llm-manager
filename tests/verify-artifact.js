'use strict';
/**
 * 打包产物校验：从 dist 里解出 app.asar，核对**产物内部**的代码，
 * 而不是源码树。源码改了但产物没重新构建时，这个脚本会失败。
 *
 *   运行：npm run dist && npm run test:artifact
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'dist/win-unpacked/resources/app.asar');
const OUT = path.join(ROOT, 'dist/_asar-check');

if (!fs.existsSync(ASAR)) {
  console.error('找不到 ' + ASAR + '\n请先运行 npm run dist');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules/@electron/asar/bin/asar.js'),
  'extract', ASAR, OUT,
], { stdio: 'inherit' });

const rd = (p) => fs.readFileSync(path.join(OUT, p), 'utf8');
const nj = rd('src/ninfer.js');
const mj = rd('src/main.js');
const hj = rd('src/renderer/index.html');
const rj = rd('src/renderer/renderer.js');
const sj = rd('src/store.js');
const aj = rd('src/api-server.js');
const pj = JSON.parse(rd('package.json'));

let pass = 0, fail = 0;
const chk = (c, l) => {
  if (c) { pass++; console.log('  ✅ ' + l); }
  else { fail++; console.log('  ❌ ' + l); }
};

console.log('--- package.json（产物内） ---');
// 版本号从源码 package.json 读，避免每次发版都要手改这个断言
const SRC_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
chk(pj.version === SRC_PKG.version,
    'version 与源码一致：' + SRC_PKG.version + '（产物 ' + pj.version + '）');
chk(pj.name === 'llm-manager',
    'name 仍是 llm-manager —— userData 路径不变，用户配置不丢');
chk(pj.main === 'src/main.js', 'main 入口正确');

console.log('--- src/ninfer.js ---');
chk(/bash', '-s'/.test(nj), 'runBash 走 bash -s（stdin），避免外层 shell 吃掉变量');
chk(/runWslStdin/.test(nj), 'runWslStdin 已导出');
chk(/\* 1024/.test(nj), 'ctxK → token 的 ×1024 换算');
chk(/filePath \|\| model\.file/.test(nj), '模型路径回退 filePath || file');
chk(/readNinferMeta/.test(nj), '.ninfer 头部解析');
chk(/max-context/.test(nj) && /kv-dtype/.test(nj), 'NInfer 独有参数已生成');

console.log('--- src/main.js ---');
chk(/function probeReady/.test(mj), 'probeReady（HTTP 就绪判据，非裸端口）');
chk(/startNinferModel/.test(mj), 'startNinferModel');
chk(/startLlamaModel/.test(mj), 'startLlamaModel');
chk(/APP_NAME/.test(mj), 'APP_NAME 常量（已改名）');
chk(/remaining=/.test(mj), 'kill 回报 remaining（停止后回读校验）');
chk(/ninfer-probe/.test(mj) && /ninfer-scan/.test(mj), 'NInfer IPC 端点');
chk(/wslToUnc/.test(mj), 'wslToUnc 路径换算');

console.log('--- src/store.js ---');
chk(/ENGINES/.test(sj), 'ENGINES 枚举');
chk(/sanitizeNinfer/.test(sj), 'sanitizeNinfer 参数归一');

console.log('--- src/api-server.js ---');
chk(/engine/.test(aj), 'API 暴露 engine 字段');
chk(/ninferPids/.test(aj), 'API 用 ninferPids 判断运行状态');

console.log('--- renderer/index.html ---');
chk(!/pane-log/.test(hj), '第三页 pane-log 已删除');
chk(!/data-view="log"/.test(hj), '侧栏没有「日志」入口');
chk(/id="st-engine"/.test(hj), '存在推理引擎卡');
chk(/id="p-ninfer-group"/.test(hj), '存在 NInfer 参数分组');
chk(/id="set-nf-distro"/.test(hj), '设置里有 NInfer 发行版');
chk(/id="f-engine"/.test(hj), '弹窗有引擎选择');
chk(/本地 ?LLM ?聚合管理/.test(hj), '应用名已改');
{
  const gear = hj.match(/id="rail-settings"[\s\S]*?<\/svg>/);
  chk(!!gear && /<circle/.test(gear[0]) && !/M10 2\.6v2\.1/.test(gear[0]),
      '设置是齿轮图标（非放射线）');
}

console.log('--- renderer/renderer.js ---');
chk(/function renderEngineCard/.test(rj), 'renderEngineCard');
chk(/function setSplitTarget/.test(rj), 'setSplitTarget（拖动条修复）');
chk(/function loadNinferStatus/.test(rj), 'loadNinferStatus');
chk(/function collectNinferFields/.test(rj), 'collectNinferFields');
chk(/id="p-ctx"/.test(hj) && /'p-ctx'/.test(rj), '上下文输入框在参数页');
chk(!/data-ctx/.test(rj), '首页卡片已移除上下文输入框');
chk(/badge nf/.test(rj) && /badge lc/.test(rj), '首页卡片带引擎标签');
chk(/function updateCtxNote/.test(rj), 'updateCtxNote（上下文换算提示）');
chk(!/saveCtx|ctxEditing/.test(rj), '旧的卡片上下文读写逻辑已删除');
chk(!/'启动参数'/.test(rj), '管理列表的「启动参数」按钮已删除');
chk(/function isAdded|const isAdded/.test(rj) && /function isBound|const isBound/.test(rj),
    '扫描结果按「已添加 / 已绑定」过滤');
chk(/已隐藏/.test(rj), '扫描标题注明隐藏数量');
chk(/selected/.test(rj) && /function select|const select/.test(rj),
    '管理列表行支持点击选中');
chk(/row\.addEventListener\('click', select\)/.test(rj), '整行点击切换参数面板');
{
  const sv = rj.match(/function switchView[\s\S]{0,900}?\n\}/);
  chk(!!sv && !/'log'/.test(sv[0]), 'switchView 不再有 log 分支');
}

fs.rmSync(OUT, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
