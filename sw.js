/**
 * Service Worker（最小实现，不做任何缓存）
 *
 * 存在的唯一目的：让 /s/md/ 满足 PWA 可安装条件（manifest + Service Worker + HTTPS）。
 * 只有装成 PWA，Chrome 才会在操作系统层面注册 .md 文件关联（File Handling API）。
 *
 * 刻意不缓存：不调用 event.respondWith()，所有请求直接走网络，
 * 避免旧资源被 SW 缓存后，页面更新了行为却还是旧的。
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome 的 PWA 可安装性判定要求存在 fetch 处理器；此处仅占位，不拦截请求。
self.addEventListener('fetch', () => {});
