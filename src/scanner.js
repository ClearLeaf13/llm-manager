'use strict';

/**
 * 扫描模型目录，识别可用的 gguf 文件。
 *
 * 职责：
 *   1. 列出目录下的 *.gguf（不递归，只扫一层）
 *   2. 区分主模型与 mmproj 视觉投影文件
 *   3. 尽力读取 gguf 头部元数据（架构、参数量、量化、上下文长度）
 *
 * gguf 元数据解析是"尽力而为"的：格式异常时降级为仅文件名/大小，
 * 绝不让扫描整体失败。
 */

const fs = require('fs');
const path = require('path');

/** gguf 文件魔数：'GGUF' */
const GGUF_MAGIC = 0x46554747; // 小端读出的 "GGUF"

/* ------------------------------------------------------------------ *
 * gguf 头部解析
 * ------------------------------------------------------------------ */

/**
 * 读取 gguf 元数据。
 * @param {string} file 绝对路径
 * @returns {object|null} 解析结果，失败返回 null
 */
function readGgufMeta(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    // 只读头部 4MB —— 元数据通常在前几百 KB，超大模型也够
    const readLen = Math.min(stat.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(readLen);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, readLen, 0);

    let off = 0;

    const u32 = () => { const v = buf.readUInt32LE(off); off += 4; return v; };
    const u64 = () => {
      // 用 BigInt 读，避免超过 2^53 精度丢失
      const v = buf.readBigUInt64LE(off); off += 8;
      return Number(v);
    };
    const str = () => {
      const len = u64();
      if (len < 0 || len > 1e6 || off + len > buf.length) throw new Error('字符串长度异常');
      const s = buf.toString('utf8', off, off + len);
      off += len;
      return s;
    };

    if (u32() !== GGUF_MAGIC) return null;

    const version = u32();
    if (version < 2 || version > 3) return null;

    const tensorCount = u64();
    const kvCount = u64();

    const meta = {
      version,
      tensorCount,
      architecture: null,
      name: null,
      paramCount: null,
      quantization: null,
      contextLength: null,
      fileType: null,
    };

    // KV 对的值类型
    const VALUE_UINT8 = 0, VALUE_INT8 = 1, VALUE_UINT16 = 2, VALUE_INT16 = 3;
    const VALUE_UINT32 = 4, VALUE_INT32 = 5, VALUE_FLOAT32 = 6;
    const VALUE_BOOL = 7, VALUE_STRING = 8, VALUE_ARRAY = 9;
    const VALUE_UINT64 = 10, VALUE_INT64 = 11, VALUE_FLOAT64 = 12;

    const readValue = (type) => {
      switch (type) {
        case VALUE_UINT8: return buf.readUInt8(off++);
        case VALUE_INT8: return buf.readInt8(off++);
        case VALUE_UINT16: { const v = buf.readUInt16LE(off); off += 2; return v; }
        case VALUE_INT16: { const v = buf.readInt16LE(off); off += 2; return v; }
        case VALUE_UINT32: return u32();
        case VALUE_INT32: { const v = buf.readInt32LE(off); off += 4; return v; }
        case VALUE_FLOAT32: { const v = buf.readFloatLE(off); off += 4; return v; }
        case VALUE_BOOL: return buf.readUInt8(off++) !== 0;
        case VALUE_STRING: return str();
        case VALUE_UINT64: return u64();
        case VALUE_INT64: {
          const v = buf.readBigInt64LE(off); off += 8;
          return Number(v);
        }
        case VALUE_FLOAT64: { const v = buf.readDoubleLE(off); off += 8; return v; }
        case VALUE_ARRAY: {
          const elemType = u32();
          const count = u64();
          // 小数组（如 rope.dimension_sections、tags）直接展开跳过；
          // 超大数组（词表 tokenizer.ggml.tokens 可达 15 万条）放弃解析，
          // 因为逐个读变长字符串会拖慢扫描且我们并不需要它。
          if (count > 512) {
            const e = new Error('超大数组，停止解析');
            e.arrayLen = count;
            throw e;
          }
          const items = [];
          for (let i = 0; i < count; i += 1) items.push(readValue(elemType));
          return items;
        }
        default: throw new Error('未知的值类型 ' + type);
      }
    };

    for (let i = 0; i < kvCount; i += 1) {
      if (off >= buf.length) break;

      let key;
      let type;
      let val;
      try {
        key = str();
        type = u32();
        val = readValue(type);
      } catch (_) {
        // 头部读取越界或遇到未支持的类型 —— 停止解析，
        // 保留此前已成功读取的字段（元数据是尽力而为）
        break;
      }

      if (key === 'general.architecture') meta.architecture = val;
      else if (key === 'general.name') meta.name = val;
      else if (key === 'general.file_type') meta.fileType = val;
      else if (key === 'general.parameter_count') meta.paramCount = val;
      else if (key === 'general.size_label') meta.sizeLabel = val;
      else if (key.endsWith('.context_length')) meta.contextLength = val;

      // 量化类型：优先取具体量化版本字符串
      if (key.endsWith('.file_type') && typeof val === 'string') meta.quantization = val;
      if (key.includes('quantization') && typeof val === 'string' && !meta.quantization) {
        meta.quantization = val;
      }
    }

    // 数组类型只记录长度，不展开（readValue 已处理），
    // 但若因数组过大中断，上面的 try/catch 已保底
    return meta;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/** 根据 file_type 数字推断量化名（llama.cpp 的枚举） */
const FILE_TYPE_NAMES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L',
  14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
};

/** 从文件名推断量化类型 —— general.file_type 常在词表大数组之后读不到 */
const QUANT_PATTERN = /\b(IQ\d+_[A-Z0-9_]+|Q\d+_K_[A-Z]+|Q\d+_K|Q\d+_\d|F32|F16|BF16|MXFP4)\b/i;

function quantFromName(filename) {
  const m = String(filename).match(QUANT_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

/** mmproj 文件的常见命名特征 */
function isMmproj(filename) {
  return /^mmproj[-_.]/i.test(filename) || /mmproj/i.test(filename);
}

/**
 * 扫描目录。
 * @param {string} dir 模型目录
 * @returns {{ok:boolean, files?:Array, error?:string}}
 */
function scan(dir) {
  if (!dir) return { ok: false, error: '未指定模型目录' };

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `无法读取目录：${e.message}` };
  }

  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.gguf$/i.test(ent.name)) continue;

    const full = path.join(dir, ent.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch (_) { continue; }

    const mmproj = isMmproj(ent.name);
    const meta = mmproj ? null : readGgufMeta(full);

    // 量化名：元数据优先，读不到就从文件名推断
    let quantization = null;
    if (meta) {
      quantization = meta.quantization
        || FILE_TYPE_NAMES[meta.fileType]
        || null;
    }
    if (!quantization) quantization = quantFromName(ent.name);

    files.push({
      file: ent.name,
      sizeGb: size / 1024 ** 3,
      mmproj,
      meta,
      quantization,
    });
  }

  // 主模型在前，mmproj 在后；同类按名字排序
  files.sort((a, b) => {
    if (a.mmproj !== b.mmproj) return a.mmproj ? 1 : -1;
    return a.file.localeCompare(b.file);
  });

  return { ok: true, dir, files };
}

module.exports = { scan, readGgufMeta, isMmproj, quantFromName, FILE_TYPE_NAMES };
