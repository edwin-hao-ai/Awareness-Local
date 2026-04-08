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
  created_at TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  synced_to_cloud INTEGER DEFAULT 0
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
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
                            source, status, tags, created_at, updated_at, content_hash, synced_to_cloud)
      VALUES (@id, @filepath, @type, @title, @session_id, @agent_role,
              @source, @status, @tags, @created_at, @updated_at, @content_hash, @synced_to_cloud)
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
        synced_to_cloud = excluded.synced_to_cloud
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
                                   evolution_type, created_at, filepath)
      VALUES (@id, @category, @title, @summary, @source_memories,
              @confidence, @status, @tags, @source, @parent_card_id,
              @evolution_type, @created_at, @filepath)
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
        filepath        = excluded.filepath
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
      created_at: card.created_at || now,
      filepath: card.filepath,
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

    const sql = `
      SELECT k.*, bm25(knowledge_fts) AS rank
      FROM knowledge_fts
      JOIN knowledge_cards k ON k.id = knowledge_fts.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ? OFFSET ?
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
