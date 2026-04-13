/**
 * Parser registry — routes files to the correct language extractor.
 *
 * Usage:
 *   const { symbols, imports } = extractFile(content, language);
 */

import { extractJavaScript, extractJSImports } from './javascript.mjs';
import { extractPython, extractPyImports } from './python.mjs';
import { extractGo, extractGoImports } from './go.mjs';
import { extractRust, extractRustImports } from './rust.mjs';
import { extractMarkdown, extractMarkdownRefs } from './markdown.mjs';
import { extractGeneric } from './generic.mjs';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SYMBOL_EXTRACTORS = {
  javascript: extractJavaScript,
  typescript: extractJavaScript, // TS uses same extractor (regex-compatible)
  python:     extractPython,
  go:         extractGo,
  rust:       extractRust,
  markdown:   extractMarkdown,
};

const IMPORT_EXTRACTORS = {
  javascript: extractJSImports,
  typescript: extractJSImports,
  python:     extractPyImports,
  go:         extractGoImports,
  rust:       extractRustImports,
  markdown:   extractMarkdownRefs,
};

/**
 * Extract symbols and imports from file content based on detected language.
 *
 * @param {string} content - File source code
 * @param {string} language - Language identifier from detectLanguage()
 * @returns {{ symbols: Array, imports: Array }}
 */
export function extractFile(content, language) {
  if (!content || !language) return { symbols: [], imports: [] };

  const symbolFn = SYMBOL_EXTRACTORS[language] || extractGeneric;
  const importFn = IMPORT_EXTRACTORS[language] || (() => []);

  return {
    symbols: symbolFn(content),
    imports: importFn(content),
  };
}

/**
 * Get list of languages with dedicated parser support.
 * @returns {string[]}
 */
export function getParserLanguages() {
  return Object.keys(SYMBOL_EXTRACTORS);
}

// Re-export individual extractors for direct use
export { extractJavaScript, extractJSImports } from './javascript.mjs';
export { extractPython, extractPyImports } from './python.mjs';
export { extractGo, extractGoImports } from './go.mjs';
export { extractRust, extractRustImports } from './rust.mjs';
export { extractMarkdown, extractMarkdownRefs } from './markdown.mjs';
export { extractGeneric } from './generic.mjs';
