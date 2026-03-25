/**
 * Knowledge Extractor for Awareness Local
 *
 * 2-layer extraction strategy:
 *   Layer 1: Agent pre-extracted insights (primary path, highest quality)
 *            The AI agent itself is the best LLM — it already understands context
 *   Layer 2: Rule engine fallback (zero LLM dependency)
 *            Multilingual regex patterns for when agents write without insights
 *
 * Supports 13 knowledge card categories:
 *   Engineering: problem_solution, decision, workflow, key_point, pitfall, insight
 *   Personal:    personal_preference, important_detail, plan_intention,
 *                activity_preference, health_info, career_info, custom_misc
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
// KnowledgeExtractor
// ---------------------------------------------------------------------------

export class KnowledgeExtractor {
  /**
   * @param {object} memoryStore - MemoryStore instance for file writes
   * @param {object} indexer     - Indexer instance for index updates
   */
  constructor(memoryStore, indexer) {
    this.store = memoryStore;
    this.indexer = indexer;
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
        cards.push({
          id: this._generateId('kc'),
          category: kc.category || 'key_point',
          title: kc.title || '',
          summary: kc.content || kc.summary || '',
          confidence: kc.confidence ?? 0.85,
          tags: kc.tags || metadata.tags || [],
          source_memory_id: metadata.id,
          created_at: new Date().toISOString(),
        });
      }
    }

    if (insights.action_items) {
      for (const item of insights.action_items) {
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
      (insights.risks?.length > 0)
    );
  }

  /**
   * Persist all extracted cards, tasks, and risks to disk.
   * @param {{ cards: object[], tasks: object[], risks: object[] }} result
   * @param {object} metadata
   */
  async _persistAll(result, metadata) {
    const promises = [];

    for (const card of result.cards) {
      card.source_memory_id = card.source_memory_id || metadata.id;
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
    if (summary.length <= 200) return summary;

    const cut = summary.slice(0, 200);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '...';
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
