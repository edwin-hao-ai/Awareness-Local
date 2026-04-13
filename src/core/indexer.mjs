/**
 * Indexer — SQLite FTS5 full-text search index for Awareness Local.
 *
 * Uses better-sqlite3 in WAL mode for concurrent read access.
 * Manages 7 tables + 2 FTS5 virtual tables + 1 embeddings table.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  filepath TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT,
  session_id TEXT,
  agent_role TEXT DEFAULT 'builder_agent',
  source TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT,
  synced_to_cloud INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED, title, content, tags,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS knowledge_cards (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_memories TEXT,
  confidence REAL DEFAULT 0.8,
  status TEXT DEFAULT 'active',
  tags TEXT,
  source TEXT,
  parent_card_id TEXT,
  evolution_type TEXT DEFAULT 'initial',
  card_type TEXT DEFAULT 'atomic',
  growth_stage TEXT DEFAULT 'seedling',
  last_touched_at TEXT,
  link_count_incoming INTEGER DEFAULT 0,
  link_count_outgoing INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  synced_to_cloud INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  memory_id TEXT,
  name TEXT NOT NULL,
  summary TEXT,
  methods TEXT,
  trigger_conditions TEXT,
  tags TEXT,
  source_card_ids TEXT,
  decay_score REAL DEFAULT 1.0,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  pinned INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  id UNINDEXED, title, summary, content, tags,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'medium',
  agent_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  synced_to_cloud INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT,
  agent_role TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  memory_count INTEGER DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS perception_state (
  signal_id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  source_card_id TEXT,
  title TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  exposure_count INTEGER DEFAULT 0,
  current_weight REAL DEFAULT 1.0,
  state TEXT DEFAULT 'active',
  snoozed_until TEXT,
  dismissed_at TEXT,
  resolved_by_memory_id TEXT,
  resolved_by_llm INTEGER DEFAULT 0,
  resolution_reason TEXT,
  user_relevance INTEGER DEFAULT 0,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_perception_state_state ON perception_state(state);
CREATE INDEX IF NOT EXISTS idx_perception_state_type ON perception_state(signal_type);
`;

// ---------------------------------------------------------------------------
// F-038 Graph-First Schema (Phase 0)
// ---------------------------------------------------------------------------

const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  title TEXT,
  content TEXT,
  metadata TEXT,
  content_hash TEXT,
  salience_score REAL DEFAULT 0,
  recall_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_status ON graph_nodes(status);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_hash ON graph_nodes(content_hash);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(edge_type);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
  id UNINDEXED, title, content,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS graph_embeddings (
  node_id TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES graph_nodes(id)
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer growth_stage from source_memories reference count.
 * Aligns with backend card_growth_stage.py promotion thresholds.
 * @param {Object} card
 * @returns {'seedling'|'budding'|'evergreen'}
 */
function inferGrowthStage(card) {
  let refCount = 0;
  try {
    const sm = card.source_memories;
    if (typeof sm === 'string' && sm.startsWith('[')) {
      refCount = JSON.parse(sm).length;
    } else if (Array.isArray(sm)) {
      refCount = sm.length;
    }
  } catch { /* default to seedling */ }
  if (refCount >= 5) return 'evergreen';
  if (refCount >= 2) return 'budding';
  return 'seedling';
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Sanitise a query string for FTS5 MATCH — escape double-quotes and wrap
 * each token in double-quotes so special characters don't break the query.
 *
 * For CJK text (Chinese/Japanese/Korean) without spaces, extracts overlapping
 * 3-character windows (trigrams) and OR-joins them, because FTS5 trigram
 * tokenizer requires substring matches — long quoted phrases fail silently.
 */
/** FTS5 boolean operators — pass through without quoting. */
const FTS5_OPS = new Set(['OR', 'AND', 'NOT', 'NEAR']);

/** Detect CJK characters. */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

/**
 * Split a CJK-heavy token into overlapping trigrams for FTS5 trigram matching.
 * @param {string} token
 * @returns {string[]}
 */
function cjkTrigrams(token) {
  const grams = [];
  for (let i = 0; i <= token.length - 3; i++) {
    grams.push(token.substring(i, i + 3));
  }
  // Also include the full token if it's short enough (≤4 chars)
  if (token.length >= 2 && token.length <= 4 && !grams.includes(token)) {
    grams.unshift(token);
  }
  return grams;
}

function sanitiseFtsQuery(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // If the query already contains FTS5 operators or quoted phrases, pass it
  // through with minimal sanitisation (just remove dangerous chars).
  if (/\bOR\b|\bAND\b|\bNOT\b|\bNEAR\b/.test(trimmed) || trimmed.includes('"')) {
    // Already structured — strip only chars that would break FTS5 syntax
    return trimmed.replace(/[;\\]/g, '');
  }

  // Split on whitespace
  const rawTokens = trimmed.split(/\s+/);
  const quotedParts = [];

  for (const token of rawTokens) {
    if (CJK_RE.test(token) && token.length > 4) {
      // CJK-heavy token: split into trigrams and OR-join
      const grams = cjkTrigrams(token).slice(0, 6);
      for (const g of grams) {
        quotedParts.push(`"${g.replace(/"/g, '""')}"`);
      }
    } else {
      // Latin/short token: quote as-is
      quotedParts.push(`"${token.replace(/"/g, '""')}"`);
    }
  }

  // Use OR for mixed CJK+Latin queries to broaden matching
  const hasCJK = rawTokens.some(t => CJK_RE.test(t) && t.length > 4);
  return hasCJK ? quotedParts.join(' OR ') : quotedParts.join(' ');
}

/**
 * Current ISO-8601 timestamp.
 */
function nowISO() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Indexer class
// ---------------------------------------------------------------------------

export class Indexer {
  /**
   * @param {string} dbPath — path to the SQLite database file.
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);

    // WAL mode for concurrent reads from the daemon & file-watchers.
    this.db.pragma('journal_mode = WAL');
    // Reasonable busy timeout so concurrent writers wait instead of failing.
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
    this._prepareStatements();
    this._reindexFts();
    this._checkFtsSyncHealth();
  }

  /**
   * If FTS row count is less than memories row count, reindex missing entries.
   * Handles cases where migration dropped FTS data or records were added without FTS.
   */
  _checkFtsSyncHealth() {
    try {
      const memCount = this.db.prepare('SELECT count(*) AS c FROM memories').get().c;
      const ftsCount = this.db.prepare('SELECT count(*) AS c FROM memories_fts').get().c;
      if (memCount > 0 && ftsCount < memCount) {
        console.log(`[indexer] FTS out of sync (${ftsCount}/${memCount}) — rebuilding missing entries...`);
        this._ftsNeedsReindex = true;
        this._reindexFts();
      }
    } catch {
      // Skip if tables don't exist yet
    }
  }

  // -----------------------------------------------------------------------
  // Schema initialisation
  // -----------------------------------------------------------------------

  /**
   * Execute all CREATE TABLE / CREATE VIRTUAL TABLE statements.
   * Safe to call repeatedly — every statement uses IF NOT EXISTS.
   */
  initSchema() {
    // Migrate FTS5 tables from unicode61 to trigram (CJK support)
    this._migrateFtsTokenizer();
    this.db.exec(SCHEMA_SQL);
    // Add evolution columns to existing knowledge_cards tables
    this._migrateKnowledgeEvolution();
    // Add sync state columns for cloud sync support
    this._migrateSyncFields();
    // Add card_type, growth_stage, link counts for F-031 alignment
    this._migrateCardTypeGrowthStage();
    // Migrate legacy skill cards to dedicated skills table (F-032)
    this._migrateLegacySkills();
    // F-038: Add graph-first schema (nodes + edges)
    this._migrateGraphSchema();
    // F-038 T-005.5: Add recall_count to knowledge_cards
    this._migrateRecallCount();
  }

  /**
   * Add parent_card_id and evolution_type columns if they don't exist yet.
   * Safe to call repeatedly — uses PRAGMA table_info to check.
   */
  _migrateKnowledgeEvolution() {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(knowledge_cards)`).all();
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('parent_card_id')) {
        this.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN parent_card_id TEXT`);
      }
      if (!colNames.has('evolution_type')) {
        this.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN evolution_type TEXT DEFAULT 'initial'`);
      }
      if (!colNames.has('source')) {
        this.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN source TEXT`);
      }
    } catch {
      // Table doesn't exist yet — SCHEMA_SQL will create it with both columns
    }
  }

  /**
   * Add sync state columns to memories and knowledge_cards for cloud sync.
   * Uses try/catch per ALTER so existing columns are silently skipped.
   * Safe to call repeatedly (idempotent).
   */
  _migrateSyncFields() {
    const migrations = [
      'ALTER TABLE memories ADD COLUMN cloud_id TEXT',
      'ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1',
      'ALTER TABLE memories ADD COLUMN schema_version INTEGER DEFAULT 1',
      'ALTER TABLE memories ADD COLUMN sync_status TEXT DEFAULT \'pending_push\'',
      'ALTER TABLE memories ADD COLUMN last_pushed_at TEXT',
      'ALTER TABLE memories ADD COLUMN last_pulled_at TEXT',
      'ALTER TABLE knowledge_cards ADD COLUMN cloud_id TEXT',
      'ALTER TABLE knowledge_cards ADD COLUMN version INTEGER DEFAULT 1',
      'ALTER TABLE knowledge_cards ADD COLUMN schema_version INTEGER DEFAULT 1',
      'ALTER TABLE knowledge_cards ADD COLUMN sync_status TEXT DEFAULT \'pending_push\'',
      'ALTER TABLE knowledge_cards ADD COLUMN last_pushed_at TEXT',
      'ALTER TABLE knowledge_cards ADD COLUMN last_pulled_at TEXT',
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  /**
   * Add card_type, growth_stage, link count columns for F-031 alignment.
   * Safe to call repeatedly (idempotent).
   */
  _migrateCardTypeGrowthStage() {
    const migrations = [
      "ALTER TABLE knowledge_cards ADD COLUMN card_type TEXT DEFAULT 'atomic'",
      "ALTER TABLE knowledge_cards ADD COLUMN growth_stage TEXT DEFAULT 'seedling'",
      'ALTER TABLE knowledge_cards ADD COLUMN last_touched_at TEXT',
      'ALTER TABLE knowledge_cards ADD COLUMN link_count_incoming INTEGER DEFAULT 0',
      'ALTER TABLE knowledge_cards ADD COLUMN link_count_outgoing INTEGER DEFAULT 0',
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  /**
   * Migrate legacy knowledge_cards with category='skill' to dedicated skills table (F-032).
   * Fire-and-forget: runs once, skips if already migrated.
   */
  _migrateLegacySkills() {
    try {
      const legacyCards = this.db.prepare(
        "SELECT * FROM knowledge_cards WHERE category = 'skill' AND status != 'superseded'"
      ).all();
      if (legacyCards.length === 0) return;

      const now = new Date().toISOString();
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO skills (id, name, summary, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `);
      let migrated = 0;
      for (const card of legacyCards) {
        const id = `sk_${card.id.slice(0, 16)}`;
        try {
          insert.run(id, card.title, card.summary, card.created_at || now, now);
          migrated++;
        } catch { /* duplicate — already migrated */ }
      }
      if (migrated > 0) {
        console.log(`[indexer] Migrated ${migrated} legacy skill cards to skills table`);
      }
    } catch {
      // skills table might not exist yet on first run — SCHEMA_SQL handles creation
    }
  }

  /**
   * F-038: Create graph-first schema tables (Phase 0).
   * Uses CREATE TABLE IF NOT EXISTS — safe to call repeatedly.
   */
  _migrateGraphSchema() {
    try {
      this.db.exec(GRAPH_SCHEMA_SQL);
    } catch (err) {
      console.warn('[indexer] graph schema migration warning:', err.message);
    }
  }

  /**
   * F-038 T-005.5: Add recall_count column to knowledge_cards.
   * Tracks how many times a card has been recalled (positive reinforcement).
   */
  _migrateRecallCount() {
    try {
      this.db.exec('ALTER TABLE knowledge_cards ADD COLUMN recall_count INTEGER DEFAULT 0');
    } catch {
      // Column already exists — expected on subsequent runs
    }
  }

  /**
   * If existing FTS5 tables use unicode61 tokenizer, recreate them with trigram.
   * This enables Chinese/Japanese/Korean full-text search.
   */
  _migrateFtsTokenizer() {
    let migrated = false;
    for (const table of ['memories_fts', 'knowledge_fts']) {
      try {
        const row = this.db.prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
        ).get(table);
        if (row && row.sql && row.sql.includes('unicode61')) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`);
          migrated = true;
        }
      } catch {
        // Table doesn't exist yet — will be created by SCHEMA_SQL
      }
    }
    this._ftsNeedsReindex = migrated;
  }

  /**
   * Rebuild FTS5 indexes from source tables after tokenizer migration.
   * Called after schema init + prepared statements are ready.
   */
  _reindexFts() {
    if (!this._ftsNeedsReindex) return;
    console.log('[indexer] Rebuilding FTS indexes after tokenizer migration...');
    // Repopulate memories_fts from memories table + markdown files
    const memories = this.db.prepare('SELECT id, title, tags, filepath FROM memories').all();
    for (const m of memories) {
      try {
        const content = m.filepath && existsSync(m.filepath)
          ? readFileSync(m.filepath, 'utf-8')
          : (m.title || '');
        this._stmtDeleteFts.run(m.id);
        this._stmtInsertFts.run({
          id: m.id,
          title: m.title || '',
          content,
          tags: m.tags || '',
        });
      } catch {
        // Skip files that can't be read
      }
    }
    // Repopulate knowledge_fts
    const cards = this.db.prepare('SELECT id, title, summary, tags FROM knowledge_cards').all();
    for (const c of cards) {
      try {
        this._stmtDeleteKnowledgeFts.run(c.id);
        this._stmtInsertKnowledgeFts.run({
          id: c.id,
          title: c.title || '',
          summary: c.summary || '',
          content: c.summary || '',
          tags: c.tags || '',
        });
      } catch {
        // Skip
      }
    }
    console.log(`[indexer] FTS reindex done: ${memories.length} memories, ${cards.length} cards`);
    this._ftsNeedsReindex = false;
  }

  // -----------------------------------------------------------------------
  // Prepared-statement cache (lazy, created once)
  // -----------------------------------------------------------------------

  /** @private */
  _prepareStatements() {
    // -- memories upsert --------------------------------------------------
    this._stmtUpsertMemory = this.db.prepare(`
      INSERT INTO memories (id, filepath, type, title, session_id, agent_role,
                            source, status, tags, created_at, updated_at, content_hash, synced_to_cloud,
                            cloud_id, version, schema_version, sync_status, last_pushed_at, last_pulled_at)
      VALUES (@id, @filepath, @type, @title, @session_id, @agent_role,
              @source, @status, @tags, @created_at, @updated_at, @content_hash, @synced_to_cloud,
              @cloud_id, @version, @schema_version, @sync_status, @last_pushed_at, @last_pulled_at)
      ON CONFLICT(id) DO UPDATE SET
        filepath     = excluded.filepath,
        type         = excluded.type,
        title        = excluded.title,
        session_id   = excluded.session_id,
        agent_role   = excluded.agent_role,
        source       = excluded.source,
        status       = excluded.status,
        tags         = excluded.tags,
        updated_at   = excluded.updated_at,
        content_hash = excluded.content_hash,
        synced_to_cloud = excluded.synced_to_cloud,
        cloud_id     = excluded.cloud_id,
        version      = excluded.version,
        schema_version = excluded.schema_version,
        sync_status  = excluded.sync_status,
        last_pushed_at = excluded.last_pushed_at,
        last_pulled_at = excluded.last_pulled_at
    `);

    this._stmtGetMemoryHash = this.db.prepare(
      `SELECT content_hash FROM memories WHERE id = ?`
    );

    // -- memories_fts upsert (delete + insert, FTS5 has no ON CONFLICT) ---
    this._stmtDeleteFts = this.db.prepare(
      `DELETE FROM memories_fts WHERE id = ?`
    );
    this._stmtInsertFts = this.db.prepare(`
      INSERT INTO memories_fts (id, title, content, tags)
      VALUES (@id, @title, @content, @tags)
    `);

    // -- knowledge_cards --------------------------------------------------
    this._stmtUpsertKnowledge = this.db.prepare(`
      INSERT INTO knowledge_cards (id, category, title, summary, source_memories,
                                   confidence, status, tags, source, parent_card_id,
                                   evolution_type, card_type, growth_stage,
                                   last_touched_at, link_count_incoming, link_count_outgoing,
                                   created_at, filepath,
                                   cloud_id, version, schema_version, sync_status,
                                   last_pushed_at, last_pulled_at)
      VALUES (@id, @category, @title, @summary, @source_memories,
              @confidence, @status, @tags, @source, @parent_card_id,
              @evolution_type, @card_type, @growth_stage,
              @last_touched_at, @link_count_incoming, @link_count_outgoing,
              @created_at, @filepath,
              @cloud_id, @version, @schema_version, @sync_status,
              @last_pushed_at, @last_pulled_at)
      ON CONFLICT(id) DO UPDATE SET
        category        = excluded.category,
        title           = excluded.title,
        summary         = excluded.summary,
        source_memories = excluded.source_memories,
        confidence      = excluded.confidence,
        status          = excluded.status,
        tags            = excluded.tags,
        source          = excluded.source,
        parent_card_id  = excluded.parent_card_id,
        evolution_type  = excluded.evolution_type,
        card_type       = excluded.card_type,
        growth_stage    = excluded.growth_stage,
        last_touched_at = excluded.last_touched_at,
        link_count_incoming = excluded.link_count_incoming,
        link_count_outgoing = excluded.link_count_outgoing,
        filepath        = excluded.filepath,
        cloud_id        = excluded.cloud_id,
        version         = excluded.version,
        schema_version  = excluded.schema_version,
        sync_status     = excluded.sync_status,
        last_pushed_at  = excluded.last_pushed_at,
        last_pulled_at  = excluded.last_pulled_at
    `);

    this._stmtDeleteKnowledgeFts = this.db.prepare(
      `DELETE FROM knowledge_fts WHERE id = ?`
    );
    this._stmtInsertKnowledgeFts = this.db.prepare(`
      INSERT INTO knowledge_fts (id, title, summary, content, tags)
      VALUES (@id, @title, @summary, @content, @tags)
    `);

    // -- tasks ------------------------------------------------------------
    this._stmtUpsertTask = this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, agent_role,
                         created_at, updated_at, filepath)
      VALUES (@id, @title, @description, @status, @priority, @agent_role,
              @created_at, @updated_at, @filepath)
      ON CONFLICT(id) DO UPDATE SET
        title       = excluded.title,
        description = excluded.description,
        status      = excluded.status,
        priority    = excluded.priority,
        agent_role  = excluded.agent_role,
        updated_at  = excluded.updated_at,
        filepath    = excluded.filepath
    `);

    // -- sessions ---------------------------------------------------------
    this._stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (id, source, agent_role, started_at)
      VALUES (@id, @source, @agent_role, @started_at)
    `);

    this._stmtUpdateSession = this.db.prepare(`
      UPDATE sessions
      SET ended_at     = COALESCE(@ended_at, ended_at),
          memory_count = COALESCE(@memory_count, memory_count),
          summary      = COALESCE(@summary, summary)
      WHERE id = @id
    `);

    // -- embeddings -------------------------------------------------------
    this._stmtUpsertEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (memory_id, vector, model_id, created_at)
      VALUES (@memory_id, @vector, @model_id, @created_at)
    `);

    this._stmtGetEmbedding = this.db.prepare(
      `SELECT vector FROM embeddings WHERE memory_id = ?`
    );

    this._stmtGetAllEmbeddings = this.db.prepare(
      `SELECT memory_id, vector, model_id FROM embeddings`
    );
  }

  // -----------------------------------------------------------------------
  // Memory indexing
  // -----------------------------------------------------------------------

  /**
   * Upsert a memory record and its FTS5 entry.
   *
   * If the content_hash is unchanged, the write is skipped entirely (no-op).
   *
   * @param {string} id
   * @param {Object} metadata — must include at least { filepath, type, created_at, updated_at }.
   * @param {string} content — the full Markdown body (used for FTS indexing).
   * @returns {{ indexed: boolean }} — true if the record was written.
   */
  indexMemory(id, metadata, content) {
    const contentHash = sha256(content);

    // Fast path: skip if unchanged.
    const existing = this._stmtGetMemoryHash.get(id);
    if (existing && existing.content_hash === contentHash) {
      return { indexed: false };
    }

    const now = nowISO();
    const tags =
      typeof metadata.tags === 'string'
        ? metadata.tags
        : Array.isArray(metadata.tags)
          ? JSON.stringify(metadata.tags)
          : null;

    const row = {
      id,
      filepath: metadata.filepath,
      type: metadata.type || 'turn_summary',
      title: metadata.title || null,
      session_id: metadata.session_id || null,
      agent_role: metadata.agent_role || 'builder_agent',
      source: metadata.source || null,
      status: metadata.status || 'active',
      tags,
      created_at: metadata.created_at || now,
      updated_at: metadata.updated_at || now,
      content_hash: contentHash,
      synced_to_cloud: metadata.synced_to_cloud ? 1 : 0,
      cloud_id: metadata.cloud_id || null,
      version: metadata.version != null ? metadata.version : 1,
      schema_version: metadata.schema_version != null ? metadata.schema_version : 1,
      sync_status: metadata.sync_status || 'pending_push',
      last_pushed_at: metadata.last_pushed_at || null,
      last_pulled_at: metadata.last_pulled_at || null,
    };

    // Wrap in a transaction so the metadata + FTS rows are atomic.
    const upsert = this.db.transaction(() => {
      this._stmtUpsertMemory.run(row);
      this._stmtDeleteFts.run(id);
      this._stmtInsertFts.run({
        id,
        title: row.title || '',
        content,
        tags: tags || '',
      });
    });
    upsert();

    return { indexed: true };
  }

  // -----------------------------------------------------------------------
  // Knowledge card indexing
  // -----------------------------------------------------------------------

  /**
   * Insert or update a knowledge card and its FTS5 entry.
   *
   * @param {Object} card — { id, category, title, summary, source_memories,
   *                           confidence, status, tags, created_at, filepath, content }
   *   `content` is used only for FTS indexing and is NOT stored in the
   *   knowledge_cards table (the full body lives in the Markdown file).
   */
  indexKnowledgeCard(card) {
    const tags =
      typeof card.tags === 'string'
        ? card.tags
        : Array.isArray(card.tags)
          ? JSON.stringify(card.tags)
          : null;

    const now = nowISO();
    const row = {
      id: card.id,
      category: card.category,
      title: card.title,
      summary: card.summary || null,
      source_memories:
        typeof card.source_memories === 'string'
          ? card.source_memories
          : Array.isArray(card.source_memories)
            ? JSON.stringify(card.source_memories)
            : null,
      confidence: card.confidence ?? 0.8,
      status: card.status || 'active',
      tags,
      source: card.source || null,
      parent_card_id: card.parent_card_id || null,
      evolution_type: card.evolution_type || 'initial',
      card_type: card.card_type || 'atomic',
      growth_stage: card.growth_stage || inferGrowthStage(card),
      last_touched_at: card.last_touched_at || now,
      link_count_incoming: card.link_count_incoming ?? 0,
      link_count_outgoing: card.link_count_outgoing ?? 0,
      created_at: card.created_at || now,
      filepath: card.filepath,
      cloud_id: card.cloud_id || null,
      version: card.version != null ? card.version : 1,
      schema_version: card.schema_version != null ? card.schema_version : 1,
      sync_status: card.sync_status || 'pending_push',
      last_pushed_at: card.last_pushed_at || null,
      last_pulled_at: card.last_pulled_at || null,
    };

    const upsert = this.db.transaction(() => {
      this._stmtUpsertKnowledge.run(row);
      this._stmtDeleteKnowledgeFts.run(card.id);
      this._stmtInsertKnowledgeFts.run({
        id: card.id,
        title: card.title || '',
        summary: card.summary || '',
        content: card.content || '',
        tags: tags || '',
      });
    });
    upsert();
  }

  // -----------------------------------------------------------------------
  // Incremental MOC (Map-of-Content) auto-creation
  // Triggered after every knowledge card write. Zero LLM, zero timers.
  // -----------------------------------------------------------------------

  /**
   * Check if a newly written card's tags warrant creating or updating a MOC card.
   *
   * Algorithm (O(1) per card, no full scan):
   *   1. Parse the card's tags
   *   2. For each tag, check if a MOC card with that tag as title already exists
   *   3. If yes → update MOC's member count (link_count_outgoing)
   *   4. If no → count how many active atomic cards share this tag
   *   5. If count >= MOC_THRESHOLD → auto-create a MOC card
   *
   * @param {Object} card — the card that was just written (must have id, tags, card_type)
   */
  /**
   * @param {Object} card — the card that was just written
   * @returns {string[]} IDs of newly created MOC cards (for optional LLM refinement)
   */
  tryAutoMoc(card) {
    // Don't create MOC from MOC cards themselves
    if (card.card_type === 'moc' || card.card_type === 'index') return [];

    let tags;
    try {
      tags = typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags;
    } catch { return []; }
    if (!Array.isArray(tags) || tags.length === 0) return [];

    const MOC_THRESHOLD = 3; // minimum cards sharing a tag to create MOC
    const now = nowISO();
    const createdMocIds = [];

    for (const rawTag of tags) {
      const tag = String(rawTag).trim().toLowerCase();
      if (!tag || tag.length < 2) continue;

      // Check if MOC already exists for this tag (case-insensitive title match)
      const existingMoc = this.db.prepare(
        `SELECT id, link_count_outgoing FROM knowledge_cards
         WHERE card_type = 'moc' AND status = 'active' AND LOWER(title) = ?
         LIMIT 1`
      ).get(tag);

      if (existingMoc) {
        // Recount actual members with this tag
        const memberCount = this.db.prepare(
          `SELECT COUNT(*) AS c FROM knowledge_cards
           WHERE status = 'active' AND card_type != 'moc'
             AND tags LIKE ?`
        ).get(`%"${tag}"%`)?.c ?? 0;

        if (memberCount !== existingMoc.link_count_outgoing) {
          this.db.prepare(
            `UPDATE knowledge_cards SET link_count_outgoing = ?, last_touched_at = ? WHERE id = ?`
          ).run(memberCount, now, existingMoc.id);
        }
        continue;
      }

      // No MOC exists — check if we have enough cards to create one
      const count = this.db.prepare(
        `SELECT COUNT(*) AS c FROM knowledge_cards
         WHERE status = 'active' AND card_type != 'moc'
           AND tags LIKE ?`
      ).get(`%"${tag}"%`)?.c ?? 0;

      if (count >= MOC_THRESHOLD) {
        // Auto-create MOC card with tag-based title (default, zero LLM)
        const mocId = `moc_${tag.replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const mocTitle = tag.replace(/\b\w/g, (c) => c.toUpperCase());

        // Collect member titles for summary
        const members = this.db.prepare(
          `SELECT title FROM knowledge_cards
           WHERE status = 'active' AND card_type != 'moc'
             AND tags LIKE ?
           ORDER BY created_at DESC LIMIT 10`
        ).all(`%"${tag}"%`);

        const summaryParts = members.map((m) => m.title).filter(Boolean);
        const summary = summaryParts.length > 0
          ? `Covers: ${summaryParts.slice(0, 5).join(', ')}${summaryParts.length > 5 ? ` (+${summaryParts.length - 5} more)` : ''}`
          : '';

        this.indexKnowledgeCard({
          id: mocId,
          category: 'moc',
          title: mocTitle,
          summary,
          card_type: 'moc',
          growth_stage: 'budding',
          confidence: 0.8,
          status: 'active',
          tags: JSON.stringify([tag]),
          source_memories: JSON.stringify([]),
          link_count_outgoing: count,
          link_count_incoming: 0,
          created_at: now,
          filepath: `__moc__/${mocId}`,
        });

        createdMocIds.push(mocId);
        console.log(`[indexer] Auto-created MOC: "${mocTitle}" (${count} cards with tag "${tag}")`);
      }
    }
    return createdMocIds;
  }

  /**
   * Upgrade a MOC card's title and summary using LLM inference.
   * Called async (fire-and-forget) after tryAutoMoc creates a new MOC.
   *
   * @param {string} mocId — the MOC card ID to refine
   * @param {Function} llmInfer — async (systemPrompt, userContent) => string
   */
  async refineMocWithLlm(mocId, llmInfer) {
    const moc = this.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(mocId);
    if (!moc) return;

    // Get the tag from the MOC's tags
    let mocTags;
    try { mocTags = JSON.parse(moc.tags); } catch { return; }
    const tag = mocTags?.[0];
    if (!tag) return;

    // Collect member card details
    const members = this.db.prepare(
      `SELECT title, summary, category FROM knowledge_cards
       WHERE status = 'active' AND card_type != 'moc'
         AND tags LIKE ?
       ORDER BY created_at DESC LIMIT 15`
    ).all(`%"${tag}"%`);

    if (members.length === 0) return;

    const memberList = members
      .map((m, i) => `${i + 1}. [${m.category}] ${m.title}: ${(m.summary || '').substring(0, 100)}`)
      .join('\n');

    const systemPrompt = `You are naming a topic cluster for a personal knowledge base.
Given a list of knowledge cards that share the tag "${tag}", produce a clear, concise topic title (3-8 words) and a 1-2 sentence summary.
Write in the SAME LANGUAGE as the member cards.
Return ONLY JSON: {"title": "...", "summary": "..."}`;

    const userContent = `Tag: "${tag}"\nMember cards:\n${memberList}`;

    try {
      const raw = await llmInfer(systemPrompt, userContent);
      // Parse JSON response
      const match = raw.match(/\{[\s\S]*?"title"[\s\S]*?\}/);
      if (!match) return;
      const parsed = JSON.parse(match[0]);
      if (!parsed.title) return;

      // Update MOC card with LLM-generated title/summary
      this.db.prepare(
        `UPDATE knowledge_cards SET title = ?, summary = ?, last_touched_at = ? WHERE id = ?`
      ).run(parsed.title, parsed.summary || moc.summary, nowISO(), mocId);

      // Update FTS
      this.db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(mocId);
      this.db.prepare(
        `INSERT INTO knowledge_fts (id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)`
      ).run(mocId, parsed.title, parsed.summary || '', '', moc.tags || '');

      console.log(`[indexer] MOC title refined by LLM: "${tag}" → "${parsed.title}"`);
    } catch (err) {
      // LLM failure is non-fatal — keep the tag-based title
      console.warn(`[indexer] MOC LLM refinement failed (non-fatal): ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Task indexing
  // -----------------------------------------------------------------------

  /**
   * Insert or update a task.
   *
   * @param {Object} task — { id, title, description, status, priority,
   *                           agent_role, created_at, updated_at, filepath }
   */
  indexTask(task) {
    const now = nowISO();
    this._stmtUpsertTask.run({
      id: task.id,
      title: task.title,
      description: task.description || null,
      status: task.status || 'open',
      priority: task.priority || 'medium',
      agent_role: task.agent_role || null,
      created_at: task.created_at || now,
      updated_at: task.updated_at || now,
      filepath: task.filepath,
    });
  }

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  /**
   * Create a new session.
   *
   * @param {string} source  — e.g. 'claude-code', 'openclaw'
   * @param {string} [agentRole='builder_agent']
   * @returns {{ id: string, source: string, agent_role: string, started_at: string }}
   */
  createSession(source, agentRole = 'builder_agent') {
    const now = nowISO();
    const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = { id, source: source || null, agent_role: agentRole, started_at: now };
    this._stmtInsertSession.run(row);
    return { ...row };
  }

  /**
   * Update an existing session (e.g. set ended_at, memory_count, summary).
   *
   * @param {string} id
   * @param {Object} updates — any subset of { ended_at, memory_count, summary }.
   */
  updateSession(id, updates = {}) {
    this._stmtUpdateSession.run({
      id,
      ended_at: updates.ended_at ?? null,
      memory_count: updates.memory_count ?? null,
      summary: updates.summary ?? null,
    });
  }

  // -----------------------------------------------------------------------
  // FTS5 search
  // -----------------------------------------------------------------------

  /**
   * Full-text search over indexed memories.
   *
   * @param {string} query — natural language or keyword query.
   * @param {Object} [options]
   * @param {string[]} [options.types]  — filter by memory type.
   * @param {string[]} [options.tags]   — filter by tag (JSON array substring match).
   * @param {number}   [options.limit=10]
   * @param {number}   [options.offset=0]
   * @returns {Array<Object>} — memory rows with an additional `rank` field (lower = more relevant).
   */
  search(query, options = {}) {
    const ftsQuery = sanitiseFtsQuery(query);
    if (!ftsQuery) return [];

    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    // Build dynamic WHERE clauses for optional filters.
    const conditions = [`memories_fts MATCH ?`, `m.status = 'active'`];
    const params = [ftsQuery];

    if (Array.isArray(options.types) && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(', ');
      conditions.push(`m.type IN (${placeholders})`);
      params.push(...options.types);
    }

    if (Array.isArray(options.tags) && options.tags.length > 0) {
      // tags is stored as a JSON array string — use LIKE for substring match.
      for (const tag of options.tags) {
        conditions.push(`m.tags LIKE ?`);
        params.push(`%${tag}%`);
      }
    }

    params.push(limit, offset);

    const sql = `
      SELECT m.*, memories_fts.content AS fts_content, bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Full-text search over knowledge cards.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {string[]} [options.categories]
   * @param {number}   [options.limit=10]
   * @param {number}   [options.offset=0]
   * @returns {Array<Object>}
   */
  searchKnowledge(query, options = {}) {
    const ftsQuery = sanitiseFtsQuery(query);
    if (!ftsQuery) return [];

    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    const conditions = [`knowledge_fts MATCH ?`, `k.status = 'active'`];
    const params = [ftsQuery];

    if (Array.isArray(options.categories) && options.categories.length > 0) {
      const placeholders = options.categories.map(() => '?').join(', ');
      conditions.push(`k.category IN (${placeholders})`);
      params.push(...options.categories);
    }

    params.push(limit, offset);

    // F-038 T-005.5: Three-dimensional weighted ranking
    // score = bm25 × 0.70 + log(recall_count+1) × 0.15 + link_count × 0.15
    // Note: bm25() returns negative values (lower = better match), so we negate it
    const sql = `
      SELECT k.*,
        bm25(knowledge_fts) AS bm25_raw,
        (
          (-bm25(knowledge_fts)) * 0.70
          + ln(COALESCE(k.recall_count, 0) + 1) * 0.15
          + (COALESCE(k.link_count_incoming, 0) + COALESCE(k.link_count_outgoing, 0)) * 0.15
        ) AS weighted_rank
      FROM knowledge_fts
      JOIN knowledge_cards k ON k.id = knowledge_fts.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY weighted_rank DESC
      LIMIT ? OFFSET ?
    `;

    const results = this.db.prepare(sql).all(...params);

    // Increment recall_count for matched cards (fire-and-forget)
    if (results.length > 0) {
      this._incrementRecallCount(results.map(r => r.id));
    }

    return results;
  }

  /**
   * Increment recall_count for the given card IDs.
   * Called when cards are returned from search results.
   *
   * @param {string[]} cardIds
   */
  _incrementRecallCount(cardIds) {
    if (!cardIds || cardIds.length === 0) return;
    try {
      const placeholders = cardIds.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE knowledge_cards SET recall_count = COALESCE(recall_count, 0) + 1 WHERE id IN (${placeholders})`
      ).run(...cardIds);
    } catch (err) {
      console.warn('[indexer] recall_count increment failed:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // F-038: Graph operations (nodes + edges + traversal)
  // -----------------------------------------------------------------------

  /**
   * Get a graph node by ID.
   *
   * @param {string} nodeId
   * @returns {{ id: string, node_type: string, title: string, content: string, content_hash: string, status: string } | null}
   */
  getGraphNode(nodeId) {
    try {
      return this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(nodeId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Insert or update a graph node.
   *
   * @param {Object} node
   * @param {string} node.id
   * @param {string} node.node_type - 'file' | 'symbol' | 'card' | 'wiki' | 'doc'
   * @param {string} [node.title]
   * @param {string} [node.content]
   * @param {Object} [node.metadata]
   * @param {string} [node.content_hash]
   * @param {number} [node.salience_score]
   * @returns {{ inserted: boolean }}
   */
  graphInsertNode(node) {
    const now = new Date().toISOString();
    const metadata = node.metadata ? JSON.stringify(node.metadata) : null;

    try {
      this.db.prepare(`
        INSERT INTO graph_nodes (id, node_type, title, content, metadata, content_hash, salience_score, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          metadata = excluded.metadata,
          content_hash = excluded.content_hash,
          salience_score = COALESCE(excluded.salience_score, salience_score),
          updated_at = excluded.updated_at
      `).run(
        node.id,
        node.node_type,
        node.title || null,
        node.content || null,
        metadata,
        node.content_hash || null,
        node.salience_score ?? 0,
        now,
        now
      );

      // Update FTS index (FTS5 doesn't support UPSERT — delete + insert)
      this.db.prepare('DELETE FROM graph_nodes_fts WHERE id = ?').run(node.id);
      this.db.prepare(`
        INSERT INTO graph_nodes_fts (id, title, content)
        VALUES (?, ?, ?)
      `).run(node.id, node.title || '', node.content || '');

      return { inserted: true };
    } catch (err) {
      console.warn('[indexer] graphInsertNode failed:', err.message);
      return { inserted: false };
    }
  }

  /**
   * Insert or update a graph edge.
   *
   * @param {Object} edge
   * @param {string} edge.from_node_id
   * @param {string} edge.to_node_id
   * @param {string} edge.edge_type - 'import' | 'doc_reference' | 'similarity' | 'evolution' | 'tag_share' | 'contains'
   * @param {number} [edge.weight=1.0]
   * @param {Object} [edge.metadata]
   * @returns {{ inserted: boolean }}
   */
  graphInsertEdge(edge) {
    const now = new Date().toISOString();
    const metadata = edge.metadata ? JSON.stringify(edge.metadata) : null;

    try {
      this.db.prepare(`
        INSERT INTO graph_edges (from_node_id, to_node_id, edge_type, weight, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_node_id, to_node_id, edge_type) DO UPDATE SET
          weight = excluded.weight,
          metadata = excluded.metadata
      `).run(
        edge.from_node_id,
        edge.to_node_id,
        edge.edge_type,
        edge.weight ?? 1.0,
        metadata,
        now
      );
      return { inserted: true };
    } catch (err) {
      console.warn('[indexer] graphInsertEdge failed:', err.message);
      return { inserted: false };
    }
  }

  /**
   * Traverse the graph from a starting node using WITH RECURSIVE.
   * Returns all reachable nodes within maxDepth hops.
   *
   * @param {string} startId - Starting node ID
   * @param {Object} [options]
   * @param {number} [options.maxDepth=2] - Maximum traversal depth
   * @param {string[]} [options.edgeTypes] - Filter by edge types (null = all)
   * @param {string[]} [options.nodeTypes] - Filter result node types (null = all)
   * @param {number} [options.limit=50] - Max nodes to return
   * @returns {Array<{ id: string, node_type: string, title: string, depth: number, edge_type: string }>}
   */
  graphTraverse(startId, options = {}) {
    const maxDepth = options.maxDepth ?? 2;
    const limit = options.limit ?? 50;

    // Build edge type filter
    let edgeFilter = '';
    const params = [startId];
    if (Array.isArray(options.edgeTypes) && options.edgeTypes.length > 0) {
      const placeholders = options.edgeTypes.map(() => '?').join(', ');
      edgeFilter = `AND e.edge_type IN (${placeholders})`;
      params.push(...options.edgeTypes);
    }

    // Build node type filter for final results
    let nodeFilter = '';
    if (Array.isArray(options.nodeTypes) && options.nodeTypes.length > 0) {
      const placeholders = options.nodeTypes.map(() => '?').join(', ');
      nodeFilter = `AND n.node_type IN (${placeholders})`;
    }

    const sql = `
      WITH RECURSIVE traversal(id, depth, edge_type, path) AS (
        -- Base case: starting node
        SELECT ?, 0, 'start', ?
        UNION ALL
        -- Recursive: follow edges in both directions
        SELECT
          CASE WHEN e.from_node_id = t.id THEN e.to_node_id ELSE e.from_node_id END,
          t.depth + 1,
          e.edge_type,
          t.path || ',' || CASE WHEN e.from_node_id = t.id THEN e.to_node_id ELSE e.from_node_id END
        FROM traversal t
        JOIN graph_edges e ON (e.from_node_id = t.id OR e.to_node_id = t.id)
        WHERE t.depth < ?
          ${edgeFilter}
          -- Prevent cycles: don't revisit nodes already in path
          AND t.path NOT LIKE '%' || CASE WHEN e.from_node_id = t.id THEN e.to_node_id ELSE e.from_node_id END || '%'
      )
      SELECT DISTINCT
        n.id, n.node_type, n.title, n.content, n.metadata,
        n.salience_score, n.recall_count,
        t.depth, t.edge_type
      FROM traversal t
      JOIN graph_nodes n ON n.id = t.id
      WHERE t.depth > 0
        AND n.status = 'active'
        ${nodeFilter}
      ORDER BY t.depth ASC, n.salience_score DESC
      LIMIT ?
    `;

    // Params: startId (base), startId (path), maxDepth, [edgeTypes...], [nodeTypes...], limit
    const allParams = [startId, startId, maxDepth, ...params.slice(1)];
    if (Array.isArray(options.nodeTypes) && options.nodeTypes.length > 0) {
      allParams.push(...options.nodeTypes);
    }
    allParams.push(limit);

    try {
      return this.db.prepare(sql).all(...allParams);
    } catch (err) {
      console.warn('[indexer] graphTraverse failed:', err.message);
      return [];
    }
  }

  /**
   * Search graph nodes using FTS5.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {string[]} [options.nodeTypes] - Filter by node type
   * @param {number} [options.limit=10]
   * @returns {Array<Object>}
   */
  searchGraphNodes(query, options = {}) {
    const ftsQuery = sanitiseFtsQuery(query);
    if (!ftsQuery) return [];

    const limit = options.limit ?? 10;
    const conditions = [`graph_nodes_fts MATCH ?`, `n.status = 'active'`];
    const params = [ftsQuery];

    if (Array.isArray(options.nodeTypes) && options.nodeTypes.length > 0) {
      const placeholders = options.nodeTypes.map(() => '?').join(', ');
      conditions.push(`n.node_type IN (${placeholders})`);
      params.push(...options.nodeTypes);
    }

    params.push(limit);

    const sql = `
      SELECT n.*, bm25(graph_nodes_fts) AS rank
      FROM graph_nodes_fts
      JOIN graph_nodes n ON n.id = graph_nodes_fts.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...params);
  }

  // -----------------------------------------------------------------------
  // Incremental indexing
  // -----------------------------------------------------------------------

  /**
   * Scan the memory store for new or changed files and index them.
   *
   * @param {Object} memoryStore — a MemoryStore instance with list() and read() methods.
   * @returns {Promise<{ indexed: number, skipped: number }>}
   */
  async incrementalIndex(memoryStore) {
    const files = await memoryStore.list();
    let indexed = 0;
    let skipped = 0;

    for (const file of files) {
      try {
        const id = file.metadata?.id;
        if (!id) {
          skipped++;
          continue;
        }
        // Ensure filepath is in metadata (list() returns it at top level)
        const meta = { ...file.metadata, filepath: file.filepath || file.metadata.filepath };
        // Derive title from first sentence of content if not in metadata
        if (!meta.title && file.content) {
          const firstSentence = file.content.split(/[.\n!?。！？]/)[0].trim();
          meta.title = firstSentence.length > 80
            ? firstSentence.substring(0, 77) + '...'
            : firstSentence || null;
        }
        const result = this.indexMemory(id, meta, file.content);
        if (result.indexed) {
          indexed++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[indexer] failed to index ${file.metadata?.id}:`, err.message);
        skipped++;
      }
    }

    return { indexed, skipped };
  }

  // -----------------------------------------------------------------------
  // Knowledge card evolution
  // -----------------------------------------------------------------------

  /**
   * Mark a card as superseded and remove it from FTS index.
   *
   * @param {string} cardId - ID of the card to supersede
   * @returns {boolean} true if updated
   */
  supersedeCard(cardId) {
    try {
      this.db.prepare(
        `UPDATE knowledge_cards SET status = 'superseded' WHERE id = ?`
      ).run(cardId);
      this._stmtDeleteKnowledgeFts.run(cardId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the full evolution chain for a card (ancestors + descendants).
   *
   * @param {string} cardId
   * @returns {object[]} — cards sorted by created_at ASC
   */
  getEvolutionChain(cardId) {
    // Find the root of the chain by walking parent_card_id upward
    let rootId = cardId;
    for (let i = 0; i < 50; i++) {
      const row = this.db.prepare(
        `SELECT parent_card_id FROM knowledge_cards WHERE id = ?`
      ).get(rootId);
      if (!row || !row.parent_card_id) break;
      rootId = row.parent_card_id;
    }

    // Walk the chain downward from root
    const chain = [];
    const visited = new Set();
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const card = this.db.prepare(
        `SELECT id, parent_card_id, evolution_type, category, title, summary,
                confidence, status, created_at FROM knowledge_cards WHERE id = ?`
      ).get(id);
      if (card) {
        chain.push(card);
        // Find children
        const children = this.db.prepare(
          `SELECT id FROM knowledge_cards WHERE parent_card_id = ?`
        ).all(id);
        for (const child of children) queue.push(child.id);
      }
    }

    chain.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return chain;
  }

  // -----------------------------------------------------------------------
  // Stats & convenience queries
  // -----------------------------------------------------------------------

  /**
   * Get aggregate counts for dashboard / healthz.
   */
  getStats() {
    return {
      totalMemories: this.db
        .prepare(`SELECT COUNT(*) AS c FROM memories WHERE status = ?`)
        .get('active').c,
      totalKnowledge: this.db
        .prepare(`SELECT COUNT(*) AS c FROM knowledge_cards WHERE status = ?`)
        .get('active').c,
      totalTasks: this.db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = ?`)
        .get('open').c,
      totalSessions: this.db
        .prepare(`SELECT COUNT(*) AS c FROM sessions`)
        .get().c,
    };
  }

  /**
   * Return the most recently stored memories within a time window.
   * Used for session-context enrichment in recall queries.
   *
   * @param {number} [windowMs=3_600_000] — look-back window in ms (default: 1 hour)
   * @param {number} [limit=8]
   * @returns {Array<{ id: string, title: string, tags: string }>}
   */
  getRecentMemories(windowMs = 3_600_000, limit = 8) {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return this.db
      .prepare(
        `SELECT id, title, tags FROM memories
         WHERE created_at > ? AND status = 'active'
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(cutoff, limit);
  }

  /**
   * Return the most recently created knowledge cards.
   *
   * @param {number} [limit=5]
   */
  getRecentKnowledge(limit = 5) {
    return this.db
      .prepare(
        `SELECT * FROM knowledge_cards WHERE status = 'active'
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit);
  }

  /**
   * Return open (un-completed) tasks.
   *
   * @param {number} [limit=5]
   */
  getOpenTasks(limit = 0) {
    if (limit > 0) {
      return this.db
        .prepare(
          `SELECT * FROM tasks WHERE status = 'open'
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit);
    }
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'open'
         ORDER BY created_at DESC`
      )
      .all();
  }

  /**
   * Return sessions started within the last N days.
   *
   * @param {number} [days=7]
   */
  getRecentSessions(days = 7) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .prepare(`SELECT * FROM sessions WHERE started_at > ? ORDER BY started_at DESC`)
      .all(cutoff);
  }

  // -----------------------------------------------------------------------
  // Embedding storage (SQLite BLOB)
  // -----------------------------------------------------------------------

  /**
   * Store (or replace) an embedding vector for a memory.
   *
   * @param {string} memoryId
   * @param {Float32Array} vector — 384-dimensional embedding.
   * @param {string} modelId — e.g. 'all-MiniLM-L6-v2' or 'multilingual-e5-small'.
   */
  storeEmbedding(memoryId, vector, modelId) {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this._stmtUpsertEmbedding.run({
      memory_id: memoryId,
      vector: buf,
      model_id: modelId,
      created_at: nowISO(),
    });
  }

  /**
   * Retrieve the embedding vector for a single memory.
   *
   * @param {string} memoryId
   * @returns {Float32Array|null}
   */
  getEmbedding(memoryId) {
    const row = this._stmtGetEmbedding.get(memoryId);
    if (!row) return null;
    return new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
  }

  /**
   * Retrieve all embeddings (for brute-force cosine search).
   *
   * @returns {Array<{ memory_id: string, vector: Float32Array }>}
   */
  getAllEmbeddings() {
    const rows = this._stmtGetAllEmbeddings.all();
    return rows.map((row) => ({
      id: row.memory_id,
      memory_id: row.memory_id,
      model_id: row.model_id || '',
      vector: new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT
      ),
    }));
  }

  // -----------------------------------------------------------------------
  // Perception state management
  // -----------------------------------------------------------------------

  /**
   * Get existing perception state by signal_id.
   * @returns {Object|null}
   */
  getPerceptionState(signalId) {
    return this.db.prepare(
      'SELECT * FROM perception_state WHERE signal_id = ?'
    ).get(signalId);
  }

  /**
   * Upsert perception state — used when surfacing a signal.
   * Increments exposure_count, updates last_seen_at, applies decay.
   */
  touchPerceptionState(signal) {
    const now = nowISO();
    const existing = this.getPerceptionState(signal.signal_id);
    if (existing) {
      const newCount = existing.exposure_count + 1;
      // Decay: weight drops as exposure grows
      const newWeight = Math.max(0, existing.current_weight - 0.2);
      this.db.prepare(
        `UPDATE perception_state SET
          exposure_count = ?,
          last_seen_at = ?,
          current_weight = ?
         WHERE signal_id = ?`
      ).run(newCount, now, newWeight, signal.signal_id);
      return { ...existing, exposure_count: newCount, current_weight: newWeight };
    }
    this.db.prepare(
      `INSERT INTO perception_state
        (signal_id, signal_type, source_card_id, title,
         first_seen_at, last_seen_at, exposure_count, current_weight, state, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1.0, 'active', ?)`
    ).run(
      signal.signal_id,
      signal.signal_type,
      signal.source_card_id || null,
      signal.title || null,
      now, now,
      signal.metadata ? JSON.stringify(signal.metadata) : null,
    );
    return { signal_id: signal.signal_id, exposure_count: 1, current_weight: 1.0, state: 'active' };
  }

  /**
   * Should this signal be shown right now?
   * Returns false if dismissed, snoozed, dormant, or weight below threshold.
   */
  shouldShowPerception(signalId) {
    const state = this.getPerceptionState(signalId);
    if (!state) return true; // New signal — always show
    if (state.state === 'dismissed' || state.state === 'auto_resolved') return false;
    if (state.state === 'dormant') return false;
    if (state.state === 'snoozed' && state.snoozed_until && state.snoozed_until > nowISO()) return false;
    if (state.exposure_count >= 3) return false;
    if (state.current_weight < 0.3) return false;
    return true;
  }

  /**
   * Mark signal as acknowledged (snooze 7 days).
   */
  acknowledgePerception(signalId, snoozeDays = 7) {
    const now = new Date();
    const snoozedUntil = new Date(now.getTime() + snoozeDays * 86400000).toISOString();
    const result = this.db.prepare(
      `UPDATE perception_state SET
        state = 'snoozed',
        snoozed_until = ?,
        last_seen_at = ?
       WHERE signal_id = ?`
    ).run(snoozedUntil, now.toISOString(), signalId);
    return result.changes > 0;
  }

  /**
   * Mark signal as dismissed (permanent).
   */
  dismissPerception(signalId) {
    const now = nowISO();
    const result = this.db.prepare(
      `UPDATE perception_state SET
        state = 'dismissed',
        dismissed_at = ?,
        last_seen_at = ?
       WHERE signal_id = ?`
    ).run(now, now, signalId);
    return result.changes > 0;
  }

  /**
   * Mark signal as auto-resolved by LLM.
   */
  autoResolvePerception(signalId, memoryId, reason) {
    const now = nowISO();
    // Ensure row exists
    const existing = this.getPerceptionState(signalId);
    if (!existing) {
      // Create minimal row first
      this.db.prepare(
        `INSERT INTO perception_state
          (signal_id, signal_type, first_seen_at, last_seen_at, state)
         VALUES (?, 'unknown', ?, ?, 'active')`
      ).run(signalId, now, now);
    }
    const result = this.db.prepare(
      `UPDATE perception_state SET
        state = 'auto_resolved',
        resolved_by_memory_id = ?,
        resolved_by_llm = 1,
        resolution_reason = ?,
        dismissed_at = ?,
        last_seen_at = ?
       WHERE signal_id = ?`
    ).run(memoryId, reason, now, now, signalId);
    return result.changes > 0;
  }

  /**
   * Undo an auto-resolved perception — restore to active state.
   */
  restorePerception(signalId) {
    const now = nowISO();
    const result = this.db.prepare(
      `UPDATE perception_state SET
        state = 'active',
        resolved_by_memory_id = NULL,
        resolved_by_llm = 0,
        resolution_reason = NULL,
        dismissed_at = NULL,
        snoozed_until = NULL,
        exposure_count = 0,
        current_weight = 1.0,
        user_relevance = 1,
        last_seen_at = ?
       WHERE signal_id = ?`
    ).run(now, signalId);
    return result.changes > 0;
  }

  /**
   * List perception states matching filters.
   */
  listPerceptionStates(opts = {}) {
    const { state, type, limit = 100 } = opts;
    const conditions = [];
    const params = [];
    if (state) {
      if (Array.isArray(state)) {
        conditions.push(`state IN (${state.map(() => '?').join(',')})`);
        params.push(...state);
      } else {
        conditions.push('state = ?');
        params.push(state);
      }
    }
    if (type) {
      conditions.push('signal_type = ?');
      params.push(type);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM perception_state ${where} ORDER BY last_seen_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  /** Count perceptions by state */
  countPerceptions() {
    const rows = this.db.prepare(
      `SELECT state, COUNT(*) as c FROM perception_state GROUP BY state`
    ).all();
    const counts = { active: 0, snoozed: 0, dismissed: 0, dormant: 0, auto_resolved: 0 };
    for (const r of rows) counts[r.state] = r.c;
    return counts;
  }

  /**
   * Cleanup old dismissed/resolved signals (>90 days).
   */
  cleanupPerceptionState() {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const result = this.db.prepare(
      `DELETE FROM perception_state
       WHERE state IN ('dismissed', 'auto_resolved')
         AND (dismissed_at IS NULL OR dismissed_at < ?)`
    ).run(cutoff);
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close the database connection.  Safe to call multiple times.
   */
  close() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}

export default Indexer;
