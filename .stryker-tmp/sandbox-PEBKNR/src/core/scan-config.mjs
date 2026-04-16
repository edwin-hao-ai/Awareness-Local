/**
 * Scan Config — reads/writes `.awareness/scan-config.json`
 * for workspace scanning preferences.
 *
 * Merges user overrides with sensible defaults.
 * Atomic writes (tmp+rename) to prevent corruption.
 */
// @ts-nocheck


import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_CONFIG_FILENAME = 'scan-config.json';
const AWARENESS_DIR = '.awareness';

/** @type {Readonly<ScanConfig>} */
const DEFAULT_SCAN_CONFIG = Object.freeze({
  enabled: true,
  include: [],
  exclude: [],
  scan_code: true,
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
