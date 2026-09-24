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

    // 运行中禁用上下文输入 —— 用与 isActive 相同的判断，避免按钮显示「停止」
    // 但输入框却还能改（外部启动的实例只满足 ports 条件）
    const ctxLocked = isActive;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${esc(m.name)}</span>
        ${badges.join('')}
      </div>
      <div class="card-meta">
        ${m.sizeGb ? m.sizeGb.toFixed(2) + ' GB' : '文件缺失'} · 端口 ${m.port}
        ${ctxLocked ? ' · <span class="lock">运行中不可改，需停止后修改</span>' : ''}
      </div>
      <div class="card-foot">
        <input type="number" min="1" max="512" step="1" value="${m.ctxK}"
               data-ctx="${m.id}" ${ctxLocked ? 'disabled' : ''}
               title="${ctxLocked ? '模型运行中，上下文需停止后修改（修改后保存到配置，下次启动生效）' : '启动时使用的上下文，改完点「启动」立即生效'}" />
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

  // 磁盘占用
  try {
    const d = await window.api.diskUsage();
    const el = $('st-disk');
    if (!d || (!d.totalGb && !d.usedGb)) {
      el.textContent = '—';
      el.title = '磁盘信息不可用';
    } else {
      // 显示：模型合计 / 剩余可用
      el.textContent = `${d.usedGb.toFixed(1)} / ${d.freeGb.toFixed(1)} GB`;
      el.title = `模型文件合计 ${d.usedGb.toFixed(2)} GB\n`
        + `所在盘 ${d.dir} 剩余 ${d.freeGb.toFixed(1)} GB`
        + (d.totalGb ? ` / 共 ${d.totalGb.toFixed(1)} GB` : '');
    }
  } catch (_) { $('st-disk').textContent = '—'; }
}

/* ------------------------------------------------------------------ *
 * 侧边栏
 * ------------------------------------------------------------------ */

function switchView(view) {
  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  const showModels = view === 'models';
  const showManage = view === 'manage';

  $('pane-models').classList.toggle('hidden', !showModels);
  $('pane-manage').classList.toggle('hidden', !showManage);

  // 左栏分栏条只在快速启用视图下出现
  $('split-1').classList.toggle('hidden',
    !showModels || $('settings').hidden === false);
  // 管理视图占满主区，分栏条隐藏
  $('split-2').classList.add('hidden');

  $('pane-console').classList.remove('hidden');

  // 进管理视图时刷新一次列表
  if (showManage) refreshManage();
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
  btn.disabled = false;
  btn.textContent = '自动扫描';

  if (!res.ok) { toast(res.error || '扫描失败', 'err'); return; }

  SCAN_FILES = res.files || [];
  renderScan(res.dir);

  if (!SCAN_FILES.length) toast('目录中没有找到 gguf 文件', 'err');
  else toast(`扫描到 ${SCAN_FILES.length} 个文件`, 'ok');
}

function renderScan(dir) {
  const box = $('scan-box');
  const list = $('scan-list');
  box.hidden = false;

  const mains = SCAN_FILES.filter((f) => !f.mmproj).length;
  const projs = SCAN_FILES.length - mains;
  $('scan-title').textContent =
    `扫描结果：${mains} 个模型${projs ? ` · ${projs} 个投影文件` : ''}`;

  list.innerHTML = '';

  if (!SCAN_FILES.length) {
    list.innerHTML = `<div class="empty">${esc(dir || '')}<br>没有找到 .gguf 文件</div>`;
    return;
  }

  SCAN_FILES.forEach((f) => {
    const added = MANAGED.some((m) => m.file === f.file);

    const item = document.createElement('div');
    item.className = 'scan-item' + (added ? ' added' : '');

    const metaBits = [f.sizeGb.toFixed(2) + 'GB'];
    if (f.quantization) metaBits.push(f.quantization);
    if (f.meta && f.meta.architecture) metaBits.push(f.meta.architecture);
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
  const base = f.file.replace(/\.gguf$/i, '');

  // 不指定端口 —— 交给主进程用 nextPort() 找一个没被占用的
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
    ? `模型目录中扫描到 ${known} 个 gguf 文件`
    : '未扫描到文件，请先点「刷新」或检查设置里的模型目录';
}

async function openModal(id) {
  editingId = id || null;
  $('modal-error').textContent = '';

  // 打开前先扫一次目录，保证文件列表是最新的
  const scan = await window.api.modelsScan(SETTINGS.modelsDir);
  SCAN_FILES = scan.ok ? (scan.files || []) : [];

  const m = id ? MANAGED.find((x) => x.id === id) : null;

  if (m) {
    $('modal-title').textContent = '编辑模型';
    $('f-name').value = m.name;
    $('f-alias').value = m.alias;
    $('f-port').value = m.port;
    $('f-ctx').value = m.ctxK;
    $('f-vision').checked = !!m.vision;
    $('f-mtp').checked = !!m.useMtp;
    fillFileOptions(m.file, m.mmproj);
  } else {
    $('modal-title').textContent = '添加模型';
    $('f-name').value = '';
    $('f-alias').value = '';
    $('f-port').value = await window.api.modelsNextPort();
    $('f-ctx').value = SETTINGS.defaultCtxK || 32;
    $('f-vision').checked = false;
    $('f-mtp').checked = false;
    fillFileOptions('', '');
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
  const file = $('f-file').value;
  const alias = $('f-alias').value.trim() || name;
  const port = parseInt($('f-port').value, 10);
  const ctxK = parseInt($('f-ctx').value, 10) || 32;
  const mmproj = $('f-mmproj').value || null;
  const vision = $('f-vision').checked;
  const useMtp = $('f-mtp').checked;

  const err = $('modal-error');

  if (!name) { err.textContent = '请填写名称'; $('f-name').focus(); return; }
  if (!file) { err.textContent = '请选择模型文件'; $('f-file').focus(); return; }
  if (!Number.isFinite(port)) { err.textContent = '端口无效'; $('f-port').focus(); return; }

  const payload = { name, alias, file, mmproj, port, ctxK, vision, useMtp };

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

// 选文件后自动填名称
$('f-file').addEventListener('change', () => {
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
  fillFileOptions($('f-file').value, $('f-mmproj').value);
  toast(`已刷新，共 ${SCAN_FILES.length} 个文件`, 'ok');
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
  await refreshManage();
  await tickHardware();
  setInterval(tickHardware, 3000);
})();
