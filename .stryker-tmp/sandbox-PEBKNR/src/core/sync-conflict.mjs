/**
 * sync-conflict.mjs — Local conflict model for version mismatches during push.
 *
 * When a push to the cloud returns HTTP 409 (optimistic-lock conflict), we
 * store a conflict record in local SQLite so the user (or a future auto-merge
 * routine) can resolve it.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Errors are caught internally — conflict bookkeeping must never crash the daemon.
 */
// @ts-nocheck


const LOG_PREFIX = '[SyncConflict]';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Ensure the sync_conflicts table exists in SQLite.
 * Idempotent — safe to call on every daemon start.
 *
 * @param {object} indexer — Indexer instance (exposes `.db` for SQLite access)
 */
export function ensureConflictSchema(indexer) {
  try {
    indexer.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS sync_conflicts (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL,
          local_version_json TEXT NOT NULL DEFAULT '{}',
          cloud_version_json TEXT NOT NULL DEFAULT '{}',
          device_id TEXT NOT NULL DEFAULT '',
          conflict_type TEXT NOT NULL DEFAULT 'version_mismatch',
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          resolution TEXT
        )`
      )
      .run();
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to ensure conflict schema:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Record a new conflict arising from a push that was rejected by the cloud.
 *
 * @param {object} indexer — Indexer instance
 * @param {object} opts
 * @param {string}  opts.card_id        — Local knowledge-card ID
 * @param {string}  opts.local_version  — JSON-serialized local version snapshot
 * @param {string}  opts.cloud_version  — JSON-serialized cloud version snapshot
 * @param {string}  opts.device_id      — Device that attempted the push
 * @param {string} [opts.conflict_type='version_mismatch'] — Conflict category
 * @returns {string|null} — The newly created conflict ID, or null on failure
 */
export function createLocalConflict(indexer, opts) {
  const {
    card_id,
    local_version = '{}',
    cloud_version = '{}',
    device_id = '',
    conflict_type = 'version_mismatch',
  } = opts;

  const id = `conflict_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  try {
    // Lazily ensure the table exists (cheap after the first call)
    ensureConflictSchema(indexer);

    indexer.db
      .prepare(
        `INSERT INTO sync_conflicts
           (id, card_id, local_version_json, cloud_version_json, device_id, conflict_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, card_id, local_version, cloud_version, device_id, conflict_type, now);

    console.log(`${LOG_PREFIX} Conflict recorded: ${id} (card ${card_id}, type ${conflict_type})`);
    return id;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to record conflict:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List local conflict records with optional resolved/unresolved filter.
 *
 * @param {object} indexer — Indexer instance
 * @param {object} [opts]
 * @param {boolean} [opts.resolved] — If true, return only resolved conflicts;
 *   if false, only unresolved; if undefined, return all.
 * @param {number}  [opts.limit=50] — Maximum number of records
 * @returns {Array<object>}
 */
export function listLocalConflicts(indexer, opts = {}) {
  const { resolved, limit = 50 } = opts;

  try {
    ensureConflictSchema(indexer);

    let sql = 'SELECT * FROM sync_conflicts';
    const params = [];

    if (resolved === true) {
      sql += ' WHERE resolved_at IS NOT NULL';
    } else if (resolved === false) {
      sql += ' WHERE resolved_at IS NULL';
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = indexer.db.prepare(sql).all(...params);

    // Parse JSON fields for convenience
    return rows.map((row) => ({
      ...row,
      local_version: _safeParse(row.local_version_json),
      cloud_version: _safeParse(row.cloud_version_json),
    }));
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to list conflicts:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Mark a conflict as resolved.
 *
 * @param {object} indexer      — Indexer instance
 * @param {string} conflict_id — ID of the conflict record
 * @param {string} resolution  — Free-text description of how it was resolved
 *   (e.g. "keep_local", "keep_cloud", "merged")
 * @returns {boolean} — true if the update succeeded
 */
export function resolveLocalConflict(indexer, conflict_id, resolution) {
  const now = new Date().toISOString();

  try {
    ensureConflictSchema(indexer);

    const info = indexer.db
      .prepare(
        'UPDATE sync_conflicts SET resolution = ?, resolved_at = ? WHERE id = ?'
      )
      .run(resolution, now, conflict_id);

    if (info.changes > 0) {
      console.log(`${LOG_PREFIX} Conflict ${conflict_id} resolved: ${resolution}`);
      return true;
    }

    console.warn(`${LOG_PREFIX} Conflict ${conflict_id} not found`);
    return false;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to resolve conflict ${conflict_id}:`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string, returning the raw string on failure.
 * @param {string} str
 * @returns {object|string}
 */
function _safeParse(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
