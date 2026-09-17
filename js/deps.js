import { CONFIG } from './config.js';

/** 本地依赖加载状态（名称沿用历史字段） */
export const libReady = {
  marked: typeof marked !== 'undefined',
  hljs: typeof hljs !== 'undefined',
  mermaid: typeof mermaid !== 'undefined',
  katex: typeof renderMathInElement !== 'undefined',
  dompurify: typeof DOMPurify !== 'undefined',
};

Object.entries(libReady).forEach(([name, ready]) => {
  if (!ready && name !== 'mermaid') {
    console.warn(`⚠️ 依赖库未加载: ${name}`);
  }
});

if (libReady.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}

let mermaidLoadPromise = null;

/** 按需加载 Mermaid（约 3.5MB，避免首屏阻塞） */
export function ensureMermaid() {
  if (libReady.mermaid && typeof mermaid !== 'undefined') {
    return Promise.resolve(true);
  }
  if (mermaidLoadPromise) return mermaidLoadPromise;

  mermaidLoadPromise = new Promise((resolve) => {
    function finish(ok) {
      if (ok && typeof mermaid !== 'undefined') {
        libReady.mermaid = true;
        try {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'strict',
          });
        } catch (e) {
          console.warn('Mermaid 初始化失败:', e);
        }
        resolve(true);
      } else {
        libReady.mermaid = false;
        console.warn('⚠️ Mermaid 未加载，图表不渲染');
        resolve(false);
      }
    }

    if (typeof mermaid !== 'undefined') {
      finish(true);
      return;
    }

    const existing = document.querySelector('script[data-md-mermaid]');
    if (existing) {
      if (typeof mermaid !== 'undefined') {
        finish(true);
        return;
      }
      existing.addEventListener('load', () => finish(true));
      existing.addEventListener('error', () => finish(false));
      return;
    }
    const s = document.createElement('script');
    s.src = CONFIG.MERMAID_SRC;
    s.async = true;
    s.dataset.mdMermaid = '1';
    s.onload = () => finish(true);
    s.onerror = () => finish(false);
    document.head.appendChild(s);
  });
  return mermaidLoadPromise;
}
