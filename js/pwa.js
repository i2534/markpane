/**
 * PWA / 系统文件关联集成
 *
 * 1) registerServiceWorker()：注册 Service Worker —— PWA 可安装的前提；
 *    装成 PWA 后，Chrome 读 manifest 的 file_handlers，在操作系统层面把
 *    本应用注册为 .md 的打开方式（Linux 走 xdg-mime，Windows 走注册表，
 *    macOS 随 app bundle 的 Info.plist）。
 * 2) initFileHandling()：消费 launchQueue 送来的文件 —— 系统双击 .md 或
 *    在“打开方式”里选中本应用时，Chrome 以 FileSystemFileHandle 的形式
 *    把文件交给页面（File Handling API，Chrome/Edge 102+ 桌面版）。
 *
 * 浏览器不支持时全部静默跳过，页面行为与之前完全一致。
 */

/** 注册 Service Worker；失败只告警，不影响页面任何功能 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // 相对“文档 URL”解析：页面在 /s/md/ 下，SW 即 /s/md/sw.js，scope 同为 /s/md/
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service Worker 注册失败（不影响正常使用）:', err);
    });
  });
}

/**
 * 接管系统交给本应用的文件。
 * @param {(file: File, opts: {handle: FileSystemFileHandle|null}) => void} onFile
 *        文件就绪后的回调，直接复用页面既有的 loadFile(file, {handle}) 入口
 * @returns {boolean} 当前环境是否支持系统文件关联
 */
export function initFileHandling(onFile) {
  if (typeof onFile !== 'function' || !('launchQueue' in window)) return false;

  window.launchQueue.setConsumer(async (launchParams) => {
    const handles = (launchParams && launchParams.files) || [];
    if (!handles.length) return;
    const handle = handles[0];
    const hasGetFile = typeof handle.getFile === 'function';
    try {
      const file = hasGetFile ? await handle.getFile() : handle;
      if (file instanceof File) {
        // 传 handle 可复用“文件被外部修改后自动重载”的能力
        onFile(file, { handle: hasGetFile ? handle : null });
      }
    } catch (err) {
      console.error('打开系统传入的文件失败:', err);
    }
  });
  return true;
}
