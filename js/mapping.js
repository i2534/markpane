import { countNewlines } from './utils.js';
import { libReady } from './deps.js';

export function getTopLevelBlockElements(container) {
  const topTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr']);
  const result = [];
  for (let i = 0; i < container.children.length; i++) {
    const el = container.children[i];
    if (topTags.has(el.tagName.toLowerCase())) result.push(el);
  }
  return result;
}

function domTagToTokenType(tag) {
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return 'heading';
    case 'p': return 'paragraph';
    case 'pre': return 'code';
    case 'ul': case 'ol': return 'list';
    case 'blockquote': return 'blockquote';
    case 'table': return 'table';
    case 'hr': return 'hr';
    default: return null;
  }
}

function headingDepthFromTag(tag) {
  const m = /^h([1-6])$/.exec(tag);
  return m ? parseInt(m[1], 10) : 0;
}

export function tokenMatchesDom(block, tag) {
  const want = domTagToTokenType(tag);
  if (!want || block.type !== want) return false;
  if (want === 'heading') {
    const d = headingDepthFromTag(tag);
    return !block.depth || block.depth === d;
  }
  if (want === 'list') {
    if (tag === 'ol') return !!block.ordered;
    if (tag === 'ul') return !block.ordered;
  }
  return true;
}

/**
 * 用 marked.lexer + 游标累加行号锚定块起止行（避免反复全量扫字符串）
 */
export function extractLexerBlocks(text) {
  if (!libReady.marked || typeof marked.lexer !== 'function') return null;

  let tokens;
  try {
    tokens = marked.lexer(text);
  } catch (e) {
    console.warn('marked.lexer 失败，回退模糊映射:', e);
    return null;
  }

  const SKIP = new Set(['space', 'def', 'html']);
  const blocks = [];
  let cursor = 0;
  let line = 1;

  const advanceCursor = (next) => {
    const to = Math.min(Math.max(next, cursor), text.length);
    line += countNewlines(text, cursor, to);
    cursor = to;
  };

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (SKIP.has(token.type)) {
      if (token.raw) {
        const skipIdx = text.indexOf(token.raw, cursor);
        if (skipIdx !== -1) {
          advanceCursor(skipIdx);
          advanceCursor(skipIdx + token.raw.length);
        } else {
          advanceCursor(cursor + token.raw.length);
        }
      }
      continue;
    }
    if (!token.raw) continue;

    let idx = text.indexOf(token.raw, cursor);
    if (idx === -1) {
      const startLine = line;
      const endPos = Math.min(text.length, cursor + token.raw.length);
      const endLine = startLine + countNewlines(text, cursor, Math.max(cursor, endPos - 1));
      blocks.push({
        type: token.type,
        depth: token.depth || 0,
        ordered: !!token.ordered,
        sourceLine: startLine,
        sourceEndLine: Math.max(startLine, endLine),
      });
      advanceCursor(endPos);
      continue;
    }

    advanceCursor(idx);
    const sourceLine = line;
    const endPos = idx + token.raw.length;
    const sourceEndLine = sourceLine + countNewlines(text, idx, Math.max(idx, endPos - 1));
    blocks.push({
      type: token.type,
      depth: token.depth || 0,
      ordered: !!token.ordered,
      sourceLine,
      sourceEndLine,
    });
    advanceCursor(endPos);
  }

  return blocks;
}

export function findMappingForSourceLine(lineMappings, lineNum) {
  let best = null;
  for (let i = 0; i < lineMappings.length; i++) {
    const m = lineMappings[i];
    if (m.sourceLine <= lineNum) best = m;
    else break;
  }
  return best;
}

export function estimateSourceLineFromClick(el, clientY, mapping, rawText) {
  const start = mapping.sourceLine;
  const end = mapping.sourceEndLine || start;
  if (end <= start) return start;

  const rect = el.getBoundingClientRect();
  if (rect.height <= 0) return start;

  const tag = el.tagName.toLowerCase();
  const lines = rawText.split('\n');
  const openLine = lines[start - 1] || '';
  const isFence = /^\s*(```|~~~)/.test(openLine);

  if (tag === 'pre') {
    const code = el.querySelector('code') || el;
    const style = window.getComputedStyle(code);
    const preStyle = window.getComputedStyle(el);
    let lh = parseFloat(style.lineHeight);
    if (!lh || Number.isNaN(lh)) lh = (parseFloat(style.fontSize) || 14) * 1.5;
    const padTop = (parseFloat(preStyle.paddingTop) || 0) + (parseFloat(style.paddingTop) || 0);
    const y = clientY - rect.top - padTop;
    const visualIdx = Math.max(0, Math.floor(y / lh));
    const contentStart = isFence ? start + 1 : start;
    const contentEnd = isFence ? Math.max(contentStart, end - 1) : end;
    return Math.min(contentEnd, contentStart + visualIdx);
  }

  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return Math.round(start + (end - start) * ratio);
}
