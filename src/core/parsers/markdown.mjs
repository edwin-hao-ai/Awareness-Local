/**
 * Markdown extractor (T-017).
 *
 * Extracts headings, frontmatter, links, code blocks, and TODO items
 * from Markdown files. Useful for doc-code association discovery.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structure from Markdown source.
 *
 * @param {string} content
 * @returns {Array<{
 *   symbol_type: string,
 *   name: string,
 *   signature: string,
 *   doc_comment: string|null,
 *   line_start: number,
 *   exported: boolean,
 *   level?: number,
 *   target?: string,
 *   language?: string
 * }>}
 */
export function extractMarkdown(content) {
  if (!content) return [];

  const symbols = [];
  const lines = content.split('\n');
  let m;

  // --- Frontmatter (YAML between ---) ---
  const fmRe = /^---\n([\s\S]*?)\n---/;
  m = fmRe.exec(content);
  if (m) {
    symbols.push({
      symbol_type: 'frontmatter',
      name: 'frontmatter',
      signature: 'frontmatter',
      doc_comment: m[1].trim(),
      line_start: 1,
      exported: true,
    });
  }

  // --- Headings ---
  const headingRe = /^(#{1,6})\s+(.+)/gm;
  while ((m = headingRe.exec(content)) !== null) {
    const line = content.slice(0, m.index).split('\n').length;
    const level = m[1].length;
    symbols.push({
      symbol_type: 'heading',
      name: m[2].trim(),
      signature: `${'#'.repeat(level)} ${m[2].trim()}`,
      doc_comment: null,
      line_start: line,
      exported: true,
      level,
    });
  }

  // --- Links: [text](url) ---
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = linkRe.exec(content)) !== null) {
    const line = content.slice(0, m.index).split('\n').length;
    symbols.push({
      symbol_type: 'link',
      name: m[1],
      signature: `[${m[1]}](${m[2]})`,
      doc_comment: null,
      line_start: line,
      exported: false,
      target: m[2],
    });
  }

  // --- Code blocks with language ---
  const codeRe = /^```(\w+)?/gm;
  while ((m = codeRe.exec(content)) !== null) {
    if (!m[1]) continue;
    const line = content.slice(0, m.index).split('\n').length;
    symbols.push({
      symbol_type: 'code_block',
      name: m[1],
      signature: `\`\`\`${m[1]}`,
      doc_comment: null,
      line_start: line,
      exported: false,
      language: m[1],
    });
  }

  // --- TODO / FIXME in markdown ---
  const todoRe = /(?:^|\s)(TODO|FIXME|HACK|NOTE)\b[:\s]*(.*)/gi;
  while ((m = todoRe.exec(content)) !== null) {
    symbols.push({
      symbol_type: 'annotation',
      name: m[1].toUpperCase(),
      signature: `${m[1].toUpperCase()}: ${m[2].trim()}`,
      doc_comment: null,
      line_start: content.slice(0, m.index).split('\n').length,
      exported: false,
    });
  }

  return symbols;
}

/**
 * Extract file references from Markdown content.
 * Finds code references in backticks and link targets.
 *
 * @param {string} content
 * @returns {Array<{ path: string, type: 'link'|'reference' }>}
 */
export function extractMarkdownRefs(content) {
  if (!content) return [];

  const refs = [];
  const seen = new Set();
  let m;

  // [text](path) links — only relative paths (not http/https)
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = linkRe.exec(content)) !== null) {
    const target = m[2].split('#')[0].trim(); // strip anchor
    if (target && !target.startsWith('http') && !target.startsWith('mailto:') && !seen.has(target)) {
      refs.push({ path: target, type: 'link' });
      seen.add(target);
    }
  }

  // Backtick code references that look like file paths
  const codeRefRe = /`([^`]+\.\w{1,5})`/g;
  while ((m = codeRefRe.exec(content)) !== null) {
    const ref = m[1].trim();
    if (ref.includes('/') && !ref.startsWith('http') && !seen.has(ref)) {
      refs.push({ path: ref, type: 'reference' });
      seen.add(ref);
    }
  }

  return refs;
}
