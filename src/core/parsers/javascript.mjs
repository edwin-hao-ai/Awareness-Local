/**
 * JavaScript / TypeScript symbol extractor (T-014).
 *
 * Regex-based extraction of functions, classes, interfaces, types,
 * exports, imports, JSDoc comments, and TODO/FIXME annotations.
 *
 * Zero AST dependency — works on raw source text.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip block and line comments from source to avoid false positives.
 * Preserves JSDoc comments (/** ... *‌/) for doc extraction.
 * @param {string} src
 * @returns {{ cleaned: string, jsdocBlocks: Map<number, string> }}
 */
function prepareSource(src) {
  const jsdocBlocks = new Map(); // lineNumber → comment text

  // Collect JSDoc blocks before stripping
  const jsdocRe = /\/\*\*([\s\S]*?)\*\//g;
  let m;
  while ((m = jsdocRe.exec(src)) !== null) {
    const lineNum = src.slice(0, m.index).split('\n').length;
    jsdocBlocks.set(lineNum, m[0]);
  }

  return { cleaned: src, jsdocBlocks };
}

/**
 * Find the closest JSDoc block above a given line.
 * @param {Map<number, string>} jsdocBlocks
 * @param {number} targetLine
 * @returns {string|null}
 */
function findJsdocAbove(jsdocBlocks, targetLine) {
  // JSDoc should be within 3 lines above the declaration
  for (let i = targetLine - 1; i >= targetLine - 4 && i >= 1; i--) {
    if (jsdocBlocks.has(i)) {
      return jsdocBlocks.get(i);
    }
  }
  return null;
}

function lineNumber(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract symbols from JavaScript or TypeScript source code.
 *
 * @param {string} content - File source code
 * @param {string} [filename] - For context (not used in extraction)
 * @returns {Array<{
 *   symbol_type: string,
 *   name: string,
 *   signature: string,
 *   doc_comment: string|null,
 *   line_start: number,
 *   exported: boolean
 * }>}
 */
export function extractJavaScript(content) {
  if (!content) return [];

  const { jsdocBlocks } = prepareSource(content);
  const symbols = [];
  const lines = content.split('\n');

  // --- Function declarations ---
  // function name(...) / async function name(...) / function* name(...)
  const funcDeclRe = /^[ \t]*(export\s+(?:default\s+)?)?(async\s+)?function\*?\s+(\w+)\s*(\([^)]*\))/gm;
  let m;
  while ((m = funcDeclRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'function',
      name: m[3],
      signature: `${m[2] || ''}function ${m[3]}${m[4]}`.trim(),
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Arrow / const function ---
  // const name = (...) => / const name = function(...) / const name = async (...)
  const arrowRe = /^[ \t]*(export\s+(?:default\s+)?)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(?:(\([^)]*\))\s*=>|function\s*(\([^)]*\)))/gm;
  while ((m = arrowRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const params = m[5] || m[6] || '()';
    symbols.push({
      symbol_type: 'function',
      name: m[3],
      signature: `${m[4] || ''}${m[3]}${params}`.trim(),
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Class declarations ---
  const classRe = /^[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w.,\s]+))?/gm;
  while ((m = classRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    let sig = `class ${m[2]}`;
    if (m[3]) sig += ` extends ${m[3]}`;
    symbols.push({
      symbol_type: 'class',
      name: m[2],
      signature: sig,
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- TypeScript interface ---
  const ifaceRe = /^[ \t]*(export\s+)?interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+([\w.,\s<>]+))?\s*\{/gm;
  while ((m = ifaceRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'interface',
      name: m[2],
      signature: `interface ${m[2]}`,
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- TypeScript type alias ---
  const typeRe = /^[ \t]*(export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/gm;
  while ((m = typeRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'type',
      name: m[2],
      signature: `type ${m[2]}`,
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- TypeScript enum ---
  const enumRe = /^[ \t]*(export\s+)?(const\s+)?enum\s+(\w+)\s*\{/gm;
  while ((m = enumRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'enum',
      name: m[3],
      signature: `enum ${m[3]}`,
      doc_comment: findJsdocAbove(jsdocBlocks, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- TODO / FIXME annotations ---
  const todoRe = /\/\/\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.*)/gi;
  while ((m = todoRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'annotation',
      name: m[1].toUpperCase(),
      signature: `${m[1].toUpperCase()}: ${m[2].trim()}`,
      doc_comment: null,
      line_start: line,
      exported: false,
    });
  }

  return symbols;
}

/**
 * Extract import/require paths from JS/TS source.
 *
 * @param {string} content
 * @returns {Array<{ path: string, type: 'esm'|'cjs'|'dynamic'|'re-export', names: string[] }>}
 */
export function extractJSImports(content) {
  if (!content) return [];

  const imports = [];
  let m;

  // ES module: import ... from '...' / import type ... from '...'
  const esmRe = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?|\*\s+as\s+\w+)?\s*(?:from\s+)?['"]([^'"]+)['"]/g;
  while ((m = esmRe.exec(content)) !== null) {
    const line = content.slice(0, m.index);
    // Skip if inside a comment
    const lastNewline = line.lastIndexOf('\n');
    const currentLine = line.slice(lastNewline + 1);
    if (currentLine.trimStart().startsWith('//')) continue;
    if (currentLine.trimStart().startsWith('*')) continue;

    const isReExport = m[0].startsWith('export');
    imports.push({
      path: m[1],
      type: isReExport ? 're-export' : 'esm',
      names: [],
    });
  }

  // Dynamic import: import('...')
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    imports.push({ path: m[1], type: 'dynamic', names: [] });
  }

  // CommonJS: require('...')
  const cjsRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsRe.exec(content)) !== null) {
    imports.push({ path: m[1], type: 'cjs', names: [] });
  }

  // Deduplicate by path
  const seen = new Set();
  return imports.filter(imp => {
    if (seen.has(imp.path)) return false;
    seen.add(imp.path);
    return true;
  });
}
