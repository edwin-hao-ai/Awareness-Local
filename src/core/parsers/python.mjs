/**
 * Python symbol extractor (T-015).
 *
 * Regex-based extraction of functions, classes, decorators,
 * docstrings, imports, and TODO/FIXME annotations.
 *
 * Zero AST dependency — works on raw source text.
 */

function lineNumber(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract symbols from Python source code.
 *
 * @param {string} content - File source code
 * @returns {Array<{
 *   symbol_type: string,
 *   name: string,
 *   signature: string,
 *   doc_comment: string|null,
 *   line_start: number,
 *   exported: boolean,
 *   decorators: string[]
 * }>}
 */
export function extractPython(content) {
  if (!content) return [];

  const symbols = [];
  const lines = content.split('\n');

  // Collect decorators for each line
  const decoratorMap = new Map(); // line → decorators[]
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('@')) {
      // Look forward to find the decorated def/class
      const decorators = [trimmed];
      let j = i + 1;
      while (j < lines.length && lines[j].trim().startsWith('@')) {
        decorators.push(lines[j].trim());
        j++;
      }
      // j is now the def/class line (1-indexed = j+1)
      decoratorMap.set(j + 1, decorators);
    }
  }

  // --- Function definitions ---
  // def name(...) / async def name(...)
  const funcRe = /^([ \t]*)(async\s+)?def\s+(\w+)\s*(\([^)]*\))(?:\s*->\s*([^\s:]+))?\s*:/gm;
  let m;
  while ((m = funcRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const indent = m[1].length;
    const isMethod = indent > 0;

    let sig = `${m[2] || ''}def ${m[3]}${m[4]}`.trim();
    if (m[5]) sig += ` -> ${m[5]}`;

    // Check for docstring on next line
    const nextLineIdx = line; // 0-indexed
    let docstring = null;
    if (nextLineIdx < lines.length) {
      const nextTrimmed = lines[nextLineIdx]?.trim();
      if (nextTrimmed?.startsWith('"""') || nextTrimmed?.startsWith("'''")) {
        const quote = nextTrimmed.slice(0, 3);
        if (nextTrimmed.endsWith(quote) && nextTrimmed.length > 6) {
          docstring = nextTrimmed.slice(3, -3).trim();
        } else {
          // Multi-line docstring
          const docLines = [nextTrimmed.slice(3)];
          for (let k = nextLineIdx + 1; k < lines.length && k < nextLineIdx + 20; k++) {
            const dl = lines[k]?.trim();
            if (dl?.endsWith(quote)) {
              docLines.push(dl.slice(0, -3));
              break;
            }
            docLines.push(dl);
          }
          docstring = docLines.join('\n').trim();
        }
      }
    }

    symbols.push({
      symbol_type: isMethod ? 'method' : 'function',
      name: m[3],
      signature: sig,
      doc_comment: docstring,
      line_start: line,
      exported: !m[3].startsWith('_'),
      decorators: decoratorMap.get(line) || [],
    });
  }

  // --- Class definitions ---
  const classRe = /^([ \t]*)class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm;
  while ((m = classRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    let sig = `class ${m[2]}`;
    if (m[3]) sig += `(${m[3]})`;

    // Docstring
    const nextLineIdx = line;
    let docstring = null;
    if (nextLineIdx < lines.length) {
      const nextTrimmed = lines[nextLineIdx]?.trim();
      if (nextTrimmed?.startsWith('"""') || nextTrimmed?.startsWith("'''")) {
        const quote = nextTrimmed.slice(0, 3);
        if (nextTrimmed.endsWith(quote) && nextTrimmed.length > 6) {
          docstring = nextTrimmed.slice(3, -3).trim();
        }
      }
    }

    symbols.push({
      symbol_type: 'class',
      name: m[2],
      signature: sig,
      doc_comment: docstring,
      line_start: line,
      exported: !m[2].startsWith('_'),
      decorators: decoratorMap.get(line) || [],
    });
  }

  // --- TODO / FIXME ---
  const todoRe = /#\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.*)/gi;
  while ((m = todoRe.exec(content)) !== null) {
    symbols.push({
      symbol_type: 'annotation',
      name: m[1].toUpperCase(),
      signature: `${m[1].toUpperCase()}: ${m[2].trim()}`,
      doc_comment: null,
      line_start: lineNumber(content, m.index),
      exported: false,
      decorators: [],
    });
  }

  return symbols;
}

/**
 * Extract import paths from Python source.
 *
 * @param {string} content
 * @returns {Array<{ path: string, type: 'import'|'from', names: string[] }>}
 */
export function extractPyImports(content) {
  if (!content) return [];

  const imports = [];
  let m;

  // from X import Y, Z
  const fromRe = /^from\s+([\w.]+)\s+import\s+(.+)/gm;
  while ((m = fromRe.exec(content)) !== null) {
    const names = m[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    imports.push({ path: m[1], type: 'from', names });
  }

  // import X, Y
  const importRe = /^import\s+([\w.,\s]+)/gm;
  while ((m = importRe.exec(content)) !== null) {
    const modules = m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const mod of modules) {
      imports.push({ path: mod, type: 'import', names: [] });
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
