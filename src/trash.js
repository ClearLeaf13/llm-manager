'use strict';

/**
 * 模型文件删除。
 *
 * 设计原则：
 *   1. 只删"本应用认定属于该模型"的文件 —— 主 gguf + 关联的 mmproj
 *   2. 默认走回收站（shell.trashItem），误删可右键还原
 *   3. 删除前逐一校验：文件存在、大小写、是否被占用
 *   4. 绝不递归删除目录，绝不删除模型目录之外的任何路径
 */

const fs = require('fs');
const path = require('path');

/** 把路径归一成绝对路径，便于比较 */
function norm(p) {
  try {
    return path.resolve(p).toLowerCase();
  } catch (_) {
    return String(p).toLowerCase();
  }
}

/**
 * 收集一个模型关联的所有文件。
 * @param {object} model 已解析出 filePath / mmprojPath 的模型
 * @param {string} modelsDir 模型目录（用于安全边界校验）
 * @returns {{files: Array<{path:string,name:string,sizeGb:number,kind:string,exists:boolean}>, outside: Array<string>}}
 */
function collectFiles(model, modelsDir) {
  const dir = norm(modelsDir);
  const out = [];
  const outside = [];

  const push = (abs, kind) => {
    if (!abs) return;
    const n = norm(abs);

    // 安全边界：只允许模型目录内的文件
    if (dir && !n.startsWith(dir + path.sep) && n !== dir) {
      outside.push(abs);
      return;
    }

    let exists = false;
    let sizeGb = 0;
    try {
      const st = fs.statSync(abs);
      exists = st.isFile();
      sizeGb = exists ? st.size / 1024 ** 3 : 0;
    } catch (_) { /* 不存在 */ }

    // 同一个文件可能被多个字段引用，去重
    if (out.some((x) => norm(x.path) === n)) return;

    out.push({
      path: abs,
      name: path.basename(abs),
      kind,
      exists,
      sizeGb,
    });
  };

  push(model.filePath, 'main');
  push(model.mmprojPath, 'mmproj');

  return { files: out, outside };
}

/**
 * 删除一批文件（走回收站）。
 * @param {string[]} paths
 * @param {object} shell Electron 的 shell 模块
 * @returns {Promise<{deleted:string[], failed:Array<{path:string,error:string}>}>}
 */
async function trashFiles(paths, shell) {
  const deleted = [];
  const failed = [];

  for (const p of paths) {
    try {
      await shell.trashItem(p);
      deleted.push(p);
    } catch (e) {
      failed.push({ path: p, error: e.message || String(e) });
    }
  }

  return { deleted, failed };
}

/**
 * 为一批模型生成"删除预览"，供界面展示确认。
 * @returns {{items:Array, totalGb:number, warnings:string[]}}
 */
function preview(models, modelsDir) {
  const items = [];
  const warnings = [];
  let totalGb = 0;

  for (const m of models) {
    const { files, outside } = collectFiles(m, modelsDir);

    for (const f of outside) {
      warnings.push(`「${m.name}」的文件不在模型目录内，已跳过：${f}`);
    }

    const entry = {
      id: m.id,
      name: m.name,
      files: files.filter((f) => f.exists),
      missing: files.filter((f) => !f.exists).map((f) => f.name),
      sizeGb: 0,
    };
    entry.sizeGb = entry.files.reduce((s, f) => s + f.sizeGb, 0);
    totalGb += entry.sizeGb;
    items.push(entry);
  }

  return { items, totalGb, warnings };
}

module.exports = { collectFiles, trashFiles, preview, norm };
