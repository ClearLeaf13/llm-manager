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

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderModels() {
  // 有输入框正在编辑时不要整块重建 —— 重建会销毁输入框，
  // 用户刚敲进去的值会被 m.ctxK 覆盖回去（"改了又变回去"的现场）
  if (ctxEditing()) return;

  const box = $('model-list');
  box.innerHTML = '';

  MODELS.forEach((m) => {
    const isActive = STATUS.current === m.id
      || (STATUS.running && STATUS.ports[m.port]);

    const card = document.createElement('div');
    card.className = 'card'
      + (isActive ? ' active' : '')
      + (!m.fileExists ? ' missing' : '');

    const badges = [];
    if (m.engine === 'ninfer') badges.push('<span class="badge nf">NInfer</span>');
    if (m.vision) badges.push('<span class="badge v">视觉</span>');
    if (m.useMtp) badges.push('<span class="badge mtp">MTP</span>');
    if (isActive) badges.push('<span class="badge run">运行中</span>');

    // 运行中禁用上下文输入 —— 用与 isActive 相同的判断，避免按钮显示「停止」
    // 但输入框却还能改（外部启动的实例只满足 ports 条件）
    const ctxLocked = isActive;
    const ctxTip = ctxLocked
      ? '模型运行中，需停止后修改'
      : '单位 K；改完自动保存到配置，下次启动生效，点「启动」则本次立即生效';

    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${esc(m.name)}</span>
        ${badges.join('')}
      </div>
      <div class="card-meta">
        ${m.sizeGb ? m.sizeGb.toFixed(2) + ' GB' : '文件缺失'} · 端口 ${m.port}
      </div>
      <div class="card-foot">
        <input type="number" min="1" max="512" step="1" value="${m.ctxK}"
               data-ctx="${m.id}" ${ctxLocked ? 'disabled' : ''} title="${ctxTip}" />
        <span class="unit">K</span>
      </div>
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

    btn.addEventListener('click', () => {
      if (isActive) doStop();
      else doStart(m.id, card.querySelector(`input[data-ctx="${m.id}"]`).value);
    });

    card.querySelector('.card-foot').appendChild(btn);

    const inp = card.querySelector(`input[data-ctx="${m.id}"]`);
    const unit = card.querySelector('.unit');
    const syncUnit = () => {
      const k = Number(inp.value) || 0;
      unit.textContent = k + 'K';
    };
    inp.addEventListener('input', syncUnit);

    // 改完就落盘。以前这个框只在本次启动生效、不写回配置，卡片每 5 秒重绘
    // 时又用 m.ctxK 填回去，看起来就像"改不了"。
    inp.addEventListener('change', () => {
      // busy 期间禁止被重绘覆盖，避免用户还在编辑时框里的值被刷回旧值
      inp.dataset.busy = '1';
      saveCtx(m.id, inp.value, inp);
    });

    // 正在编辑的框不被重绘覆盖（renderModels 会整块重建卡片 DOM）
    inp.addEventListener('focus', () => { inp.dataset.busy = '1'; });
    inp.addEventListener('blur', () => {
      inp.dataset.busy = '';
      // 编辑期间重绘被跳过，失焦后补一次，把卡片刷成当前真实状态
      refresh();
    });

    syncUnit();

    box.appendChild(card);
  });
}

/**
 * 把「快速启用」卡片里改的上下文写回配置。
 *
 * 这个框既当本次启动的参数（点「启动」时直接读它），也负责落盘，
 * 否则卡片重绘 / 重启应用就变回 models.json 里的旧值。
 *
 * @param {string} id 模型 id
 * @param {string|number} raw 输入框里的原始值
 * @param {HTMLInputElement} inp 输入框本体
 */
async function saveCtx(id, raw, inp) {
  const k = Math.round(Number(raw));
  if (!Number.isFinite(k) || k < 1) {
    const cur = MODELS.find((x) => x.id === id);
    if (cur) {
      inp.value = String(cur.ctxK);
      inp.dispatchEvent(new Event('input'));
    }
    inp.dataset.busy = '';
    return;
  }

  // 数值没变就不写盘，避免无意义的重绘
  if (String(k) === String(raw)) {
    const cur0 = MODELS.find((x) => x.id === id);
    if (cur0 && cur0.ctxK === k) {
      inp.dataset.busy = '';
      return;
    }
  }

  const res = await window.api.modelsUpdate(id, { ctxK: k });
  if (res.ok) {
    inp.value = String(k);
    inp.dispatchEvent(new Event('input'));
    await refresh();
    toast(`上下文已保存为 ${k}K，下次启动生效`, 'ok');
  } else {
    $('modal-error').textContent = res.error || '保存失败';
    toast(res.error || '保存失败', 'err');
    const cur = MODELS.find((x) => x.id === id);
    if (cur) {
      inp.value = String(cur.ctxK);
      inp.dispatchEvent(new Event('input'));
    }
  }
  inp.dataset.busy = '';
}

/** 是否有上下文输入框正在被编辑 —— 用于避免重绘把用户输入刷掉 */
function ctxEditing() {
  return !!document.querySelector('#model-list input[data-ctx][data-busy="1"]');
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

  // PID
  const pids = STATUS.pids && STATUS.pids.length ? STATUS.pids.join(', ') : '—';
  $('st-pid').textContent = pids;
  $('st-pid-sub').textContent = 'llama-server PID ' + pids;

  // 当前模型
  const cur = MODELS.find((m) => m.id === STATUS.current);
  let modelName = cur ? cur.alias : (running ? '未知 (外部启动)' : '—');
  let sub = '';
  if (cur) {
    sub = `端口 ${cur.port}${cur.vision ? ' · 多模态' : ''}${cur.useMtp ? ' · MTP' : ''}`;
  } else if (running) {
    const open = MODELS.filter((m) => STATUS.ports[m.port]);
    if (open.length) {
      modelName = open[0].alias;
      sub = `端口 ${open[0].port}（非管理器启动）`;
    }
  }
  $('st-model').textContent = modelName;
  $('st-model-sub').textContent = sub;

  renderEngineCard(cur);
}

/**
 * 推理引擎卡片：当前模型走的是哪条引擎路径。
 *
 * 引擎判定优先级：实际在跑的进程 > 当前模型的 engine 字段。
 * 这样即使是外部手动拉起的服务，也能显示对。
 */
function renderEngineCard(cur) {
  const el = $('st-engine');
  const sub = $('st-engine-sub');
  const nf = STATUS.ninfer || {};

  // 以真实进程为准
  const llamaRunning = STATUS.pids && STATUS.pids.length > 0;
  const ninferRunning = STATUS.ninferPids && STATUS.ninferPids.length > 0;

  let engine = null;
  if (ninferRunning) engine = 'ninfer';
  else if (llamaRunning) engine = 'llamacpp';
  else if (cur) engine = cur.engine || 'llamacpp';

  if (!engine) {
    el.textContent = '—';
    sub.textContent = '';
    return;
  }

  if (engine === 'ninfer') {
    el.textContent = 'NInfer';
    const bits = [];
    if (nf.distro) bits.push(`WSL ${nf.distro}`);
    if (ninferRunning) bits.push(`${nf.pids.length} 个进程`);
    else if (nf.distroState === 'stopped') bits.push('发行版未启动');
    else if (nf.distroState) bits.push(nf.distroState);
    sub.textContent = bits.join(' · ');
  } else {
    el.textContent = 'llama.cpp';
    const bits = [];
    if (llamaRunning) bits.push(`${STATUS.pids.length} 个进程`);
    else bits.push('未运行');
    if (cur && cur.ninfer === null && cur.engine === 'llamacpp') bits.push('本地 .gguf');
    sub.textContent = bits.join(' · ');
  }
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
function setBar(id, pct) {
  const el = $(id);
  if (!el) return;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = v + '%';
  el.className = 'sbar-fill' + (v >= 90 ? ' err' : v >= 75 ? ' warn' : '');
}

async function tickHardware() {
  // 内存
  try {
    const m = await window.api.getMemory();
    $('st-mem').textContent = `${m.freeGb.toFixed(1)} / ${m.totalGb.toFixed(1)} GB 可用`;
    const used = m.totalGb - m.freeGb;
    setBar('st-mem-bar', m.totalGb ? (used / m.totalGb) * 100 : 0);
  } catch (_) { $('st-mem').textContent = '—'; setBar('st-mem-bar', 0); }

  // 显存
  try {
    const g = await window.api.getGpu();
    const el = $('st-vram');
    if (!g) {
      el.textContent = '不可用';
      el.title = '未检测到 NVIDIA GPU 或 nvidia-smi';
      $('st-vram-bar').parentElement.style.visibility = 'hidden';
    } else {
      el.textContent = `${g.usedGb.toFixed(1)} / ${g.totalGb.toFixed(1)} GB`;
      el.title = `${g.name} · 占用率 ${g.util}%`;
      setBar('st-vram-bar', g.totalGb ? (g.usedGb / g.totalGb) * 100 : 0);
    }
  } catch (_) { $('st-vram').textContent = '—'; setBar('st-vram-bar', 0); }

  // 磁盘占用
  try {
    const d = await window.api.diskUsage();
    const el = $('st-disk');
    if (!d || (!d.totalGb && !d.usedGb)) {
      el.textContent = '—';
      el.title = '磁盘信息不可用';
      setBar('st-disk-bar', 0);
    } else {
      // 显示：模型合计 / 剩余可用
      el.textContent = `模型 ${d.usedGb.toFixed(1)} · 余 ${d.freeGb.toFixed(1)} GB`;
      el.title = `模型文件合计 ${d.usedGb.toFixed(2)} GB\n`
        + `所在盘 ${d.dir} 剩余 ${d.freeGb.toFixed(1)} GB`
        + (d.totalGb ? ` / 共 ${d.totalGb.toFixed(1)} GB` : '');
      // 进度条按整盘占用算，比只算模型体积更有参考价值
      const usedDisk = d.totalGb ? d.totalGb - d.freeGb : 0;
      setBar('st-disk-bar', d.totalGb ? (usedDisk / d.totalGb) * 100 : 0);
    }
  } catch (_) { $('st-disk').textContent = '—'; setBar('st-disk-bar', 0); }
}

/* ------------------------------------------------------------------ *
 * 侧边栏
 * ------------------------------------------------------------------ */

/**
 * 切换视图。只有两页：
 *   第一页 快速启用（左：模型卡 │ 右：状态总览）
 *   第二页 模型管理（左：模型列表 │ 右：启动参数 + 日志）
 *
 * 两页的左栏是不同的元素（pane-models / pane-manage），
 * 拖动条要跟着换绑定的目标，否则拖的是隐藏的那一个。
 */
function switchView(view) {
  const v = view === 'manage' ? 'manage' : 'models';

  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });

  const showManage = v === 'manage';

  // 左栏
  $('pane-models').classList.toggle('hidden', showManage);
  $('pane-manage').classList.toggle('hidden', !showManage);

  // 右栏
  $('pane-status').classList.toggle('hidden', showManage);
  $('pane-params').classList.toggle('hidden', !showManage);

  // 拖动条：两页都有，但作用对象不同
  setSplitTarget(showManage ? 'pane-manage' : 'pane-models');

  if (showManage) { refreshManage(); loadParams(); }
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
    const row = document.createElement('div');
    row.className = 'mrow'
      + (isActive ? ' active' : '')
      + (!m.fileExists ? ' missing' : '');

    const badges = [];
    if (m.vision) badges.push('<span class="badge v">视觉</span>');
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
    edit.addEventListener('click', () => openModal(m.id));
    acts.appendChild(edit);

    // 直接跳到启动参数页并选中该模型
    const pbtn = document.createElement('button');
    pbtn.className = 'mini';
    pbtn.textContent = '启动参数';
    pbtn.addEventListener('click', () => {
      paramsModelId = m.id;
      switchView('manage');
    });
    acts.appendChild(pbtn);
    // 删除统一走顶部「删除模型」按钮，避免误点单个卡片就删几十 GB

    row.appendChild(acts);
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

  const mains = SCAN_FILES.filter((f) => !f.mmproj && f.engine !== 'ninfer').length;
  const projs = SCAN_FILES.filter((f) => f.mmproj).length;
  const nfs = SCAN_FILES.filter((f) => f.engine === 'ninfer').length;

  const bits = [`${mains} 个模型`];
  if (projs) bits.push(`${projs} 个投影文件`);
  if (nfs) bits.push(`${nfs} 个 NInfer`);
  $('scan-title').textContent = `扫描结果：${bits.join(' · ')}`;

  list.innerHTML = '';

  if (!SCAN_FILES.length) {
    list.innerHTML = `<div class="empty">${esc(dir || '')}<br>没有找到 .gguf 或 .ninfer 文件</div>`;
    return;
  }

  SCAN_FILES.forEach((f) => {
    const added = MANAGED.some((m) => m.file === f.file || m.file === f.path);

    const item = document.createElement('div');
    item.className = 'scan-item' + (added ? ' added' : '');

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
      // 投影文件不能单独作为模型，提示用户去主模型里绑定
      const owners = MANAGED.filter((m) => m.mmproj === f.file);
      add.textContent = owners.length ? '已绑定' : '绑定';
      add.title = owners.length
        ? `已绑定到「${owners[0].name}」`
        : '投影文件需绑定到主模型：点主模型的「编辑」，在「视觉投影」里选择它';
      if (!owners.length) {
        add.addEventListener('click', () => {
          toast('请在主模型的「编辑」里，于「视觉投影」中选择该文件', 'ok');
        });
      }
      item.appendChild(add);
      list.appendChild(item);
      return;
    }

    item.classList.toggle('added', added);
    add.textContent = added ? '已添加' : '添加';
    if (!added) {
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
    }
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
    $('f-vision').checked = !!m.vision;
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
  // 切到 NInfer 时补一份默认参数，否则参数面板没有可编辑的值
  if (engine === 'ninfer') {
    const cur = editingId ? MANAGED.find((x) => x.id === editingId) : null;
    payload.ninfer = (cur && cur.ninfer) || undefined;
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
    $('p-cmd').textContent = '（还没有配置任何模型）';
    $('p-cmd-meta').textContent = '';
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
    $('p-nommprojoffload').checked = !!m.noMmprojOffload;
    $('p-extraargs').value = isNinfer
      ? ((m.ninfer && m.ninfer.extraArgs) || '')
      : (m.extraArgs || '');
    if (isNinfer) fillNinferFields(m.ninfer || {});
  } else {
    // 值已经从 store 加载过了，脏标记说明输入框里才是用户的最新意图
    $('p-status').textContent = '有未保存的改动';
    $('p-status').className = 'phint';
  }

  // llama.cpp 专属的 mmproj 开关在 NInfer 下没有意义，整行隐藏
  $('p-row-nommproj').hidden = isNinfer;
  $('p-ninfer-group').hidden = !isNinfer;
  $('p-extraargs-hint').textContent = isNinfer
    ? '追加到 ninfer-serve 命令末尾，按空格拆分；含空格的用引号包起来'
    : '本版本未内置的参数都填这里，按空格拆分；含空格的用引号包起来。会插在 --host 之前';

  $('p-nommprojoffload').disabled = running || !hasMmproj;
  $('p-extraargs').disabled = running;
  $('p-save').disabled = running;
  setNinferInputsDisabled(running);

  if (running) {
    $('p-status').textContent = '模型运行中，停止后才能改参数';
    $('p-status').className = 'phint err';
  }
  $('p-nommprojoffload-hint').textContent = hasMmproj
    ? '让视觉投影（mmproj）留在 CPU 内存，省约 1 GB 显存；仅多模态模型有效'
    : '该模型没有视觉投影文件，此项无效';

  await refreshCmd();
}

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
async function refreshCmd() {
  if (!paramsModelId) return;
  const ctxK = ctxValueOf(paramsModelId);
  const r = await window.api.modelsArgs(paramsModelId, ctxK);
  if (!r || !r.ok) {
    $('p-cmd').textContent = '（组装失败：' + ((r && r.error) || '未知原因') + '）';
    $('p-cmd-meta').textContent = '';
    return;
  }
  $('p-cmd').textContent = r.command;

  const bits = [`上下文 ${r.ctxK}K = ${r.ctxTokens} tokens`];
  if (r.engine === 'ninfer') {
    bits.push('NInfer');
    const nf = r.ninfer || {};
    if (nf.kvDtype) bits.push(`KV ${nf.kvDtype}`);
    if (nf.spec) bits.push(`投机 ${nf.spec}`);
    if (nf.vision) bits.push('视觉');
  } else {
    if (r.hasMmproj) bits.push(r.noMmprojOffload ? 'mmproj 留在 CPU' : 'mmproj 卸载到 GPU');
    if (r.extraArgs) bits.push('含补充参数');
  }
  if (r.running) bits.push('运行中');
  $('p-cmd-meta').textContent = bits.join(' · ');
}

/** 取快速启用卡片上的上下文值（那个框是启动时的真实来源） */
function ctxValueOf(id) {
  const inp = document.querySelector(`#model-list input[data-ctx="${id}"]`);
  const v = inp ? Number(inp.value) : NaN;
  if (Number.isFinite(v) && v > 0) return v;
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

  let patch;
  if (isNinfer) {
    patch = {
      ninfer: {
        ...(m.ninfer || {}),
        ...collectNinferFields(),
        extraArgs: $('p-extraargs').value,
      },
    };
  } else {
    patch = {
      noMmprojOffload: $('p-nommprojoffload').checked,
      extraArgs: $('p-extraargs').value,
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
$('p-nommprojoffload').addEventListener('change', () => { paramsDirty = true; refreshCmd(); });
$('p-extraargs').addEventListener('input', () => { paramsDirty = true; refreshCmd(); });

// NInfer 参数改动同样标脏并刷新命令预览
['p-nf-kvdtype', 'p-nf-spec', 'p-nf-prefill', 'p-nf-draft', 'p-nf-thinking',
 'p-nf-visiontokens', 'p-nf-vision', 'p-nf-embedding', 'p-nf-nocudagraph']
  .forEach((id) => {
    $(id).addEventListener('change', () => { paramsDirty = true; refreshCmd(); });
  });
$('p-copy').addEventListener('click', async () => {
  const text = $('p-cmd').textContent || '';
  if (!text || text.startsWith('（')) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('启动命令已复制', 'ok');
  } catch (_) {
    // 剪贴板不可用时退回选中文本，让用户手动复制
    const r = document.createRange();
    r.selectNodeContents($('p-cmd'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
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
