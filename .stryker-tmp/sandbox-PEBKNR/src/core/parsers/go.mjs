/**
 * Go symbol extractor (T-016).
 *
 * Regex-based extraction of functions, types, interfaces,
 * package declarations, and imports.
 */
// @ts-nocheck


function lineNumber(src, index) {
  return src.slice(0, index).split('\n').length;
}

/**
 * Find the closest doc comment (// lines) above a target line.
 * @param {string[]} lines - All source lines (0-indexed)
 * @param {number} targetLine - 1-indexed line number
 * @returns {string|null}
 */
function findGoDocAbove(lines, targetLine) {
  const docs = [];
  for (let i = targetLine - 2; i >= 0 && i >= targetLine - 10; i--) {
    const trimmed = lines[i]?.trim();
    if (trimmed?.startsWith('//')) {
      docs.unshift(trimmed.replace(/^\/\/\s?/, ''));
    } else {
      break;
    }
  }
  return docs.length > 0 ? docs.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract symbols from Go source code.
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
export function extractGo(content) {
  if (!content) return [];

  const symbols = [];
  const lines = content.split('\n');
  let m;

  // --- Package declaration ---
  const pkgRe = /^package\s+(\w+)/m;
  m = pkgRe.exec(content);
  if (m) {
    symbols.push({
      symbol_type: 'package',
      name: m[1],
      signature: `package ${m[1]}`,
      doc_comment: null,
      line_start: lineNumber(content, m.index),
      exported: true,
    });
  }

  // --- Function declarations ---
  // func Name(...) ... / func (r *Receiver) Name(...) ...
  const funcRe = /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*(\([^)]*\))(?:\s*(\([^)]*\)|[\w.*[\]]+))?/gm;
  while ((m = funcRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const name = m[3];
    const receiver = m[2] ? `(${m[1]} *${m[2]}) ` : '';
    let sig = `func ${receiver}${name}${m[4]}`;
    if (m[5]) sig += ` ${m[5]}`;

    symbols.push({
      symbol_type: m[2] ? 'method' : 'function',
      name,
      signature: sig.trim(),
      doc_comment: findGoDocAbove(lines, line),
      line_start: line,
      exported: name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]),
    });
  }

  // --- Type declarations ---
  // type Name struct { / type Name interface { / type Name = ... / type Name ...
  const typeRe = /^type\s+(\w+)\s+(struct|interface|=?\s*\w+)/gm;
  while ((m = typeRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const name = m[1];
    const kind = m[2].trim();
    let symbolType = 'type';
    if (kind === 'struct') symbolType = 'struct';
    else if (kind === 'interface') symbolType = 'interface';

    symbols.push({
      symbol_type: symbolType,
      name,
      signature: `type ${name} ${kind}`,
      doc_comment: findGoDocAbove(lines, line),
      line_start: line,
      exported: name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]),
    });
  }

  // --- Const declarations (top-level named constants) ---
  const constRe = /^(?:const|var)\s+(\w+)\s+/gm;
  while ((m = constRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const name = m[1];
    symbols.push({
      symbol_type: 'constant',
      name,
      signature: m[0].trim(),
      doc_comment: null,
      line_start: line,
      exported: name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]),
    });
  }

  // --- TODO / FIXME ---
  const todoRe = /\/\/\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.*)/gi;
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

/**
 * Extract import paths from Go source.
 *
 * @param {string} content
 * @returns {Array<{ path: string, type: 'import', names: string[] }>}
 */
export function extractGoImports(content) {
  if (!content) return [];

  const imports = [];
  let m;

  // Single import: import "fmt"
  const singleRe = /^import\s+"([^"]+)"/gm;
  while ((m = singleRe.exec(content)) !== null) {
    imports.push({ path: m[1], type: 'import', names: [] });
  }

  // Block import: import ( "fmt" \n "os" )
  const blockRe = /^import\s*\(([\s\S]*?)\)/gm;
  while ((m = blockRe.exec(content)) !== null) {
    const lineRe = /(?:\w+\s+)?"([^"]+)"/g;
    let lm;
    while ((lm = lineRe.exec(m[1])) !== null) {
      imports.push({ path: lm[1], type: 'import', names: [] });
    }
  }

  // Deduplicate
  const seen = new Set();
  return imports.filter(imp => {
    if (seen.has(imp.path)) return false;
    seen.add(imp.path);
    return true;
  });
}
