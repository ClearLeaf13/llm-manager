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
const xj = rd('src/models.js');
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
chk(/id="pane-log"/.test(hj), '第三页日志页存在');
chk(/data-view="log"/.test(hj), '侧栏有「日志」入口（设置按钮上方）');
chk(!/id="st-engine"/.test(hj) && !/id="st-engine-sub"/.test(hj),
    '独立的「推理引擎」卡已合并进当前模型卡');
chk(/id="st-engine-pill"/.test(hj), '当前模型名前有引擎标签');
chk(/id="st-vram-arc"/.test(hj) && /id="st-mem-arc"/.test(hj)
    && /id="st-disk-arc"/.test(hj), '显存/内存/磁盘改为 SVG 圆环');
chk(!/st-vram-bar|st-mem-bar|st-disk-bar/.test(hj), '旧的条形进度条已移除');
chk(/id="pgroup-kvmem"/.test(hj), 'KVMem 卡片（原日志位置，启动命令下方）');
chk(/id="p-kvmem"/.test(hj), 'KVMem 开启/关闭开关');
chk(/href="https:\/\/github\.com\/kvmem\/kvmem-llama\.cpp"/.test(hj),
    'KVMem 卡片底部有项目地址链接');
chk(/class="kvmem-link"/.test(hj), '项目地址链接用居中样式');
chk(!/id="p-ninfer-group"/.test(hj), '旧的平级 NInfer 分组已并入启动命令子菜单');
chk(/id="popt-mem"/.test(hj), '显存与卸载是启动命令下的折叠子菜单');
chk(/id="popt-ctx"/.test(hj) && /id="popt-adv"/.test(hj), '上下文 / 高级选项子菜单');
chk(/id="popt-perf"/.test(hj) && /id="popt-tpl"/.test(hj) && /id="popt-sample"/.test(hj),
    '性能与批处理 / 对话模板 / 采样 子菜单');
chk(!/id="popt-extra"/.test(hj) && !/id="p-extraargs"/.test(hj),
    '「补充参数」整栏已删除（并入可编辑的启动命令）');
chk(/<textarea[^>]*id="p-cmd"/.test(hj), '启动命令框是可编辑的 textarea');
chk(/id="p-cmd-regen"/.test(hj) && /id="p-cmd-flag"/.test(hj),
    '命令框带「重新生成」与「已自定义」标记');
chk(/id="p-restore"/.test(hj), '存在「恢复默认参数」按钮');
chk(/id="p-jinja"/.test(hj) && /id="p-loadmode"/.test(hj), '存在可改的启动开关');
chk(/id="p-ngl"/.test(hj) && /id="p-temp"/.test(hj) && /id="p-topk"/.test(hj)
    && /id="p-ctk"/.test(hj) && /id="p-splitmode"/.test(hj),
    '补全的选项控件（GPU 层数 / 采样 / KV 类型 / 切分模式）');
chk(/id="set-nf-distro"/.test(hj), '设置里有 NInfer 发行版');
chk(/id="f-engine"/.test(hj), '弹窗有引擎选择');
chk(/本地 ?LLM ?聚合管理/.test(hj), '应用名已改');
{
  const gear = hj.match(/id="rail-settings"[\s\S]*?<\/svg>/);
  chk(!!gear && /<circle/.test(gear[0]) && !/M10 2\.6v2\.1/.test(gear[0]),
      '设置是齿轮图标（非放射线）');
}

console.log('--- renderer/renderer.js ---');
chk(!/function renderEngineCard/.test(rj), '独立引擎卡的渲染已删除（并入当前模型卡）');
chk(/st-engine-pill/.test(rj), 'renderer 写模型名前的引擎标签');
chk(/function engineInUse/.test(rj), 'engineInUse（按实际在跑的进程判断引擎）');
chk(/function engineLabel/.test(rj), 'engineLabel（引擎显示名）');
chk(/st-pid-engine/.test(rj), 'PID 行也按引擎切显示名');
chk(/function setRing/.test(rj) && /RING_CIRC/.test(rj), '圆环进度：setRing + 周长常量');
chk(!/function setBar/.test(rj), '旧的条形进度条渲染函数已删除');
chk(/setAttribute\('class'/.test(rj), 'SVG 圆环用 setAttribute 改 class（SVG className 只读）');
chk(/pane-log/.test(rj) && /scrollLogToEnd/.test(rj), '日志页切换与自动滚动');
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
chk(/function hasVision/.test(rj), 'hasVision 按引擎判定视觉能力');
chk(/ninferVisionOf/.test(mj), 'main.js 按 ninfer.vision 报视觉状态');
chk(!/vision: false, engine: 'ninfer'/.test(mj), '不再把 NInfer 的 vision 写死为 false');
chk(/out\.vision = out\.ninfer\.vision/.test(sj), 'store 强制同步两处 vision 字段');
chk(/ninfer-serve PID/.test(rj), 'PID 行按引擎显示进程名');
chk(/function restoreDefaults/.test(rj), 'restoreDefaults（恢复默认参数）');
chk(/function updateOptSummaries/.test(rj), 'updateOptSummaries（折叠子菜单摘要）');
chk(/function previewOptsOf/.test(rj), 'previewOptsOf（未保存改动也进命令预览）');
chk(/PARAM_DEFAULTS/.test(xj), 'models.js 有启动选项默认值表');
chk(/function paramDefaults/.test(xj), 'paramDefaults 按引擎给默认值');
chk(/model-defaults/.test(mj) && /'model-defaults'/.test(mj), 'IPC model-defaults 在 main.js 里注册并处理');
chk(/'jinja', 'flashAttn', 'ctxShift', 'loadMode'/.test(sj), 'store 白名单含新启动开关');
chk(/kvmem/.test(sj), 'store 白名单含 kvmem');
chk(/kvmem: false/.test(xj), 'PARAM_DEFAULTS 里 kvmem 默认关');
chk(/'--kvmem'/.test(xj), 'models.js 会按开关追加 --kvmem');
chk(/name: 'KVMem'/.test(xj), 'PARAM_GROUPS 里有 KVMem 分类');

console.log('--- 启动命令可自行修改 ---');
chk(/function parseCommandLine/.test(xj), 'parseCommandLine 解析用户手写的命令');
chk(/function applyCmdOverride/.test(xj), 'applyCmdOverride 合并基准命令与手改命令');
chk(/'cmdOverride'/.test(sj), 'store 白名单含 cmdOverride（手改命令会落盘）');
chk(/cmdOverride/.test(mj), 'main.js 启动时应用手改命令');
chk(/applyCmdOverride/.test(mj), '启动路径真的调用了 applyCmdOverride');
chk(/cmdOverride/.test(rj), 'renderer 读写命令框内容');
chk(/savedCmdOverride/.test(rj), 'renderer 区分「自定义命令」与「基准命令」');
chk(/id="p-cmd"/.test(hj) && /'p-cmd'/.test(rj), '命令框与渲染逻辑对得上');
chk(/'p-cmd-regen'/.test(rj), '「重新生成」按钮已接线');
chk(!/'p-extraargs'/.test(rj), 'renderer 不再引用已删除的补充参数输入框');
chk(!/popt-llama/.test(rj) && !/popt-llama/.test(hj), '旧的 popt-llama 已全部改名');
{
  // 受保护项：模型文件/端口这些必须仍由管理器接管，否则界面显示的端口和
  // 实际监听的端口会对不上，状态探测全废。
  const ov = xj.match(/function applyCmdOverride[\s\S]*?\n\}/);
  chk(!!ov && /'-m'/.test(ov[0]) && /'--host'/.test(ov[0]) && /'--port'/.test(ov[0]),
      '受保护项含 -m / --host / --port');
}
{
  const sv = rj.match(/function switchView[\s\S]{0,1400}?\n\}/);
  chk(!!sv && /'log'/.test(sv[0]), 'switchView 支持第三页 log');
  chk(!!sv && /pane-log/.test(sv[0]), 'switchView 会切到日志页');
}

fs.rmSync(OUT, { recursive: true, force: true });

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
