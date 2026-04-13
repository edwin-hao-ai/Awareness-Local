/**
 * Language detection utilities for Awareness Local.
 *
 * - detectNeedsCJK: CJK-aware multilingual model routing
 * - detectLanguage: file extension + shebang based language detection
 * - getSupportedLanguages: list all supported language identifiers
 *
 * Shared by daemon.mjs and search.mjs to avoid logic drift.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// CJK Detection (existing)
// ---------------------------------------------------------------------------

/**
 * Detect if text needs a CJK-aware multilingual embedding model.
 * Samples the first 500 chars; if CJK characters exceed 5% of non-space
 * characters, returns true.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectNeedsCJK(text) {
  if (!text) return false;
  const sample = text.slice(0, 500);
  const cjkChars = sample.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3400-\u4dbf]/g);
  if (!cjkChars) return false;
  const nonSpace = sample.replace(/\s/g, '').length;
  return nonSpace > 0 && (cjkChars.length / nonSpace) > 0.05;
}

// ---------------------------------------------------------------------------
// Extension → language mapping (T-013)
// ---------------------------------------------------------------------------

/** @type {Record<string, { language: string, category: string }>} */
const EXT_MAP = {
  // JavaScript
  '.js':   { language: 'javascript', category: 'code' },
  '.mjs':  { language: 'javascript', category: 'code' },
  '.cjs':  { language: 'javascript', category: 'code' },
  '.jsx':  { language: 'javascript', category: 'code' },

  // TypeScript
  '.ts':   { language: 'typescript', category: 'code' },
  '.tsx':  { language: 'typescript', category: 'code' },
  '.mts':  { language: 'typescript', category: 'code' },
  '.cts':  { language: 'typescript', category: 'code' },

  // Python
  '.py':   { language: 'python', category: 'code' },
  '.pyi':  { language: 'python', category: 'code' },
  '.pyw':  { language: 'python', category: 'code' },

  // Go
  '.go':   { language: 'go', category: 'code' },

  // Rust
  '.rs':   { language: 'rust', category: 'code' },

  // Java / Kotlin
  '.java': { language: 'java', category: 'code' },
  '.kt':   { language: 'kotlin', category: 'code' },
  '.kts':  { language: 'kotlin', category: 'code' },

  // C / C++
  '.c':    { language: 'c', category: 'code' },
  '.h':    { language: 'c', category: 'code' },
  '.cpp':  { language: 'cpp', category: 'code' },
  '.cc':   { language: 'cpp', category: 'code' },
  '.cxx':  { language: 'cpp', category: 'code' },
  '.hpp':  { language: 'cpp', category: 'code' },
  '.hxx':  { language: 'cpp', category: 'code' },

  // C#
  '.cs':   { language: 'csharp', category: 'code' },

  // Swift
  '.swift': { language: 'swift', category: 'code' },

  // Dart
  '.dart': { language: 'dart', category: 'code' },

  // Ruby
  '.rb':   { language: 'ruby', category: 'code' },
  '.rake': { language: 'ruby', category: 'code' },

  // PHP
  '.php':  { language: 'php', category: 'code' },

  // Perl
  '.pl':   { language: 'perl', category: 'code' },
  '.pm':   { language: 'perl', category: 'code' },

  // Lua
  '.lua':  { language: 'lua', category: 'code' },

  // R
  '.r':    { language: 'r', category: 'code' },

  // Scala
  '.scala': { language: 'scala', category: 'code' },

  // Elixir
  '.ex':   { language: 'elixir', category: 'code' },
  '.exs':  { language: 'elixir', category: 'code' },

  // Haskell
  '.hs':   { language: 'haskell', category: 'code' },

  // Zig
  '.zig':  { language: 'zig', category: 'code' },

  // Shell
  '.sh':   { language: 'shell', category: 'code' },
  '.bash': { language: 'shell', category: 'code' },
  '.zsh':  { language: 'shell', category: 'code' },
  '.fish': { language: 'shell', category: 'code' },

  // Markup / Docs
  '.md':    { language: 'markdown', category: 'docs' },
  '.mdx':   { language: 'markdown', category: 'docs' },
  '.rst':   { language: 'rst', category: 'docs' },
  '.txt':   { language: 'plaintext', category: 'docs' },

  // Web
  '.html':  { language: 'html', category: 'code' },
  '.htm':   { language: 'html', category: 'code' },
  '.css':   { language: 'css', category: 'code' },
  '.scss':  { language: 'css', category: 'code' },
  '.sass':  { language: 'css', category: 'code' },
  '.less':  { language: 'css', category: 'code' },
  '.vue':   { language: 'vue', category: 'code' },
  '.svelte': { language: 'svelte', category: 'code' },

  // Data / Config
  '.json':   { language: 'json', category: 'data' },
  '.jsonc':  { language: 'json', category: 'data' },
  '.json5':  { language: 'json', category: 'data' },
  '.yaml':   { language: 'yaml', category: 'data' },
  '.yml':    { language: 'yaml', category: 'data' },
  '.toml':   { language: 'toml', category: 'data' },
  '.xml':    { language: 'xml', category: 'data' },
  '.csv':    { language: 'csv', category: 'data' },

  // SQL / Query
  '.sql':     { language: 'sql', category: 'code' },
  '.graphql': { language: 'graphql', category: 'code' },
  '.gql':     { language: 'graphql', category: 'code' },
  '.proto':   { language: 'protobuf', category: 'code' },

  // Terraform / Infra
  '.tf':   { language: 'terraform', category: 'code' },
  '.hcl':  { language: 'hcl', category: 'code' },
};

// ---------------------------------------------------------------------------
// Shebang → language mapping
// ---------------------------------------------------------------------------

const SHEBANG_MAP = [
  { pattern: /\bpython[23]?\b/, language: 'python', category: 'code' },
  { pattern: /\bnode\b/,        language: 'javascript', category: 'code' },
  { pattern: /\bdeno\b/,        language: 'typescript', category: 'code' },
  { pattern: /\bbash\b/,        language: 'shell', category: 'code' },
  { pattern: /\bzsh\b/,         language: 'shell', category: 'code' },
  { pattern: /\bsh\b/,          language: 'shell', category: 'code' },
  { pattern: /\bruby\b/,        language: 'ruby', category: 'code' },
  { pattern: /\bperl\b/,        language: 'perl', category: 'code' },
  { pattern: /\bphp\b/,         language: 'php', category: 'code' },
  { pattern: /\blua\b/,         language: 'lua', category: 'code' },
];

// ---------------------------------------------------------------------------
// Public API (T-013)
// ---------------------------------------------------------------------------

/**
 * Detect language from filename extension, falling back to shebang if needed.
 *
 * @param {string} filename - File name or relative path
 * @param {string} [firstLine] - First line of file content (for shebang detection)
 * @returns {{ language: string, category: string } | null}
 */
export function detectLanguage(filename, firstLine) {
  if (!filename) return null;

  // Check for .d.ts before normal extension
  if (filename.endsWith('.d.ts')) {
    return { language: 'typescript', category: 'code' };
  }

  const ext = path.extname(filename).toLowerCase();

  if (ext && EXT_MAP[ext]) {
    return { ...EXT_MAP[ext] };
  }

  // Shebang fallback for extensionless files
  if (firstLine && firstLine.startsWith('#!')) {
    for (const entry of SHEBANG_MAP) {
      if (entry.pattern.test(firstLine)) {
        return { language: entry.language, category: entry.category };
      }
    }
  }

  return null;
}

/**
 * Get a list of all supported language identifiers.
 * @returns {string[]}
 */
export function getSupportedLanguages() {
  const langs = new Set();
  for (const entry of Object.values(EXT_MAP)) {
    langs.add(entry.language);
  }
  for (const entry of SHEBANG_MAP) {
    langs.add(entry.language);
  }
  return [...langs].sort();
}
