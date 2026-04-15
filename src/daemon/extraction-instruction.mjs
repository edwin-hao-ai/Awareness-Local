/**
 * extraction-instruction.mjs
 *
 * Builds a _extraction_instruction string for the local daemon — mirrors the
 * cloud backend's format_extraction_instruction() so that client LLMs (Claude,
 * OpenClaw, etc.) follow the same extraction loop locally.
 *
 * The local daemon is zero-LLM server-side. When awareness_record is called
 * WITHOUT pre-extracted insights, we return this instruction so the client's
 * own LLM does the extraction and calls submit_insights.
 */

/** Event types that are too low-level to extract knowledge cards from. */
const SKIP_EVENT_TYPES = new Set([
  'code_change',
  'tool_use',
  'session_checkpoint',
  'file_index',
  'code_index',
  'heartbeat',
]);

/** Minimum content length (chars) before we bother asking for extraction. */
const MIN_EXTRACTABLE_CHARS = 150;

/**
 * Decide whether this record call should trigger extraction.
 *
 * @param {object} params - awareness_record params
 * @returns {boolean}
 */
export function shouldRequestExtraction(params) {
  const { insights, event_type, content } = params;

  // Already has pre-extracted insights — no extraction needed
  if (insights && (
    (Array.isArray(insights.knowledge_cards) && insights.knowledge_cards.length > 0) ||
    (Array.isArray(insights.action_items) && insights.action_items.length > 0) ||
    (Array.isArray(insights.risks) && insights.risks.length > 0) ||
    (Array.isArray(insights.skills) && insights.skills.length > 0)
  )) {
    return false;
  }

  // Low-level event types produce noise, not knowledge
  if (SKIP_EVENT_TYPES.has(event_type)) {
    return false;
  }

  // Too short to be worth extracting
  const text = typeof content === 'string' ? content : JSON.stringify(content || '');
  if (text.length < MIN_EXTRACTABLE_CHARS) {
    return false;
  }

  return true;
}

/**
 * Format a plain-text extraction instruction for the client LLM.
 *
 * @param {object} opts
 * @param {string} opts.content     - The content that was just recorded
 * @param {string} opts.memoryId    - The memory ID that was created
 * @param {Array}  opts.existingCards - Recent knowledge cards for dedup context (max 8)
 * @param {object} opts.spec        - Loaded awareness-spec.json (for write_guide)
 * @returns {string}
 */
export function buildExtractionInstruction({ content, memoryId, existingCards = [], spec = {} }) {
  const writeGuide = spec?.init_guides?.write_guide || '';
  const cardsJson = existingCards.length > 0
    ? JSON.stringify(
        existingCards.slice(0, 8).map((c) => ({
          id: c.id,
          title: c.title || '',
          category: c.category || '',
          summary: c.summary || '',
        })),
        null,
        2,
      )
    : '[]';

  const contentSnippet = typeof content === 'string'
    ? content.slice(0, 4000)
    : JSON.stringify(content || '').slice(0, 4000);

  return (
    '--- INSIGHT EXTRACTION REQUEST (local) ---\n' +
    'Analyze the content below and extract structured knowledge.\n' +
    'Then call: awareness_record(action="submit_insights", insights=<json_result>)\n\n' +
    'IMPORTANT: If submit_insights fails, retry once. If it still fails, continue working.\n\n' +
    '## Extraction Guide\n' +
    (writeGuide || 'Extract knowledge_cards, action_items, and risks from the content.') + '\n\n' +
    '## HIGH_SALIENCE — always create cards for:\n' +
    '  [decision] choices made between alternatives\n' +
    '  [problem_solution] bugs found AND fixed\n' +
    '  [decision] previous approaches explicitly reversed\n' +
    '  [key_point] "never/always" rules stated\n' +
    '  [personal_preference] user likes/dislikes/style preferences — HIGH PRIORITY, write richly with scope and examples\n' +
    '  [important_detail] key personal facts about the user\n' +
    'For each card include: novelty_score (0.0-1.0 vs existing knowledge),\n' +
    'salience_reason: decision_made | error_fixed | approach_reversed | first_encounter | routine\n' +
    'Cards with novelty_score < 0.3 AND salience_reason="routine" → omit.\n\n' +
    '## Existing Knowledge Cards (for dedup — do NOT recreate these)\n' +
    cardsJson + '\n\n' +
    '## Content to Analyze\n' +
    contentSnippet + '\n\n' +
    '## CRITICAL: Summary Quality Requirements\n' +
    'Each card = a mini wiki entry. A reader 6 months from now must fully understand the topic from this card alone.\n' +
    'Minimum 200 characters, target 400-800. Use natural Markdown (bullets, `code`, **bold** for key terms).\n\n' +
    'Write naturally per category — do NOT force a rigid template:\n' +
    '- **decision**: what was chosen, alternatives considered, why this one won, trade-offs\n' +
    '- **problem_solution**: symptom, root cause, fix applied, files/commands involved\n' +
    '- **workflow**: steps in order, prerequisites, key config, gotchas\n' +
    '- **pitfall**: what went wrong, trigger conditions, workaround or avoidance\n' +
    '- **insight**: the pattern or learning, when it applies, concrete example\n' +
    '- **key_point**: the fact, why it matters, where it applies\n' +
    '- **personal_preference**: what the user prefers, scope, specific examples\n' +
    '- **important_detail**: the fact, why it matters, how to use it\n\n' +
    'Include specific file paths, error messages, version numbers, commands where relevant.\n' +
    'BAD: "Use pgvector instead of Pinecone"\n' +
    'GOOD: "Chose PostgreSQL **pgvector** over Pinecone for vector storage. Eliminates external dependency ($70/mo saved), co-locates vectors with relational data for JOIN-based hybrid search, supports IVFFlat + HNSW indexes. Trade-off: lower QPS at >10M vectors, acceptable at our <1M scale. Setup: `CREATE EXTENSION vector`, `memory_vectors` table with `vector(1536)`, cosine distance `<=>`.""\n\n' +
    'The summary is the primary content for vector search recall — more detail = better recall.\n\n' +
    '## Expected JSON Output\n' +
    '{\n' +
    '  "knowledge_cards": [{"category":"decision|problem_solution|workflow|key_point|pitfall|insight","title":"Descriptive declarative sentence","summary":"200-800 char wiki-style Markdown entry, naturally structured per category","tags":[],"confidence":0.85,"novelty_score":0.8,"salience_reason":"decision_made"}],\n' +
    '  "action_items": [{"title":"...","priority":"high|medium|low","status":"open"}],\n' +
    '  "risks": [{"title":"...","level":"high|medium|low","detail":"..."}]\n' +
    '}\n' +
    '--- END EXTRACTION REQUEST ---'
  );
}
