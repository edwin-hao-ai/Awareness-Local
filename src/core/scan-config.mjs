/**
 * Scan Config — reads/writes `.awareness/scan-config.json`
 * for workspace scanning preferences.
 *
 * Merges user overrides with sensible defaults.
 * Atomic writes (tmp+rename) to prevent corruption.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_CONFIG_FILENAME = 'scan-config.json';
const AWARENESS_DIR = '.awareness';
const require = createRequire(import.meta.url);

/** @type {Readonly<ScanConfig>} */
const DEFAULT_SCAN_CONFIG = Object.freeze({
  enabled: true,
  include: [],
  exclude: [],
  // Memory recall is for decisions / intent / learnings — those live in markdown.
  // Source code is already addressable via git/IDE search and embedding it just
  // crowds the vector space with low-quality matches. Users can opt in via
  // ~/.awareness/scan-config.json { "scan_code": true }. Infrastructure code
  // (Dockerfile / *.sql / *.sh) lives in the "code" category for now — opt in
  // if you want migration history and infra decisions in recall.
  scan_code: false,
  scan_docs: true,
  scan_config: false,
  scan_convertible: true,
  max_file_size_kb: 500,
  max_total_files: 10000,
  max_depth: 15,
  git_incremental: true,
  watch_enabled: true,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load scan configuration. Returns defaults merged with any user overrides.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {ScanConfig} Complete configuration object
 */
export function loadScanConfig(projectDir) {
  const configPath = getScanConfigPath(projectDir);

  if (!fs.existsSync(configPath)) {
    // ── Backward-compat migration (v0.10.0+) ─────────────────────────
    // Before v0.10.0 the default was scan_code=true. We flipped to false
    // because memory recall benefits from markdown-only indexing. To avoid
    // surprising existing users who already have an index.db full of code
    // chunks, detect that case and write a config that preserves the old
    // behavior. Net effect: existing daemons keep scanning code; brand-new
    // installs get the cleaner default.
    const legacyIndexPath = path.join(projectDir, AWARENESS_DIR, 'index.db');
    const isExistingInstall = hasLegacyCodeIndex(legacyIndexPath);
    if (isExistingInstall) {
      const preserved = { ...DEFAULT_SCAN_CONFIG, scan_code: true };
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(
          configPath,
          JSON.stringify({ scan_code: true, _migration_note: 'preserved pre-0.10.0 default' }, null, 2),
        );
      } catch {
        // Non-fatal: if we can't write, just return preserved in-memory.
      }
      return preserved;
    }
    return { ...DEFAULT_SCAN_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const userConfig = JSON.parse(raw);
    return mergeScanConfig(DEFAULT_SCAN_CONFIG, userConfig);
  } catch {
    // Corrupted JSON — return defaults
    return { ...DEFAULT_SCAN_CONFIG };
  }
}

function hasLegacyCodeIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return false;
  try {
    if (fs.statSync(indexPath).size <= 0) return false;
  } catch {
    return false;
  }

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(indexPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT count(*) AS total
      FROM graph_nodes
      WHERE node_type = 'file'
        AND status = 'active'
        AND json_extract(metadata, '$.category') = 'code'
    `).get();
    return Number(row?.total || 0) > 0;
  } catch {
    // If we cannot inspect the legacy DB safely, preserve the old behavior.
    return true;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Save scan configuration atomically.
 * Only writes user-modified values (diff from defaults).
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {Partial<ScanConfig>} config - Configuration to save
 * @returns {ScanConfig} The complete merged configuration
 */
export function saveScanConfig(projectDir, config) {
  const configPath = getScanConfigPath(projectDir);
  const dir = path.dirname(configPath);

  // Ensure .awareness/ directory exists
  fs.mkdirSync(dir, { recursive: true });

  const merged = mergeScanConfig(DEFAULT_SCAN_CONFIG, config);

  // Atomic write: tmp + rename
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmpPath, configPath);

  return merged;
}

/**
 * Get the absolute path to scan-config.json.
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function getScanConfigPath(projectDir) {
  return path.join(projectDir, AWARENESS_DIR, SCAN_CONFIG_FILENAME);
}

/**
 * Return default scan configuration (immutable copy).
 *
 * @returns {ScanConfig}
 */
export function getDefaultScanConfig() {
  return { ...DEFAULT_SCAN_CONFIG };
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Merge user config over defaults.
 * Only known keys are accepted; unknown keys are ignored.
 *
 * @param {ScanConfig} defaults
 * @param {Record<string, unknown>} userConfig
 * @returns {ScanConfig}
 */
function mergeScanConfig(defaults, userConfig) {
  const merged = { ...defaults };

  for (const key of Object.keys(defaults)) {
    if (!(key in userConfig)) continue;

    const defaultVal = defaults[key];
    const userVal = userConfig[key];

    // Type check: only accept values matching the default's type
    if (typeof defaultVal === typeof userVal) {
      merged[key] = userVal;
    } else if (Array.isArray(defaultVal) && Array.isArray(userVal)) {
      merged[key] = userVal;
    }
    // Otherwise: silently keep default (prevents type corruption)
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ScanConfig
 * @property {boolean} enabled - Whether scanning is enabled
 * @property {string[]} include - Include-only patterns (empty = all)
 * @property {string[]} exclude - Additional exclude patterns
 * @property {boolean} scan_code - Scan code files
 * @property {boolean} scan_docs - Scan documentation files
 * @property {boolean} scan_config - Scan configuration files
 * @property {boolean} scan_convertible - Scan convertible files (PDF/DOCX)
 * @property {number} max_file_size_kb - Max file size in KB
 * @property {number} max_total_files - Max total files to scan
 * @property {number} max_depth - Max directory depth
 * @property {boolean} git_incremental - Use git for incremental detection
 * @property {boolean} watch_enabled - Enable file watching
 */
