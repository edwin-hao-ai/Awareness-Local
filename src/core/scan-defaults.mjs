/**
 * Scan Defaults — file type classification, blacklists, and sensitive file detection
 * for workspace scanning.
 *
 * All rules are data-driven (Sets and RegExp arrays), not hardcoded conditionals.
 * Zero LLM dependency.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// White-list: scannable file extensions by category
// ---------------------------------------------------------------------------

/** @type {Record<string, Set<string>>} */
export const SCANNABLE_EXTENSIONS = Object.freeze({
  code: new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '.py', '.pyi',
    '.go',
    '.rs',
    '.java', '.kt', '.kts',
    '.swift',
    '.c', '.h', '.cpp', '.hpp', '.cc',
    '.cs',
    '.rb',
    '.php',
    '.lua',
    '.sh', '.bash', '.zsh',
    '.sql',
    '.r', '.R',
    '.scala',
    '.dart',
    '.ex', '.exs',
    '.zig',
    '.vue', '.svelte',
  ]),

  docs: new Set([
    '.md', '.mdx',
    '.txt',
    '.rst',
    '.adoc',
    '.org',
    '.tex',
  ]),

  convertible: new Set([
    '.pdf',
    '.docx', '.doc',
    '.xlsx', '.xls',
    '.csv',
    '.pptx',
  ]),

  config: new Set([
    '.json',
    '.yaml', '.yml',
    '.toml',
    '.ini', '.cfg',
    '.env.example',
    '.editorconfig',
    '.prisma',
    '.graphql', '.gql',
  ]),
});

/** Basenames (no extension) recognized as special file types */
const SPECIAL_BASENAMES_CONFIG = new Set([
  'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Vagrantfile',
  'Procfile', 'Justfile',
]);

const SPECIAL_BASENAMES_DOCS = new Set([
  'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING',
  'AUTHORS', 'NOTICE', 'COPYING',
]);

// ---------------------------------------------------------------------------
// Black-list: always excluded directories, files, and patterns
// ---------------------------------------------------------------------------

export const ALWAYS_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out', 'target',
  '.cache', '.turbo',
  'vendor', '.vendor',
  'venv', '.venv', 'env',
  '.tox', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', '.eclipse',
  'coverage', '.nyc_output',
  '.terraform',
  '.docker',
  'pods',
  '.awareness',
]);

export const ALWAYS_EXCLUDE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.env', '.env.local', '.env.production', '.env.staging',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock',
  'go.sum',
]);

/** @type {RegExp[]} */
export const ALWAYS_EXCLUDE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.d\.ts$/,
  /\.(wasm|so|dylib|dll|exe)$/,
  /\.(jpg|jpeg|png|gif|svg|ico|webp|avif|bmp|tiff?)$/i,
  /\.(mp4|mp3|wav|ogg|webm|avi|mov|flac|aac)$/i,
  /\.(woff2?|ttf|otf|eot)$/,
  /\.(zip|tar|gz|bz2|7z|rar|dmg|iso)$/,
  /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/,
  /\.(key|pem|crt|cer|pfx|p12)$/,
];

// ---------------------------------------------------------------------------
// Sensitive file detection
// ---------------------------------------------------------------------------

/** @type {RegExp[]} */
const SENSITIVE_PATTERNS = [
  /\.env(\..+)?$/,
  /credentials?\.(json|yaml|yml|xml)$/i,
  /secrets?\.(json|yaml|yml|xml)$/i,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /id_rsa/, /id_ed25519/, /id_ecdsa/,
  /\.htpasswd$/,
  /token\.json$/,
  /auth\.json$/,
  /\.netrc$/,
  /\.npmrc$/,
  /\.pypirc$/,
  /kubeconfig/i,
  /service[_-]?account.*\.json$/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a file into a scan category based on its name/extension.
 *
 * @param {string} filename - File basename or full relative path
 * @returns {'code' | 'docs' | 'convertible' | 'config' | null}
 */
export function getFileCategory(filename) {
  const basename = path.basename(filename);
  const ext = path.extname(basename).toLowerCase();

  // Special basenames without extensions (or with non-standard extensions)
  if (SPECIAL_BASENAMES_CONFIG.has(basename)) return 'config';
  if (SPECIAL_BASENAMES_DOCS.has(basename)) return 'docs';

  if (!ext) return null;

  if (SCANNABLE_EXTENSIONS.code.has(ext)) return 'code';
  if (SCANNABLE_EXTENSIONS.docs.has(ext)) return 'docs';
  if (SCANNABLE_EXTENSIONS.convertible.has(ext)) return 'convertible';
  if (SCANNABLE_EXTENSIONS.config.has(ext)) return 'config';
  return null;
}

/**
 * Check if a directory name should always be excluded.
 *
 * @param {string} dirName - Directory basename (not full path)
 * @returns {boolean}
 */
export function isExcludedDir(dirName) {
  return ALWAYS_EXCLUDE_DIRS.has(dirName);
}

/**
 * Check if a file should be excluded based on name or pattern.
 *
 * @param {string} filename - File basename
 * @returns {boolean}
 */
export function isExcludedFile(filename) {
  const basename = path.basename(filename);
  if (ALWAYS_EXCLUDE_FILES.has(basename)) return true;
  return ALWAYS_EXCLUDE_PATTERNS.some(p => p.test(basename));
}

/**
 * Check if a file is sensitive (credentials, keys, secrets).
 * This is an additional safety layer on top of .gitignore.
 *
 * @param {string} relativePath - Path relative to project root
 * @returns {boolean}
 */
export function isSensitiveFile(relativePath) {
  const filename = path.basename(relativePath);
  return SENSITIVE_PATTERNS.some(p => p.test(filename) || p.test(relativePath));
}

/**
 * Apply the full filter pipeline to determine if a file should be scanned.
 * Returns the category if scannable, or null with a reason if excluded.
 *
 * @param {string} relativePath - Path relative to project root
 * @param {Object} [options]
 * @param {boolean} [options.scan_code=true]
 * @param {boolean} [options.scan_docs=true]
 * @param {boolean} [options.scan_config=false]
 * @param {boolean} [options.scan_convertible=true]
 * @returns {{ category: string, excluded: false } | { category: null, excluded: true, reason: string }}
 */
export function classifyFile(relativePath, options = {}) {
  const basename = path.basename(relativePath);

  // Step 1: Excluded file?
  if (isExcludedFile(basename)) {
    return { category: null, excluded: true, reason: 'excluded_file' };
  }

  // Step 2: Sensitive?
  if (isSensitiveFile(relativePath)) {
    return { category: null, excluded: true, reason: 'sensitive' };
  }

  // Step 3: Classify
  const category = getFileCategory(basename);
  if (!category) {
    return { category: null, excluded: true, reason: 'unknown_type' };
  }

  // Step 4: Category enabled?
  const categoryEnabled = {
    code: options.scan_code !== false,
    docs: options.scan_docs !== false,
    config: options.scan_config === true,
    convertible: options.scan_convertible !== false,
  };

  if (!categoryEnabled[category]) {
    return { category: null, excluded: true, reason: 'category_disabled' };
  }

  return { category, excluded: false };
}
