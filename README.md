# markpane

纯前端的文档渲染器：把 Markdown（以及 docx / pdf / pptx / xlsx 等）拖进浏览器就能读，并且可以安装成 PWA、被系统关联为 .md 文件的默认打开方式。

## 功能

- Markdown 渲染：标题、表格、代码高亮、任务列表；KaTeX 数学公式；Mermaid 图表（按需懒加载）
- 双栏对照：左侧渲染、右侧源码，行级映射 + 同步滚动 + 源码搜索
- 其他文档：docx / pdf / pptx / xlsx / odt 等由 AnyDoc（WebAssembly，本地转换）渲染为 Markdown 预览
- 目录（TOC）、暗色模式、图片灯箱、导出内联样式 HTML、长文虚拟滚动
- 纯静态、无后端：文件全部在浏览器本地处理，不上传

## 快速开始

起一个静态服务器即可（Service Worker 要求 HTTPS 或 localhost）：

    python3 -m http.server 8088
    # 浏览器打开 http://localhost:8088/

部署到任意 HTTPS 静态托管（Caddy / nginx / GitHub Pages …）都行，本目录就是站点根。

## 在线使用

- 在线地址（GitHub Pages）：<https://i2534.github.io/markpane/>
- 源码仓库：<https://github.com/i2534/markpane>
- 问题反馈：<https://github.com/i2534/markpane/issues>

Pages 直接以仓库根目录为站点根（含 .nojekyll，无构建步骤），推送到 main 后自动更新；
线上是 HTTPS，可直接“安装”为 PWA 并使用系统 .md 文件关联。

页面右上角的 ℹ️ 按钮即“关于”，里面汇总了快捷键说明、项目地址与依赖版本。

## 安装为 PWA 并关联系统 .md

manifest.json 里声明了 file_handlers（text/markdown ← .md / .markdown / .mdown）：

1. 用 Chrome 或 Edge（102+ 桌面版）打开站点，地址栏右侧点“安装”
2. 把“Markdown 渲染器”设为 .md 的默认打开方式
   - Linux：文件管理器右键 → 属性 → 打开方式 → 选中后设为默认
   - Windows：双击 .md 时选“始终使用此应用”
   - macOS：安装后在“显示简介 → 打开方式”里指定
3. 之后双击 .md，Chrome 会通过 launchQueue 把文件交给页面直接渲染

仅 Chromium 系桌面浏览器支持系统文件关联；Firefox / Safari / 移动端可以正常当网页使用，但无法被系统关联。

## 缓存建议

页面壳（HTML / JS / CSS / manifest / sw）建议 Cache-Control: no-cache（配合 ETag 走 304），
避免浏览器启发式缓存导致更新不生效；vendor/ 下的第三方库可以长缓存。
GitHub Pages 固定给资源加 max-age=600（约 10 分钟），更新最多延迟这么久。

## 目录结构

    index.html          页面骨架
    manifest.json       PWA 清单（含 file_handlers）
    sw.js               最小 Service Worker（pass-through，不缓存任何资源）
    js/                 应用逻辑（app.js 为主）
    css/app.css         样式
    vendor/             第三方库与 AnyDoc wasm
    icons/              PWA 图标
    docs/               设计文档
    Caddyfile           部署参考片段
