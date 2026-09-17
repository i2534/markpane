import { CONFIG } from './config.js';
import { debounce, escapeHtml, isTypingTarget } from './utils.js';
import { libReady, ensureMermaid } from './deps.js';
import {
  getTopLevelBlockElements,
  tokenMatchesDom,
  extractLexerBlocks,
  findMappingForSourceLine,
  estimateSourceLineFromClick,
} from './mapping.js';
import { createVirtualSource } from './virtual-source.js';
import { createSyncScrollController } from './sync-scroll.js';
import { isFsSupported, openFileFromPicker, createFileWatcher, saveFileHandle } from './file-system.js';
import { convertToMarkdown, warmUpAnyDoc, isAnyDocEngineReady } from './anydoc-loader.js';
import { registerServiceWorker, initFileHandling } from './pwa.js';

const state = {
  rawText: '',
  renderedHtml: '',
  lineMappings: [],
  isDark: false,
  syncScroll: false,
  isScrolling: false,
  syncLock: false,
  syncLockGen: 0,
  layout: 'split',
  searchMatchIdx: -1,
  searchMatchLines: [],
  currentFileName: '',
  fileWatcher: null,
  sourceScrollTop: 0,
  renderScrollTop: 0,
  isConvertedPreview: false, // 当前是 AnyDoc 转换出的只读预览
  progressActive: false,     // 状态栏进行中（转换/读取）标记
};

const RELOAD_DEBOUNCE_MS = 500;

const DOM = {
  fileInput: document.getElementById('file-input'),
  content: document.getElementById('content'),
  emptyState: document.getElementById('emptyState'),
  sourceCode: document.getElementById('sourceCode'),
  sourceEmpty: document.getElementById('sourceEmpty'),
  fileName: document.getElementById('fileName'),
  tocItems: document.getElementById('tocItems'),
  toc: document.getElementById('toc'),
  statusInfo: document.getElementById('statusInfo'),
  statusSpinner: document.getElementById('statusSpinner'),
  statsInfo: document.getElementById('statsInfo'),
  renderBody: document.getElementById('renderBody'),
  sourceBody: document.getElementById('sourceBody'),
  copyBtn: document.getElementById('copyBtn'),
  copyHtmlBtn: document.getElementById('copyHtmlBtn'),
  themeToggle: document.getElementById('themeToggle'),
  syncScrollBtn: document.getElementById('syncScrollBtn'),
  shortcutsBtn: document.getElementById('shortcutsBtn'),
  shortcutsHint: document.getElementById('shortcutsHint'),
  lightHljs: document.getElementById('lightHljs'),
  darkHljs: document.getElementById('darkHljs'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxClose: document.getElementById('lightboxClose'),
  searchInput: document.getElementById('searchInput'),
  searchCount: document.getElementById('searchCount'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  resizeHandle: document.getElementById('resizeHandle'),
  panels: document.getElementById('panels'),
  renderPanel: document.getElementById('renderPanel'),
  sourcePanel: document.getElementById('sourcePanel'),
  layoutBtn: document.getElementById('layoutBtn'),
  appHeader: document.getElementById('appHeader'),
  fabToggle: document.getElementById('fabToggle'),
  dropOverlay: document.getElementById('dropOverlay'),
  tocWrap: document.getElementById('tocWrap'),
  tocHideBtn: document.getElementById('tocHideBtn'),
  tocEdge: document.getElementById('tocEdge'),
  tocResizeHandle: document.getElementById('tocResizeHandle'),
};

const narrowMediaQuery = window.matchMedia(`(max-width: ${CONFIG.NARROW_MAX_WIDTH}px)`);
const isNarrowViewport = () => narrowMediaQuery.matches;

const virtualSource = createVirtualSource({
  sourceBody: DOM.sourceBody,
  sourceCode: DOM.sourceCode,
  sourceEmpty: DOM.sourceEmpty,
});

const syncCtl = createSyncScrollController({
  getState: () => state,
  setState: (patch) => Object.assign(state, patch),
  renderBody: DOM.renderBody,
  sourceBody: DOM.sourceBody,
});

let lightboxLastFocus = null;

const STATUS_PERSIST_MS = 3000;
let statusPersistUntil = 0;
let statusPersistTimer = null;

function updateStatusBar(msg, type) {
  const icons = { info: '✅', warning: '⚠️', error: '❌', success: '✅' };
  const fileBit = state.currentFileName ? ` · ${state.currentFileName}` : '';
  DOM.statusInfo.textContent = `${icons[type] || '✅'} ${msg}${fileBit}`;
  DOM.statusInfo.style.color = type === 'error' ? 'var(--error-text)'
    : type === 'warning' ? 'var(--warning-text)' : '';
}

/**
 * 状态栏更新 + console 日志。
 * 全部状态栏更新都会同步输出到 console（带时间戳/类型/文件名），便于调试。
 * @param {string} msg
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {object} [opts]
 * @param {boolean} [opts.persist] 提示在状态栏停留 STATUS_PERSIST_MS，期间忽略后续 info/success 更新
 */
function setStatus(msg, type = 'info', opts = {}) {
  // 进行中（转换/读取）时，忽略非 progress 的状态更新，避免覆盖进度提示
  if (state.progressActive && !opts.progress) {
    return;
  }

  // console 日志：全部状态栏更新都输出，方便调试
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const fileBitLog = state.currentFileName ? ` · ${state.currentFileName}` : '';
  const method = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
  console[method](`[${ts}] [${type}] ${msg}${fileBitLog}`);

  const now = Date.now();

  if (opts.persist) {
    // 持久提示：立即显示并设定恢复窗口
    statusPersistUntil = now + STATUS_PERSIST_MS;
    if (statusPersistTimer) clearTimeout(statusPersistTimer);
    updateStatusBar(msg, type);
    statusPersistTimer = setTimeout(() => {
      statusPersistTimer = null;
      statusPersistUntil = 0;
      updateStatusBar('渲染完成', 'success');
    }, STATUS_PERSIST_MS);
    return;
  }

  // 持久窗口内：错误/警告仍显示，info/success 不覆盖（避免「已自动重载」被瞬间刷掉）
  if (now < statusPersistUntil && (type === 'info' || type === 'success')) {
    return;
  }
  updateStatusBar(msg, type);
}

/**
 * 状态栏「进行中」模式（转换/读取等长耗时操作）。
 * @param {boolean} active 是否进行中
 * @param {string} [msg] 提示文本（active 时必填）
 */
function setProgress(active, msg = '') {
  state.progressActive = active;
  if (DOM.statusSpinner) DOM.statusSpinner.classList.toggle('show', active);
  if (active) {
    // 清除 persist 定时器，避免它恢复「渲染完成」盖掉进度提示
    if (statusPersistTimer) clearTimeout(statusPersistTimer);
    statusPersistTimer = null;
    statusPersistUntil = 0;
    updateStatusBar(msg, 'info');
    // 与 setStatus 一致：进度提示也输出到 console，便于调试/测试
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.info(`[${ts}] [progress] ${msg}`);
  }
}

function showLoading(show) {
  DOM.loadingOverlay.classList.toggle('show', show);
}

function applyTheme(isDark) {
  state.isDark = isDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : '');
  DOM.themeToggle.textContent = isDark ? '☀️' : '🌙';
  DOM.themeToggle.title = isDark ? '切换浅色模式' : '切换暗黑模式';
  DOM.themeToggle.setAttribute('aria-label', DOM.themeToggle.title);
  DOM.lightHljs.disabled = isDark;
  DOM.darkHljs.disabled = !isDark;
}

async function toggleTheme() {
  applyTheme(!state.isDark);
  localStorage.setItem('md-renderer-theme', state.isDark ? 'dark' : 'light');
  // 主题切换后重放图片反色状态（按主题+地址记忆）
  DOM.content.querySelectorAll('img').forEach((img) => {
    if (img._invertBtn) {
      applySavedInvert(img);
    }
  });
  if (state.rawText && libReady.mermaid) {
    await renderMermaidBlocks(true);
  }
}

function updateSyncScrollAvailability() {
  const dual = state.layout === 'split';
  DOM.syncScrollBtn.style.display = dual ? '' : 'none';
  DOM.syncScrollBtn.setAttribute('aria-hidden', dual ? 'false' : 'true');
  const toolbar = DOM.syncScrollBtn.closest('.toolbar');
  if (toolbar) toolbar.style.display = dual ? '' : 'none';
  if (!dual) {
    syncCtl.tearDown();
    return;
  }
  if (state.syncScroll) syncCtl.setup();
}

function setLayout(layout, opts = {}) {
  const persist = opts.persist !== false;
  state.layout = layout;
  const layouts = {
    split: { render: false, source: false, handle: false, btn: '📐 双栏' },
    render: { render: false, source: true, handle: true, btn: '📐 仅渲染' },
    source: { render: true, source: false, handle: true, btn: '📐 仅源码' },
  };
  const config = layouts[layout];
  DOM.renderPanel.classList.toggle('hidden', config.render);
  DOM.sourcePanel.classList.toggle('hidden', config.source);
  DOM.resizeHandle.style.display = config.handle ? 'none' : '';
  DOM.layoutBtn.textContent = config.btn;
  DOM.layoutBtn.setAttribute('aria-label', `切换布局，当前：${config.btn.replace(/^📐\s*/, '')}`);
  if (persist) localStorage.setItem(CONFIG.LAYOUT_STORAGE_KEY, layout);
  updateSyncScrollAvailability();
}

function isFabCollapsed() {
  return localStorage.getItem(CONFIG.FAB_COLLAPSED_KEY) !== '0';
}

function syncFabCollapsedUI() {
  if (!DOM.appHeader || !DOM.fabToggle) return;
  if (!isNarrowViewport()) {
    DOM.appHeader.classList.remove('header--fab-collapsed');
    return;
  }
  const collapsed = isFabCollapsed();
  DOM.appHeader.classList.toggle('header--fab-collapsed', collapsed);
  DOM.fabToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  DOM.fabToggle.textContent = collapsed ? '☰' : '✕';
  DOM.fabToggle.title = collapsed ? '展开工具栏' : '收起工具栏';
  DOM.fabToggle.setAttribute('aria-label', DOM.fabToggle.title);
}

function applyResponsiveLayout() {
  const saved = localStorage.getItem(CONFIG.LAYOUT_STORAGE_KEY);
  if (isNarrowViewport()) {
    if (state.layout === 'split') setLayout('render', { persist: false });
    syncFabCollapsedUI();
    return;
  }
  const wideLayout = (saved && ['split', 'render', 'source'].includes(saved)) ? saved : 'split';
  if (state.layout !== wideLayout) setLayout(wideLayout, { persist: false });
  if (DOM.appHeader) DOM.appHeader.classList.remove('header--fab-collapsed');
}

/* ========== 目录：拖拽调宽 + 显示/隐藏 ========== */
function getSavedTocWidth() {
  const w = parseInt(localStorage.getItem(CONFIG.TOC_WIDTH_KEY), 10);
  if (Number.isNaN(w)) return CONFIG.TOC_DEFAULT_WIDTH;
  return Math.max(CONFIG.TOC_MIN_WIDTH, Math.min(CONFIG.TOC_MAX_WIDTH, w));
}

function setTocWidth(width) {
  const w = Math.max(CONFIG.TOC_MIN_WIDTH, Math.min(CONFIG.TOC_MAX_WIDTH, width));
  DOM.toc.style.width = `${w}px`;
  localStorage.setItem(CONFIG.TOC_WIDTH_KEY, String(w));
}

function setTocVisible(visible, opts = {}) {
  const persist = opts.persist !== false;
  DOM.tocWrap.classList.toggle('hidden', !visible);
  if (persist) localStorage.setItem(CONFIG.TOC_VISIBLE_KEY, visible ? '1' : '0');
}

function isTocVisible() {
  return !DOM.tocWrap.classList.contains('hidden');
}

function initTocControls() {
  // 恢复宽度
  DOM.toc.style.width = `${getSavedTocWidth()}px`;

  // 恢复可见性（窄屏始终隐藏，由 CSS 控制）
  if (!isNarrowViewport()) {
    const savedVisible = localStorage.getItem(CONFIG.TOC_VISIBLE_KEY);
    setTocVisible(savedVisible === null ? true : savedVisible !== '0', { persist: false });
  }

  // 隐藏按钮
  DOM.tocHideBtn.addEventListener('click', () => {
    setTocVisible(false);
    setStatus('目录已隐藏（点击左侧 ▸ 展开）', 'info');
  });

  // 展开边条
  DOM.tocEdge.addEventListener('click', () => {
    setTocVisible(true);
    setStatus('目录已显示', 'info');
  });

  // 拖拽调整宽度
  let isDragging = false;
  DOM.tocResizeHandle.addEventListener('mousedown', (e) => {
    if (isNarrowViewport()) return;
    isDragging = true;
    DOM.tocResizeHandle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const mainRect = document.querySelector('.main-container').getBoundingClientRect();
    const startX = mainRect.left;
    const w = e.clientX - startX;
    DOM.toc.style.width = `${Math.max(CONFIG.TOC_MIN_WIDTH, Math.min(CONFIG.TOC_MAX_WIDTH, w))}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    DOM.tocResizeHandle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = parseInt(DOM.toc.style.width, 10);
    if (!Number.isNaN(w)) {
      setTocWidth(w);
      setStatus(`目录宽度已调整为 ${w}px`, 'info');
    }
  });
}

function loadFile(file, opts = {}) {
  if (!file) return;
  if (file.size > CONFIG.MAX_FILE_SIZE) {
    const limitMB = Math.round(CONFIG.MAX_FILE_SIZE / 1024 / 1024);
    setStatus(`文件过大 (${(file.size / 1024 / 1024).toFixed(1)}MB)，限制 ${limitMB}MB`, 'error');
    return;
  }
  const validExts = ['.md', '.markdown', '.mdown', '.txt'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  teardownFileWatcher();
  state.isConvertedPreview = false;
  if (!validExts.includes(ext)) {
    if (CONFIG.ANYDOC_EXTENSIONS.includes(ext)) {
      loadNonMarkdownFile(file, opts.handle);
      return;
    }
    setStatus(`不支持的文件类型: ${ext}`, 'warning');
    return;
  }
  setStatus('正在读取文件...', 'info');
  document.title = `${file.name} - Markdown 渲染器`;
  const reader = new FileReader();
  reader.onload = async (e) => {
    await renderMarkdown(e.target.result, file.name);
    if (opts.handle) {
      setupFileWatcher({ file, handle: opts.handle });
    }
  };
  reader.onerror = () => setStatus('文件读取失败', 'error');
  reader.readAsText(file, 'UTF-8');
}

/**
 * 用 AnyDoc 把 docx/pdf/pptx 等转换为 Markdown 预览（只读）。
 * wasm 侧无页级进度回调，转换期由主线程计时心跳刷新状态栏（秒数跳动），
 * 阶段由 worker 的 phase 事件驱动（engine → convert）。
 * @param {File} file
 * @param {FileSystemFileHandle} [handle]
 * @param {object} [opts]
 * @param {boolean} [opts.restoreScroll] 重载时恢复阅读位置
 */
async function loadNonMarkdownFile(file, handle, opts = {}) {
  setProgress(true, '正在读取文件...');
  document.title = `${file.name} - Markdown 渲染器`;
  state.isConvertedPreview = true;
  let phaseTimer = null;
  try {
    const startTs = Date.now();
    const bytes = new Uint8Array(await file.arrayBuffer());

    // 转换阶段：心跳计时，让状态栏进度持续刷新
    let phase = isAnyDocEngineReady() ? 'convert' : 'engine';
    phaseTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTs) / 1000);
      setProgress(true, phase === 'engine'
        ? `正在加载文档引擎（首次） · ${elapsed}s`
        : `正在转换 ${file.name} · ${elapsed}s`);
    }, 500);
    const md = await convertToMarkdown(bytes, undefined, {
      onPhase: (p) => { if (p.phase === 'convert') phase = 'convert'; },
    });
    clearInterval(phaseTimer);
    phaseTimer = null;

    if (!md || !md.trim()) {
      setProgress(false);
      setStatus('文档未能提取到文本（可能是不含文字层的扫描件）', 'warning', { persist: true });
      return;
    }
    setProgress(true, '正在渲染转换结果...');
    await renderMarkdown(md, file.name, { restoreScroll: opts.restoreScroll });
    setProgress(false);
    setStatus(`已转换为 Markdown 预览（${file.name}）`, 'success', { persist: true });
    if (handle) {
      setupFileWatcher({ file, handle });
    }
  } catch (e) {
    if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
    setProgress(false);
    console.error('AnyDoc 转换失败:', e);
    setStatus('文档转换失败: ' + (e?.message || '未知错误'), 'error', { persist: true });
  }
}

function teardownFileWatcher() {
  if (state.fileWatcher) {
    try { state.fileWatcher.stop(); } catch (_) { /* ignore */ }
    state.fileWatcher = null;
  }
}

function setupFileWatcher({ file, handle }) {
  teardownFileWatcher();
  if (!handle) return;
  const watcher = createFileWatcher({
    handle,
    getFile: () => handle.getFile(),
    onChange: (newFile) => {
      // 与手动打开共享防抖：合并编辑器的连续保存
      // 转换预览（PDF/Office）走重新转换，普通文本走重新渲染
      if (state.isConvertedPreview) {
        reloadConvertedDebounced(newFile, handle);
      } else {
        reloadFileDebounced(newFile);
      }
    },
    onError: (err) => {
      console.warn('文件监听失败:', err);
      teardownFileWatcher();
    },
  });
  state.fileWatcher = watcher;
  if (watcher && watcher.supported) {
    setStatus(`已开启文件监听（${state.currentFileName}），变更将自动重载`, 'info');
  }
}

function restoreScrollPosition(behavior = 'auto') {
  if (state.sourceScrollTop > 0) {
    DOM.sourceBody.scrollTop = state.sourceScrollTop;
    virtualSource.refresh();
  }
  if (state.renderScrollTop > 0) {
    DOM.renderBody.scrollTop = state.renderScrollTop;
  }
}

const reloadFileDebounced = debounce(async (file) => {
  if (!file) return;
  // 保留当前阅读位置，自动重载不打断阅读
  state.sourceScrollTop = DOM.sourceBody.scrollTop;
  state.renderScrollTop = DOM.renderBody.scrollTop;
  if (state.currentFileName) document.title = `${state.currentFileName} - Markdown 渲染器`;
  setStatus('文件已变更，正在自动重载...', 'info', { persist: true });
  const reader = new FileReader();
  reader.onload = (e) => {
    renderMarkdown(e.target.result, file.name, { restoreScroll: true });
  };
  reader.onerror = () => setStatus('自动重载失败: 文件读取失败', 'error');
  reader.readAsText(file, 'UTF-8');
}, RELOAD_DEBOUNCE_MS);

const reloadConvertedDebounced = debounce(async (file, handle) => {
  if (!file) return;
  // 保留当前阅读位置，重新转换不打断阅读
  state.sourceScrollTop = DOM.sourceBody.scrollTop;
  state.renderScrollTop = DOM.renderBody.scrollTop;
  await loadNonMarkdownFile(file, handle, { restoreScroll: true });
}, RELOAD_DEBOUNCE_MS);

function renderKaTeX() {
  if (!libReady.katex) return;
  try {
    renderMathInElement(DOM.content, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
    });
  } catch (e) {
    console.warn('KaTeX 渲染失败:', e);
  }
}

async function renderMermaidBlocks(force = false) {
  const ok = await ensureMermaid();
  if (!ok || !mermaid?.render) return;

  if (force) {
    DOM.content.querySelectorAll('pre.mermaid-rendered').forEach((pre) => {
      const src = pre.dataset.mermaidSource;
      if (src == null) return;
      pre.classList.remove('mermaid-rendered');
      pre.innerHTML = '';
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = src;
      pre.appendChild(code);
    });
  }

  const blocks = DOM.content.querySelectorAll('pre code.language-mermaid');
  if (!blocks.length) return;

  mermaid.initialize({
    startOnLoad: false,
    theme: state.isDark ? 'dark' : 'default',
    securityLevel: 'strict',
  });

  let idCounter = 0;
  for (const codeBlock of blocks) {
    const pre = codeBlock.parentElement;
    if (!pre || pre.classList.contains('mermaid-rendered')) continue;
    const text = codeBlock.textContent.trim();
    pre.dataset.mermaidSource = text;
    const graphId = `mermaid-${Date.now()}-${++idCounter}`;
    try {
      const { svg } = await mermaid.render(graphId, text);
      pre.classList.add('mermaid-rendered');
      pre.innerHTML = '';
      const container = document.createElement('div');
      container.className = 'mermaid-container';
      container.innerHTML = svg;
      pre.appendChild(container);
    } catch (e) {
      console.warn('Mermaid 渲染失败:', e);
      pre.classList.add('mermaid-rendered');
      const errDiv = document.createElement('div');
      errDiv.className = 'mermaid-error';
      errDiv.textContent = '图表渲染失败: ' + (typeof e === 'string' ? e : e.message || '未知错误');
      pre.appendChild(errDiv);
    }
  }
}

function assignMapping(el, elIdx, sourceLine, sourceEndLine) {
  const end = sourceEndLine && sourceEndLine >= sourceLine ? sourceEndLine : sourceLine;
  el.classList.add('render-element');
  el.dataset.elIdx = String(elIdx);
  el.dataset.sourceLine = String(sourceLine);
  el.dataset.sourceEndLine = String(end);
  state.lineMappings.push({ el, elIdx, sourceLine, sourceEndLine: end });
}

function markRenderElementsFallback(topElements) {
  const lines = state.rawText.split('\n');
  let searchFrom = 0;
  function takeNext(pred) {
    for (let i = searchFrom; i < lines.length; i++) {
      if (pred(lines[i], i)) {
        searchFrom = i + 1;
        return i + 1;
      }
    }
    const line = Math.min(lines.length, searchFrom + 1) || 1;
    searchFrom = Math.min(lines.length, searchFrom + 1);
    return line;
  }
  topElements.forEach((el, elIdx) => {
    const tag = el.tagName.toLowerCase();
    let sourceLine = 1;
    if (/^h[1-6]$/.test(tag)) {
      const depth = parseInt(tag[1], 10);
      sourceLine = takeNext((l) => {
        const m = /^(#{1,6})\s/.exec(l);
        return m && m[1].length === depth;
      });
    } else if (tag === 'pre') {
      sourceLine = takeNext((l) => /^\s*(```|~~~)/.test(l));
    } else if (tag === 'hr') {
      sourceLine = takeNext((l) => /^[-*_]{3,}\s*$/.test(l.trim()));
    } else if (tag === 'ul') {
      sourceLine = takeNext((l) => /^\s*[-*+]\s+/.test(l));
    } else if (tag === 'ol') {
      sourceLine = takeNext((l) => /^\s*\d+\.\s+/.test(l));
    } else if (tag === 'blockquote') {
      sourceLine = takeNext((l) => /^\s*>/.test(l));
    } else if (tag === 'table') {
      sourceLine = takeNext((l) => /^\s*\|/.test(l));
    } else {
      sourceLine = takeNext((l) => {
        const t = l.trim();
        return t && !/^#{1,6}\s/.test(t) && !/^(```|~~~)/.test(t)
          && !/^[-*_]{3,}\s*$/.test(t) && !/^\|/.test(t)
          && !/^[-*+]\s+/.test(t) && !/^\d+\.\s+/.test(t) && !/^>/.test(t);
      });
    }
    assignMapping(el, elIdx, sourceLine, sourceLine);
  });
}

function markRenderElements() {
  state.lineMappings = [];
  const topElements = getTopLevelBlockElements(DOM.content);
  const blocks = extractLexerBlocks(state.rawText);
  if (blocks && blocks.length > 0) {
    if (topElements.length === blocks.length) {
      let ok = true;
      for (let i = 0; i < topElements.length; i++) {
        if (!tokenMatchesDom(blocks[i], topElements[i].tagName.toLowerCase())) {
          ok = false;
          break;
        }
      }
      if (ok) {
        topElements.forEach((el, i) => assignMapping(el, i, blocks[i].sourceLine, blocks[i].sourceEndLine));
        return;
      }
    }
    let bi = 0;
    topElements.forEach((el, elIdx) => {
      const tag = el.tagName.toLowerCase();
      let found = -1;
      for (let i = bi; i < blocks.length; i++) {
        if (tokenMatchesDom(blocks[i], tag)) {
          found = i;
          break;
        }
      }
      if (found !== -1) {
        assignMapping(el, elIdx, blocks[found].sourceLine, blocks[found].sourceEndLine);
        bi = found + 1;
      } else {
        const prev = state.lineMappings[state.lineMappings.length - 1];
        const line = prev ? prev.sourceLine + 1 : 1;
        assignMapping(el, elIdx, line, line);
      }
    });
    return;
  }
  markRenderElementsFallback(topElements);
}

function generateToc() {
  const headings = DOM.content.querySelectorAll('h1,h2,h3');
  if (!headings.length) {
    DOM.tocItems.innerHTML = '<p style="font-size:12px;color:var(--text-secondary);opacity:0.7;">无标题</p>';
    return;
  }
  let html = '';
  headings.forEach((hEl, i) => {
    const lv = hEl.tagName.toLowerCase();
    const id = 'heading-' + i;
    hEl.id = id;
    html += `<a class="toc-item ${lv}" href="#${id}">${escapeHtml(hEl.textContent)}</a>`;
  });
  DOM.tocItems.innerHTML = html;
}

function addCopyCodeButtons() {
  DOM.content.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.setAttribute('aria-label', '复制代码块');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }).catch(() => {});
    });
    pre.appendChild(btn);
  });
}

function openLightbox(src, opts = {}) {
  lightboxLastFocus = document.activeElement;
  DOM.lightboxImg.src = src;
  // 大图预览跟随原图反色状态（暗色下深色图标更清晰）
  DOM.lightboxImg.classList.toggle('img-inverted', !!opts.inverted);
  DOM.lightbox.classList.add('show');
  DOM.lightbox.setAttribute('aria-hidden', 'false');
  DOM.lightboxClose.focus();
}

function closeLightbox() {
  DOM.lightbox.classList.remove('show');
  DOM.lightbox.setAttribute('aria-hidden', 'true');
  DOM.lightboxImg.removeAttribute('src');
  if (lightboxLastFocus && typeof lightboxLastFocus.focus === 'function') {
    lightboxLastFocus.focus();
  }
  lightboxLastFocus = null;
}

function setupImageLightbox() {
  DOM.content.querySelectorAll('img').forEach((img) => {
    // 暗色主题：包一层容器用于定位悬停工具条，避免重复包裹
    let wrap = img.closest('.img-wrap');
    if (!wrap) {
      wrap = document.createElement('span');
      wrap.className = 'img-wrap';
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
    }

    // 恢复该图的反色状态（按 src 记忆）
    applySavedInvert(img);

    // 悬停工具条：反色开关
    if (!wrap.querySelector('.img-toolbar')) {
      const toolbar = document.createElement('span');
      toolbar.className = 'img-toolbar';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = '切换反色（适合深色图标/截图）';
      btn.textContent = '🔄';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleInvert(img, btn);
      });
      toolbar.appendChild(btn);
      wrap.appendChild(toolbar);
      img._invertBtn = btn;
      refreshInvertBtn(img);
    }

    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', img.alt ? `查看大图：${img.alt}` : '查看大图');
    const open = (e) => {
      e.stopPropagation();
      openLightbox(img.src, { inverted: img.classList.contains('img-inverted') });
    };
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(e);
      }
    });
  });
}

/* ========== 图片反色（暗色主题下深色图标/截图适配） ========== */
function getImgInvertKey(src) {
  // 按「主题 + 图片地址」记忆，避免不同主题状态串扰
  return `md-renderer-img-invert:${state.isDark ? 'dark' : 'light'}:${src}`;
}

function isImgInverted(src) {
  try {
    return localStorage.getItem(getImgInvertKey(src)) === '1';
  } catch (_) { return false; }
}

function applySavedInvert(img) {
  if (isImgInverted(img.src)) {
    img.classList.add('img-inverted');
  } else {
    img.classList.remove('img-inverted');
  }
  if (img._invertBtn) refreshInvertBtn(img);
}

function refreshInvertBtn(img) {
  if (!img._invertBtn) return;
  const on = img.classList.contains('img-inverted');
  img._invertBtn.textContent = on ? '🔄 ✕' : '🔄';
  img._invertBtn.classList.toggle('inverted', on);
}

function toggleInvert(img, btn) {
  const on = img.classList.toggle('img-inverted');
  try {
    localStorage.setItem(getImgInvertKey(img.src), on ? '1' : '0');
  } catch (_) { /* 忽略存储失败 */ }
  refreshInvertBtn(img);
  setStatus(on ? `已对该图启用反色（${img.alt || '图片'}）` : '已取消该图反色', 'info');
}

function scrollSourceToLine(lineNum) {
  virtualSource.scrollToLine(lineNum, 'smooth');
}

function scrollRenderToMapping(mapping, lineNum) {
  if (!mapping?.el) return;
  const el = mapping.el;
  const start = mapping.sourceLine;
  const end = mapping.sourceEndLine || start;
  DOM.content.querySelectorAll('.render-element.highlighted').forEach((e) => e.classList.remove('highlighted'));
  el.classList.add('highlighted');
  setTimeout(() => el.classList.remove('highlighted'), CONFIG.HIGHLIGHT_DURATION);

  if (el.tagName.toLowerCase() === 'pre' && end > start) {
    const lines = state.rawText.split('\n');
    const isFence = /^\s*(```|~~~)/.test(lines[start - 1] || '');
    const contentStart = isFence ? start + 1 : start;
    const contentEnd = isFence ? Math.max(contentStart, end - 1) : end;
    const span = Math.max(1, contentEnd - contentStart);
    const ratio = Math.max(0, Math.min(1, (lineNum - contentStart) / span));
    const top = el.offsetTop + el.offsetHeight * ratio - DOM.renderBody.clientHeight / 3;
    DOM.renderBody.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearSearch() {
  state.searchMatchIdx = -1;
  state.searchMatchLines = [];
  DOM.searchInput.value = '';
  DOM.searchCount.textContent = '';
  virtualSource.clearSearch();
}

function performSearch(query) {
  state.searchMatchLines = [];
  state.searchMatchIdx = -1;
  if (!query.trim()) {
    DOM.searchCount.textContent = '';
    virtualSource.clearSearch();
    return;
  }
  const lower = query.toLowerCase();
  const matches = [];
  const n = virtualSource.getLineCount();
  for (let i = 1; i <= n; i++) {
    if (virtualSource.getLineText(i).toLowerCase().includes(lower)) matches.push(i);
  }
  state.searchMatchLines = matches;
  virtualSource.setSearchMatches(matches);
  DOM.searchCount.textContent = matches.length > 0 ? `0/${matches.length}` : '无匹配';
}

function navigateSearch(forward = true) {
  if (!state.searchMatchLines.length) return;
  if (forward) {
    state.searchMatchIdx = (state.searchMatchIdx + 1) % state.searchMatchLines.length;
  } else {
    state.searchMatchIdx = (state.searchMatchIdx - 1 + state.searchMatchLines.length) % state.searchMatchLines.length;
  }
  const line = state.searchMatchLines[state.searchMatchIdx];
  virtualSource.scrollToLine(line, 'smooth');
  DOM.searchCount.textContent = `${state.searchMatchIdx + 1}/${state.searchMatchLines.length}`;
}

async function renderMarkdown(text, name, opts = {}) {
  state.rawText = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = state.rawText;
  state.currentFileName = name || '未命名.md';
  showLoading(true);
  try {
    let html;
    if (libReady.marked) {
      html = marked.parse(text);
    } else {
      html = `<div style="color:red;padding:20px;">⚠️ Markdown 解析器未加载</div>`
        + `<pre style="white-space:pre-wrap;">${escapeHtml(text)}</pre>`;
    }

    let cleanHtml;
    if (libReady.dompurify) {
      cleanHtml = DOMPurify.sanitize(html, { ADD_ATTR: ['target'], ADD_TAGS: ['details', 'summary'] });
    } else {
      console.warn('⚠️ DOMPurify 未加载，拒绝渲染 HTML，降级为纯文本');
      cleanHtml = `<div style="color:var(--error-text);padding:12px;margin-bottom:12px;background:var(--error-bg);border-radius:6px;">`
        + `安全净化库未加载，已拒绝渲染 HTML，以下为纯文本预览</div>`
        + `<pre style="background:var(--code-bg);padding:14px;border-radius:6px;overflow:auto;white-space:pre-wrap;">${escapeHtml(text)}</pre>`;
    }

    state.renderedHtml = cleanHtml;
    DOM.content.innerHTML = cleanHtml;
    DOM.content.style.display = 'block';
    DOM.emptyState.style.display = 'none';
    DOM.fileName.textContent = state.currentFileName + (state.isConvertedPreview ? '（转换预览）' : '');

    DOM.content.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });

    if (libReady.hljs) {
      DOM.content.querySelectorAll('pre code').forEach((block) => {
        const lang = Array.from(block.classList).find((c) => c.startsWith('language-'))?.replace('language-', '');
        if (lang && hljs.getLanguage(lang)) {
          try { hljs.highlightElement(block); } catch (_) { /* ignore */ }
        }
      });
    }

    if (libReady.katex) renderKaTeX();
    else console.warn('⚠️ KaTeX 未加载，数学公式不渲染');

    if (DOM.content.querySelector('pre code.language-mermaid')) {
      await renderMermaidBlocks();
    }

    virtualSource.setLines(text);
    markRenderElements();
    generateToc();
    addCopyCodeButtons();
    setupImageLightbox();
    clearSearch();

    const lineCount = text.split('\n').length;
    const chars = text.replace(/\s+/g, '').length;
    DOM.statsInfo.textContent = `${lineCount} 行 · ${chars} 字符`;

    if (opts.restoreScroll) {
      restoreScrollPosition();
    }

    if (!libReady.dompurify) {
      setStatus('安全净化库未加载，已拒绝渲染 HTML（纯文本预览）', 'error');
    } else {
      const missing = Object.entries(libReady).filter(([k, r]) => !r && k !== 'mermaid').map(([n]) => n);
      if (missing.length) setStatus(`渲染完成（部分功能受限: ${missing.join(', ')}）`, 'warning');
      else setStatus('渲染完成', 'success');
    }
  } catch (e) {
    setStatus('渲染失败: ' + e.message, 'error');
    console.error(e);
  } finally {
    showLoading(false);
  }
}

function getExportableHtml() {
  const clone = DOM.content.cloneNode(true);
  clone.querySelectorAll('.copy-code-btn').forEach((el) => el.remove());
  clone.querySelectorAll('.render-element').forEach((el) => {
    el.classList.remove('render-element', 'highlighted');
    el.removeAttribute('data-el-idx');
  });
  clone.querySelectorAll('[data-mermaid-source]').forEach((el) => {
    el.removeAttribute('data-mermaid-source');
    el.classList.remove('mermaid-rendered');
  });
  const html = clone.innerHTML;
  if (libReady.dompurify) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], ADD_TAGS: ['details', 'summary'] });
  }
  return `<pre style="white-space:pre-wrap;">${escapeHtml(state.rawText)}</pre>`;
}

async function exportHTML() {
  if (!state.rawText) { setStatus('没有可导出的内容', 'warning'); return; }
  const htmlContent = getExportableHtml();
  let hljsCss = '';
  let katexCss = '';
  try {
    const [a, b] = await Promise.all([
      fetch('vendor/github.min.css').then((r) => (r.ok ? r.text() : '')),
      fetch('vendor/katex.min.css').then((r) => (r.ok ? r.text() : '')),
    ]);
    hljsCss = a;
    katexCss = b.replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.18.1/dist/fonts/');
  } catch (_) { /* 离线导出仍可用内联基础样式 */ }

  const fullHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown 导出</title>
<style>
${hljsCss}
${katexCss}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.7; color: #333; }
h1, h2, h3 { margin-top: 24px; margin-bottom: 12px; }
h1 { border-bottom: 2px solid #eee; padding-bottom: 8px; }
h2 { border-bottom: 1px solid #eee; padding-bottom: 4px; }
code { background: #f6f8fa; padding: 2px 5px; border-radius: 3px; font-size: 13px; }
pre { background: #f6f8fa; padding: 14px; border-radius: 6px; overflow-x: auto; margin-bottom: 14px; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #1a73e8; padding: 6px 14px; margin: 14px 0; background: #f8f9fa; color: #555; }
table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
th, td { border: 1px solid #e0e0e0; padding: 6px 10px; }
th { background: #f6f8fa; font-weight: 600; }
img { max-width: 100%; border-radius: 4px; }
a { color: #1a73e8; }
hr { border: none; border-top: 2px solid #eee; margin: 20px 0; }
.mermaid-container { text-align: center; margin: 14px 0; }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`;

  const blob = new Blob([fullHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.currentFileName || 'document').replace(/\.(md|markdown|mdown|txt)$/i, '') + '.html';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('HTML 已导出（样式已内联）', 'success');
}

function bindEvents() {
  DOM.fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadFile(f);
    DOM.fileInput.value = '';
  });

  // 打开文件（支持时走系统文件选择器，定位到上次所在文件夹）
  async function openFile() {
    if (isFsSupported()) {
      try {
        const { file, handle } = await openFileFromPicker();
        loadFile(file, { handle });
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 用户取消
        console.error('打开文件失败:', err);
        setStatus('打开文件失败: ' + (err?.message || '未知错误'), 'error');
      }
      return;
    }
    DOM.fileInput.click();
  }

  const openLabel = (DOM.fileInput.labels && DOM.fileInput.labels[0])
    || document.querySelector('label[for="file-input"]');
  if (openLabel) {
    openLabel.addEventListener('click', (e) => {
      e.preventDefault();
      openFile();
    });
  }

  let dragCounter = 0;
  const showDrop = (on) => {
    if (DOM.dropOverlay) DOM.dropOverlay.classList.toggle('show', on);
  };
  document.body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    showDrop(true);
  });
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      showDrop(false);
    }
  });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    showDrop(false);
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const f = dt.files[0];
    let handle = null;
    if (dt.items && typeof dt.items[0]?.getAsFileSystemHandle === 'function') {
      try {
        const h = await dt.items[0].getAsFileSystemHandle();
        if (h && h.kind === 'file') {
          handle = h;
          saveFileHandle(h); // 记住所在文件夹，下次打开定位到这里
        }
      } catch (_) { /* 拖拽句柄获取失败，按普通文件处理 */ }
    }
    loadFile(f, { handle });
  });

  DOM.content.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('.copy-code-btn') || e.target.closest('img')) return;
    const el = e.target.closest('.render-element');
    if (!el) return;
    const elIdx = parseInt(el.dataset.elIdx, 10);
    const mapping = state.lineMappings.find((m) => m.elIdx === elIdx);
    if (mapping) {
      const line = estimateSourceLineFromClick(el, e.clientY, mapping, state.rawText);
      syncCtl.withSyncDisabled(() => scrollSourceToLine(line));
    }
  });

  const onSourceLine = (e) => {
    const lineDiv = e.target.closest('.source-line');
    if (!lineDiv) return;
    const lineNum = parseInt(lineDiv.dataset.line, 10);
    const mapping = findMappingForSourceLine(state.lineMappings, lineNum);
    if (mapping) syncCtl.withSyncDisabled(() => scrollRenderToMapping(mapping, lineNum));
  };
  DOM.sourceCode.addEventListener('click', onSourceLine);
  DOM.sourceCode.addEventListener('dblclick', onSourceLine);

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('toc-item')) {
      e.preventDefault();
      const t = document.querySelector(e.target.getAttribute('href'));
      if (t) {
        syncCtl.withSyncDisabled(() => {
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const elIdx = parseInt(t.dataset.elIdx, 10);
          const mapping = state.lineMappings.find((m) => m.elIdx === elIdx);
          if (mapping) scrollSourceToLine(mapping.sourceLine);
        });
      }
    }
  });

  DOM.copyBtn.addEventListener('click', () => {
    if (!state.rawText) { setStatus('没有可复制的内容', 'warning'); return; }
    navigator.clipboard.writeText(state.rawText).then(() => {
      DOM.copyBtn.textContent = '✅ 已复制';
      DOM.copyBtn.classList.add('copied');
      setTimeout(() => {
        DOM.copyBtn.textContent = '📋 源码';
        DOM.copyBtn.classList.remove('copied');
      }, 2000);
      setStatus('源码已复制到剪贴板', 'success');
    }).catch(() => setStatus('复制失败', 'error'));
  });

  DOM.copyHtmlBtn.addEventListener('click', () => {
    if (!state.renderedHtml) { setStatus('没有可复制的内容', 'warning'); return; }
    navigator.clipboard.writeText(getExportableHtml()).then(() => {
      DOM.copyHtmlBtn.textContent = '✅ 已复制';
      DOM.copyHtmlBtn.classList.add('copied');
      setTimeout(() => {
        DOM.copyHtmlBtn.textContent = '📋 HTML';
        DOM.copyHtmlBtn.classList.remove('copied');
      }, 2000);
      setStatus('HTML 已复制到剪贴板', 'success');
    }).catch(() => setStatus('复制失败', 'error'));
  });

  DOM.themeToggle.addEventListener('click', toggleTheme);
  DOM.syncScrollBtn.addEventListener('click', () => {
    if (state.layout !== 'split') return;
    state.syncScroll = !state.syncScroll;
    DOM.syncScrollBtn.classList.toggle('active', state.syncScroll);
    DOM.syncScrollBtn.textContent = state.syncScroll ? '🔗 已同步' : '🔗 同步';
    syncCtl.setup();
    setStatus(state.syncScroll ? '同步滚动已开启' : '同步滚动已关闭');
    localStorage.setItem('md-renderer-sync-scroll', state.syncScroll ? '1' : '0');
  });

  DOM.layoutBtn.addEventListener('click', () => {
    const narrow = isNarrowViewport();
    const layouts = narrow ? ['render', 'source'] : ['split', 'render', 'source'];
    const idx = Math.max(0, layouts.indexOf(state.layout));
    setLayout(layouts[(idx + 1) % layouts.length], { persist: !narrow });
  });

  DOM.shortcutsBtn.addEventListener('click', () => {
    DOM.shortcutsHint.classList.toggle('show');
  });

  DOM.lightboxClose.addEventListener('click', closeLightbox);
  DOM.lightbox.addEventListener('click', (e) => {
    if (e.target === DOM.lightbox) closeLightbox();
  });
  DOM.lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      DOM.lightboxClose.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!DOM.shortcutsHint.contains(e.target) && e.target !== DOM.shortcutsBtn) {
      DOM.shortcutsHint.classList.remove('show');
    }
  });

  if (DOM.fabToggle) {
    DOM.fabToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isNarrowViewport()) return;
      localStorage.setItem(CONFIG.FAB_COLLAPSED_KEY, isFabCollapsed() ? '0' : '1');
      syncFabCollapsedUI();
    });
  }

  DOM.searchInput.addEventListener('input', debounce(() => {
    performSearch(DOM.searchInput.value);
  }, 200));

  document.addEventListener('keydown', (e) => {
    if (DOM.lightbox.classList.contains('show') && e.key === 'Escape') {
      closeLightbox();
      return;
    }
    const typing = isTypingTarget(e.target);
    if (e.key === 'Enter' && e.target === DOM.searchInput && state.searchMatchLines.length > 0) {
      navigateSearch(!e.shiftKey);
      e.preventDefault();
      return;
    }
    if (typing && !(e.ctrlKey || e.metaKey)) return;
    if (e.key === '?') {
      DOM.shortcutsHint.classList.toggle('show');
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'o') {
        e.preventDefault();
        openFile();
      }
      if (e.key === 'd') {
        e.preventDefault();
        toggleTheme();
      }
      if (e.key === 'l') {
        if (state.layout !== 'split') return;
        e.preventDefault();
        DOM.syncScrollBtn.click();
      }
      if (e.key === 's') {
        e.preventDefault();
        exportHTML();
      }
      if (e.key === '\\' || e.key === '|') {
        e.preventDefault();
        DOM.layoutBtn.click();
      }
    }
  });

  let isResizing = false;
  DOM.resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    DOM.resizeHandle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const containerRect = DOM.panels.getBoundingClientRect();
    const handleW = DOM.resizeHandle.offsetWidth || 8;
    const gap = 8; // .panels gap
    const usable = Math.max(1, containerRect.width - handleW - gap);
    const percentage = ((e.clientX - containerRect.left) / usable) * 100;
    const clamped = Math.max(20, Math.min(80, percentage));
    DOM.renderPanel.style.flex = `0 0 ${clamped}%`;
    DOM.sourcePanel.style.flex = `1 1 auto`;
  });
  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    DOM.resizeHandle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('panel-width', DOM.renderPanel.style.flex);
  });
}

function init() {
  const savedTheme = localStorage.getItem('md-renderer-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    applyTheme(savedTheme === 'dark');
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    applyTheme(true);
  } else {
    applyTheme(false);
  }

  const savedWidth = localStorage.getItem('panel-width');
  if (savedWidth) {
    DOM.renderPanel.style.flex = savedWidth;
    const match = savedWidth.match(/(\d+)/);
    if (match) DOM.sourcePanel.style.flex = `0 0 ${100 - parseInt(match[1], 10)}%`;
  }

  applyResponsiveLayout();
  if (typeof narrowMediaQuery.addEventListener === 'function') {
    narrowMediaQuery.addEventListener('change', applyResponsiveLayout);
  } else if (typeof narrowMediaQuery.addListener === 'function') {
    narrowMediaQuery.addListener(applyResponsiveLayout);
  }

  if (localStorage.getItem('md-renderer-sync-scroll') === '1') {
    state.syncScroll = true;
    DOM.syncScrollBtn.classList.add('active');
    DOM.syncScrollBtn.textContent = '🔗 已同步';
  }
  updateSyncScrollAvailability();
  syncFabCollapsedUI();
  initTocControls();

  // a11y labels
  DOM.layoutBtn.setAttribute('aria-label', '切换布局');
  DOM.shortcutsBtn.setAttribute('aria-label', '显示快捷键');
  DOM.syncScrollBtn.setAttribute('aria-label', '同步滚动');
  DOM.copyBtn.setAttribute('aria-label', '复制源码');
  DOM.copyHtmlBtn.setAttribute('aria-label', '复制渲染 HTML');
  DOM.fabToggle?.setAttribute('aria-label', '展开工具栏');
  DOM.lightbox.setAttribute('role', 'dialog');
  DOM.lightbox.setAttribute('aria-modal', 'true');
  DOM.lightbox.setAttribute('aria-hidden', 'true');
  DOM.lightboxClose.setAttribute('aria-label', '关闭图片预览');
  DOM.lightboxClose.setAttribute('tabindex', '0');

  bindEvents();

  // 系统文件关联：装成 PWA 后双击 .md，Chrome 经 launchQueue 把文件交进来，
  // 复用既有 loadFile 入口；浏览器不支持时这两步自动跳过
  initFileHandling((file, opts) => loadFile(file, opts));
  registerServiceWorker();

  setStatus('就绪 · 按 Ctrl+O 打开文件 · 按 ? 查看快捷键');

  // 页面空闲时预热 AnyDoc 引擎（约 6.7MB wasm），首次打开 Office/PDF 免等待
  const warmUp = () => { warmUpAnyDoc(); };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(warmUp, { timeout: 3000 });
  } else {
    setTimeout(warmUp, 2000);
  }
}

init();
