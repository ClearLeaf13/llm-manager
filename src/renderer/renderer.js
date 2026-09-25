'use strict';

const $ = (id) => document.getElementById(id);

let MODELS = [];
let STATUS = { running: false, pids: [], ports: {}, current: null, starting: false };
let SETTINGS = {};
let autoscroll = true;
let logSysOnly = false;
/** 设置面板是否展开 —— 展开时右栏让位给设置 */
let settingsOpen = false;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast ' + kind; }, 3200);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

function appendLog(entry, prepend = false) {
  const box = $('log');
  const wrap = $('log-wrap');

  // 距底部 40px 内视为"跟到底"
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;

  const div = document.createElement('div');
  div.className = 'line ' + (entry.stream || 'out');
  // 过滤模式下隐藏普通输出行
  if (logSysOnly && entry.stream === 'out') div.classList.add('filtered');
  div.innerHTML = `<span class="ts">${fmtTime(entry.t)}</span><span class="tx">${esc(entry.text)}</span>`;

  if (prepend && box.firstChild) box.insertBefore(div, box.firstChild);
  else box.appendChild(div);

  if (autoscroll && (atBottom || prepend === false)) {
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function applyLogFilter() {
  $('log').classList.toggle('sysonly', logSysOnly);
}

/** 切到日志页时把视图拉到底 —— 日志页平时是隐藏的，滚动位置在隐藏期间没有意义 */
function scrollLogToEnd() {
  const wrap = $('log-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 这个模型是否有视觉能力。
 *
 * 两个引擎的判定源不同：
 *   llama.cpp —— 看 model.vision（是否挂了 mmproj）
 *   NInfer    —— 看 ninfer.vision（视觉编码器内建在 .ninfer 里，靠 --vision 开关）
 * 缺省都按「有」处理会误报，所以这里按引擎分别取，并对 NInfer 做 undefined→true。
 */
function hasVision(m) {
  if (!m) return false;
  if (m.engine === 'ninfer') {
    const nf = m.ninfer;
    return !nf || nf.vision !== false;
  }
  return !!m.vision;
}

function renderModels() {
  const box = $('model-list');
  box.innerHTML = '';

  MODELS.forEach((m) => {
    const isActive = STATUS.current === m.id
      || (STATUS.running && STATUS.ports[m.port]);

    const card = document.createElement('div');
    card.className = 'card'
      + (isActive ? ' active' : '')
      + (!m.fileExists ? ' missing' : '');

    // 引擎标签：和「视觉 / MTP」同级的小标，一眼看出走哪条引擎
    const isNinfer = m.engine === 'ninfer';
    const badges = [];
    badges.push(isNinfer
      ? '<span class="badge nf" title="NInfer 引擎（WSL 内运行）">NInfer</span>'
      : '<span class="badge lc" title="llama.cpp 引擎（Windows 原生）">llama.cpp</span>');
    if (hasVision(m)) badges.push('<span class="badge v">视觉</span>');
    if (m.useMtp) badges.push('<span class="badge mtp">MTP</span>');
    if (isActive) badges.push('<span class="badge run">运行中</span>');

    // 上下文不在这张卡片上改（已挪到「启动参数」页），这里只展示只读值
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${esc(m.name)}</span>
        ${badges.join('')}
      </div>
      <div class="card-meta">
        ${m.sizeGb ? m.sizeGb.toFixed(2) + ' GB' : '文件缺失'} · 端口 ${m.port} · 上下文 ${m.ctxK}K
      </div>
      <div class="card-foot"></div>
    `;

    const btn = document.createElement('button');
    btn.className = 'btn' + (isActive ? ' stop' : '');
    btn.textContent = isActive ? '停止' : '启动';
    if (!m.fileExists) {
      btn.disabled = true;
      btn.textContent = '文件缺失';
    } else if (STATUS.starting && !isActive) {
      btn.disabled = true;
    }

    // 启动用配置里的 ctxK —— 上下文在「启动参数」页改并落盘
    btn.addEventListener('click', () => {
      if (isActive) doStop();
      else doStart(m.id, m.ctxK);
    });

    card.querySelector('.card-foot').appendChild(btn);
    box.appendChild(card);
  });
}

function renderStatus() {
  const anyPort = Object.values(STATUS.ports).some(Boolean);
  const running = STATUS.running || anyPort;
  const loading = STATUS.starting;

  // 标题栏圆点
  const dot = document.querySelector('.dot');
  dot.className = 'dot' + (loading ? ' busy' : running ? ' on' : '');

  // 运行状态
  const st = $('st-state');
  if (loading) { st.innerHTML = '<span class="pill load">加载中…</span>'; }
  else if (running) { st.innerHTML = '<span class="pill run">运行中</span>'; }
  else { st.innerHTML = '<span class="pill idle">未运行</span>'; }

  // 状态卡的语义色条随运行状态变化
  const stCard = $('scard-state');
  if (stCard) {
    stCard.className = 'scard scard-wide scard-accent '
      + (loading ? 'warn' : running ? 'ok' : 'idle');
  }

  // PID：两个引擎的进程名不同，别一律写 llama-server
  const nfPids = STATUS.ninferPids || [];
  const isNinferRun = STATUS.engine === 'ninfer' || nfPids.length > 0;
  const pids = (isNinferRun ? nfPids : (STATUS.pids || [])).join(', ') || '—';
  $('st-pid').textContent = pids;
  $('st-pid-sub').textContent = (isNinferRun ? 'ninfer-serve PID ' : 'llama-server PID ') + pids;
  // 进程卡右下角的引擎名（原来是写死的 llama-server）
  const pidEngine = $('st-pid-engine');
  if (pidEngine) pidEngine.textContent = isNinferRun ? 'ninfer-serve' : 'llama-server';

  // 当前模型 + 推理引擎（合并卡）：引擎标签挂在模型名前面
  const cur = MODELS.find((m) => m.id === STATUS.current);
  const engine = engineInUse(cur);
  let modelName = cur ? cur.alias : (running ? '未知 (外部启动)' : '—');
  let sub = '';
  if (cur) {
    sub = `端口 ${cur.port}${hasVision(cur) ? ' · 多模态' : ''}${cur.useMtp ? ' · MTP' : ''}`;
  } else if (running) {
    const open = MODELS.filter((m) => STATUS.ports[m.port]);
    if (open.length) {
      modelName = open[0].alias;
      sub = `端口 ${open[0].port}（非管理器启动）`;
    }
  }
  $('st-model').textContent = modelName;
  $('st-model-sub').textContent = engineSummary(engine, cur, sub);

  // 引擎标签：只在真有模型在跑的时候出现（没跑就没有「当前引擎」可言）
  const epill = $('st-engine-pill');
  if (running && engine) {
    epill.hidden = false;
    epill.dataset.engine = engine;
    epill.textContent = engineLabel(engine);
  } else {
    epill.hidden = true;
  }
}

/**
 * 当前真正在用的引擎。
 *
 * 判定优先级：实际在跑的进程 > 当前模型的 engine 字段。
 * 这样即使是外部手动拉起的服务，也能显示对。
 */
function engineInUse(cur) {
  const llamaRunning = STATUS.pids && STATUS.pids.length > 0;
  const ninferRunning = STATUS.ninferPids && STATUS.ninferPids.length > 0;
  if (ninferRunning) return 'ninfer';
  if (llamaRunning) return 'llamacpp';
  if (cur) return cur.engine || 'llamacpp';
  return null;
}

function engineLabel(engine) {
  return engine === 'ninfer' ? 'NInfer' : 'llama.cpp';
}

/**
 * 合并卡的第二行：端口信息 + 引擎细节。
 *
 * 原来「推理引擎」是独立一张卡，现在折进来当副标题，所以这里要把
 * 引擎的补充说明（WSL 发行版、进程数、本地 .gguf 等）一起拼上。
 */
function engineSummary(engine, cur, baseSub) {
  if (!engine) return baseSub;
  const bits = [];
  if (baseSub) bits.push(baseSub);

  const nf = STATUS.ninfer || {};
  if (engine === 'ninfer') {
    if (nf.distro) bits.push(`WSL ${nf.distro}`);
    if (STATUS.ninferPids && STATUS.ninferPids.length) bits.push(`${STATUS.ninferPids.length} 个进程`);
    else if (nf.distroState === 'stopped') bits.push('发行版未启动');
    else if (nf.distroState) bits.push(nf.distroState);
  } else {
    if (STATUS.pids && STATUS.pids.length) bits.push(`${STATUS.pids.length} 个进程`);
    else bits.push('未运行');
    if (cur && cur.engine === 'llamacpp') bits.push('本地 .gguf');
  }
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function doStart(id, ctxK) {
  const m = MODELS.find((x) => x.id === id);
  $('log').innerHTML = '';
  toast(`正在启动 ${m.name} …`);
  renderStatus();

  const res = await window.api.start(id, ctxK);

  if (res.ok) {
    toast(`已就绪 — ${res.modelId || m.alias}`, 'ok');
  } else {
    toast(res.error || '启动失败', 'err');
  }
  await refresh();
}

async function doStop() {
  toast('正在停止 …');
  const res = await window.api.stop();
  if (res.ok) toast('已停止', 'ok');
  else toast(res.error || '停止失败', 'err');
  await refresh();
}

async function refresh() {
  const [models, status] = await Promise.all([
    window.api.getModels(),
    window.api.getStatus(),
  ]);
  MODELS = models;
  STATUS = status;
  renderModels();
  renderStatus();
}

/* ------------------------------------------------------------------ *
 * 显存 / 内存显示
 * ------------------------------------------------------------------ */

/** 设置进度条宽度与告警色（pct 为 0-100） */
/** 圆环周长：2πr，r=40，与 style.css 里的 stroke-dasharray 保持一致 */
const RING_CIRC = 2 * Math.PI * 40;

/**
 * 资源环绕圈。
 *
 * 用 stroke-dashoffset 控制可见弧长，比改 path 更省事也更好做过渡。
 * 阈值配色与原进度条一致：>=90% 红、>=75% 黄。
 *
 * 注意：SVG 元素的 className 是只读的 SVGAnimatedString，直接赋字符串会抛
 * TypeError 并中断整个 tickHardware，必须走 setAttribute。
 */
function setRingClass(arc, extra) {
  arc.setAttribute('class', 'ring-fill' + extra);
}

function setRing(arcId, pct, pctId) {
  const arc = $(arcId);
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  if (arc) {
    arc.style.strokeDashoffset = String(RING_CIRC * (1 - v / 100));
    setRingClass(arc, v >= 90 ? ' err' : v >= 75 ? ' warn' : '');
  }
  const lbl = pctId ? $(pctId) : null;
  if (lbl) lbl.textContent = Math.round(v) + '%';
}

/** 环不可用时：整圈留空、中间写占位符 */
function ringUnavailable(arcId, pctId) {
  const arc = $(arcId);
  if (arc) {
    arc.style.strokeDashoffset = String(RING_CIRC);
    setRingClass(arc, '');
  }
  const lbl = pctId ? $(pctId) : null;
  if (lbl) lbl.textContent = '—';
}

async function tickHardware() {
  // 内存
  try {
    const m = await window.api.getMemory();
    $('st-mem').textContent = `${m.freeGb.toFixed(1)} / ${m.totalGb.toFixed(1)} GB 可用`;
    const used = m.totalGb - m.freeGb;
    setRing('st-mem-arc', m.totalGb ? (used / m.totalGb) * 100 : 0, 'st-mem-pct');
  } catch (_) { $('st-mem').textContent = '—'; ringUnavailable('st-mem-arc', 'st-mem-pct'); }

  // 显存
  try {
    const g = await window.api.getGpu();
    const el = $('st-vram');
    if (!g) {
      el.textContent = '不可用';
      el.title = '未检测到 NVIDIA GPU 或 nvidia-smi';
      ringUnavailable('st-vram-arc', 'st-vram-pct');
    } else {
      el.textContent = `${g.usedGb.toFixed(1)} / ${g.totalGb.toFixed(1)} GB`;
      el.title = `${g.name} · 占用率 ${g.util}%`;
      setRing('st-vram-arc', g.totalGb ? (g.usedGb / g.totalGb) * 100 : 0, 'st-vram-pct');
    }
  } catch (_) { $('st-vram').textContent = '—'; ringUnavailable('st-vram-arc', 'st-vram-pct'); }

  // 磁盘占用
  try {
    const d = await window.api.diskUsage();
    const el = $('st-disk');
    if (!d || (!d.totalGb && !d.usedGb)) {
      el.textContent = '—';
      el.title = '磁盘信息不可用';
      ringUnavailable('st-disk-arc', 'st-disk-pct');
    } else {
      // 显示：模型合计 / 剩余可用
      el.textContent = `模型 ${d.usedGb.toFixed(1)} · 余 ${d.freeGb.toFixed(1)} GB`;
      el.title = `模型文件合计 ${d.usedGb.toFixed(2)} GB\n`
        + `所在盘 ${d.dir} 剩余 ${d.freeGb.toFixed(1)} GB`
        + (d.totalGb ? ` / 共 ${d.totalGb.toFixed(1)} GB` : '');
      // 圆环按整盘占用算，比只算模型体积更有参考价值
      const usedDisk = d.totalGb ? d.totalGb - d.freeGb : 0;
      setRing('st-disk-arc', d.totalGb ? (usedDisk / d.totalGb) * 100 : 0, 'st-disk-pct');
    }
  } catch (_) { $('st-disk').textContent = '—'; ringUnavailable('st-disk-arc', 'st-disk-pct'); }
}

/* ------------------------------------------------------------------ *
 * 侧边栏
 * ------------------------------------------------------------------ */

/**
 * 切换视图。三页：
 *   第一页 快速启用（左：模型卡 │ 右：状态总览）
 *   第二页 模型管理（左：模型列表 │ 右：启动参数）
 *   第三页 日志（整页）
 *
 * 前两页的左栏是不同的元素（pane-models / pane-manage），
 * 拖动条要跟着换绑定的目标，否则拖的是隐藏的那一个。
 * 日志页没有左栏，拖动条一并隐藏。
 */
function switchView(view) {
  const v = (view === 'manage' || view === 'log') ? view : 'models';

  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });

  const showManage = v === 'manage';
  const showLog = v === 'log';

  // 左栏
  $('pane-models').classList.toggle('hidden', showManage || showLog);
  $('pane-manage').classList.toggle('hidden', !showManage);

  // 右栏 / 整页
  $('pane-status').classList.toggle('hidden', showManage || showLog);
  $('pane-params').classList.toggle('hidden', !showManage);
  $('pane-log').classList.toggle('hidden', !showLog);

  // 日志页没有左栏，拖动条跟着藏起来
  const sp = $('split-1');
  if (sp) sp.classList.toggle('hidden', showLog);

  // 拖动条：只对前两页有意义，作用对象各不相同
  if (!showLog) setSplitTarget(showManage ? 'pane-manage' : 'pane-models');

  if (showManage) { refreshManage(); loadParams(); }
  if (showLog) scrollLogToEnd();
}

/* ------------------------------------------------------------------ *
 * 分栏拖动
 * ------------------------------------------------------------------ */

/** 当前被拖动的左栏元素 id —— 两页各有自己的左栏 */
let splitTargetId = 'pane-models';

/** 切换拖动条作用的左栏，并把记住的宽度套用它 */
function setSplitTarget(id) {
  splitTargetId = id;
  const w = Math.max(160, parseInt(settingsWidth(), 10) || 300);
  // 两页共用同一份宽度记忆，切换视图时视觉一致
  ['pane-models', 'pane-manage'].forEach((pid) => {
    const el = $(pid);
    if (!el) return;
    el.style.flexBasis = w + 'px';
    el.style.width = w + 'px';
  });
}

/** 从内存里的设置取记住的栏宽 */
function settingsWidth() {
  return SETTINGS && SETTINGS.modelsWidth ? SETTINGS.modelsWidth : 300;
}

function initSplitter() {
  const sp = $('split-1');
  const shell = document.querySelector('.shell');

  let dragging = false;

  const onDown = (e) => {
    // 隐藏时不响应（例如设置面板打开）
    if (sp.classList.contains('hidden')) return;
    dragging = true;
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const pane = $(splitTargetId);
    if (!pane) return;

    const rect = shell.getBoundingClientRect();
    // 相对 shell 左边算，扣掉侧边栏宽度
    const railW = $('rail').getBoundingClientRect().width;
    let w = e.clientX - rect.left - railW;
    const maxW = rect.width - railW - 240;   // 给右侧至少留 240px
    w = Math.max(160, Math.min(w, Math.max(160, maxW)));
    pane.style.flexBasis = w + 'px';
    pane.style.width = w + 'px';
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove('dragging');
    document.body.classList.remove('resizing');
    // 记住宽度（两页共用）
    const pane = $(splitTargetId);
    const w = pane ? (parseInt(pane.style.width, 10) || 300) : 300;
    SETTINGS.modelsWidth = w;
    window.api.saveSettings({ modelsWidth: w });
  };

  sp.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ------------------------------------------------------------------ *
 * 模型管理
 * ------------------------------------------------------------------ */

let MANAGED = [];        // 管理界面的模型列表（含元信息）
let SCAN_FILES = [];     // 最近一次扫描结果
let editingId = null;    // 正在编辑的模型 id；null 表示新增

const fmtGb = (n) => (n ? n.toFixed(2) + ' GB' : '—');

/** 加载并渲染管理列表 */
async function refreshManage() {
  MANAGED = await window.api.modelsList();
  renderManage();
}

function renderManage() {
  const box = $('manage-list');
  const count = MANAGED.length;
  $('manage-count').textContent = count ? `共 ${count} 个` : '';
  box.innerHTML = '';

  if (!count) {
    box.innerHTML = '<div class="empty">还没有配置任何模型<br>点击上方「添加模型」或「自动扫描」开始</div>';
    return;
  }

  MANAGED.forEach((m) => {
    const isActive = STATUS.current === m.id;
    // 是否就是右侧「启动参数」当前正在编辑的那个模型
    const isSelected = paramsModelId === m.id;
    const row = document.createElement('div');
    row.className = 'mrow'
      + (isActive ? ' active' : '')
      + (isSelected ? ' selected' : '')
      + (!m.fileExists ? ' missing' : '');
    // 整行可点：点一下就选中它，右侧参数面板跟着切过去
    row.title = '点击此卡片，在右侧编辑它的启动参数';
    row.tabIndex = 0;

    const badges = [];
    if (m.engine === 'ninfer') badges.push('<span class="badge nf">NInfer</span>');
    else badges.push('<span class="badge lc">llama.cpp</span>');
    if (hasVision(m)) badges.push('<span class="badge v">视觉</span>');
    if (m.useMtp) badges.push('<span class="badge mtp">MTP</span>');
    if (isActive) badges.push('<span class="badge run">运行中</span>');
    if (!m.fileExists) badges.push('<span class="badge off">文件缺失</span>');

    const info = [
      `<span class="k">文件</span> ${esc(m.file)}`,
      `<span class="k">大小</span> ${fmtGb(m.sizeGb)} · <span class="k">端口</span> ${m.port} · <span class="k">上下文</span> ${m.ctxK}K`,
      `<span class="k">别名</span> ${esc(m.alias)}`,
    ];
    if (m.mmproj) {
      info.push(`<span class="k">投影</span> ${esc(m.mmproj)}${m.mmprojExists ? '' : ' <span style="color:var(--err)">(缺失)</span>'}`);
    }

    row.innerHTML = `
      <div class="mrow-top">
        <span class="mrow-name">${esc(m.name)}</span>
        ${badges.join('')}
      </div>
      <div class="mrow-info">${info.join('<br>')}</div>
    `;

    const acts = document.createElement('div');
    acts.className = 'mrow-actions';

    const edit = document.createElement('button');
    edit.className = 'mini';
    edit.textContent = '编辑';
    edit.title = '编辑名称、文件、端口等';
    // 编辑按钮要吃掉冒泡，否则会连带触发整行的「选中」
    edit.addEventListener('click', (e) => { e.stopPropagation(); openModal(m.id); });
    acts.appendChild(edit);
    // 删除统一走顶部「删除模型」按钮，避免误点单个卡片就删几十 GB

    row.appendChild(acts);

    // 选中该模型 → 右侧参数面板切换过去
    const select = () => {
      if (paramsModelId === m.id) return;
      paramsModelId = m.id;
      paramsDirty = false;          // 换模型时丢掉上一个模型的未保存标记
      paramsSaving = false;
      renderManage();               // 刷新 selected 高亮
      loadParams();
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });

    box.appendChild(row);
  });
}

/* --- 批量删除 --- */

/** 打开删除弹窗，列出所有模型供勾选 */
function openDeleteModal() {
  if (!MANAGED.length) { toast('没有可删除的模型', 'err'); return; }

  const list = $('del-list');
  list.innerHTML = '';

  MANAGED.forEach((m) => {
    const isActive = STATUS.current === m.id;

    const row = document.createElement('label');
    row.className = 'del-row' + (isActive ? ' locked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = m.id;
    cb.disabled = isActive;
    if (isActive) cb.title = '模型正在运行，无法删除';
    cb.addEventListener('change', updateDeletePreview);

    const info = document.createElement('div');
    info.className = 'dinfo';
    const files = [m.file, m.mmproj].filter(Boolean).join(' + ');
    info.innerHTML = `
      <div class="dname">${esc(m.name)}</div>
      <div class="dmeta">${esc(files)} · ${fmtGb(m.sizeGb)}</div>
    `;

    row.appendChild(cb);
    row.appendChild(info);
    list.appendChild(row);
  });

  $('del-error').textContent = '';
  $('del-with-files').checked = true;
  updateDeletePreview();
  $('del-modal').hidden = false;
}

function closeDeleteModal() {
  $('del-modal').hidden = true;
}

/** 勾选变化时，拉取待删文件清单并展示 */
async function updateDeletePreview() {
  const ids = [...document.querySelectorAll('#del-list input[type=checkbox]:checked')]
    .map((c) => c.value);

  const btn = $('del-confirm');
  const box = $('del-preview');

  if (!ids.length) {
    btn.disabled = true;
    box.innerHTML = '';
    return;
  }

  btn.disabled = true;   // 预览返回前禁止点击，避免删到未预览的内容
  box.textContent = '正在统计…';

  const res = await window.api.modelsDeletePreview(ids);
  if (!res.ok) {
    box.textContent = '';
    $('del-error').textContent = res.error || '统计失败';
    return;
  }

  const withFiles = $('del-with-files').checked;
  const lines = [];

  if (withFiles) {
    res.items.forEach((it) => {
      it.files.forEach((f) => {
        const tag = f.kind === 'mmproj' ? '[投影]' : '[模型]';
        lines.push(`${tag} ${f.path}  ${f.sizeGb.toFixed(2)} GB`);
      });
      it.missing.forEach((n) => lines.push(`[缺失] ${n}`));
    });
  } else {
    res.items.forEach((it) => lines.push(`[仅移除配置] ${it.name}`));
  }

  const total = res.totalGb;
  box.innerHTML = lines.map((l) => `<div class="fpath">${esc(l)}</div>`).join('')
    + `<div class="ftotal">合计：${total.toFixed(2)} GB（${res.items.length} 个模型）</div>`
    + (res.warnings.length
      ? `<div style="color:var(--warn)">${res.warnings.map(esc).join('<br>')}</div>`
      : '');

  $('del-error').textContent = '';
  btn.disabled = false;
}

async function confirmDelete() {
  const ids = [...document.querySelectorAll('#del-list input[type=checkbox]:checked')]
    .map((c) => c.value);
  if (!ids.length) return;

  const withFiles = $('del-with-files').checked;
  const btn = $('del-confirm');
  btn.disabled = true;
  btn.textContent = '删除中…';

  const res = await window.api.modelsDeleteBatch(ids, withFiles);

  btn.textContent = '确认删除';
  btn.disabled = false;

  if (!res.ok) {
    $('del-error').textContent = res.error || '删除失败';
    return;
  }

  const parts = [`已移除 ${res.removed} 个模型`];
  if (withFiles) parts.push(`文件移入回收站 ${res.trashed} 个`);
  if (res.failed.length) parts.push(`失败 ${res.failed.length} 个`);
  if (res.skipped.length) parts.push(`跳过 ${res.skipped.length} 个`);

  toast(parts.join(' · '), res.failed.length ? 'err' : 'ok');

  if (res.failed.length) {
    $('del-error').textContent = res.failed
      .map((f) => `${f.name}: ${f.error}`).join(' ; ');
    return;
  }

  closeDeleteModal();
  await refreshManage();
  await refresh();
}

/* --- 扫描 --- */

async function doScan() {
  const btn = $('btn-scan');
  btn.disabled = true;
  btn.textContent = '扫描中…';

  const res = await window.api.modelsScan(SETTINGS.modelsDir);

  // NInfer 的模型在 WSL 里，单独扫一份合进来
  let nfFiles = [];
  let nfErr = null;
  if (SETTINGS.ninferAutoScan !== false) {
    try {
      const ns = await window.api.ninferScan();
      if (ns && ns.ok) {
        nfFiles = (ns.wsl || []).map((f) => ({
          ...f, engine: 'ninfer', mmproj: false, file: f.path,
        }));
        if (ns.errors && ns.errors.length) nfErr = ns.errors[0];
      }
    } catch (e) { nfErr = e.message; }
  }

  btn.disabled = false;
  btn.textContent = '自动扫描';

  if (!res.ok) { toast(res.error || '扫描失败', 'err'); return; }

  SCAN_FILES = [...(res.files || []), ...nfFiles];
  renderScan(res.dir);

  const bits = [`${(res.files || []).length} 个本地文件`];
  if (nfFiles.length) bits.push(`${nfFiles.length} 个 NInfer 模型`);
  if (!SCAN_FILES.length) toast('没有找到任何模型文件', 'err');
  else toast(`扫描到 ${bits.join(' · ')}`, 'ok');
  if (nfErr) toast('NInfer 扫描提示：' + nfErr, 'err');
}

function renderScan(dir) {
  const box = $('scan-box');
  const list = $('scan-list');
  box.hidden = false;

  // 扫描结果里只保留「还没配置过的东西」：
  //   - 已添加的模型不再列出（列表里已经有了，重复显示只会干扰）
  //   - 已被某个模型绑定的视觉投影也不再列出
  // 判断依据同时兼容文件名（gguf）与绝对路径（NInfer / 本地 .ninfer）。
  const isAdded = (f) => MANAGED.some(
    (m) => m.file === f.file || m.file === f.path || (f.path && m.file === f.path));
  const isBound = (f) => MANAGED.some(
    (m) => m.mmproj && (m.mmproj === f.file || m.mmproj === f.path));

  const all = SCAN_FILES;
  const fresh = all.filter((f) => (f.mmproj ? !isBound(f) : !isAdded(f)));
  const hiddenCount = all.length - fresh.length;

  const mains = fresh.filter((f) => !f.mmproj && f.engine !== 'ninfer').length;
  const projs = fresh.filter((f) => f.mmproj).length;
  const nfs = fresh.filter((f) => f.engine === 'ninfer').length;

  const bits = [`${mains} 个模型`];
  if (projs) bits.push(`${projs} 个投影文件`);
  if (nfs) bits.push(`${nfs} 个 NInfer`);
  $('scan-title').textContent = `扫描结果：${bits.join(' · ')}`
    + (hiddenCount ? `（已隐藏 ${hiddenCount} 个已添加的）` : '');

  list.innerHTML = '';

  if (!all.length) {
    list.innerHTML = `<div class="empty">${esc(dir || '')}<br>没有找到 .gguf 或 .ninfer 文件</div>`;
    return;
  }

  if (!fresh.length) {
    list.innerHTML = '<div class="empty">扫描到的文件都已经添加过了<br>'
      + '（已添加的模型和已绑定的投影不会在这里重复显示）</div>';
    return;
  }

  fresh.forEach((f) => {
    const item = document.createElement('div');
    item.className = 'scan-item';

    const metaBits = [f.sizeGb.toFixed(2) + 'GB'];
    if (f.engine === 'ninfer') {
      metaBits.push('NInfer');
      if (f.meta && f.meta.modelId) metaBits.push(f.meta.modelId);
    } else {
      if (f.quantization) metaBits.push(f.quantization);
      if (f.meta && f.meta.architecture) metaBits.push(f.meta.architecture);
    }
    if (f.mmproj) metaBits.unshift('投影');

    item.innerHTML = `
      <span class="sname" title="${esc(f.file)}">${esc(f.file)}</span>
      <span class="smeta">${metaBits.join(' · ')}</span>
    `;

    const add = document.createElement('button');
    add.className = 'sadd';

    if (f.mmproj) {
      // 已绑定的投影在过滤阶段就被去掉了，这里剩下的都是未绑定的
      add.textContent = '绑定';
      add.title = '投影文件需绑定到主模型：点主模型的「编辑」，在「视觉投影」里选择它';
      add.addEventListener('click', () => {
        toast('请在主模型的「编辑」里，于「视觉投影」中选择该文件', 'ok');
      });
      item.appendChild(add);
      list.appendChild(item);
      return;
    }

    // 未添加的模型（已添加的已被过滤掉）
    add.textContent = '添加';
    add.addEventListener('click', async () => {
      add.disabled = true;
      const preset = scanToModel(f);
      const res = await window.api.modelsCreate(preset);
      if (!res.ok) {
        toast(res.error || '添加失败', 'err');
        add.disabled = false;
        return;
      }
      toast(`已添加「${preset.name}」`, 'ok');
      await refreshManage();
      renderScan(dir);
      await refresh();
    });
    item.appendChild(add);
    list.appendChild(item);
  });
}

/** 从 gguf 元数据推断一个对用户有意义的名称 */
function bestName(f) {
  const base = f.file.replace(/\.gguf$/i, '');
  const m = f.meta || {};

  // 元数据里的 general.name 有时是无意义的占位值
  const junk = /^(src|safetensors|model|output|gguf|test)$/i;
  const metaName = (m.name || '').trim();

  if (metaName && !junk.test(metaName) && metaName.length <= 48) {
    return metaName;
  }

  // 退而用文件名，去掉量化后缀让名称更干净
  return base
    .replace(/[-_.](IQ\d+_[A-Z0-9_]+|Q\d+_K_[A-Z]+|Q\d+_K|Q\d+_\d|F16|F32|BF16)$/i, '')
    || base;
}

/** 把扫描结果转成可提交的模型数据 */
function scanToModel(f) {
  // NInfer 模型：路径是 WSL 内的绝对路径，参数用默认值
  if (f.engine === 'ninfer') {
    const meta = f.meta || {};
    return {
      name: meta.modelId || f.file.replace(/\.ninfer$/i, ''),
      alias: meta.modelId || f.file.replace(/\.ninfer$/i, ''),
      file: f.path,
      mmproj: null,
      ctxK: 32,
      useMtp: false,
      vision: /vl|vision/i.test(f.file),
      port: null,
      engine: 'ninfer',
    };
  }

  const base = f.file.replace(/\.gguf$/i, '');

  return {
    name: bestName(f),
    alias: base,
    file: f.file,
    mmproj: null,
    ctxK: f.meta && f.meta.contextLength
      ? Math.max(1, Math.round(f.meta.contextLength / 1024))
      : 32,
    useMtp: /\bMTP\b/i.test(base),
    vision: false,
    port: null,
    engine: 'llamacpp',
  };
}

/* --- 弹窗 --- */

function fillFileOptions(keepFile, keepMmproj) {
  const files = SCAN_FILES.filter((f) => !f.mmproj);
  const projs = SCAN_FILES.filter((f) => f.mmproj);

  const sel = $('f-file');
  sel.innerHTML = '<option value="">（请选择）</option>'
    + files.map((f) => `<option value="${esc(f.file)}">${esc(f.file)}</option>`).join('');

  const selP = $('f-mmproj');
  selP.innerHTML = '<option value="">（无）</option>'
    + projs.map((f) => `<option value="${esc(f.file)}">${esc(f.file)}</option>`).join('');

  if (keepFile) sel.value = keepFile;
  if (keepMmproj) selP.value = keepMmproj;

  const known = files.length + projs.length;
  $('f-file-hint').textContent = known
    ? `模型目录中扫描到 ${known} 个文件`
    : '未扫描到文件，请先点「刷新」或检查设置里的模型目录';
}

/** NInfer 扫描结果缓存（弹窗里下拉用） */
let NINFER_FILES = [];

/**
 * 按引擎切换弹窗里的文件选择方式。
 *
 * llama.cpp 从扫描到的 gguf 下拉选；NInfer 的文件在 WSL 里，
 * 下拉列出扫到的 .ninfer，同时也允许手填任意 WSL 路径。
 */
function applyEngineToModal(engine) {
  const isNinfer = engine === 'ninfer';

  $('f-file-wrap').hidden = false;
  $('f-file').hidden = isNinfer;          // NInfer 用文本框（下拉仍保留给 gguf）
  $('f-file-text').hidden = !isNinfer;
  $('f-mmproj-row').hidden = isNinfer;

  if (isNinfer) {
    const sel = $('f-file');
    sel.innerHTML = '<option value="">（请选择）</option>'
      + NINFER_FILES.map((f) => `<option value="${esc(f.path)}">${esc(f.file)} · ${f.sizeGb.toFixed(2)}GB</option>`).join('');
    $('f-file-hint').textContent = NINFER_FILES.length
      ? `WSL 中扫描到 ${NINFER_FILES.length} 个 .ninfer，也可直接手填路径`
      : '未在 WSL 中扫到 .ninfer，请手动填写 WSL 内的绝对路径';
  } else {
    fillFileOptions($('f-file').value, $('f-mmproj').value);
  }
}

/** 取弹窗里当前选中的模型文件路径（按引擎取不同控件） */
function modalFilePath(engine) {
  if (engine === 'ninfer') {
    // 文本框优先；为空时退回下拉（下拉里可能是扫到的 .ninfer）
    const t = $('f-file-text').value.trim();
    if (t) return t;
    return $('f-file').value || '';
  }
  return $('f-file').value || '';
}

async function openModal(id) {
  editingId = id || null;
  $('modal-error').textContent = '';

  // 打开前先扫一次目录，保证文件列表是最新的
  const scan = await window.api.modelsScan(SETTINGS.modelsDir);
  SCAN_FILES = scan.ok ? (scan.files || []) : [];

  // NInfer 的文件在 WSL 里，单拿一份列表
  try {
    const ns = await window.api.ninferScan();
    NINFER_FILES = ns && ns.ok ? [...(ns.wsl || []), ...(ns.local || [])] : [];
  } catch (_) { NINFER_FILES = []; }

  const m = id ? MANAGED.find((x) => x.id === id) : null;
  const engine = m ? (m.engine || 'llamacpp') : 'llamacpp';

  $('f-engine').value = engine;

  if (m) {
    $('modal-title').textContent = '编辑模型';
    $('f-name').value = m.name;
    $('f-alias').value = m.alias;
    $('f-port').value = m.port;
    $('f-ctx').value = m.ctxK;
    // NInfer 的视觉来自 ninfer.vision（内建编码器），不是顶层 vision
    $('f-vision').checked = engine === 'ninfer'
      ? (m.ninfer ? m.ninfer.vision !== false : true)
      : !!m.vision;
    $('f-mtp').checked = !!m.useMtp;
    $('f-nommprojoffload').checked = !!m.noMmprojOffload;
    $('f-file-text').value = engine === 'ninfer' ? (m.file || '') : '';
    applyEngineToModal(engine);
    if (engine === 'llamacpp') fillFileOptions(m.file, m.mmproj);
  } else {
    $('modal-title').textContent = '添加模型';
    $('f-name').value = '';
    $('f-alias').value = '';
    $('f-port').value = await window.api.modelsNextPort();
    $('f-ctx').value = SETTINGS.defaultCtxK || 32;
    $('f-vision').checked = false;
    $('f-mtp').checked = false;
    $('f-nommprojoffload').checked = false;
    $('f-file-text').value = '';
    applyEngineToModal(engine);
  }

  $('modal').hidden = false;
  $('f-name').focus();
}

function closeModal() {
  $('modal').hidden = true;
  editingId = null;
}

async function saveModal() {
  const name = $('f-name').value.trim();
  const engine = $('f-engine').value;
  const file = modalFilePath(engine);
  const alias = $('f-alias').value.trim() || name;
  const port = parseInt($('f-port').value, 10);
  const ctxK = parseInt($('f-ctx').value, 10) || 32;
  const mmproj = engine === 'ninfer' ? null : ($('f-mmproj').value || null);
  const vision = $('f-vision').checked;
  const useMtp = engine === 'ninfer' ? false : $('f-mtp').checked;
  const noMmprojOffload = engine === 'ninfer' ? false : $('f-nommprojoffload').checked;

  const err = $('modal-error');

  if (!name) { err.textContent = '请填写名称'; $('f-name').focus(); return; }
  if (!file) {
    err.textContent = engine === 'ninfer' ? '请填写 WSL 内的 .ninfer 路径' : '请选择模型文件';
    return;
  }
  if (engine === 'ninfer' && !file.startsWith('/')) {
    err.textContent = 'NInfer 模型需填 WSL 内的绝对路径，例如 /root/models/xxx.ninfer';
    return;
  }
  if (!Number.isFinite(port)) { err.textContent = '端口无效'; $('f-port').focus(); return; }

  const payload = { name, alias, file, mmproj, port, ctxK, vision, useMtp, noMmprojOffload, engine };
  // NInfer：视觉存在 ninfer 子对象里（内建编码器，无独立 mmproj），
  // 顶层 vision 由主进程按引擎语义解读，这里一并写上以保持两者一致。
  if (engine === 'ninfer') {
    const cur = editingId ? MANAGED.find((x) => x.id === editingId) : null;
    payload.ninfer = { ...((cur && cur.ninfer) || {}), vision };
    payload.vision = vision;
  }

  const res = editingId
    ? await window.api.modelsUpdate(editingId, payload)
    : await window.api.modelsCreate(payload);

  if (!res.ok) { err.textContent = res.error || '保存失败'; return; }

  toast(editingId ? '已保存' : '已添加', 'ok');
  closeModal();
  await refreshManage();
  await refresh();
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

let savedHintTimer = null;

function flashSaved() {
  const h = $('saved-hint');
  h.textContent = '已保存';
  h.classList.add('show');
  clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => h.classList.remove('show'), 1400);
}

function fillSettings(s) {
  $('set-theme').value = s.theme || 'system';
  $('set-zoom').value = String(s.zoom || 1);
  $('set-ctx').value = s.defaultCtxK || 32;
  $('set-timeout').value = s.readyTimeoutSec || 180;
  $('set-autochat').checked = !!s.autoChatAfterStart;
  $('set-loglimit').value = s.logLimit || 4000;
  $('set-logfilter').checked = !!s.logSysOnly;
  $('set-server').value = s.serverExe || '';
  $('set-modelsdir').value = s.modelsDir || '';
  $('set-tray').checked = s.closeToTray !== false;

  // NInfer
  $('set-nf-serve').value = s.ninferServe || '';
  $('set-nf-cli').value = s.ninferCli || '';
  $('set-nf-modelsdir').value = s.ninferModelsDir || '';
  $('set-nf-autoscan').checked = s.ninferAutoScan !== false;

  // 开机自启状态来自注册表，不在 settings.json 里
  window.api.autostartGet().then((r) => {
    const el = $('set-autostart');
    el.checked = !!(r && r.enabled);
    el.disabled = !(r && r.supported);
  }).catch(() => {});
}

function collectSettings() {
  return {
    theme: $('set-theme').value,
    zoom: parseFloat($('set-zoom').value) || 1,
    defaultCtxK: parseInt($('set-ctx').value, 10) || 32,
    readyTimeoutSec: parseInt($('set-timeout').value, 10) || 180,
    autoChatAfterStart: $('set-autochat').checked,
    logLimit: parseInt($('set-loglimit').value, 10) || 4000,
    logSysOnly: $('set-logfilter').checked,
    serverExe: $('set-server').value.trim(),
    modelsDir: $('set-modelsdir').value.trim(),
    closeToTray: $('set-tray').checked,
  };
}

async function saveFromPanel() {
  const patch = collectSettings();
  const res = await window.api.saveSettings(patch);
  if (!res.ok) { toast('保存失败：' + res.error, 'err'); return; }
  SETTINGS = res.settings;

  // 即时生效的项
  document.documentElement.style.zoom = String(SETTINGS.zoom) === '1' ? '' : String(SETTINGS.zoom);
  logSysOnly = !!SETTINGS.logSysOnly;
  applyLogFilter();

  flashSaved();
}

function openSettings(open) {
  const s = $('settings');
  settingsOpen = !!open;
  s.hidden = !open;
  $('rail-settings').classList.toggle('active', open);
  // 设置打开时隐藏分栏条，避免和面板边框挤在一起
  $('split-1').classList.toggle('hidden', settingsOpen);
  if (open) loadNinferStatus();
}

/* ------------------------------------------------------------------ *
 * NInfer 设置
 * ------------------------------------------------------------------ */

/** 探测 NInfer 环境并刷新设置面板里的状态区 */
async function loadNinferStatus() {
  const badge = $('nf-badge');
  const box = $('nf-status');
  badge.textContent = '检测中…';
  badge.className = 'sgroup-badge';
  box.textContent = '正在探测 WSL…';

  let r;
  try {
    r = await window.api.ninferProbe();
  } catch (e) {
    badge.textContent = '不可用';
    badge.className = 'sgroup-badge err';
    box.innerHTML = '<span class="err">探测失败：' + esc(e.message || String(e)) + '</span>';
    return;
  }

  // 发行版下拉：把探测到的都列出来，保留当前选择
  const sel = $('set-nf-distro');
  const cur = SETTINGS.ninferDistro || (r.cfg && r.cfg.distro) || '';
  sel.innerHTML = (r.distros || [])
    .map((d) => `<option value="${esc(d.name)}">${esc(d.name)}${d.state === 'running' ? ' （运行中）' : ''}</option>`)
    .join('');
  if (cur && !(r.distros || []).some((d) => d.name === cur)) {
    sel.innerHTML += `<option value="${esc(cur)}">${esc(cur)}（未检测到）</option>`;
  }
  sel.value = cur;

  const rt = r.runtime || {};
  const lines = [];
  if (!r.wslAvailable) {
    lines.push('<span class="err">未检测到 WSL 发行版</span>');
    badge.textContent = '不可用';
    badge.className = 'sgroup-badge err';
  } else {
    lines.push(`发行版 <b>${esc(rt.distro || '')}</b>`
      + (rt.ok ? '' : ` <span class="err">（${esc(rt.error || '不可访问')}）</span>`));
    lines.push(`ninfer-serve ${rt.hasServe ? '<span class="ok">已找到</span>' : '<span class="err">缺失</span>'}`);
    lines.push(`ninfer CLI ${rt.hasCli ? '<span class="ok">已找到</span>' : '<span class="err">缺失</span>'}`);
    lines.push(`模型目录 ${rt.hasModelsDir ? '<span class="ok">存在</span>' : '<span class="err">不存在</span>'}`);
    const ok = rt.hasServe;
    badge.textContent = ok ? '就绪' : '不完整';
    badge.className = 'sgroup-badge ' + (ok ? 'ok' : 'err');
  }
  box.innerHTML = lines.join('<br>');
}

/** NInfer 设置写回 */
async function saveNinferSettings() {
  const patch = {
    ninferDistro: $('set-nf-distro').value,
    ninferServe: $('set-nf-serve').value.trim(),
    ninferCli: $('set-nf-cli').value.trim(),
    ninferModelsDir: $('set-nf-modelsdir').value.trim(),
    ninferAutoScan: $('set-nf-autoscan').checked,
  };
  const res = await window.api.saveSettings(patch);
  if (!res.ok) { toast('保存失败：' + res.error, 'err'); return; }
  SETTINGS = res.settings;
  flashSaved();
  loadNinferStatus();
}

/* ------------------------------------------------------------------ *
 * 启动参数模块
 * ------------------------------------------------------------------ */

/** 参数视图当前选中的模型 id（默认取第一个模型） */
let paramsModelId = null;
let paramsSaving = false;
/** 用户是否动过参数但还没保存 —— 防 onStatus 定时刷新把未保存的输入冲掉 */
let paramsDirty = false;

/** 拉取当前模型的启动参数并刷新命令预览 */
async function loadParams() {
  if (!MODELS.length) {
    paramsModelId = null;
    $('params-model').textContent = '无模型';
    $('p-cmd').value = '（还没有配置任何模型）';
    $('p-cmd').disabled = true;
    $('p-cmd-meta').textContent = '';
    setCmdCustom(false);
    return;
  }

  // 选中的模型被删掉时回落到第一个
  if (!paramsModelId || !MODELS.some((m) => m.id === paramsModelId)) {
    paramsModelId = MODELS[0].id;
    paramsDirty = false;
  }

  const list = await window.api.modelsList();
  const m = list.find((x) => x.id === paramsModelId);
  if (!m) return;

  $('params-model').textContent = m.name;

  const isNinfer = m.engine === 'ninfer';

  // 引擎徽标
  const tag = $('p-engine-tag');
  if (tag) {
    tag.hidden = false;
    tag.className = 'engine-tag ' + (isNinfer ? 'ninfer' : 'llamacpp');
    tag.innerHTML = `<span class="et-dot"></span>`
      + (isNinfer ? '推理引擎：NInfer（WSL）' : '推理引擎：llama.cpp（Windows）');
  }

  // 运行中禁用编辑：改了也要等下次启动才生效，避免误解
  const running = !!STATUS.current && STATUS.current === m.id;
  // 非多模态模型不需要 mmproj 卸载开关
  const hasMmproj = !!m.mmproj;

  // 用户有未保存改动时不覆盖输入框，只更新只读部分与锁状态
  if (!paramsDirty) {
    fillLlamaFields(m);
    if (isNinfer) fillNinferFields(m.ninfer || {});
    // 命令框：有自定义命令就显示自定义的，否则等 refreshCmd 填基准命令
    cmdEditing = false;
    setCmdCustom(!!(m.cmdOverride && m.cmdOverride.trim()));
    if (m.cmdOverride && m.cmdOverride.trim()) {
      $('p-cmd').value = m.cmdOverride.trim();
    }
  } else {
    // 值已经从 store 加载过了，脏标记说明输入框里才是用户的最新意图
    $('p-status').textContent = '有未保存的改动';
    $('p-status').className = 'phint';
  }

  // 上下文在运行中也能改（下次启动生效），所以这个框不随运行状态禁用
  updateCtxNote(isNinfer);

  // llama.cpp 专属的选项在 NInfer 下没有意义，整块隐藏
  $('p-row-nommproj').hidden = isNinfer;
  ['popt-mem', 'popt-perf', 'popt-tpl', 'popt-sample', 'popt-adv'].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = isNinfer;
  });
  $('popt-ctx').hidden = false;
  $('popt-ninfer').hidden = !isNinfer;

  // KVMem 是 llama.cpp 侧的东西，NInfer 下整块隐藏
  const kvGroup = $('pgroup-kvmem');
  if (kvGroup) kvGroup.hidden = isNinfer;

  // 这些参数一律「下次启动才生效」，所以运行中照样可以改、可以存 ——
  // 之前整页锁死，导致想改上下文得先停模型，体验上就像"被锁住了"。
  // 只有 mmproj 开关在「该模型根本没有投影文件」时才需要禁用（改了也没用）。
  $('p-nommprojoffload').disabled = !hasMmproj;
  $('p-ctx').disabled = false;
  $('p-save').disabled = false;
  $('p-restore').disabled = false;
  $('p-cmd').disabled = false;
  setNinferInputsDisabled(false);

  if (running) {
    $('p-status').textContent = '模型运行中，改动将在下次启动生效';
    $('p-status').className = 'phint';
  }
  $('p-nommprojoffload-hint').textContent = hasMmproj
    ? '让视觉投影（mmproj）留在 CPU 内存，省约 1 GB 显存；仅多模态模型有效'
    : '该模型没有视觉投影文件，此项无效';

  updateOptSummaries(isNinfer, hasMmproj, m);
  await refreshCmd();
}

/** 把模型的 llama.cpp 启动选项填进输入框（缺省值与 PARAM_DEFAULTS 一致） */
function fillLlamaFields(m) {
  $('p-ctx').value = m.ctxK;
  $('p-nommprojoffload').checked = !!m.noMmprojOffload;
  $('p-loadmode').value = ['mlock', 'mmap', 'none'].includes(m.loadMode)
    ? m.loadMode : 'mlock';

  const int = (id, v, d) => { $(id).value = Number.isFinite(Number(v)) ? v : d; };
  const str = (id, v, d) => { $(id).value = (v === undefined || v === null) ? d : v; };

  // 显存
  int('p-ngl', m.gpuLayers, -1);
  str('p-splitmode', m.splitMode, 'layer');
  $('p-kvoffload').checked = m.kvOffload !== false;

  // 性能
  int('p-threads', m.threads, -1);
  int('p-threadsbatch', m.threadsBatch, -1);
  int('p-batch', m.batch, 2048);
  int('p-ubatch', m.ubatch, 512);
  $('p-fits').checked = m.fits !== false;

  // 模板
  $('p-jinja').checked = m.jinja !== false;
  str('p-chattpl', m.chatTemplateFile, '');
  str('p-reasoningfmt', m.reasoningFormat, 'auto');

  // 采样（默认值保持字符串，才能保住 0.0 / 1.0 的小数位）
  str('p-temp', m.temperature, '0.6');
  str('p-topp', m.topP, '0.95');
  int('p-topk', m.topK, 20);
  str('p-minp', m.minP, '0.0');
  str('p-repeatpenalty', m.repeatPenalty, '1.0');
  str('p-presencepenalty', m.presencePenalty, '0.0');

  // 高级
  $('p-ctxshift').checked = m.ctxShift !== false;
  $('p-flashattn').checked = m.flashAttn !== false;
  $('p-usemtp').checked = !!m.useMtp;
  $('p-noopoffload').checked = !!m.noOpOffload;
  $('p-metrics').checked = !!m.metrics;
  $('p-nowebui').checked = !!m.noWebui;
  int('p-parallel', m.parallel, 1);
  int('p-timeout', m.timeout, 0);
  str('p-ctk', m.cacheTypeK, 'q8_0');
  str('p-ctv', m.cacheTypeV, 'q8_0');

  // KVMem（llama.cpp 专用，跟在启动命令下面）
  $('p-kvmem').checked = !!m.kvmem;
}

/**
 * 刷新各折叠分组的「当前值」摘要。
 * 收起状态下不解开也能看清配了什么，省得来回点开对比。
 *
 * 参数可省略：从当前选中模型推断引擎，从配置推断是否有 mmproj。
 */
function updateOptSummaries(isNinfer, hasMmproj, m) {
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

  const model = m || MODELS.find((x) => x.id === paramsModelId) || {};
  const nfEngine = isNinfer === undefined ? model.engine === 'ninfer' : isNinfer;
  const withMmproj = hasMmproj === undefined ? !!model.mmproj : hasMmproj;

  const ctxK = Number($('p-ctx').value) || 0;
  set('popt-ctx-val', ctxK > 0 ? `${ctxK}K` : '');

  if (nfEngine) {
    const nf = collectNinferFields();
    const bits = [];
    if (nf.kvDtype) bits.push(`KV ${nf.kvDtype}`);
    if (nf.spec) bits.push(nf.spec);
    if (nf.vision) bits.push('视觉');
    set('popt-ninfer-val', bits.join(' · '));
    ['popt-mem-val', 'popt-perf-val', 'popt-tpl-val', 'popt-sample-val', 'popt-adv-val']
      .forEach((id) => set(id, ''));
    return;
  }

  // ② 显存与卸载
  const mem = [];
  const ngl = Number($('p-ngl').value);
  mem.push(Number.isFinite(ngl) && ngl >= 0 ? `${ngl} 层上卡` : '自动分层');
  if (withMmproj) mem.push($('p-nommprojoffload').checked ? 'mmproj 留 CPU' : 'mmproj 上卡');
  const lm = $('p-loadmode').value;
  if (lm !== 'none') mem.push(lm);
  if (!$('p-kvoffload').checked) mem.push('KV 不入显存');
  set('popt-mem-val', mem.join(' · '));

  // ③ 性能
  const perf = [];
  const th = Number($('p-threads').value);
  if (Number.isFinite(th) && th > 0) perf.push(`${th} 线程`);
  perf.push(`b ${$('p-batch').value}/ub ${$('p-ubatch').value}`);
  if (!$('p-fits').checked) perf.push('fit 关');
  set('popt-perf-val', perf.join(' · '));

  // ④ 模板
  const tpl = [];
  tpl.push($('p-jinja').checked ? 'jinja' : '无 jinja');
  if (($('p-chattpl').value || '').trim()) tpl.push('自定义模板');
  const rf = $('p-reasoningfmt').value;
  if (rf && rf !== 'auto') tpl.push(rf);
  set('popt-tpl-val', tpl.join(' · '));

  // ⑤ 采样：只写非默认值，默认时保持清爽
  const samp = [];
  const d = PARAM_DEFAULTS_FALLBACK;
  const same = (id, key) => String($(id).value).trim() === String(d[key]);
  if (!same('p-temp', 'temperature')) samp.push(`temp ${$('p-temp').value}`);
  if (!same('p-topp', 'topP')) samp.push(`top-p ${$('p-topp').value}`);
  if (!same('p-minp', 'minP')) samp.push(`min-p ${$('p-minp').value}`);
  if (Number($('p-topk').value) !== d.topK) samp.push(`top-k ${$('p-topk').value}`);
  if (!same('p-repeatpenalty', 'repeatPenalty')) samp.push(`rep ${$('p-repeatpenalty').value}`);
  if (!same('p-presencepenalty', 'presencePenalty')) {
    samp.push(`pres ${$('p-presencepenalty').value}`);
  }
  set('popt-sample-val', samp.length ? samp.join(' · ') : '默认');

  // ⑥ 高级
  const adv = [];
  if ($('p-ctxshift').checked) adv.push('shift');
  if ($('p-flashattn').checked) adv.push('fa');
  if ($('p-usemtp').checked) adv.push('mtp');
  if ($('p-noopoffload').checked) adv.push('no-op-offload');
  if ($('p-metrics').checked) adv.push('metrics');
  if ($('p-nowebui').checked) adv.push('no-webui');
  if (Number($('p-parallel').value) > 1) adv.push(`np ${$('p-parallel').value}`);
  if (Number($('p-timeout').value) > 0) adv.push(`-to ${$('p-timeout').value}`);
  const ctk = $('p-ctk').value;
  const ctv = $('p-ctv').value;
  if (ctk !== d.cacheTypeK || ctv !== d.cacheTypeV) adv.push(`KV ${ctk}/${ctv}`);
  set('popt-adv-val', adv.length ? adv.join(' · ') : '全部默认');
}

/** 选项摘要在拿不到主进程默认值时的兜底（与 models.js 的 PARAM_DEFAULTS 一致） */
const PARAM_DEFAULTS_FALLBACK = {
  temperature: '0.6', topP: '0.95', minP: '0.0', topK: 20,
  repeatPenalty: '1.0', presencePenalty: '0.0',
  cacheTypeK: 'q8_0', cacheTypeV: 'q8_0',
};

/** 把 ninfer 参数填进输入框 */
function fillNinferFields(nf) {
  $('p-nf-kvdtype').value = nf.kvDtype || 'q4';
  $('p-nf-spec').value = nf.spec === undefined ? 'mtp' : (nf.spec || '');
  $('p-nf-prefill').value = nf.prefillChunk || 512;
  $('p-nf-draft').value = nf.draftTokens || 3;
  $('p-nf-thinking').value = nf.thinkingBudget === undefined ? 2048 : nf.thinkingBudget;
  $('p-nf-visiontokens').value = nf.visionMaxTokens === undefined ? 2048 : nf.visionMaxTokens;
  $('p-nf-vision').checked = nf.vision !== false;
  $('p-nf-embedding').checked = nf.embeddingHost !== false;
  $('p-nf-nocudagraph').checked = nf.noCudaGraph !== false;
}

/** 运行中把 NInfer 输入一并锁上 */
function setNinferInputsDisabled(disabled) {
  ['p-nf-kvdtype', 'p-nf-spec', 'p-nf-prefill', 'p-nf-draft', 'p-nf-thinking',
   'p-nf-visiontokens', 'p-nf-vision', 'p-nf-embedding', 'p-nf-nocudagraph']
    .forEach((id) => { const el = $(id); if (el) el.disabled = disabled; });
}

/** 收集 NInfer 参数输入 */
function collectNinferFields() {
  const num = (id, d) => {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? v : d;
  };
  return {
    kvDtype: $('p-nf-kvdtype').value,
    spec: $('p-nf-spec').value,
    prefillChunk: num('p-nf-prefill', 512),
    draftTokens: num('p-nf-draft', 3),
    thinkingBudget: num('p-nf-thinking', 2048),
    visionMaxTokens: num('p-nf-visiontokens', 2048),
    vision: $('p-nf-vision').checked,
    embeddingHost: $('p-nf-embedding').checked,
    noCudaGraph: $('p-nf-nocudagraph').checked,
  };
}

/** 只刷新命令预览（不动输入框，避免打断正在输入的用户） */
/**
 * 取当前参数页里填的启动选项（未保存也算）。
 *
 * 预览要回答的是「照现在这样点保存，命令会变成什么」，所以不能只读已保存的
 * 配置，得把界面上的实时值一起带上。主进程只接受白名单字段。
 */
function previewOptsOf(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) return null;
  if (m.engine === 'ninfer') {
    // NInfer 的参数收在 ninfer 子对象里，主进程用 ninfer 分支单独处理
    return null;
  }
  return {
    ctxK: ctxValueOf(id),
    noMmprojOffload: $('p-nommprojoffload').checked,
    loadMode: $('p-loadmode').value,
    gpuLayers: intOf('p-ngl', -1),
    splitMode: $('p-splitmode').value,
    kvOffload: $('p-kvoffload').checked,
    threads: intOf('p-threads', -1),
    threadsBatch: intOf('p-threadsbatch', -1),
    batch: intOf('p-batch', 2048),
    ubatch: intOf('p-ubatch', 512),
    fits: $('p-fits').checked,
    jinja: $('p-jinja').checked,
    chatTemplateFile: $('p-chattpl').value.trim(),
    reasoningFormat: $('p-reasoningfmt').value,
    temperature: $('p-temp').value,
    topP: $('p-topp').value,
    topK: intOf('p-topk', 20),
    minP: $('p-minp').value,
    repeatPenalty: $('p-repeatpenalty').value,
    presencePenalty: $('p-presencepenalty').value,
    ctxShift: $('p-ctxshift').checked,
    flashAttn: $('p-flashattn').checked,
    useMtp: $('p-usemtp').checked,
    noOpOffload: $('p-noopoffload').checked,
    metrics: $('p-metrics').checked,
    noWebui: $('p-nowebui').checked,
    parallel: intOf('p-parallel', 1),
    timeout: intOf('p-timeout', 0),
    cacheTypeK: $('p-ctk').value,
    cacheTypeV: $('p-ctv').value,
    kvmem: $('p-kvmem').checked,
    // 只有命令框里真的是一段「自定义命令」时才把它当覆盖传下去。
    // 没自定义过时框里显示的是基准命令本身，若原样当覆盖传下去，
    // 主进程会把它当成用户手改的内容（受保护项还会被挪位），
    // 于是每条命令都被判成「已自定义」，改选项再也不刷新命令预览。
    cmdOverride: cmdEditing ? $('p-cmd').value : savedCmdOverride,
  };
}

/** 命令框里当前这段自定义命令（没自定义过就是空串） */
let savedCmdOverride = '';

/** 读一个整数输入框，取不到就用兜底值 */
function intOf(id, d) {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? v : d;
}

/** 命令框是否处于「用户手改过」的状态（改了就不再被选项覆盖） */
let cmdEditing = false;

/**
 * 打上/去掉命令框的「已自定义」样式与标记。
 * 手改过的命令右边会出现「已自定义」小标和「重新生成」按钮，
 * 选项区整体变暗，提示改选项已经不影响命令了。
 */
function setCmdCustom(on) {
  const ta = $('p-cmd');
  if (ta) ta.classList.toggle('custom', !!on);
  const flag = $('p-cmd-flag');
  if (flag) flag.hidden = !on;
  const regen = $('p-cmd-regen');
  if (regen) regen.hidden = !on;
  const opts = document.querySelector('.poptions');
  if (opts) opts.classList.toggle('locked', !!on);
  const warn = $('p-cmd-warn');
  if (warn) {
    // 「-m / --mmproj / --host / --port」由管理器接管：模型文件、端口这些
    // 必须和界面上的配置一致，否则界面显示的端口和实际监听的端口会对不上。
    warn.hidden = !on;
    warn.textContent = on
      ? '已使用自定义命令。模型文件、投影文件、监听地址与端口仍由管理器接管，'
        + '这几项会以界面配置为准；其余参数以你写的为准。'
      : '';
  }
}

async function refreshCmd() {
  if (!paramsModelId) return;
  const ctxK = ctxValueOf(paramsModelId);
  const r = await window.api.modelsArgs(paramsModelId, ctxK, previewOptsOf(paramsModelId));
  if (!r || !r.ok) {
    $('p-cmd').value = '（组装失败：' + ((r && r.error) || '未知原因') + '）';
    $('p-cmd-meta').textContent = '';
    setCmdCustom(false);
    return;
  }

  // 记下基准命令：保存时用它判断命令框里是不是真的改过，
  // 「重新生成」也直接用它回填，不必再往主进程跑一趟。
  const m = MODELS.find((x) => x.id === paramsModelId);
  if (m) m.baseCommand = r.baseCommand || r.command;

  // 正在输入命令时绝不回写，否则会把用户敲到一半的内容冲掉
  if (!cmdEditing) {
    const saved = (r.cmdOverride || '').trim();
    if (saved) {
      $('p-cmd').value = saved;
      savedCmdOverride = saved;
      setCmdCustom(true);
    } else {
      // 没自定义过就显示按选项拼出来的基准命令，用户可以在此基础上改
      $('p-cmd').value = r.command;
      savedCmdOverride = '';
      setCmdCustom(false);
    }
  }

  const bits = [`上下文 ${r.ctxK}K = ${r.ctxTokens} tokens`];
  if (r.engine === 'ninfer') {
    bits.push('NInfer');
    const nf = r.ninfer || {};
    if (nf.kvDtype) bits.push(`KV ${nf.kvDtype}`);
    if (nf.spec) bits.push(`投机 ${nf.spec}`);
    if (nf.vision) bits.push('视觉');
  } else {
    if (r.hasMmproj) bits.push(r.noMmprojOffload ? 'mmproj 留在 CPU' : 'mmproj 卸载到 GPU');
  }
  if (r.running) bits.push('运行中');
  $('p-cmd-meta').textContent = bits.join(' · ');
}

/**
 * 更新上下文输入框旁边的换算提示。
 * NInfer 的上下文和 llama.cpp 一样按 K 存，但换算都是 ×1024。
 */
function updateCtxNote(isNinfer) {
  const el = $('p-ctx-note');
  if (!el) return;
  const k = Number($('p-ctx').value) || 0;
  const engine = isNinfer === undefined
    ? ((MODELS.find((x) => x.id === paramsModelId) || {}).engine === 'ninfer')
    : isNinfer;
  el.textContent = k > 0
    ? `= ${k * 1024} tokens${engine ? '（NInfer）' : ''}`
    : '';
}

/** 取当前参数页里填的上下文（K）；取不到就回退到配置值 */
function ctxValueOf(id) {
  const inp = $('p-ctx');
  // 只有参数页显示的就是这个模型时，输入框里的值才可信
  if (inp && (!id || id === paramsModelId)) {
    const v = Number(inp.value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const m = MODELS.find((x) => x.id === id);
  return m ? m.ctxK : undefined;
}

/** 保存当前模型的启动参数 */
async function saveParams() {
  if (!paramsModelId || paramsSaving) return;
  paramsSaving = true;
  $('p-save').disabled = true;
  $('p-status').textContent = '保存中…';
  $('p-status').className = 'phint';

  // 按引擎决定参数写到哪：NInfer 的参数收在 ninfer 子对象里
  const m = MODELS.find((x) => x.id === paramsModelId) || {};
  const isNinfer = m.engine === 'ninfer';

  // 上下文对所有引擎都存顶层 ctxK
  const ctxK = Math.round(Number($('p-ctx').value));
  if (!Number.isFinite(ctxK) || ctxK < 1) {
    paramsSaving = false;
    $('p-save').disabled = false;
    $('p-status').textContent = '上下文需为不小于 1 的整数';
    $('p-status').className = 'phint err';
    return;
  }

  let patch;
  if (isNinfer) {
    const nf = {
      ...(m.ninfer || {}),
      ...collectNinferFields(),
    };
    patch = {
      ctxK,
      ninfer: nf,
      // 顶层 vision 与 ninfer.vision 保持同步，避免两处显示不一致
      vision: nf.vision !== false,
      cmdOverride: cmdOverrideToSave(m),
    };
  } else {
    patch = {
      ctxK,
      noMmprojOffload: $('p-nommprojoffload').checked,
      loadMode: $('p-loadmode').value,
      gpuLayers: intOf('p-ngl', -1),
      splitMode: $('p-splitmode').value,
      kvOffload: $('p-kvoffload').checked,
      threads: intOf('p-threads', -1),
      threadsBatch: intOf('p-threadsbatch', -1),
      batch: intOf('p-batch', 2048),
      ubatch: intOf('p-ubatch', 512),
      fits: $('p-fits').checked,
      jinja: $('p-jinja').checked,
      chatTemplateFile: $('p-chattpl').value.trim(),
      reasoningFormat: $('p-reasoningfmt').value,
      temperature: $('p-temp').value,
      topP: $('p-topp').value,
      topK: intOf('p-topk', 20),
      minP: $('p-minp').value,
      repeatPenalty: $('p-repeatpenalty').value,
      presencePenalty: $('p-presencepenalty').value,
      ctxShift: $('p-ctxshift').checked,
      flashAttn: $('p-flashattn').checked,
      useMtp: $('p-usemtp').checked,
      noOpOffload: $('p-noopoffload').checked,
      metrics: $('p-metrics').checked,
      noWebui: $('p-nowebui').checked,
      parallel: intOf('p-parallel', 1),
      timeout: intOf('p-timeout', 0),
      cacheTypeK: $('p-ctk').value,
      cacheTypeV: $('p-ctv').value,
      kvmem: $('p-kvmem').checked,
      cmdOverride: cmdOverrideToSave(m),
    };
  }

  const res = await window.api.modelsUpdate(paramsModelId, patch);

  paramsSaving = false;
  $('p-save').disabled = false;

  if (!res.ok) {
    $('p-status').textContent = res.error || '保存失败';
    $('p-status').className = 'phint err';
    toast(res.error || '保存失败', 'err');
    return;
  }

  $('p-status').textContent = '已保存';
  $('p-status').className = 'phint ok';
  paramsDirty = false;
  toast('启动参数已保存，下次启动生效', 'ok');
  await refresh();
  await loadParams();
}

/**
 * 决定这次要保存的「命令覆盖」。
 *
 * 只有命令和界面选项拼出来的基准命令确实不一样时才存覆盖：
 * 一样就存空，这样以后改选项依然能刷新命令，不会莫名其妙被旧命令钉死。
 */
function cmdOverrideToSave(m) {
  const text = ($('p-cmd').value || '').trim();
  if (!text || text.startsWith('（')) return '';
  const base = (m.baseCommand || '').trim();
  if (base && text === base) return '';
  return text;
}

/**
 * 恢复默认参数：把该引擎的启动参数还原成出厂值。
 *
 * 参数填错导致模型起不来时，靠这个一键回到已知可用的配置，
 * 不用手工回忆每个值原本是什么。默认值由主进程给（models.js 的
 * PARAM_DEFAULTS），界面不另存一份，避免两处对不上。
 */
async function restoreDefaults() {
  if (!paramsModelId || paramsSaving) return;

  const m = MODELS.find((x) => x.id === paramsModelId) || {};
  const isNinfer = m.engine === 'ninfer';
  const name = m.name || paramsModelId;

  const msg = isNinfer
    ? `把「${name}」的启动参数恢复成默认值？\n\n会重置上下文、KV 精度、投机解码、视觉等全部选项。`
      + '\n保存前不会写盘。'
    : `把「${name}」的启动参数恢复成默认值？\n\n会重置上下文、显存与卸载、`
      + '性能与批处理、对话模板、采样、高级、KVMem，以及自定义启动命令。\n保存前不会写盘。';
  if (!confirm(msg)) return;

  const r = await window.api.modelDefaults(paramsModelId);
  if (!r || !r.ok) {
    toast((r && r.error) || '取默认参数失败', 'err');
    return;
  }

  // 只填进输入框并标脏，用户确认无误后再点「保存参数」——
  // 直接落盘的话，误点一下就再也回不去了。
  fillLlamaFields(r);
  if (isNinfer) fillNinferFields(r.ninfer || {});

  // 恢复默认＝丢掉自定义命令，让命令重新由选项决定
  cmdEditing = false;
  setCmdCustom(false);

  paramsDirty = true;
  updateCtxNote(isNinfer);
  updateOptSummaries(isNinfer, !!m.mmproj, m);
  await refreshCmd();

  $('p-status').textContent = '已填入默认参数，点「保存参数」生效';
  $('p-status').className = 'phint';
  toast('已填入默认参数，确认后点保存', 'ok');
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

$('btn-min').addEventListener('click', () => window.api.winMinimize());
$('btn-max').addEventListener('click', () => window.api.winMaximize());
$('btn-close').addEventListener('click', () => window.api.winClose());
$('btn-clear').addEventListener('click', async () => {
  await window.api.clearLogs();
  $('log').innerHTML = '';
});

$('btn-autoscroll').addEventListener('click', (e) => {
  autoscroll = !autoscroll;
  e.target.textContent = '自动滚动：' + (autoscroll ? '开' : '关');
});

// 状态总览的快捷操作
$('btn-open-webui').addEventListener('click', () => {
  const cur = MODELS.find((m) => m.id === STATUS.current);
  const port = cur ? cur.port : (MODELS.find((m) => STATUS.ports[m.port]) || {}).port;
  if (!port) { toast('没有正在运行的模型', 'err'); return; }
  window.api.openUrl(`http://127.0.0.1:${port}`);
});
$('btn-open-datadir').addEventListener('click', () => {
  window.api.openDataDir();
});

// 启动参数模块
$('p-save').addEventListener('click', saveParams);
$('p-restore').addEventListener('click', restoreDefaults);

// 所有 llama.cpp 启动选项：改了就标脏 + 刷新摘要与命令预览。
// 命令框手改过之后选项不再影响命令行，但仍然标脏，免得改了半天没保存。
const LLAMA_OPTION_IDS = [
  'p-nommprojoffload', 'p-loadmode', 'p-ngl', 'p-splitmode', 'p-kvoffload',
  'p-threads', 'p-threadsbatch', 'p-batch', 'p-ubatch', 'p-fits',
  'p-jinja', 'p-chattpl', 'p-reasoningfmt',
  'p-temp', 'p-topp', 'p-topk', 'p-minp', 'p-repeatpenalty', 'p-presencepenalty',
  'p-ctxshift', 'p-flashattn', 'p-usemtp', 'p-noopoffload', 'p-metrics', 'p-nowebui',
  'p-parallel', 'p-timeout', 'p-ctk', 'p-ctv', 'p-kvmem',
];
LLAMA_OPTION_IDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  // 文本框用 input（边打边刷新），其余用 change
  const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'number')
    ? 'change' : 'input';
  el.addEventListener(evt, () => {
    paramsDirty = true;
    updateOptSummaries();
    if (!cmdEditing) refreshCmd();
  });
});

// 上下文：改了就标脏 + 刷新换算提示与命令预览
$('p-ctx').addEventListener('input', () => {
  paramsDirty = true;
  updateCtxNote();
  updateOptSummaries();
  if (!cmdEditing) refreshCmd();
});

// NInfer 参数改动同样标脏并刷新命令预览
['p-nf-kvdtype', 'p-nf-spec', 'p-nf-prefill', 'p-nf-draft', 'p-nf-thinking',
 'p-nf-visiontokens', 'p-nf-vision', 'p-nf-embedding', 'p-nf-nocudagraph']
  .forEach((id) => {
    $(id).addEventListener('change', () => {
      paramsDirty = true;
      updateOptSummaries();
      if (!cmdEditing) refreshCmd();
    });
  });

/* ---- 启动命令框：可以直接改，改了就覆盖按选项拼出来的命令 ---- */

// 一开始敲就进入「编辑中」：此后选项不再回写命令，避免把用户写的内容冲掉
$('p-cmd').addEventListener('input', () => {
  cmdEditing = true;
  savedCmdOverride = $('p-cmd').value;
  // 走统一的标记逻辑，别在这里手改 flag/regen：选项区变暗和提示文案
  // 都在 setCmdCustom 里，漏掉一处就会出现「标了已自定义但选项还能改」的错觉。
  setCmdCustom(true);
  paramsDirty = true;
});

// 改完（失焦）再把这段命令交给主进程比对一次。
// 顺序很关键：必须先把用户写的内容记进 savedCmdOverride 再交还控制权，
// 否则 refreshCmd 拿到的还是上一轮的旧值，用户的修改会被直接抹掉。
$('p-cmd').addEventListener('blur', async () => {
  const typed = $('p-cmd').value;
  cmdEditing = false;
  savedCmdOverride = typed;
  await refreshCmd();
  paramsDirty = true;
});

// 重新生成：丢弃手改，回到按选项拼出来的命令
$('p-cmd-regen').addEventListener('click', async () => {
  if (!confirm('丢弃手改的启动命令，按下面的选项重新生成？')) return;
  cmdEditing = false;
  savedCmdOverride = '';
  setCmdCustom(false);
  const m = MODELS.find((x) => x.id === paramsModelId);
  // baseCommand 是上次刷新时的基准命令，直接用即可
  if (m && m.baseCommand) $('p-cmd').value = m.baseCommand;
  await refreshCmd();
  paramsDirty = true;
  toast('已按选项重新生成命令，点「保存参数」生效', 'ok');
});

$('p-copy').addEventListener('click', async () => {
  const text = $('p-cmd').value || '';
  if (!text || text.startsWith('（')) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('启动命令已复制', 'ok');
  } catch (_) {
    // 剪贴板不可用时退回选中文本，让用户手动复制
    $('p-cmd').select();
    toast('已选中命令，按 Ctrl+C 复制', 'ok');
  }
});

// 侧边栏视图切换
document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// 模型管理
$('btn-scan').addEventListener('click', doScan);
$('scan-close').addEventListener('click', () => { $('scan-box').hidden = true; });
$('btn-add').addEventListener('click', () => openModal(null));
$('btn-delete-models').addEventListener('click', openDeleteModal);
$('btn-reset-models').addEventListener('click', async () => {
  if (!confirm('恢复内置的三套预置模型？\n\n会清空当前模型列表并重新导入预置配置，不会删除 gguf 文件。')) return;
  const res = await window.api.modelsReset();
  if (!res.ok) { toast(res.error || '恢复失败', 'err'); return; }
  toast('已恢复预置模型', 'ok');
  await refreshManage();
  await refresh();
});

// 批量删除弹窗
$('del-close').addEventListener('click', closeDeleteModal);
$('del-cancel').addEventListener('click', closeDeleteModal);
$('del-confirm').addEventListener('click', confirmDelete);
$('del-with-files').addEventListener('change', updateDeletePreview);
$('del-modal').addEventListener('mousedown', (e) => {
  if (e.target === $('del-modal')) closeDeleteModal();
});

$('modal-close').addEventListener('click', closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-save').addEventListener('click', saveModal);
$('modal').addEventListener('mousedown', (e) => {
  if (e.target === $('modal')) closeModal();   // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});

// 选文件后自动填名称（仅 llama.cpp；NInfer 走另一个监听）
$('f-file').addEventListener('change', () => {
  if ($('f-engine').value === 'ninfer') return;
  const f = SCAN_FILES.find((x) => x.file === $('f-file').value);
  if (!f) return;
  if (!$('f-name').value.trim()) {
    $('f-name').value = bestName(f);
  }
  if (!$('f-alias').value.trim()) {
    $('f-alias').value = f.file.replace(/\.gguf$/i, '');
  }
  if (f.meta && f.meta.contextLength) {
    $('f-ctx').value = Math.max(1, Math.round(f.meta.contextLength / 1024));
  }
});

$('f-file-refresh').addEventListener('click', async () => {
  const scan = await window.api.modelsScan(SETTINGS.modelsDir);
  SCAN_FILES = scan.ok ? (scan.files || []) : [];

  // NInfer 的文件在 WSL 里，一并刷新
  try {
    const ns = await window.api.ninferScan();
    NINFER_FILES = ns && ns.ok ? [...(ns.wsl || []), ...(ns.local || [])] : [];
  } catch (_) { /* 忽略 */ }

  applyEngineToModal($('f-engine').value);
  toast(`已刷新，共 ${SCAN_FILES.length} 个本地文件、${NINFER_FILES.length} 个 NInfer 模型`, 'ok');
});

// 设置
$('rail-settings').addEventListener('click', () => {
  openSettings($('settings').hidden);
});
$('settings-close').addEventListener('click', () => openSettings(false));

['set-theme', 'set-zoom', 'set-ctx', 'set-timeout', 'set-autochat',
 'set-loglimit', 'set-logfilter', 'set-tray'].forEach((id) => {
  $(id).addEventListener('change', saveFromPanel);
});

// 开机自启：直接写注册表，不经过 settings.json
$('set-autostart').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const res = await window.api.autostartSet(want);
  if (!res.ok) {
    e.target.checked = !want;
    toast(res.error || '设置失败', 'err');
    return;
  }
  toast(want ? '已开启开机自启' : '已关闭开机自启', 'ok');
});

$('btn-browse-server').addEventListener('click', async () => {
  const r = await window.api.pickPath('file');
  if (r.ok) { $('set-server').value = r.path; saveFromPanel(); }
});
$('btn-browse-models').addEventListener('click', async () => {
  const r = await window.api.pickPath('dir');
  if (r.ok) { $('set-modelsdir').value = r.path; saveFromPanel(); }
});

// NInfer 设置
['set-nf-serve', 'set-nf-cli', 'set-nf-modelsdir'].forEach((id) => {
  $(id).addEventListener('change', saveNinferSettings);
});
$('set-nf-distro').addEventListener('change', saveNinferSettings);
$('set-nf-autoscan').addEventListener('change', saveNinferSettings);

// 弹窗里切换引擎：换控件、清一下不适用的选项
$('f-engine').addEventListener('change', () => {
  const engine = $('f-engine').value;
  applyEngineToModal(engine);
  if (engine === 'ninfer') {
    $('f-mtp').checked = false;
    $('f-nommprojoffload').checked = false;
    $('f-engine-hint').textContent = 'NInfer 跑在 WSL 里，模型文件请填 WSL 内的绝对路径';
  } else {
    $('f-engine-hint').textContent = '决定用哪个引擎拉起这个模型';
  }
});

// NInfer 下拉选一个就回填到文本框 + 自动起名
$('f-file').addEventListener('change', () => {
  if ($('f-engine').value !== 'ninfer') return;
  const p = $('f-file').value;
  if (!p) return;
  $('f-file-text').value = p;
  const f = NINFER_FILES.find((x) => x.path === p);
  const base = (f ? f.file : p.split('/').pop()).replace(/\.ninfer$/i, '');
  const id = (f && f.meta && f.meta.modelId) || base;
  if (!$('f-name').value.trim()) $('f-name').value = id;
  if (!$('f-alias').value.trim()) $('f-alias').value = id;
});

$('btn-reset').addEventListener('click', async () => {
  const res = await window.api.resetSettings();
  if (res.ok) {
    SETTINGS = res.settings;
    fillSettings(SETTINGS);
    document.documentElement.style.zoom = '';
    logSysOnly = false;
    applyLogFilter();
    toast('已恢复默认设置', 'ok');
  }
});

window.api.onLog((entry) => appendLog(entry));
window.api.onStatus((s) => {
  STATUS = s;
  renderModels();
  renderStatus();
  // 运行状态变了要重新算参数能否编辑 + 命令预览里的「运行中」标记
  if (!$('pane-params').classList.contains('hidden')) loadParams();
});
window.api.onWindowState(() => {});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(async function init() {
  SETTINGS = await window.api.getSettings();

  if (SETTINGS.zoom && String(SETTINGS.zoom) !== '1') {
    document.documentElement.style.zoom = String(SETTINGS.zoom);
  }

  logSysOnly = !!SETTINGS.logSysOnly;
  applyLogFilter();
  fillSettings(SETTINGS);

  initSplitter();
  // 两页左栏共用记住的宽度
  setSplitTarget('pane-models');

  const logs = await window.api.getLogs();
  logs.forEach((e) => appendLog(e));
  await refresh();
  await refreshManage();
  await loadParams();
  await tickHardware();
  setInterval(tickHardware, 3000);
})();
