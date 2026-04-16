/**
 * Generic extractor (T-017).
 *
 * Fallback extractor for unsupported languages. Extracts
 * comment blocks and TODO/FIXME annotations only.
 */
// @ts-nocheck


function lineNumber(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract annotations and comment blocks from any source file.
 *
 * @param {string} content
 * @returns {Array<{
 *   symbol_type: string,
 *   name: string,
 *   signature: string,
 *   doc_comment: string|null,
 *   line_start: number,
 *   exported: boolean
 * }>}
 */
export function extractGeneric(content) {
  if (!content) return [];

  const symbols = [];
  let m;

  // --- Block comments /** ... */ ---
  const blockRe = /\/\*\*([\s\S]*?)\*\//g;
  while ((m = blockRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const body = m[1]
      .split('\n')
      .map(l => l.trim().replace(/^\*\s?/, ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (body.length > 10) {
      symbols.push({
        symbol_type: 'comment_block',
        name: body.split('\n')[0].slice(0, 60),
        signature: body.split('\n')[0],
        doc_comment: body,
        line_start: line,
        exported: false,
      });
    }
  }

  // --- TODO / FIXME (C-style comments) ---
  const todoRe = /(?:\/\/|#)\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.*)/gi;
  while ((m = todoRe.exec(content)) !== null) {
    symbols.push({
      symbol_type: 'annotation',
      name: m[1].toUpperCase(),
      signature: `${m[1].toUpperCase()}: ${m[2].trim()}`,
      doc_comment: null,
      line_start: lineNumber(content, m.index),
      exported: false,
    });
  }

  return symbols;
}
