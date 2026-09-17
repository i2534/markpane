import { CONFIG } from './config.js';
import { escapeHtml } from './utils.js';

/**
 * 源码面板虚拟列表：只渲染可视区域附近的行
 */
export function createVirtualSource({ sourceBody, sourceCode, sourceEmpty }) {
  const LH = CONFIG.SOURCE_LINE_HEIGHT;
  const OVERSCAN = CONFIG.SOURCE_OVERSCAN;

  let lines = [];
  let activeLine = -1;
  let searchMatches = new Set();
  let windowEl = null;
  let scrollBound = false;
  let raf = 0;

  function ensureDom() {
    if (windowEl) return;
    sourceCode.innerHTML = '';
    sourceCode.classList.add('source-virtual-root');
    windowEl = document.createElement('div');
    windowEl.className = 'source-virtual-window';
    sourceCode.appendChild(windowEl);
  }

  function totalHeight() {
    return Math.max(LH, lines.length * LH);
  }

  function paint() {
    if (!windowEl || !lines.length) return;
    const scrollTop = sourceBody.scrollTop;
    const viewH = sourceBody.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / LH) - OVERSCAN);
    const count = Math.ceil(viewH / LH) + OVERSCAN * 2;
    const end = Math.min(lines.length, start + count);

    sourceCode.style.height = `${totalHeight()}px`;
    windowEl.style.transform = `translateY(${start * LH}px)`;

    let html = '';
    for (let i = start; i < end; i++) {
      const num = i + 1;
      const cls = [
        'source-line',
        num === activeLine ? 'active' : '',
        searchMatches.has(num) ? 'search-match' : '',
      ].filter(Boolean).join(' ');
      const escaped = escapeHtml(lines[i]);
      html += `<div class="${cls}" data-line="${num}" style="height:${LH}px">` +
        `<span class="source-line-num">${num}</span>` +
        `<span class="source-line-code">${escaped || '&nbsp;'}</span></div>`;
    }
    windowEl.innerHTML = html;
  }

  function schedulePaint() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }

  function bindScroll() {
    if (scrollBound) return;
    scrollBound = true;
    sourceBody.addEventListener('scroll', schedulePaint, { passive: true });
    window.addEventListener('resize', schedulePaint, { passive: true });
  }

  return {
    setLines(text) {
      lines = text.split('\n');
      activeLine = -1;
      searchMatches = new Set();
      ensureDom();
      sourceEmpty.style.display = 'none';
      sourceCode.style.display = 'block';
      bindScroll();
      sourceBody.scrollTop = 0;
      paint();
    },
    getLineCount() {
      return lines.length;
    },
    getLineText(lineNum) {
      return lines[lineNum - 1] || '';
    },
    setActiveLine(lineNum) {
      activeLine = lineNum;
      schedulePaint();
    },
    setSearchMatches(lineNums) {
      searchMatches = new Set(lineNums);
      schedulePaint();
    },
    clearSearch() {
      searchMatches = new Set();
      schedulePaint();
    },
    scrollToLine(lineNum, behavior = 'smooth') {
      const idx = Math.max(0, Math.min(lineNum - 1, lines.length - 1));
      activeLine = idx + 1;
      const top = Math.max(0, idx * LH - sourceBody.clientHeight / 3);
      sourceBody.scrollTo({ top, behavior });
      schedulePaint();
    },
    refresh() {
      schedulePaint();
    },
  };
}
