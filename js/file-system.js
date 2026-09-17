/**
 * 文件系统增强模块
 *
 * 能力检测 + 打开文件选择器（定位上次所在文件夹）+ 文件变更监听（自动重载）。
 * 全部为“渐进增强”：浏览器不支持时静默回退到传统 <input type="file"> 方式，
 * 页面行为与旧版完全一致。
 *
 * 依赖：
 *   - window.showOpenFilePicker：File System Access API（Chrome/Edge/Opera）
 *   - FileSystemObserver：Chrome 133+ 默认启用
 */

import { CONFIG } from './config.js';

const DB_NAME = 'md-renderer-fs';
const DB_VERSION = 1;
const HANDLE_STORE = 'handles';
const LAST_HANDLE_KEY = 'last-file-handle';

/** File System Access API 是否可用 */
export function isFsSupported() {
  return typeof window !== 'undefined'
    && typeof window.showOpenFilePicker === 'function';
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('indexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getLastFileHandle() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(LAST_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('读取上次文件句柄失败:', e);
    return null;
  }
}

export async function saveFileHandle(handle) {
  if (!handle) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, LAST_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('保存文件句柄失败:', e);
  }
}

/**
 * 用系统文件选择器打开文件。
 * 若已保存过上次文件句柄，则通过 startIn 定位到上次文件所在文件夹。
 * @returns {Promise<{file: File, handle: FileSystemFileHandle|null}>}
 */
export async function openFileFromPicker() {
  const pickerOpts = {
    multiple: false,
    types: [{
      description: '支持的文档格式（Markdown / Office / PDF 等）',
      accept: {
        'text/*': ['.md', '.markdown', '.mdown', '.txt', '.csv', '.rtf', '.epub'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx', '.doc', '.docm'],
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx', '.ppt', '.pptm', '.ppsx', '.ppsm'],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xls', '.xlsm', '.xlsb'],
        'application/vnd.oasis.opendocument.text': ['.odt'],
        'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
        'application/vnd.oasis.opendocument.presentation': ['.odp'],
        'application/pdf': ['.pdf'],
      },
    }],
  };
  const last = await getLastFileHandle();
  if (last) pickerOpts.startIn = last;

  const [handle] = await window.showOpenFilePicker(pickerOpts);
  const file = await handle.getFile();
  await saveFileHandle(handle);
  return { file, handle };
}

/**
 * 创建文件变更监听。
 * 路径 A：FileSystemObserver（Chrome 133+，事件驱动）
 * 路径 B：轮询 file.lastModified / size（不支持 Observer 的 Chrome 版本兜底）
 * @param {object} opts
 * @param {FileSystemFileHandle|null} opts.handle 文件句柄（无句柄则无法监听）
 * @param {() => Promise<File|null>} opts.getFile 重新读取文件
 * @param {(file: File) => void} opts.onChange   内容变化回调
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{supported: boolean, stop: () => void}|null} 无法监听时返回 null
 */
export function createFileWatcher({ handle, getFile, onChange, onError = () => {} }) {
  if (!handle || typeof onChange !== 'function') return null;

  // 路径 A：FileSystemObserver（事件驱动）
  if (typeof FileSystemObserver === 'function') {
    let stopped = false;
    let pending = false;
    const observer = new FileSystemObserver(async () => {
      if (pending) return;
      pending = true;
      try {
        const file = await getFile();
        if (file) onChange(file);
      } catch (e) {
        onError(e);
      } finally {
        pending = false;
      }
    });
    observer.observe(handle).catch((e) => onError(e));
    return {
      supported: true,
      stop() {
        if (stopped) return;
        stopped = true;
        try { observer.disconnect(); } catch (_) { /* ignore */ }
      },
    };
  }

  // 路径 B：轮询 lastModified
  const POLL_INTERVAL = 1000;
  let lastModified = null;
  let stopped = false;
  let timer = null;

  async function check() {
    if (stopped) return;
    try {
      const file = await getFile();
      if (!file) return;
      const key = `${file.lastModified}:${file.size}`;
      if (lastModified !== null && key !== lastModified) onChange(file);
      lastModified = key;
    } catch (e) {
      onError(e);
    }
  }

  check().then(() => {
    if (stopped) return;
    timer = setInterval(check, POLL_INTERVAL);
  });

  return {
    supported: false,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
