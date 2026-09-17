# AnyDoc 集成方案（细节 + 实测验证）

> 日期：2026-08-20
> 主题：为 Markdown 渲染器集成 [Firecrawl AnyDoc](https://github.com/firecrawl/anydoc)（WASM），支持打开 docx/pdf/pptx/xlsx 等更多格式
> 状态：**方案已实测验证，待实施**

---

## 一、结论

**可行，且与当前纯静态架构高度契合。** AnyDoc 提供浏览器 WebAssembly 接口，转换完全本地完成（无后端）。两个核心风险点（自托管加载、Worker 化）已在真实 Chrome 中实测通过。

---

## 二、实测验证结果

实验目录：`.test/anydoc-exp/`（真实 Chrome + CDP）

| 验证项 | 结果 |
|---|---|
| wasm-pack 产物自托管 + ES module 懒加载 | ✅ |
| CSV → Markdown 表格 | ✅ |
| **真实 docx** → Markdown（标题/粗体/表格全识别） | ✅ 62ms |
| **Worker 化**转换，主线程不阻塞 | ✅ 转换期间 UI 流畅 |

---

## 三、AnyDoc 是什么

[Firecrawl AnyDoc](https://github.com/firecrawl/anydoc)（MIT，Rust）——把办公文档统一转成 GitHub-Flavored Markdown，速度极快（中位 <5ms/文档）。

**支持格式**：
- Word: `.doc` `.docx` `.docm`
- PowerPoint: `.ppt` `.pptx` `.pptm` `.ppsx` 等
- Excel: `.xls` `.xlsx` `.xlsm` `.xlsb`
- OpenDocument: `.odt` `.ods` `.odp`
- 其他: `.rtf` `.epub` `.csv`
- PDF: `.pdf`（文本型，无 OCR）

**边界**：无 OCR——扫描件/纯图片 PDF 无法处理；图片以 alt 文本保留。

---

## 四、实现方案

### 1. 文件放置

```
vendor/anydoc/
├── anydoc_wasm.js        (14 KB  ES module glue)
├── anydoc_wasm_bg.wasm   (6.5 MB)
└── anydoc-worker.js      (module worker，新增)
```

与现有 `vendor/`（marked/mermaid）模式一致，纯手放、无构建。`.wasm` MIME 实测 `application/wasm` 正确（python http.server / Caddy 都支持）。

### 2. 懒加载封装 `js/anydoc-loader.js`（核心新增，约 80 行）

复用 `ensureMermaid` 的懒加载模式 + **Worker 化**：

```js
// 核心：module worker 内 initSync 加载，主线程不阻塞
let workerPromise = null;
export function getAnyDocWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise((resolve, reject) => {
    const worker = new Worker('vendor/anydoc/anydoc-worker.js', { type: 'module' });
    worker.onerror = (e) => reject(new Error('AnyDoc Worker 加载失败: ' + e.message));
    resolve(worker);
  });
  return workerPromise;
}

export async function convertToMarkdown(bytes, format) {
  const worker = await getAnyDocWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    handlers.set(id, { resolve, reject });
    worker.onmessage = (e) => {
      const { id, ok, md, error } = e.data;
      const h = handlers.get(id);
      if (!h) return;
      handlers.delete(id);
      ok ? h.resolve(md) : h.reject(new Error(error));
    };
    worker.postMessage({ id, bytes, format });
  });
}
```

### 3. Worker 文件 `vendor/anydoc/anydoc-worker.js`（约 30 行，实测可用）

```js
import { initSync, toMarkdownBytes } from './anydoc_wasm.js';
let ready = null;
async function ensureInit() {
  if (!ready) {
    ready = (async () => {
      const r = await fetch('./anydoc_wasm_bg.wasm');
      initSync(new Uint8Array(await r.arrayBuffer()));
    })();
  }
  return ready;
}
self.onmessage = async (e) => {
  const { id, bytes, format } = e.data;
  try { await ensureInit(); self.postMessage({ id, ok: true, md: toMarkdownBytes(bytes, format) }); }
  catch (err) { self.postMessage({ id, ok: false, error: err.message }); }
};
```

### 4. `app.js` 打开流程分流

```js
const ANYDOC_EXTS = ['.doc','.docx','.docm','.ppt','.pptx','.xls','.xlsx',
                     '.odt','.ods','.odp','.rtf','.epub','.csv','.pdf'];
function isAnyDocExt(ext) { return ANYDOC_EXTS.includes(ext); }

async function loadNonMarkdownFile(file, handle) {
  setStatus('正在转换文档...', 'info', { persist: true });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const md = await convertToMarkdown(bytes);   // Worker 异步
  await renderMarkdown(md, file.name);
  setStatus(`已转换为 Markdown 预览（${file.name}）`, 'success', { persist: true });
}
```

---

## 五、关键设计决策

| 决策点 | 方案 |
|---|---|
| 转换结果落盘 | **不落盘**，内存预览，不触发 watcher |
| Worker 生命周期 | **复用常驻单 worker**（缓存），首次初始化 ~100ms，之后秒开 |
| 格式检测 | `formatFromBytes()` 自动检测；CSV 等无签名格式按扩展名显式传入 |
| 与编辑/写回关系 | 转换预览**只读**，无写回能力；UI 标记「转换预览」 |
| 大文件策略 | Worker 化不卡 UI；超大文件转换耗时数秒，需等待提示 |

---

## 六、改动文件清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `vendor/anydoc/` | 新增 3 个文件（6.5MB） | 新增 |
| `js/anydoc-loader.js` | 新增：Worker 封装 + 懒加载 | 中（~80行） |
| `vendor/anydoc/anydoc-worker.js` | 新增：module worker | 小（~30行） |
| `app.js` | 打开/拖拽分流 + 转换预览标记 | 中 |
| `config.js` | anydoc 扩展名 + 路径常量 | 小 |
| `index.html` | accept 扩展格式 | 小 |
| `app.css` | 转换中/预览标记样式 | 小 |

**不涉及**：`virtual-source.js`、`sync-scroll.js`、`mapping.js`、`file-system.js`（读句柄已支持）——都不用动。

---

## 七、CSP 与部署注意

- 现有 Caddyfile CSP 行是**注释掉的**（未启用），部署无阻碍
- 若将来启用 CSP：`script-src` 需加 `'wasm-unsafe-eval'`（实测 wasm 编译需要）
- **浏览器兼容性**：WebAssembly 所有现代浏览器都支持（无 Chrome-only 限制）

---

*本文档由对话分析整理，2026-08-20。*
