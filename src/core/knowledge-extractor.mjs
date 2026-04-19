/**
 * Knowledge Extractor for Awareness Local
 *
 * 2-layer extraction strategy:
 *   Layer 1: Agent pre-extracted insights (primary path, highest quality)
 *            The AI agent itself is the best LLM — it already understands context
 *   Layer 2: Rule engine fallback (zero LLM dependency)
 *            Multilingual regex patterns for when agents write without insights
 *
 * Supports 14 formal knowledge card categories (mirrors cloud VALID_CATEGORIES):
 *   Engineering: problem_solution, decision, workflow, key_point, pitfall, insight, skill
 *   Personal:    personal_preference, important_detail, plan_intention,
 *                activity_preference, health_info, career_info, custom_misc
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTaskQuality, checkTaskDedup, validateCardQuality } from './lifecycle-manager.mjs';

// 0.7.3: salience post-process floors. The extraction prompt (see
// sdks/_shared/prompts/extraction-salience.md) instructs the client LLM
// to self-score each card on novelty/durability/specificity and warns
// that cards below these floors will be dropped server-side. Keep
// these aligned with the floors documented in the prompt.
const SALIENCE_NOVELTY_FLOOR = 0.4;
const SALIENCE_DURABILITY_FLOOR = 0.4;

// Valid knowledge card categories — dynamically loaded from awareness-spec.json
// with a hardcoded fallback for resilience (matches cloud backend VALID_CATEGORIES).
function loadValidCategories() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const specPath = path.join(__dirname, '..', '..', 'awareness-spec.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    if (spec.categories && Array.isArray(spec.categories)) {
      const names = new Set(spec.categories.map(c => c.name));
      names.add('risk'); // backward compat alias
      return names;
    }
  } catch {
    // Fall through to hardcoded defaults
  }
  return new Set([
    'problem_solution', 'decision', 'workflow', 'key_point', 'pitfall', 'insight',
    'personal_preference', 'important_detail', 'plan_intention', 'activity_preference',
    'health_info', 'career_info', 'custom_misc', 'risk', 'skill',
  ]);
}

const VALID_CATEGORIES = loadValidCategories();

/**
 * Structural quality gate for knowledge cards submitted by AI agents.
 *
 * Rejects cards that lack prose content — i.e. cards whose body, after
 * stripping fenced code blocks, contains no meaningful natural-language text.
 * This catches system metadata dumps (e.g. raw JSON payloads passed as content)
 * without inspecting or hardcoding any specific strings.
 *
 * Rules:
 *   1. Title + summary combined must contain at least MIN_PROSE_CHARS
 *      non-whitespace characters that are NOT inside a code fence.
 *   2. At least one "word" (≥2 Unicode letters/digits in a row) must exist
 *      outside of code fences.
 *
 * This is purely a structural check — it says nothing about whether the
 * content is correct or relevant.  Wrong-but-prose cards still pass;
 * correctness validation requires human review.
 */
// A card must have at least this many whitespace-separated prose tokens
// (after stripping code fences) to be considered structurally valid.
// This prevents pure system-metadata payloads (e.g. a raw JSON dump with a
// single-line label) from being stored as knowledge.
// Example failure: "Request: Sender (untrusted metadata):" → 4 tokens → rejected.
// Example pass:    "Plugin 升级超时修复: npm pack 只有 60s" → 7+ tokens → accepted.
const MIN_PROSE_TOKENS = 5;

export function isStructurallyValidKnowledgeCard(kc) {
  const title = String(kc.title || '').trim();
  const body  = String(kc.content || kc.summary || '').trim();

  // Strip fenced code blocks (``` ... ```) and inline code (` ... `) from body.
  // The title is kept as-is since it never contains code fences.
  const bodyProse = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').trim();

  // Must contain at least one word-like character somewhere.
  if (!/[\p{L}\p{N}]{2}/u.test(`${title} ${bodyProse}`)) return false;

  // Count UNIQUE prose tokens across title + body.
  // Using a Set eliminates repetition — sender-metadata cards repeat the same
  // label in both title and body, so their unique-token count stays low even
  // though their raw token count looks acceptable.
  const titleTokens  = title.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  const bodyTokens   = bodyProse.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  const uniqueTokens = new Set([...titleTokens, ...bodyTokens].map(w => w.toLowerCase()));

  if (uniqueTokens.size < MIN_PROSE_TOKENS) return false;

  return true;
}

/** Normalize a category string to a valid standard category.
 *  Only does case/whitespace normalization — no language-specific aliases.
 *  The MCP tool schema already enumerates valid categories so LLMs output them directly.
 */
function normalizeCategory(raw) {
  if (!raw) return 'key_point';
  const normalized = raw.trim().toLowerCase().replace(/[\s\-]+/g, '_');
  if (VALID_CATEGORIES.has(normalized)) return normalized;
  return 'key_point';
}

// Conflict detection thresholds for SQLite FTS5 trigram tokenizer.
// bm25() returns negative values — closer to 0 = better match.
// Trigram range is typically -0.1 to -3.0 (much narrower than PostgreSQL ts_rank).
const BM25_DUPLICATE_THRESHOLD = -1.0;  // rank > this → very close match, skip
const BM25_UPDATE_THRESHOLD = -2.0;     // rank > this → similar enough for evolution
// Vector cosine similarity thresholds (same as cloud backend)
const VECTOR_DUPLICATE_THRESHOLD = 0.95;
const VECTOR_UPDATE_THRESHOLD = 0.85;
const VECTOR_MERGE_THRESHOLD = 0.70;    // sim >= this + same category + tags overlap → merge content

// ---------------------------------------------------------------------------
// Multilingual regex patterns (NOT hardcoded to any single language)
// ---------------------------------------------------------------------------

/** Decision patterns: Chinese, English, Japanese */
const DECISION_PATTERNS = [
  /\b(decided?|decision|chose|选择了|决定|決定|決めた)\b/i,
  /\b(migrat(ed?|ion)|switched to|replaced|迁移|替换|切换)\b/i,
];

/** Problem/solution patterns */
const SOLUTION_PATTERNS = [
  /\b(fix(ed)?|resolved?|solved?|修复|解决|修正|直した)\b/i,
  /\b(bug|issue|error|problem|问题|バグ|エラー)\b/i,
];

/** Workflow/process patterns */
const WORKFLOW_PATTERNS = [
  /\b(step\s*\d|workflow|process|流程|步骤|手順)\b/i,
  /\b(first|then|finally|首先|然后|最后|まず|次に)\b/i,
];

/** Risk/warning patterns */
const RISK_PATTERNS = [
  /\b(risk|warning|caution|danger|注意|风险|リスク|危険)\b/i,
  /\b(careful|watch out|be aware|小心|警告)\b/i,
];

/** Task/TODO patterns */
const TASK_PATTERNS = [
  /^[\s]*[-*]\s*\[\s*\]/m,             // - [ ] unchecked checkbox
  /\b(TODO|FIXME|HACK|待办|要做)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true if two tag arrays share at least one tag. Handles JSON strings and plain arrays. */
function _hasTagOverlap(a, b) {
  const parse = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  };
  const setA = new Set(parse(a).map((t) => String(t).toLowerCase().trim()).filter(Boolean));
  return setA.size > 0 && parse(b).some((t) => setA.has(String(t).toLowerCase().trim()));
}

// ---------------------------------------------------------------------------
// KnowledgeExtractor
// ---------------------------------------------------------------------------

export class KnowledgeExtractor {
  /**
   * @param {object} memoryStore - MemoryStore instance for file writes
   * @param {object} indexer     - Indexer instance for index updates
   * @param {object} [embedderModule] - Optional embedder module ({ embed, cosineSimilarity, isEmbeddingAvailable })
   */
  constructor(memoryStore, indexer, embedderModule = null) {
    this.store = memoryStore;
    this.indexer = indexer;
    this._embedder = embedderModule;
  }

  // -------------------------------------------------------------------------
  // Main entry
  // -------------------------------------------------------------------------

  /**
   * Extract knowledge cards, tasks, and risks from memory content.
   *
   * @param {string}      content             - Raw memory content
   * @param {object}      metadata            - Memory metadata (id, tags, agent_role, etc.)
   * @param {object|null} preExtractedInsights - Agent-provided insights (Layer 1)
   * @returns {Promise<{ cards: object[], tasks: object[], risks: object[] }>}
   */
  async extract(content, metadata, preExtractedInsights = null) {
    let result;

    // Layer 1: Agent pre-extracted insights (95% of cases)
    if (preExtractedInsights && this._hasInsights(preExtractedInsights)) {
      result = this.processPreExtracted(preExtractedInsights, metadata);
    } else {
      // Skip rule engine for raw tool captures — they produce low-quality cards
      const skipTypes = new Set(['tool_use', 'code_change', 'session_checkpoint']);
      if (skipTypes.has(metadata?.type)) {
        result = { cards: [], tasks: [], risks: [] };
      } else {
        // Layer 2: Rule engine fallback (SDK/API writes without agent)
        result = this.extractByRules(content, metadata);
      }
    }

    // Persist extracted artifacts to disk + index
    await this._persistAll(result, metadata);

    return result;
  }

  // -------------------------------------------------------------------------
  // Layer 1: Process agent pre-extracted insights
  // -------------------------------------------------------------------------

  /**
   * Transform agent-provided insights into internal card/task/risk format.
   * The agent (Claude/GPT/Gemini/etc.) already did the hard extraction work
   * during the conversation — we just normalize the structure.
   *
   * @param {object} insights - { knowledge_cards?, action_items?, risks? }
   * @param {object} metadata - Parent memory metadata
   * @returns {{ cards: object[], tasks: object[], risks: object[] }}
   */
  processPreExtracted(insights, metadata) {
    const cards = [];
    const tasks = [];
    const risks = [];

    if (insights.knowledge_cards) {
      for (const kc of insights.knowledge_cards) {
        if (!isStructurallyValidKnowledgeCard(kc)) continue;

        // 0.7.3 salience gate: the LLM is asked to self-score each card
        // on three axes in the extraction prompt (see
        // sdks/_shared/prompts/extraction-salience.md). We discard cards
        // that score low — under-extraction is cheaper than a polluted
        // knowledge base. Missing scores are treated as "legacy LLM that
        // didn't follow the new prompt" and waved through with a warning.
        const novelty = typeof kc.novelty_score === 'number' ? kc.novelty_score : null;
        const durability = typeof kc.durability_score === 'number' ? kc.durability_score : null;
        if (novelty !== null && novelty < SALIENCE_NOVELTY_FLOOR) {
          console.log(`[extractor] dropping card "${(kc.title || '').slice(0, 60)}" — novelty_score=${novelty.toFixed(2)} < ${SALIENCE_NOVELTY_FLOOR}`);
          continue;
        }
        if (durability !== null && durability < SALIENCE_DURABILITY_FLOOR) {
          console.log(`[extractor] dropping card "${(kc.title || '').slice(0, 60)}" — durability_score=${durability.toFixed(2)} < ${SALIENCE_DURABILITY_FLOOR}`);
          continue;
        }

        cards.push({
          id: this._generateId('kc'),
          category: normalizeCategory(kc.category),
          title: kc.title || '',
          summary: kc.content || kc.summary || '',
          confidence: kc.confidence ?? 0.85,
          tags: kc.tags || metadata.tags || [],
          source: metadata.source || null,
          source_memory_id: metadata.id,
          created_at: new Date().toISOString(),
          novelty_score: novelty,
          durability_score: durability,
          specificity_score: typeof kc.specificity_score === 'number' ? kc.specificity_score : null,
          salience_reason: kc.salience_reason || null,
        });
      }
    }

    if (insights.action_items) {
      for (const item of insights.action_items) {
        // Quality gate: reject noise tasks
        const rejection = validateTaskQuality(item.title);
        if (rejection) continue;

        // Dedup gate: skip if similar open task exists
        if (this.indexer) {
          const { isDuplicate } = checkTaskDedup(this.indexer, item.title);
          if (isDuplicate) continue;
        }

        tasks.push({
          id: this._generateId('task'),
          title: item.title || '',
          description: item.description || '',
          priority: item.priority || 'medium',
          status: 'open',
          source_memory_id: metadata.id,
          created_at: new Date().toISOString(),
        });
      }
    }

    if (insights.risks) {
      for (const risk of insights.risks) {
        risks.push({
          id: this._generateId('risk'),
          title: risk.title || '',
          description: risk.description || '',
          severity: risk.severity || 'medium',
          source_memory_id: metadata.id,
          created_at: new Date().toISOString(),
        });
      }
    }

    // Collect completed_tasks for auto-completion processing
    const completedTasks = [];
    if (insights.completed_tasks) {
      for (const ct of insights.completed_tasks) {
        const taskId = (ct.task_id || '').trim();
        if (taskId) {
          completedTasks.push({ task_id: taskId, reason: ct.reason || '' });
        }
      }
    }

    return { cards, tasks, risks, completedTasks };
  }

  // -------------------------------------------------------------------------
  // Layer 2: Rule-based extraction (multilingual regex)
  // -------------------------------------------------------------------------

  /**
   * Extract knowledge using multilingual pattern matching.
   * This is the fallback when agents don't provide pre-extracted insights.
   *
   * @param {string} content  - Raw content text
   * @param {object} metadata - Parent memory metadata
   * @returns {{ cards: object[], tasks: object[], risks: object[] }}
   */
  extractByRules(content, metadata) {
    const cards = [];
    const tasks = [];
    const risks = [];

    if (!content || typeof content !== 'string') {
      return { cards, tasks, risks };
    }

    // Decision detection
    if (this.matchesPattern(content, DECISION_PATTERNS)) {
      cards.push(this.buildCard('decision', content, metadata));
    }

    // Problem/solution detection
    if (this.matchesPattern(content, SOLUTION_PATTERNS)) {
      cards.push(this.buildCard('problem_solution', content, metadata));
    }

    // Workflow detection (only if not already a decision — avoid double-tagging)
    if (this.matchesPattern(content, WORKFLOW_PATTERNS) && !this.matchesPattern(content, DECISION_PATTERNS)) {
      cards.push(this.buildCard('workflow', content, metadata));
    }

    // Task extraction
    tasks.push(...this.extractTasks(content, TASK_PATTERNS));

    // Risk extraction
    risks.push(...this.extractRisks(content, RISK_PATTERNS));

    return { cards, tasks, risks };
  }

  // -------------------------------------------------------------------------
  // Pattern matching
  // -------------------------------------------------------------------------

  /**
   * Test if content matches ANY pattern in the array.
   *
   * @param {string}   content  - Text to test
   * @param {RegExp[]} patterns - Array of regex patterns
   * @returns {boolean}
   */
  matchesPattern(content, patterns) {
    return patterns.some((p) => p.test(content));
  }

  // -------------------------------------------------------------------------
  // Card / Task / Risk builders
  // -------------------------------------------------------------------------

  /**
   * Build a knowledge card from matched content.
   *
   * @param {string} category - Card category (decision, problem_solution, workflow, etc.)
   * @param {string} content  - Full content text
   * @param {object} metadata - Parent memory metadata
   * @returns {object}
   */
  buildCard(category, content, metadata) {
    // Extract a meaningful title from the first non-empty line
    const firstLine = content.split('\n').find((l) => l.trim().length > 0) || '';
    const title = firstLine
      .replace(/^#+\s*/, '')    // strip markdown headers
      .replace(/^[-*]\s*/, '')  // strip list markers
      .slice(0, 100)
      .trim() || category;

    return {
      id: this._generateId('kc'),
      category,
      title,
      summary: this._extractSummary(content),
      confidence: 0.7,  // rule-based extraction has lower confidence than agent
      tags: metadata.tags || [],
      source_memory_id: metadata.id,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Extract TODO/checkbox tasks from content.
   *
   * @param {string}   content  - Text to scan
   * @param {RegExp[]} patterns - Task detection patterns
   * @returns {object[]}
   */
  extractTasks(content, patterns) {
    const tasks = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Unchecked Markdown checkbox: - [ ] task text
      const checkboxMatch = trimmed.match(/^[-*]\s*\[\s*\]\s*(.+)/);
      if (checkboxMatch) {
        tasks.push({
          id: this._generateId('task'),
          title: checkboxMatch[1].trim(),
          description: '',
          priority: 'medium',
          status: 'open',
          created_at: new Date().toISOString(),
        });
        continue;
      }

      // TODO/FIXME/HACK inline comments
      const todoMatch = trimmed.match(/\b(?:TODO|FIXME|HACK|待办|要做)[:\s]*(.+)/i);
      if (todoMatch) {
        tasks.push({
          id: this._generateId('task'),
          title: todoMatch[1].trim().slice(0, 200),
          description: '',
          priority: trimmed.match(/FIXME/i) ? 'high' : 'medium',
          status: 'open',
          created_at: new Date().toISOString(),
        });
      }
    }

    return tasks;
  }

  /**
   * Extract risk/warning items from content.
   *
   * @param {string}   content  - Text to scan
   * @param {RegExp[]} patterns - Risk detection patterns
   * @returns {object[]}
   */
  extractRisks(content, patterns) {
    const risks = [];

    if (!this.matchesPattern(content, patterns)) {
      return risks;
    }

    // Find lines containing risk keywords
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const isRiskLine = patterns.some((p) => p.test(trimmed));
      if (isRiskLine) {
        risks.push({
          id: this._generateId('risk'),
          title: trimmed
            .replace(/^[-*]\s*/, '')
            .replace(/^#+\s*/, '')
            .slice(0, 200)
            .trim(),
          description: '',
          severity: this._inferSeverity(trimmed),
          created_at: new Date().toISOString(),
        });
      }
    }

    return risks;
  }

  // -------------------------------------------------------------------------
  // Persistence: write extracted artifacts to disk + index
  // -------------------------------------------------------------------------

  /**
   * Save a knowledge card as a Markdown file and update the index.
   *
   * @param {object} card - Knowledge card object
   * @returns {Promise<string>} Filepath of the written card
   */
  async saveCard(card) {
    // F-058 bug B — the rule-based extractor path (extractByRules) bypassed
    // the F-055 R1-R5 quality gate, polluting the card store with
    // summary=title, <80-char, envelope-leaked cards. Apply the same gate
    // here so BOTH LLM-submitted and daemon-internal paths reject noise.
    const gate = validateCardQuality(card);
    if (!gate.ok) {
      console.warn(
        `[knowledge-extractor] Rejected rule-based card (${gate.reasons.join(', ')}): ${(card?.title || '').substring(0, 60)}`,
      );
      return null;
    }
    if (gate.warnings.length > 0) {
      console.warn(
        `[knowledge-extractor] Accepted with warnings (${gate.warnings.join(', ')}): ${(card?.title || '').substring(0, 60)}`,
      );
    }

    const categoryDir = this._categoryToDir(card.category);
    const filename = this._buildFilename(card.title, card.id);
    const filepath = path.join(categoryDir, filename);

    const content = this._cardToMarkdown(card);

    // Ensure directory exists
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write: tmp file + rename
    const tmpPath = filepath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filepath);

    // Update index
    if (this.indexer?.indexKnowledgeCard) {
      this.indexer.indexKnowledgeCard({
        id: card.id,
        category: card.category,
        title: card.title,
        summary: card.summary || '',
        source_memories: card.source_memory_id ? [card.source_memory_id] : [],
        confidence: card.confidence ?? 0.8,
        status: card.status || 'active',
        tags: card.tags || [],
        parent_card_id: card.parent_card_id || null,
        evolution_type: card.evolution_type || 'initial',
        created_at: card.created_at || new Date().toISOString(),
        filepath,
        content: card.summary || card.title || '',
      });
    }

    return filepath;
  }

  /**
   * Save a task as a Markdown file and update the index.
   *
   * @param {object} task - Task object
   * @returns {Promise<string>} Filepath of the written task
   */
  async saveTask(task) {
    const statusDir = task.status === 'done' ? 'tasks/done' : 'tasks/open';
    const awarenessDir = this._getAwarenessDir();
    const filename = this._buildFilename(task.title, task.id);
    const filepath = path.join(awarenessDir, statusDir, filename);

    const content = this._taskToMarkdown(task);

    // Ensure directory exists
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write
    const tmpPath = filepath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filepath);

    // Update index
    if (this.indexer?.indexTask) {
      this.indexer.indexTask({
        id: task.id,
        title: task.title,
        description: task.description || '',
        status: task.status || 'open',
        priority: task.priority || 'medium',
        agent_role: task.agent_role || null,
        created_at: task.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        filepath,
      });
    }

    return filepath;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Check if insights object has any meaningful data.
   * @param {object} insights
   * @returns {boolean}
   */
  _hasInsights(insights) {
    return (
      (insights.knowledge_cards?.length > 0) ||
      (insights.action_items?.length > 0) ||
      (insights.risks?.length > 0) ||
      (insights.completed_tasks?.length > 0)
    );
  }

  /**
   * Check if a new card conflicts with existing cards.
   * Uses BM25 (FTS5) as primary check, vector cosine as secondary.
   *
   * @param {object} card - The new card to check
   * @returns {Promise<{ verdict: 'new'|'duplicate'|'update', matchId?: string }>}
   */
  async _checkConflict(card) {
    if (!this.indexer?.searchKnowledge) {
      return { verdict: 'new' };
    }

    // Use title only for BM25 search — long title+summary phrases fail with
    // trigram tokenizer because quoted phrases require exact sequential match.
    const queryText = (card.title || '').trim();
    if (!queryText) return { verdict: 'new' };

    // Layer 1: BM25 full-text search
    try {
      const matches = this.indexer.searchKnowledge(queryText, { limit: 3 });
      if (matches.length > 0) {
        const best = matches[0];
        // SQLite FTS5 bm25() returns negative values — closer to 0 = better match
        const rank = best.rank ?? -999;
        if (rank > BM25_DUPLICATE_THRESHOLD) {
          return { verdict: 'duplicate', matchId: best.id };
        }
        if (rank > BM25_UPDATE_THRESHOLD) {
          // Only treat as update if new content is longer (has more info)
          const newLen = (card.summary || '').length;
          const oldLen = (best.summary || '').length;
          if (newLen > oldLen) {
            return { verdict: 'update', matchId: best.id };
          }
          return { verdict: 'duplicate', matchId: best.id };
        }
      }
    } catch (err) {
      console.warn(`[KnowledgeExtractor] BM25 conflict check failed:`, err.message);
    }

    // Layer 2: Vector cosine similarity (if embedder available)
    if (this._embedder) {
      try {
        const available = await this._embedder.isEmbeddingAvailable();
        if (available) {
          const newVec = await this._embedder.embed(queryText, 'passage');
          // Compare against recent active cards
          const recentCards = this.indexer.getRecentKnowledge?.(20) || [];
          let bestSim = 0;
          let bestMatchId = null;
          for (const existing of recentCards) {
            const existingText = `${existing.title} ${existing.summary || ''}`.trim();
            if (!existingText) continue;
            const existingVec = await this._embedder.embed(existingText, 'passage');
            const sim = this._embedder.cosineSimilarity(newVec, existingVec);
            if (sim > bestSim) {
              bestSim = sim;
              bestMatchId = existing.id;
            }
          }
          if (bestSim >= VECTOR_DUPLICATE_THRESHOLD) {
            return { verdict: 'duplicate', matchId: bestMatchId };
          }
          if (bestSim >= VECTOR_UPDATE_THRESHOLD && bestMatchId) {
            // Mirror backend logic: if new summary is not longer AND tags overlap,
            // merge into existing card instead of creating a new evolution card.
            // Prevents accumulation of barely-different evolution chains.
            const existingCard = recentCards.find((c) => c.id === bestMatchId);
            if (existingCard) {
              const newSummaryLen = (card.summary || '').length;
              const existingSummaryLen = (existingCard.summary || '').length;
              const tagsOverlap = _hasTagOverlap(card.tags, existingCard.tags);
              if (newSummaryLen <= existingSummaryLen && tagsOverlap) {
                return { verdict: 'merge', matchId: bestMatchId };
              }
            }
            return { verdict: 'update', matchId: bestMatchId };
          }
          // Same topic, related content — merge into existing card instead of creating new
          if (bestSim >= VECTOR_MERGE_THRESHOLD && bestMatchId) {
            const existingCard = recentCards.find((c) => c.id === bestMatchId);
            if (existingCard) {
              const sameCategory = (card.category || '') === (existingCard.category || '');
              const tagsOverlap = _hasTagOverlap(card.tags, existingCard.tags);
              if (sameCategory && tagsOverlap) {
                return { verdict: 'merge', matchId: bestMatchId };
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[KnowledgeExtractor] Vector conflict check failed:`, err.message);
      }
    }

    return { verdict: 'new' };
  }

  /**
   * Persist all extracted cards, tasks, and risks to disk.
   * @param {{ cards: object[], tasks: object[], risks: object[] }} result
   * @param {object} metadata
   */
  async _persistAll(result, metadata) {
    const promises = [];

    // Run conflict detection on each card before saving
    const cardsToSave = [];
    for (const card of result.cards) {
      card.source_memory_id = card.source_memory_id || metadata.id;
      const conflict = await this._checkConflict(card);
      if (conflict.verdict === 'duplicate') {
        console.log(`[KnowledgeExtractor] Skipping duplicate card '${card.title}' (matched: ${conflict.matchId})`);
        continue;
      }
      if (conflict.verdict === 'merge' && conflict.matchId) {
        try {
          const existing = this.indexer.db
            .prepare('SELECT id, title, summary FROM knowledge_cards WHERE id = ?')
            .get(conflict.matchId);
          if (existing) {
            const newSummary = existing.summary
              ? `${existing.summary}\n\n---\n${card.summary}`
              : card.summary;
            this.indexer.db
              .prepare('UPDATE knowledge_cards SET summary = ?, version = COALESCE(version, 1) + 1, last_touched_at = ?, synced_to_cloud = 0 WHERE id = ?')
              .run(newSummary, new Date().toISOString(), existing.id);
            console.log(`[KnowledgeExtractor] Merged '${card.title}' into '${existing.title}'`);
            continue;
          }
        } catch (err) {
          console.warn(`[KnowledgeExtractor] Merge failed for '${card.title}', saving as new:`, err.message);
        }
      }
      if (conflict.verdict === 'update' && conflict.matchId) {
        card.parent_card_id = conflict.matchId;
        card.evolution_type = 'update';
        // Supersede the old card
        this.indexer?.supersedeCard?.(conflict.matchId);
        console.log(`[KnowledgeExtractor] Evolving card '${card.title}' (supersedes: ${conflict.matchId})`);
      }
      cardsToSave.push(card);
    }

    for (const card of cardsToSave) {
      promises.push(this.saveCard(card).catch((err) => {
        // Log but don't fail the whole extraction
        console.warn(`[KnowledgeExtractor] Failed to save card ${card.id}:`, err.message);
      }));
    }

    for (const task of result.tasks) {
      task.source_memory_id = task.source_memory_id || metadata.id;
      promises.push(this.saveTask(task).catch((err) => {
        console.warn(`[KnowledgeExtractor] Failed to save task ${task.id}:`, err.message);
      }));
    }

    // Risks are stored as knowledge cards with category 'risk'
    for (const risk of result.risks) {
      const riskCard = {
        id: risk.id,
        category: 'risk',
        title: risk.title,
        summary: risk.description || risk.title,
        confidence: 0.6,
        tags: [],
        severity: risk.severity,
        source_memory_id: risk.source_memory_id || metadata.id,
        created_at: risk.created_at,
      };
      promises.push(this.saveCard(riskCard).catch((err) => {
        console.warn(`[KnowledgeExtractor] Failed to save risk ${risk.id}:`, err.message);
      }));
    }

    await Promise.all(promises);

    // Skill auto-evolution: check if new cards should evolve existing skills
    for (const card of cardsToSave) {
      try {
        await this._checkSkillEvolution(card);
      } catch (err) {
        // Non-critical, never block extraction
        console.warn(`[KnowledgeExtractor] Skill evolution check failed:`, err.message);
      }
    }

    // Auto-complete tasks identified by the LLM
    if (result.completedTasks && this.indexer) {
      for (const ct of result.completedTasks) {
        try {
          const existing = this.indexer.db
            .prepare('SELECT * FROM tasks WHERE id = ?')
            .get(ct.task_id);
          if (existing && existing.status !== 'done') {
            this.indexer.indexTask({
              ...existing,
              status: 'done',
              updated_at: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.warn(`[KnowledgeExtractor] Failed to auto-complete task ${ct.task_id}:`, err.message);
        }
      }
    }
  }

  /**
   * Check if a newly saved card should trigger evolution of an existing skill.
   * Two paths:
   *   1. Cloud-connected: call cloud API to trigger LLM re-synthesis (precise)
   *   2. Offline: lightweight append of new method step (immediate)
   */
  async _checkSkillEvolution(card) {
    if (!this.indexer?.db) return;

    const EVOLUTION_CATEGORIES = new Set(['workflow', 'problem_solution', 'pitfall', 'decision']);
    if (!EVOLUTION_CATEGORIES.has(card.category)) return;

    const cardTags = Array.isArray(card.tags) ? card.tags : [];
    if (cardTags.length < 2) return;

    const cardTagSet = new Set(cardTags.map(t => (t || '').toLowerCase().trim()).filter(Boolean));

    // Find skills with ≥2 tag overlap
    let skills;
    try {
      skills = this.indexer.db
        .prepare("SELECT id, name, summary, methods, tags, source_card_ids, updated_at FROM skills WHERE status = 'active'")
        .all();
    } catch { return; } // skills table might not exist

    if (!skills || skills.length === 0) return;

    const now = Date.now();
    const DEBOUNCE_MS = 3600_000; // 1 hour

    for (const skill of skills) {
      let skillTags;
      try { skillTags = JSON.parse(skill.tags || '[]'); } catch { skillTags = []; }
      const skillTagSet = new Set(skillTags.map(t => (t || '').toLowerCase().trim()).filter(Boolean));

      const overlap = [...cardTagSet].filter(t => skillTagSet.has(t));
      if (overlap.length < 2) continue;

      // Debounce: skip if updated within the last hour
      if (skill.updated_at) {
        const updatedMs = new Date(skill.updated_at).getTime();
        if (now - updatedMs < DEBOUNCE_MS) continue;
      }

      // Path 1: Try cloud API for LLM re-synthesis
      const cloudEvolved = await this._tryCloudSkillEvolution(skill, card);
      if (cloudEvolved) {
        console.log(`[KnowledgeExtractor] Skill '${skill.name}' evolved via cloud LLM (${overlap.length} tags overlap)`);
        continue;
      }

      // Path 2: Offline fallback — append new method step
      try {
        let methods;
        try { methods = JSON.parse(skill.methods || '[]'); } catch { methods = []; }
        const newStep = {
          step: methods.length + 1,
          description: `[Auto-evolved] ${card.title}: ${card.summary || ''}`,
        };
        methods.push(newStep);

        let sourceIds;
        try { sourceIds = JSON.parse(skill.source_card_ids || '[]'); } catch { sourceIds = []; }
        if (card.id && !sourceIds.includes(card.id)) {
          sourceIds.push(card.id);
        }

        this.indexer.db
          .prepare('UPDATE skills SET methods = ?, source_card_ids = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(methods), JSON.stringify(sourceIds), new Date().toISOString(), skill.id);

        console.log(`[KnowledgeExtractor] Skill '${skill.name}' evolved locally (appended step, ${overlap.length} tags overlap)`);
      } catch (err) {
        console.warn(`[KnowledgeExtractor] Local skill evolution failed for '${skill.name}':`, err.message);
      }
    }
  }

  /**
   * Try to evolve a skill via cloud API (LLM re-synthesis).
   * Returns true if cloud evolution succeeded, false otherwise (offline or error).
   */
  async _tryCloudSkillEvolution(skill, newCard) {
    try {
      // Check if cloud sync is configured
      const configPath = path.join(process.env.HOME || '', '.awareness', 'config.json');
      if (!fs.existsSync(configPath)) return false;

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const apiBase = config?.cloud?.api_base;
      const apiKey = config?.cloud?.api_key;
      const memoryId = config?.cloud?.memory_id;
      if (!apiBase || !apiKey || !memoryId) return false;

      // Call POST /skills/extract with the source cards + new card
      let sourceIds;
      try { sourceIds = JSON.parse(skill.source_card_ids || '[]'); } catch { sourceIds = []; }
      if (newCard.id && !sourceIds.includes(newCard.id)) {
        sourceIds.push(newCard.id);
      }

      // Use the skills extract endpoint with existing card IDs
      // Note: new card might not be in cloud yet, so we also pass it inline
      const url = `${apiBase}/memories/${memoryId}/skills/extract`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ card_ids: sourceIds.filter(id => id !== newCard.id) }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) return false;

      const data = await resp.json();
      const extracted = data.extracted || [];
      if (extracted.length === 0) return false;

      // Update local skill with cloud-synthesized result
      const evolved = extracted[0];
      this.indexer.db
        .prepare('UPDATE skills SET name = ?, summary = ?, methods = ?, tags = ?, trigger_conditions = ?, source_card_ids = ?, updated_at = ? WHERE id = ?')
        .run(
          evolved.name || skill.name,
          evolved.summary || skill.summary,
          JSON.stringify(evolved.methods || []),
          JSON.stringify(evolved.tags || []),
          JSON.stringify(evolved.trigger_conditions || []),
          JSON.stringify(sourceIds),
          new Date().toISOString(),
          skill.id,
        );

      return true;
    } catch {
      return false; // Cloud unavailable, fall through to offline path
    }
  }

  /**
   * Generate a unique ID with a type prefix.
   * @param {string} prefix - 'kc', 'task', or 'risk'
   * @returns {string}
   */
  _generateId(prefix) {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `${prefix}_${ts}_${rand}`;
  }

  /**
   * Extract a summary from content (first meaningful paragraph, max 200 chars).
   * @param {string} content
   * @returns {string}
   */
  _extractSummary(content) {
    if (!content) return '';

    // Skip headers and blank lines, find first content paragraph
    const lines = content.split('\n');
    const paragraphs = [];
    let current = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current) {
          paragraphs.push(current);
          current = '';
        }
        continue;
      }
      // Skip markdown headers for summary
      if (trimmed.startsWith('#')) continue;
      current += (current ? ' ' : '') + trimmed;
    }
    if (current) paragraphs.push(current);

    const summary = paragraphs[0] || '';
    return summary;
  }

  /**
   * Map card category to .awareness/ subdirectory.
   * @param {string} category
   * @returns {string}
   */
  _categoryToDir(category) {
    const awarenessDir = this._getAwarenessDir();
    const dirMap = {
      decision: 'knowledge/decisions',
      problem_solution: 'knowledge/solutions',
      workflow: 'knowledge/workflows',
      risk: 'knowledge/insights',
    };
    const subdir = dirMap[category] || 'knowledge/insights';
    return path.join(awarenessDir, subdir);
  }

  /**
   * Get the .awareness directory path from the memory store.
   * @returns {string}
   */
  _getAwarenessDir() {
    // MemoryStore exposes the awareness directory path
    if (this.store?.awarenessDir) return this.store.awarenessDir;
    if (this.store?.projectDir) return path.join(this.store.projectDir, '.awareness');
    return path.join(process.cwd(), '.awareness');
  }

  /**
   * Build a safe filename from title and ID.
   * @param {string} title
   * @param {string} id
   * @returns {string}
   */
  _buildFilename(title, id) {
    const date = new Date().toISOString().slice(0, 10);
    const slug = (title || id)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || id;
    return `${date}_${slug}.md`;
  }

  /**
   * Convert a knowledge card to Markdown with YAML front matter.
   * @param {object} card
   * @returns {string}
   */
  _cardToMarkdown(card) {
    const tags = Array.isArray(card.tags) ? card.tags : [];
    const frontMatter = [
      '---',
      `id: ${card.id}`,
      `category: ${card.category}`,
      `confidence: ${card.confidence ?? 0.7}`,
      `tags: [${tags.join(', ')}]`,
      card.source_memory_id ? `source_memory_id: ${card.source_memory_id}` : null,
      card.parent_card_id ? `parent_card_id: ${card.parent_card_id}` : null,
      card.evolution_type && card.evolution_type !== 'initial' ? `evolution_type: ${card.evolution_type}` : null,
      card.severity ? `severity: ${card.severity}` : null,
      `created_at: ${card.created_at || new Date().toISOString()}`,
      '---',
    ].filter(Boolean);

    return `${frontMatter.join('\n')}\n\n# ${card.title}\n\n${card.summary || ''}\n`;
  }

  /**
   * Convert a task to Markdown with YAML front matter.
   * @param {object} task
   * @returns {string}
   */
  _taskToMarkdown(task) {
    const frontMatter = [
      '---',
      `id: ${task.id}`,
      `priority: ${task.priority || 'medium'}`,
      `status: ${task.status || 'open'}`,
      task.source_memory_id ? `source_memory_id: ${task.source_memory_id}` : null,
      `created_at: ${task.created_at || new Date().toISOString()}`,
      '---',
    ].filter(Boolean);

    return `${frontMatter.join('\n')}\n\n# ${task.title}\n\n${task.description || ''}\n`;
  }

  /**
   * Infer risk severity from keyword intensity.
   * @param {string} text
   * @returns {string}
   */
  _inferSeverity(text) {
    if (/\b(danger|critical|危険|严重)\b/i.test(text)) return 'high';
    if (/\b(warning|caution|警告|注意)\b/i.test(text)) return 'medium';
    return 'low';
  }
}
