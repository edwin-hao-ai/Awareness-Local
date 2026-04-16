/**
 * sync-state.mjs — Sync state persistence layer for CloudSync.
 *
 * Extracted from cloud-sync.mjs to decouple state management from the
 * coordinator.  Every function receives an `indexer` instance as its first
 * parameter instead of relying on `this`.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Errors are caught internally — none of these helpers may crash the daemon.
 */
// @ts-nocheck


const LOG_PREFIX = '[SyncState]';

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure the sync_state table and any missing columns exist.
 * Idempotent — safe to call on every daemon start.
 *
 * @param {object} indexer — Indexer instance (exposes `.db` for SQLite access)
 */
export function ensureSyncSchema(indexer) {
  try {
    // sync_state table is created by indexer schema init; just verify it exists
    indexer.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      )
      .run();
  } catch {
    // Table likely already exists
  }

  // Migrate existing tables: add synced_to_cloud column if missing.
  // DEFAULT 0 means all existing records are marked as unsynced — they'll be
  // pushed on the next sync cycle, ensuring old data reaches the cloud.
  for (const table of ['knowledge_cards', 'tasks']) {
    try {
      indexer.db
        .prepare(`ALTER TABLE ${table} ADD COLUMN synced_to_cloud INTEGER DEFAULT 0`)
        .run();
      console.log(`${LOG_PREFIX} Migrated ${table}: added synced_to_cloud column`);
    } catch {
      // Column already exists — expected for fresh installs
    }
  }
}

// ---------------------------------------------------------------------------
// Key-value state
// ---------------------------------------------------------------------------

/**
 * Get a value from sync_state.
 *
 * @param {object} indexer
 * @param {string} key
 * @returns {string|null}
 */
export function getSyncState(indexer, key) {
  try {
    const row = indexer.db
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(key);
    return row?.value || null;
  } catch {
    return null;
  }
}

/**
 * Set a value in sync_state (upsert).
 *
 * @param {object} indexer
 * @param {string} key
 * @param {string} value
 */
export function setSyncState(indexer, key, value) {
  try {
    indexer.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  } catch {
    // Non-critical — log and continue
  }
}

// ---------------------------------------------------------------------------
// Sync history
// ---------------------------------------------------------------------------

/**
 * Record a sync event to the sync_state table for history tracking.
 *
 * @param {object} indexer
 * @param {string} type — "memories" | "insights" | "tasks"
 * @param {object} details — { count, direction: "push"|"pull" }
 */
export function recordSyncEvent(indexer, type, details) {
  try {
    const timestamp = new Date().toISOString();
    const key = `sync_log:${timestamp}`;
    const value = JSON.stringify({ type, details, timestamp });
    setSyncState(indexer, key, value);
  } catch {
    // Non-critical — don't crash on history logging failure
  }
}

/**
 * Get recent sync history events.
 *
 * @param {object} indexer
 * @param {number} [limit=20] — Maximum number of events to return
 * @returns {Array<{ type: string, details: object, timestamp: string }>}
 */
export function getSyncHistory(indexer, limit = 20) {
  try {
    const rows = indexer.db
      .prepare(
        `SELECT value FROM sync_state WHERE key LIKE 'sync_log:%' ORDER BY key DESC LIMIT ?`
      )
      .all(limit);

    return rows
      .map((row) => {
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Parse tags JSON string safely.
 *
 * @param {string} tagsStr — JSON array string or empty
 * @returns {string[]}
 */
export function parseTags(tagsStr) {
  if (!tagsStr) return [];
  try {
    const parsed = JSON.parse(tagsStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Simple async sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
