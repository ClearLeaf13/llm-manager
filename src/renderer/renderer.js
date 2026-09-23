'use strict';

const $ = (id) => document.getElementById(id);

let MODELS = [];
let STATUS = { running: false, pids: [], ports: {}, current: null, starting: false };
let SETTINGS = {};
let autoscroll = true;
let logSysOnly = false;

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
    if (m.vision) badges.push('<span class="badge v">视觉</span>');
    if (m.useMtp) badges.push('<span class="badge mtp">MTP</span>');
    if (isActive) badges.push('<span class="badge run">运行中</span>');

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
               data-ctx="${m.id}" ${isActive ? 'disabled' : ''} />
        <span class="unit">K = <b>${m.ctxK * 1024}</b> tokens</span>
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

    // 实时显示换算后的 token 数，避免单位歧义
    const inp = card.querySelector(`input[data-ctx="${m.id}"]`);
    const unit = card.querySelector('.unit');
    const syncUnit = () => {
      const k = Number(inp.value) || 0;
      unit.innerHTML = `K = <b>${k * 1024}</b> tokens`;
    };
    inp.addEventListener('input', syncUnit);
    syncUnit();

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

  // 状态
  const st = $('st-state');
  if (loading) { st.innerHTML = '<span class="pill load">加载中…</span>'; }
  else if (running) { st.innerHTML = '<span class="pill run">运行中</span>'; }
  else { st.innerHTML = '<span class="pill idle">未运行</span>'; }

  // 当前模型
  const cur = MODELS.find((m) => m.id === STATUS.current);
  $('st-model').textContent = cur ? cur.alias : (running ? '未知 (外部启动)' : '—');

  // PID
  $('st-pid').textContent = STATUS.pids && STATUS.pids.length ? STATUS.pids.join(', ') : '—';

  // 端口监听补充
  if (!cur && running) {
    const open = MODELS.filter((m) => STATUS.ports[m.port]);
    if (open.length) $('st-model').textContent = open[0].alias + ' (端口)';
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

async function tickHardware() {
  // 内存
  try {
    const m = await window.api.getMemory();
    $('st-mem').textContent =
      `${m.freeGb.toFixed(1)} / ${m.totalGb.toFixed(1)} GB`;
  } catch (_) { $('st-mem').textContent = '—'; }

  // 显存
  try {
    const g = await window.api.getGpu();
    const el = $('st-vram');
    if (!g) {
      el.textContent = '不可用';
      el.title = '未检测到 NVIDIA GPU 或 nvidia-smi';
    } else {
      el.textContent = `${g.usedGb.toFixed(1)} / ${g.totalGb.toFixed(1)} GB`;
      el.title = `${g.name} · 占用率 ${g.util}%`;
    }
  } catch (_) { $('st-vram').textContent = '—'; }
}

/* ------------------------------------------------------------------ *
 * 侧边栏
 * ------------------------------------------------------------------ */

function switchView(view) {
  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  const showModels = view === 'models';
  $('pane-models').classList.toggle('hidden', !showModels);
  $('split-1').classList.toggle('hidden', !showModels || $('settings').hidden === false);
  $('pane-console').classList.remove('hidden');
}

/* ------------------------------------------------------------------ *
 * 分栏拖动
 * ------------------------------------------------------------------ */

function initSplitter() {
  const sp = $('split-1');
  const pane = $('pane-models');
  const shell = document.querySelector('.shell');

  let dragging = false;

  const onDown = (e) => {
    dragging = true;
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
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
    // 记住宽度
    window.api.saveSettings({ modelsWidth: parseInt(pane.style.width, 10) || 280 });
  };

  sp.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
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
  s.hidden = !open;
  $('rail-settings').classList.toggle('active', open);
  // 设置打开时隐藏分栏条，避免和面板边框挤在一起
  $('split-1').classList.toggle('hidden', open || $('pane-models').classList.contains('hidden'));
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

// 侧边栏视图切换
document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// 设置
$('rail-settings').addEventListener('click', () => {
  openSettings($('settings').hidden);
});
$('settings-close').addEventListener('click', () => openSettings(false));

['set-theme', 'set-zoom', 'set-ctx', 'set-timeout', 'set-autochat',
 'set-loglimit', 'set-logfilter'].forEach((id) => {
  $(id).addEventListener('change', saveFromPanel);
});

$('btn-browse-server').addEventListener('click', async () => {
  const r = await window.api.pickPath('file');
  if (r.ok) { $('set-server').value = r.path; saveFromPanel(); }
});
$('btn-browse-models').addEventListener('click', async () => {
  const r = await window.api.pickPath('dir');
  if (r.ok) { $('set-modelsdir').value = r.path; saveFromPanel(); }
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
window.api.onStatus((s) => { STATUS = s; renderModels(); renderStatus(); });
window.api.onWindowState(() => {});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(async function init() {
  SETTINGS = await window.api.getSettings();

  // 恢复模型栏宽度
  if (SETTINGS.modelsWidth) {
    const w = Math.max(160, parseInt(SETTINGS.modelsWidth, 10) || 280);
    $('pane-models').style.flexBasis = w + 'px';
    $('pane-models').style.width = w + 'px';
  }

  if (SETTINGS.zoom && String(SETTINGS.zoom) !== '1') {
    document.documentElement.style.zoom = String(SETTINGS.zoom);
  }

  logSysOnly = !!SETTINGS.logSysOnly;
  applyLogFilter();
  fillSettings(SETTINGS);

  initSplitter();

  const logs = await window.api.getLogs();
  logs.forEach((e) => appendLog(e));
  await refresh();
  await tickHardware();
  setInterval(tickHardware, 3000);
})();
