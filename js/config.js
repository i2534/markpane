/** @typedef {'split'|'render'|'source'} LayoutMode */

export const CONFIG = {
  DEBOUNCE_DELAY: 100,
  HIGHLIGHT_DURATION: 2000,
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  SYNC_LOCK_GRACE_MS: 150,
  NARROW_MAX_WIDTH: 900,
  LAYOUT_STORAGE_KEY: 'md-renderer-layout-wide',
  FAB_COLLAPSED_KEY: 'md-renderer-fab-collapsed',
  TOC_WIDTH_KEY: 'md-renderer-toc-width',
  TOC_VISIBLE_KEY: 'md-renderer-toc-visible',
  TOC_DEFAULT_WIDTH: 170,
  TOC_MIN_WIDTH: 90,
  TOC_MAX_WIDTH: 420,
  SOURCE_LINE_HEIGHT: 22,
  SOURCE_OVERSCAN: 16,
  MERMAID_SRC: 'vendor/mermaid.min.js',
  ANYDOC_EXTENSIONS: ['.doc', '.docx', '.docm', '.ppt', '.pptx', '.pptm', '.ppsx',
    '.ppsm', '.xls', '.xlsx', '.xlsm', '.xlsb', '.odt', '.ods', '.odp',
    '.rtf', '.epub', '.csv', '.pdf'],
};
