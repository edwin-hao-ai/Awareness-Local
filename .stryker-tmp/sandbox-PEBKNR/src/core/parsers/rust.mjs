/**
 * Rust symbol extractor (T-016).
 *
 * Regex-based extraction of functions, structs, enums, traits,
 * impl blocks, modules, and use declarations.
 */
// @ts-nocheck


function lineNumber(src, index) {
  return src.slice(0, index).split('\n').length;
}

/**
 * Find the closest doc comment (/// or //! lines) above a target line.
 */
function findRustDocAbove(lines, targetLine) {
  const docs = [];
  for (let i = targetLine - 2; i >= 0 && i >= targetLine - 15; i--) {
    const trimmed = lines[i]?.trim();
    if (trimmed?.startsWith('///') || trimmed?.startsWith('//!')) {
      docs.unshift(trimmed.replace(/^\/\/[\/!]\s?/, ''));
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
 * Extract symbols from Rust source code.
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
export function extractRust(content) {
  if (!content) return [];

  const symbols = [];
  const lines = content.split('\n');
  let m;

  // --- Function declarations ---
  // pub fn name(...) -> ... / fn name(...) / pub async fn name(...)
  const funcRe = /^[ \t]*(pub(?:\(crate\))?\s+)?(async\s+)?(?:unsafe\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*(\([^)]*\))(?:\s*->\s*([^{]+?))?(?:\s*\{|$)/gm;
  while ((m = funcRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const name = m[3];
    let sig = `${m[2] || ''}fn ${name}${m[4]}`.trim();
    if (m[5]) sig += ` -> ${m[5]}`;

    symbols.push({
      symbol_type: 'function',
      name,
      signature: sig,
      doc_comment: findRustDocAbove(lines, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Struct declarations ---
  const structRe = /^[ \t]*(pub(?:\(crate\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?/gm;
  while ((m = structRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'struct',
      name: m[2],
      signature: `struct ${m[2]}`,
      doc_comment: findRustDocAbove(lines, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Enum declarations ---
  const enumRe = /^[ \t]*(pub(?:\(crate\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?/gm;
  while ((m = enumRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'enum',
      name: m[2],
      signature: `enum ${m[2]}`,
      doc_comment: findRustDocAbove(lines, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Trait declarations ---
  const traitRe = /^[ \t]*(pub(?:\(crate\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?/gm;
  while ((m = traitRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'trait',
      name: m[2],
      signature: `trait ${m[2]}`,
      doc_comment: findRustDocAbove(lines, line),
      line_start: line,
      exported: !!m[1],
    });
  }

  // --- Impl blocks ---
  const implRe = /^[ \t]*impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)(?:<[^>]*>)?/gm;
  while ((m = implRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    const name = m[2];
    const traitName = m[1];
    const sig = traitName ? `impl ${traitName} for ${name}` : `impl ${name}`;
    symbols.push({
      symbol_type: 'impl',
      name,
      signature: sig,
      doc_comment: findRustDocAbove(lines, line),
      line_start: line,
      exported: false,
    });
  }

  // --- Module declarations ---
  const modRe = /^[ \t]*(pub(?:\(crate\))?\s+)?mod\s+(\w+)/gm;
  while ((m = modRe.exec(content)) !== null) {
    const line = lineNumber(content, m.index);
    symbols.push({
      symbol_type: 'module',
      name: m[2],
      signature: `mod ${m[2]}`,
      doc_comment: null,
      line_start: line,
      exported: !!m[1],
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
 * Extract use/mod paths from Rust source.
 *
 * @param {string} content
 * @returns {Array<{ path: string, type: 'use'|'mod', names: string[] }>}
 */
export function extractRustImports(content) {
  if (!content) return [];

  const imports = [];
  let m;

  // use std::collections::HashMap; / use crate::module::{A, B};
  const useRe = /^[ \t]*(?:pub\s+)?use\s+([\w:]+(?:::\{[^}]+\})?(?:::[\w*]+)?)\s*;/gm;
  while ((m = useRe.exec(content)) !== null) {
    imports.push({ path: m[1], type: 'use', names: [] });
  }

  // mod name;
  const modRe = /^[ \t]*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
  while ((m = modRe.exec(content)) !== null) {
    imports.push({ path: m[1], type: 'mod', names: [] });
  }

  const seen = new Set();
  return imports.filter(imp => {
    if (seen.has(imp.path)) return false;
    seen.add(imp.path);
    return true;
  });
}
