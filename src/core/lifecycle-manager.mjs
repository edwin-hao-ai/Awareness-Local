/**
 * Smart Lifecycle Manager — auto-resolve tasks/risks based on incoming content.
 *
 * When new content is recorded, this module:
 * 1. Task auto-resolve: word-overlap matching open tasks against new content, auto-completes high-confidence matches
 * 2. Risk auto-mitigate: FTS5 matches active risks (via knowledge_fts), marks as mitigated when content addresses them
 * 3. Garbage collector: archives stale low-quality tasks/risks past expiry threshold
 * 4. Task dedup: prevents duplicate task creation (exact match + word-overlap)
 *
 * Zero LLM. SQLite FTS5 for knowledge cards, JS word-overlap for tasks (no tasks_fts index).
 * Target: <30ms total.
 */

// Thresholds
const RISK_MITIGATE_RANK_THRESHOLD = -5.0;
const TASK_STALE_DAYS = 14;                  // Auto-archive tasks older than 14 days
const RISK_STALE_DAYS = 30;                  // Auto-archive risks older than 30 days
const TASK_MIN_TITLE_LENGTH = 15;            // Reject garbage tasks shorter than this
const TASK_RESOLVE_JACCARD_THRESHOLD = 0.35; // Word overlap threshold for task auto-resolve
const TASK_DEDUP_JACCARD_THRESHOLD = 0.50;   // Word overlap threshold for task dedup

// Patterns that indicate noise tasks (never should have been created)
const NOISE_TASK_PATTERNS = [
  /^er\s+news/i,
  /^hacker\s*news/i,
  /^request:\s/i,
  /^result:\s/i,
  /https?:\/\/\S+\s*$/,                     // Just a URL
  /^the\s+`\w+`\s+command/i,                // "The `curl` command..."
  /^\w+\s+is\s+(not\s+)?available/i,
];

// Keywords that indicate a task is being completed
const COMPLETION_SIGNALS = [
  'done', 'completed', 'finished', 'resolved', 'fixed', 'implemented',
  'deployed', 'merged', 'shipped', 'released', '完成', '已完成',
  '已修复', '已部署', '已实现', '已解决',
];

// Keywords that indicate a risk is being mitigated
const MITIGATION_SIGNALS = [
  'fixed', 'resolved', 'mitigated', 'patched', 'secured', 'handled',
  'addressed', '已修复', '已解决', '已处理', '已缓解',
];

/**
 * Run lifecycle checks after a record operation.
 * Fire-and-forget — errors are swallowed and logged.
 *
 * @param {Object} indexer - The SQLite indexer instance
 * @param {string} content - The newly recorded content
 * @param {string} title - Auto-generated or provided title
 * @param {Object} [insights] - Optional pre-extracted insights
 * @returns {{ resolved_tasks: string[], mitigated_risks: string[], archived: number, deduped: number }}
 */
export function runLifecycleChecks(indexer, content, title, insights) {
  const result = {
    resolved_tasks: [],
    mitigated_risks: [],
    archived: 0,
    deduped: 0,
  };

  if (!indexer?.db) return result;

  try {
    // 1. Garbage collection: clean up noise tasks and stale items
    result.archived = _garbageCollect(indexer);

    // 2. Task auto-resolve: match new content against open tasks
    result.resolved_tasks = _autoResolveTasks(indexer, content, title);

    // 3. Risk auto-mitigate: match new content against active risks
    result.mitigated_risks = _autoMitigateRisks(indexer, content, title);
  } catch (err) {
    console.warn('[lifecycle-manager] lifecycle check failed (non-fatal):', err.message);
  }

  return result;
}

/**
 * Check if a new task is a duplicate of an existing open task.
 * Call this BEFORE creating a task.
 *
 * @param {Object} indexer
 * @param {string} taskTitle
 * @returns {{ isDuplicate: boolean, existingTaskId?: string }}
 */
export function checkTaskDedup(indexer, taskTitle) {
  if (!indexer?.db || !taskTitle || taskTitle.length < 5) {
    return { isDuplicate: false };
  }

  try {
    const openTasks = indexer.db
      .prepare(`SELECT id, title FROM tasks WHERE status = 'open'`)
      .all();

    // Exact title match
    for (const task of openTasks) {
      if (task.title && task.title.toLowerCase() === taskTitle.toLowerCase()) {
        return { isDuplicate: true, existingTaskId: task.id };
      }
    }

    // Word-overlap similarity match (no tasks_fts index exists)
    const newWords = _tokenize(taskTitle);
    if (newWords.size === 0) return { isDuplicate: false };

    for (const task of openTasks) {
      const existingWords = _tokenize(task.title || '');
      const jaccard = _jaccardSimilarity(newWords, existingWords);
      if (jaccard >= TASK_DEDUP_JACCARD_THRESHOLD) {
        return { isDuplicate: true, existingTaskId: task.id };
      }
    }
  } catch {
    // query may fail
  }

  return { isDuplicate: false };
}

/**
 * Validate task quality before creation.
 * Returns rejection reason or null if acceptable.
 *
 * @param {string} taskTitle
 * @returns {string|null} rejection reason, or null if valid
 */
export function validateTaskQuality(taskTitle) {
  if (!taskTitle || typeof taskTitle !== 'string') {
    return 'empty_title';
  }

  const trimmed = taskTitle.trim();

  if (trimmed.length < TASK_MIN_TITLE_LENGTH) {
    return 'too_short';
  }

  for (const pattern of NOISE_TASK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'noise_pattern';
    }
  }

  // Check if title is just a URL
  if (/^https?:\/\//.test(trimmed) && !trimmed.includes(' ')) {
    return 'url_only';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Auto-resolve open tasks that match the new content.
 * Uses JS word-overlap (Jaccard) since tasks have no FTS5 index.
 */
function _autoResolveTasks(indexer, content, title) {
  const resolved = [];

  // Check if content contains completion signals
  const lowerContent = (content || '').toLowerCase();
  const hasCompletionSignal = COMPLETION_SIGNALS.some((s) => lowerContent.includes(s));
  if (!hasCompletionSignal) return resolved;

  const openTasks = indexer.db
    .prepare(`SELECT id, title, description FROM tasks WHERE status = 'open'`)
    .all();

  if (openTasks.length === 0) return resolved;

  // Tokenize content for word overlap matching
  const contentWords = _tokenize(`${title} ${content}`.substring(0, 500));
  if (contentWords.size === 0) return resolved;

  try {
    // Score each open task by word overlap with content
    const scored = openTasks
      .map((task) => {
        const taskWords = _tokenize(`${task.title || ''} ${task.description || ''}`);
        const jaccard = _jaccardSimilarity(contentWords, taskWords);
        return { ...task, jaccard };
      })
      .filter((t) => t.jaccard >= TASK_RESOLVE_JACCARD_THRESHOLD)
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, 3);

    for (const match of scored) {
      // Strong word overlap + completion signal = auto-resolve
      const existing = indexer.db.prepare('SELECT * FROM tasks WHERE id = ?').get(match.id);
      indexer.indexTask({
        ...existing,
        status: 'done',
        updated_at: new Date().toISOString(),
      });
      resolved.push(match.id);
    }
  } catch {
    // query may fail
  }

  return resolved;
}

/**
 * Auto-mitigate active risks that match the new content.
 * Uses knowledge_fts (FTS5 index on knowledge_cards).
 */
function _autoMitigateRisks(indexer, content, title) {
  const mitigated = [];
  const lowerContent = (content || '').toLowerCase();

  const hasMitigationSignal = MITIGATION_SIGNALS.some((s) => lowerContent.includes(s));
  if (!hasMitigationSignal) return mitigated;

  const searchText = `${title} ${content}`.substring(0, 500);
  const sanitized = _sanitizeFts(searchText);
  if (!sanitized) return mitigated;

  try {
    const riskCards = indexer.db
      .prepare(
        `SELECT kc.id, kc.title, kc.category, bm25(knowledge_fts) AS rank
         FROM knowledge_fts
         JOIN knowledge_cards kc ON kc.id = knowledge_fts.id
         WHERE knowledge_fts MATCH ?
           AND kc.status = 'active'
           AND kc.category IN ('pitfall', 'risk')
         ORDER BY rank
         LIMIT 3`
      )
      .all(sanitized);

    for (const card of riskCards) {
      if (card.rank < RISK_MITIGATE_RANK_THRESHOLD) {
        // Mark the risk card as resolved
        indexer.db
          .prepare(
            `UPDATE knowledge_cards SET status = 'resolved', updated_at = ? WHERE id = ?`
          )
          .run(new Date().toISOString(), card.id);
        mitigated.push(card.id);
      }
    }
  } catch {
    // FTS query may fail
  }

  return mitigated;
}

/**
 * Garbage collection: archive stale tasks and noise items.
 */
function _garbageCollect(indexer) {
  let archived = 0;

  try {
    // 1. Archive noise tasks (match noise patterns)
    const openTasks = indexer.db
      .prepare(`SELECT id, title FROM tasks WHERE status = 'open'`)
      .all();

    for (const task of openTasks) {
      const rejection = validateTaskQuality(task.title);
      if (rejection) {
        indexer.db
          .prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), task.id);
        archived++;
      }
    }

    // 2. Archive stale tasks (open for > TASK_STALE_DAYS)
    const taskCutoff = new Date(Date.now() - TASK_STALE_DAYS * 86400000).toISOString();
    const staleResult = indexer.db
      .prepare(
        `UPDATE tasks SET status = 'archived', updated_at = ?
         WHERE status = 'open' AND updated_at < ? AND created_at < ?`
      )
      .run(new Date().toISOString(), taskCutoff, taskCutoff);
    archived += staleResult.changes;

    // 3. Archive stale risk/pitfall cards (active for > RISK_STALE_DAYS, low confidence)
    const riskCutoff = new Date(Date.now() - RISK_STALE_DAYS * 86400000).toISOString();
    const staleRisks = indexer.db
      .prepare(
        `UPDATE knowledge_cards SET status = 'archived', updated_at = ?
         WHERE status = 'active'
           AND category IN ('pitfall', 'risk')
           AND confidence < 0.6
           AND updated_at < ?
           AND created_at < ?`
      )
      .run(new Date().toISOString(), riskCutoff, riskCutoff);
    archived += staleRisks.changes;
  } catch (err) {
    console.warn('[lifecycle-manager] garbage collection failed:', err.message);
  }

  return archived;
}

/**
 * Sanitize text for FTS5 MATCH query.
 * Removes special chars that would break FTS5 syntax.
 */
function _sanitizeFts(text) {
  if (!text) return '';

  return text
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')  // Keep word chars + CJK
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 2)
    .map((w) => w.toLowerCase())  // Lowercase to avoid FTS5 reserved words (NOT, AND, OR, NEAR)
    .slice(0, 10)  // Max 10 terms
    .join(' OR ');  // OR for broader matching
}

/**
 * Tokenize text into a Set of lowercase words (≥2 chars).
 * Handles Latin + CJK by splitting on non-word boundaries.
 */
function _tokenize(text) {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

/**
 * Jaccard similarity between two Sets of words.
 * Returns 0..1 (1 = identical).
 */
function _jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
