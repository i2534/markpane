import { CONFIG } from './config.js';

/**
 * 双栏同步滚动 + 程序化跳转时的锁
 */
export function createSyncScrollController({ getState, setState, renderBody, sourceBody }) {
  let handlers = [];
  let scrollTimeout = null;

  function tearDown() {
    handlers.forEach(({ el, handler }) => {
      if (typeof handler.cancel === 'function') handler.cancel();
      el.removeEventListener('scroll', handler);
    });
    handlers = [];
    setState({ isScrolling: false });
    clearTimeout(scrollTimeout);
  }

  function createHandler() {
    let timer = null;
    function handler(e) {
      const state = getState();
      if (state.syncLock || !state.syncScroll || state.isScrolling) return;
      if (state.layout !== 'split') return;

      const target = e.target;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const st = getState();
        if (st.syncLock || !st.syncScroll || st.isScrolling || st.layout !== 'split') return;

        setState({ isScrolling: true });
        const scrollTop = target.scrollTop;
        const scrollHeight = target.scrollHeight - target.clientHeight;
        const ratio = scrollHeight > 0 ? scrollTop / scrollHeight : 0;
        const other = target === renderBody ? sourceBody : renderBody;
        const otherScrollHeight = other.scrollHeight - other.clientHeight;
        if (otherScrollHeight > 0) other.scrollTop = ratio * otherScrollHeight;

        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => setState({ isScrolling: false }), 80);
      }, CONFIG.DEBOUNCE_DELAY);
    }
    handler.cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    return handler;
  }

  function setup() {
    tearDown();
    const state = getState();
    if (!state.syncScroll || state.syncLock || state.layout !== 'split') return;
    const handleScroll = createHandler();
    renderBody.addEventListener('scroll', handleScroll, { passive: true });
    sourceBody.addEventListener('scroll', handleScroll, { passive: true });
    handlers = [
      { el: renderBody, handler: handleScroll },
      { el: sourceBody, handler: handleScroll },
    ];
  }

  function waitScrollStable(el, timeout = 2000) {
    if (!el) return Promise.resolve();
    return new Promise((resolve) => {
      const startTime = Date.now();
      const startTop = el.scrollTop;
      let lastTop = startTop;
      let stableCount = 0;
      let seenMotion = false;
      const requiredStable = 6;
      const idleOkMs = 120;

      const check = () => {
        const now = Date.now();
        if (now - startTime > timeout) {
          resolve();
          return;
        }
        const top = el.scrollTop;
        if (top !== startTop) seenMotion = true;
        if (top === lastTop) {
          stableCount++;
          if (stableCount >= requiredStable && (seenMotion || now - startTime >= idleOkMs)) {
            resolve();
            return;
          }
        } else {
          stableCount = 0;
          lastTop = top;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  function withSyncDisabled(fn) {
    const state = getState();
    if (!state.syncScroll || state.layout !== 'split') {
      fn();
      return;
    }
    const gen = (state.syncLockGen || 0) + 1;
    setState({ syncLock: true, syncLockGen: gen });
    tearDown();
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
    Promise.all([waitScrollStable(renderBody), waitScrollStable(sourceBody)])
      .then(() => new Promise((r) => setTimeout(r, CONFIG.SYNC_LOCK_GRACE_MS)))
      .then(() => {
        if (getState().syncLockGen !== gen) return;
        setState({ syncLock: false });
        if (getState().syncScroll) setup();
      });
  }

  return { setup, tearDown, withSyncDisabled };
}
