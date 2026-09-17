/**
 * AnyDoc 转换 Worker（module worker）
 * 在 Worker 内用 initSync 加载 wasm，主线程不阻塞。
 *
 * 消息协议：
 *   接收 { type: 'warmup' }                         → 预热：仅加载/编译 wasm，完成后回 { type: 'ready' }
 *   接收 { id, bytes, format? }                     → 转换任务
 *   发送 { id, type: 'phase', phase: 'engine'|'convert' } → 阶段事件（'engine' 仅出现在需要加载 wasm 时）
 *   发送 { id, ok, md } | { id, ok: false, error }  → 转换结果
 *
 * 说明：toMarkdownBytes 是同步阻塞调用，无法在转换中途发心跳；
 * 因此这里只发阶段事件，转换中的「已耗时」计时由主线程负责。
 */
import { initSync, toMarkdownBytes } from './anydoc_wasm.js';

let ready = null;
let engineReady = false;

async function ensureInit() {
  if (!ready) {
    ready = (async () => {
      const res = await fetch('./anydoc_wasm_bg.wasm');
      const wasmBytes = new Uint8Array(await res.arrayBuffer());
      initSync(wasmBytes);
      engineReady = true;
    })();
  }
  return ready;
}

self.onmessage = async (e) => {
  const { id, bytes, format, type } = e.data || {};

  // 预热：提前把 wasm 拉下来并编译，转换时省去等待
  if (type === 'warmup') {
    try {
      await ensureInit();
      self.postMessage({ type: 'ready' });
    } catch (_) {
      // 预热失败静默；正常转换仍会走到 ensureInit 重试
    }
    return;
  }

  try {
    if (!engineReady) {
      // 首次需要加载引擎：先通知主线程进入「加载文档引擎」阶段
      self.postMessage({ id, type: 'phase', phase: 'engine' });
      await ensureInit();
    }
    self.postMessage({ id, type: 'phase', phase: 'convert' });
    const md = toMarkdownBytes(bytes, format || undefined);
    self.postMessage({ id, ok: true, md });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
