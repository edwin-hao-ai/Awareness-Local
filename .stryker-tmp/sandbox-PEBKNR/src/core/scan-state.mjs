/**
 * Scan State — manages workspace scan progress and persistence.
 *
 * Provides an immutable ScanState model with atomic file I/O
 * (tmp + rename) to prevent corruption during concurrent access.
 */
// @ts-nocheck


import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_STATE_FILENAME = 'scan-state.json';
const AWARENESS_DIR = '.awareness';

// ---------------------------------------------------------------------------
// Default state factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh ScanState with all fields at their initial values.
 * @returns {ScanState}
 */
export function createScanState() {
  return {
    status: 'idle',
    phase: null,

    // Discovery
    discovered_total: 0,
    discovered_scanned: 0,

    // Indexing
    index_total: 0,
    index_done: 0,
    index_skipped: 0,

    // Embedding (future)
    embed_total: 0,
    embed_done: 0,

    // Aggregate stats
    total_files: 0,
    total_code_files: 0,
    total_doc_files: 0,
    total_symbols: 0,
    total_chunks: 0,

    // Timestamps
    last_full_scan_at: null,
    last_incremental_at: null,
    last_git_commit: null,
    scan_duration_ms: 0,

    // Errors (keep last 10)
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Immutable updater
// ---------------------------------------------------------------------------

/**
 * Return a new ScanState with one or more fields updated.
 * Never mutates the original.
 *
 * @param {ScanState} state - Current state (not mutated)
 * @param {Partial<ScanState>} updates - Fields to update
 * @returns {ScanState} New state with updates applied
 */
export function updateScanState(state, updates) {
  const next = { ...state, ...updates };
  // Cap errors at 10 entries
  if (Array.isArray(next.errors) && next.errors.length > 10) {
    next.errors = next.errors.slice(-10);
  }
  return next;
}

/**
 * Append an error to the state (immutable).
 *
 * @param {ScanState} state
 * @param {string} message
 * @returns {ScanState}
 */
export function appendScanError(state, message) {
  const errors = [...(state.errors || []), { message, at: new Date().toISOString() }];
  return updateScanState(state, { errors });
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Get the absolute path to scan-state.json.
 * @param {string} projectDir
 * @returns {string}
 */
export function getScanStatePath(projectDir) {
  return path.join(projectDir, AWARENESS_DIR, SCAN_STATE_FILENAME);
}

/**
 * Load scan state from disk. Returns a fresh state if the file
 * doesn't exist or is corrupted.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {ScanState}
 */
export function loadScanState(projectDir) {
  const filePath = getScanStatePath(projectDir);

  if (!fs.existsSync(filePath)) {
    return createScanState();
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle schema evolution
    return { ...createScanState(), ...parsed };
  } catch {
    // Corrupted file — return fresh state
    return createScanState();
  }
}

/**
 * Save scan state atomically (write to tmp, then rename).
 * Only persists the fields that differ from defaults to keep file small.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {ScanState} state - State to persist
 */
export function saveScanState(projectDir, state) {
  const filePath = getScanStatePath(projectDir);
  const dir = path.dirname(filePath);

  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ScanState
 * @property {'idle'|'scanning'|'indexing'|'error'} status
 * @property {'discovering'|'parsing'|'embedding'|null} phase
 * @property {number} discovered_total
 * @property {number} discovered_scanned
 * @property {number} index_total
 * @property {number} index_done
 * @property {number} index_skipped
 * @property {number} embed_total
 * @property {number} embed_done
 * @property {number} total_files
 * @property {number} total_code_files
 * @property {number} total_doc_files
 * @property {number} total_symbols
 * @property {number} total_chunks
 * @property {string|null} last_full_scan_at
 * @property {string|null} last_incremental_at
 * @property {string|null} last_git_commit
 * @property {number} scan_duration_ms
 * @property {Array<{message: string, at: string}>} errors
 */
