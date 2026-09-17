/**
 * AnyDoc 转换封装（懒加载 + Worker 化）
 *
 * 用 module worker 加载 anydoc wasm，在主线程外把 docx/pdf/pptx 等
 * 转换为 Markdown。Worker 常驻复用，首次初始化后转换秒开。
 *
 * 进度：worker 的 toMarkdownBytes 是同步调用，无法中途发心跳，
 * 因此模块只转发 worker 的「阶段事件」（engine/convert），
 * 转换中的已耗时计时由调用方（app.js）自行完成。
 */

const WORKER_URL = 'vendor/anydoc/anydoc-worker.js';

let workerPromise = null;
let seq = 0;
const pending = new Map();

/** 引擎（wasm）是否已完成加载/编译；true 后转换无需「加载文档引擎」等待 */
let readyState = false;

/** 引擎是否已就绪（预热完成或转换阶段进入 convert） */
export function isAnyDocEngineReady() {
  return readyState;
}

/** 获取（或创建）常驻转换 Worker */
export function getAnyDocWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (e) {
      reject(new Error('AnyDoc Worker 创建失败: ' + e.message));
      return;
    }
    worker.onerror = (e) => {
      // 致命错误：清空所有挂起请求
      const err = new Error('AnyDoc Worker 加载失败: ' + (e.message || '未知错误'));
      pending.forEach(({ reject: r }) => r(err));
      pending.clear();
      workerPromise = null;
      readyState = false;
      reject(err);
    };
    worker.onmessage = (e) => {
      const d = e.data || {};
      // 预热完成
      if (d.type === 'ready') {
        readyState = true;
        return;
      }
      // 阶段事件（engine / convert）
      if (d.type === 'phase') {
        if (d.phase === 'convert') readyState = true;
        const h = pending.get(d.id);
        if (h && typeof h.onPhase === 'function') h.onPhase(d);
        return;
      }
      const { id, ok, md, error } = d;
      const h = pending.get(id);
      if (!h) return;
      pending.delete(id);
      ok ? h.resolve(md) : h.reject(new Error(error || 'AnyDoc 转换失败'));
    };
    resolve(worker);
  });
  return workerPromise;
}

/** 终止并丢弃 Worker（一般无需调用） */
export function destroyAnyDocWorker() {
  if (workerPromise) {
    workerPromise.then((w) => {
      try { w.terminate(); } catch (_) { /* ignore */ }
    }).catch(() => {});
  }
  workerPromise = null;
  pending.clear();
  readyState = false;
}

/**
 * 预热：提前创建 Worker 并加载/编译 wasm。
 * 页面空闲时调用，首次打开 Office/PDF 时免去引擎等待。
 * 失败静默，不影响后续正常转换。
 */
export async function warmUpAnyDoc() {
  try {
    const worker = await getAnyDocWorker();
    worker.postMessage({ type: 'warmup' });
  } catch (_) { /* 预热失败静默 */ }
}

/**
 * 把文档字节转换为 Markdown。
 * @param {Uint8Array} bytes 文件字节
 * @param {string} [format] 可选：显式指定格式（如 'csv'）；不传则自动检测
 * @param {object} [opts]
 * @param {(phase: {phase: 'engine' | 'convert'}) => void} [opts.onPhase] 阶段事件回调
 * @returns {Promise<string>} Markdown 文本
 */
export async function convertToMarkdown(bytes, format, opts = {}) {
  const worker = await getAnyDocWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onPhase: opts.onPhase });
    worker.postMessage({ id, bytes, format: format || undefined }, [bytes.buffer]);
  });
}
