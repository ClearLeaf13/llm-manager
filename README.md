# 本地 LLM 聚合管理

统一管理本地推理引擎的 Electron 桌面应用：一套界面管两种引擎 —— Windows 上的 [llama.cpp](https://github.com/ggml-org/llama.cpp) 与 WSL 里的 NInfer。一键切换模型、实时查看日志、监控显存占用。

> 本仓库为**私有备份**，仅作者本人使用。

---

## 功能

- **双引擎** — llama.cpp（`.gguf`，Windows 原生）与 NInfer（`.ninfer`，WSL 内），同一份模型列表里统一启停
- **多模型切换** — 点击即启动，自动清理上一个进程（两个引擎都会清）
- **实时日志** — 捕获引擎的 stdout/stderr，支持按类型过滤
- **状态总览** — 运行状态 / 当前模型 / 推理引擎 / 显存 / 内存 / 磁盘 / PID，带占用进度条
- **启动参数** — 图形化调参（**上下文**、含 NInfer 的 KV 精度、投机解码、预填充块等），并实时预览最终命令；**模型运行中也能改**，改动下次启动生效
- **自动扫描** — 扫 Windows 模型目录里的 `.gguf`，同时扫 WSL 里的 `.ninfer`；已添加的模型与已绑定的视觉投影不再重复列出
- **点卡片即改参** — 在「模型管理」里点任意一张模型卡，右侧「启动参数」就切到它（无需额外按钮）
- **显存监控** — 通过 `nvidia-smi` 读取 GPU 名称、显存占用、利用率
- **路径自适应** — 自动探测 llama.cpp 安装位置与 WSL 发行版，换机器无需改代码

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 x64 | 仅支持 Windows（依赖 `tasklist` / `taskkill`） |
| Node.js | ≥ 18 | 仅**源码运行**时需要；用打包版 exe 则无需安装 |
| llama.cpp | 任意近期版本 | 需含 `llama-server.exe` 及配套 DLL |
| WSL + NInfer | 可选 | 不装则自动隐藏 NInfer 相关功能，不影响 llama.cpp |
| NVIDIA 驱动 | — | 可选；无 N 卡时显存监控自动降级隐藏 |

---

## 安装与运行

### 方式一：打包版（推荐，无需 Node.js）

从 [Releases](../../releases) 下载 `LLM-Manager-v<版本>.exe`，双击运行。

### 方式二：源码运行

```powershell
git clone https://github.com/ClearLeaf13/llm-manager.git
cd llm-manager
npm install
```

然后双击 `启动.cmd`，或：

```powershell
npm start
```

### 方式三：自行打包

```powershell
npm run dist
```

产物输出到 `dist/` 目录。

---

## 前置条件：准备推理引擎

应用本身**不含**模型和推理引擎，需要你自行准备。

### 1. 放置 llama.cpp

默认按以下顺序自动探测根目录：

1. 环境变量 `LLM_MANAGER_DIR`
2. `%USERPROFILE%\llama.cpp`
3. `%USERPROFILE%\Documents\默认工作区\llama-cpp`

目录结构应为：

```
<llama.cpp 根目录>/
├── llama-server.exe
├── llama.dll
├── ggml.dll
├── ggml-cuda.dll          # CUDA 版本才有
├── cudart64_13.dll 等     # CUDA 运行时
└── models/
    ├── Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf
    ├── Qwen3VL-8B-Instruct-Q4_K_M.gguf
    ├── mmproj-Qwen3VL-8B-Instruct-F16.gguf
    ├── Qwen3.6-VL-REAP-26B-A3B-text-IQ4_XS.gguf
    └── mmproj-REAP-26B-F16.gguf
```

### 2. 放置 NInfer（可选）

NInfer 跑在 WSL 里，模型是 `.ninfer` 单文件。默认约定：

| 项 | 默认值 |
|---|---|
| WSL 发行版 | `Ubuntu-24.04` |
| 服务端 | `/root/ninfer-5080/build/apps/ninfer-serve` |
| CLI | `/root/ninfer-5080/build/apps/ninfer` |
| 模型目录 | `/root/models` |

以上全部可在**设置 → NInfer** 里改，界面会实时显示探测结果（发行版是否在跑、二进制是否可执行、模型目录是否存在）。

> 管理器通过 `wsl.exe` 调用引擎，并在**停止时确实结束 Linux 侧的进程**（只杀 Windows 宿主的 `wsl.exe` 会留下孤儿进程占着显存）。

### 3. 自定义路径

三种方式，任选其一：

**环境变量**（推荐，适合多机部署）

```powershell
setx LLM_MANAGER_DIR "D:\AI\llama.cpp"
```

**界面设置** —— 打开应用 → 设置 → 分别指定 `llama-server.exe`、模型目录，以及 NInfer 的 WSL 路径。

**直接改代码** —— 编辑 `src/models.js` 的 `LLAMA_DIR_CANDIDATES`。

> ⚠️ 换机器后如果原来的绝对路径失效，应用会**自动回退**到探测到的有效路径，不会卡死。

---

## 预置模型

| ID | 显示名 | 引擎 | 量化 | 大小 | 端口 | 多模态 | MTP |
|---|---|---|---|---|---|---|---|
| `balanced` | Qwen3.6-35B-A3B I-Balanced | llama.cpp | — | ~24 GB | 8080 | ✗ | ✓ |
| `vl8b` | Qwen3-VL-8B-Instruct 视觉 | llama.cpp | Q4_K_M | ~4.7 GB | 8081 | ✓ | ✗ |
| `reap` | Qwen3.6-VL-REAP-26B-A3B 视觉 | llama.cpp | IQ4_XS | ~13.6 GB | 8082 | ✓ | ✗ |
| `ninfer-qwen38` | Qwen3.8-27B (NInfer) | NInfer | Q4 KV | ~15.3 GB | 8090 | ✓ | MTP-3 |

模型文件**不在本仓库中**（总计约 44 GB，远超 Git 限制）。需要另行备份或下载。

> 预置数据只在 `models.json` **不存在**时写入；已有配置不会被覆盖。

### 修改模型列表

编辑 `src/models.js` 的 `MODELS` 数组。`file` / `mmproj` 填**文件名**即可，应用会自动拼接到模型目录：

```js
{
  id: 'mymodel',
  name: '显示名称',
  alias: 'API 里的模型 id',
  file: 'your-model.gguf',        // 相对 models 目录
  mmproj: null,                    // 多模态才需要
  ctxK: 32,                        // 默认上下文（K tokens）
  useMtp: false,
  port: 8083,
  vision: false,
}
```

---

## 项目结构

```
llm-manager/
├── src/
│   ├── main.js              主进程：进程管控 / 端口探测 / IPC / 窗口
│   ├── models.js            模型配置与 llama-server 启动参数
│   ├── preload.js           contextBridge 安全桥接
│   └── renderer/
│       ├── index.html       界面结构
│       ├── renderer.js      渲染层逻辑
│       └── style.css        样式
├── 启动.cmd                 免安装启动脚本
├── package.json
└── .gitignore
```

---

## 常见问题

**启动后提示「找不到 llama-server」**

检查 `llama-server.exe` 是否在探测目录中，或在设置里手动指定。可用环境变量一键指定：

```powershell
setx LLM_MANAGER_DIR "你的\llama.cpp\路径"
```

**提示「模型文件不存在」**

模型目录结构与预期不符。确认 `models/` 是小写、且文件名与 `src/models.js` 中完全一致。

**启动超时（180 秒未就绪）**

大模型首次加载需要预热。35B 模型在机械硬盘上可能更久，可在设置里调大 `readyTimeoutSec`。

**显存监控不显示**

没装 N 卡驱动，或 `nvidia-smi.exe` 不在 PATH 与默认位置。此功能缺失**不影响**模型运行。

**llama-server 无法停止**

应用会用 `taskkill /F /IM llama-server.exe /T` 强杀。若仍有残留，手动执行同命令。

---

## 技术说明

- **安全模型** — `contextIsolation: true`、`nodeIntegration: false`，渲染层只能通过 `preload.js` 暴露的白名单方法访问系统能力
- **端口分配** — 每个模型独占一个端口，避免切换时端口冲突
- **单实例约束** — 一次只允许一个 `llama-server` 运行，启动前会自动检查并拒绝
- **日志环形缓冲** — 默认保留 4000 行，硬上限 50000 行，防止内存膨胀

---

## 许可

MIT
