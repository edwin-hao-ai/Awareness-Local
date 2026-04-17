/**
 * extraction-instruction.mjs
 *
 * Builds a _extraction_instruction string for the local daemon. Mirrors the
 * cloud backend's format_extraction_instruction() so client LLMs (Claude,
 * OpenClaw, etc.) follow the same extraction loop locally.
 *
 * The local daemon is zero-LLM server-side. When awareness_record is called
 * WITHOUT pre-extracted insights, we return this instruction so the client's
 * own LLM does the extraction and calls submit_insights.
 *
 * 0.7.3 philosophy — "distilled essence, not raw logs":
 *   Borrowed from OpenClaw's native MEMORY.md design (see
 *   `~/.openclaw/workspace/MEMORY.md` + the `dreaming` cron in
 *   `openclaw/dist/dreaming-*.js`). The old prompt said "always create
 *   cards for …" and nudged the LLM into extracting every turn — even
 *   `Request: Sender (untrusted metadata)` framework-metadata blocks and
 *   bare user prompts ("test if recall works") ended up as
 *   problem_solution cards. The new prompt asks the LLM to FIRST decide
 *   whether the content is worth remembering six months from now, and
 *   treats an empty `knowledge_cards: []` array as a first-class answer.
 *
 *   Every card must self-score on three axes (novelty, durability,
 *   specificity). The daemon applies a post-process floor; see
 *   SALIENCE_FLOOR in knowledge-extractor.mjs.
 *
 *   We do NOT gate on character length. A 15-character user preference
 *   ("用户偏好中文") can be more valuable than a 5000-character log dump.
 *   The LLM is trusted to decide.
 */

/** Event types that are too low-level to ever produce knowledge cards. */
const SKIP_EVENT_TYPES = new Set([
  'code_change',
  'tool_use',
  'session_checkpoint',
  'file_index',
  'code_index',
  'heartbeat',
]);

/**
 * Decide whether this record call should trigger extraction.
 *
 * 0.7.3: removed the MIN_EXTRACTABLE_CHARS length gate. Short content can
 * be valuable (a one-line preference, a short decision statement) and
 * long content can be pure noise (a 10 KB stack trace). The LLM makes
 * the call; we only cut the obvious structural no-ops here.
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

  // Low-level event types produce noise, not knowledge.
  if (SKIP_EVENT_TYPES.has(event_type)) {
    return false;
  }

  // No body at all → nothing to extract.
  const text = typeof content === 'string' ? content : JSON.stringify(content || '');
  if (!text.trim()) {
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
    '\n' +
    '## Your Task\n' +
    'Review the conversation snippet below. Your job is **not** "generate cards for this turn" —\n' +
    'it is "identify the distilled essence worth recalling in 6 months on a fresh project".\n' +
    '\n' +
    'Then call: awareness_record(action="submit_insights", insights=<json_result>)\n' +
    'If submit_insights fails, retry once; if it still fails, continue working.\n' +
    '\n' +
    '## When to Extract (real insights)\n' +
    '- The user **made a decision** — chose X over Y, with a stated reason\n' +
    '- A **non-obvious bug was fixed** — symptom + root cause + fix + how to avoid recurring\n' +
    '- A **workflow / convention was established** — ordered steps, preconditions, gotchas\n' +
    '- The user stated a **preference or hard constraint** — "I prefer X", "never do Y"\n' +
    '- A **pitfall was encountered and a workaround found** — trigger + impact + avoidance\n' +
    '- An **important fact about the user or project** surfaced for the first time\n' +
    '\n' +
    '## When NOT to Extract (raw logs — return empty cards array)\n' +
    '- **Agent framework metadata**: content beginning with `Sender (untrusted metadata)`,\n' +
    '  `turn_brief`, `[Operational context metadata ...]`, `[Subagent Context]`, or wrapped\n' +
    '  inside `Request:` / `Result:` / `Send:` envelopes that only carry such metadata.\n' +
    '  Strip those wrappers mentally and judge what remains.\n' +
    '- **Greetings / command invocations**: "hi", "run tests", "save this", "try again".\n' +
    '- **"What can you do" / AI self-introduction turns**.\n' +
    '- **Code restatement**: code itself lives in git; only extract the *lesson* if one exists.\n' +
    '- **Test / debug sessions where the user is verifying the tool works** (including tests\n' +
    '  of awareness_record / awareness_recall themselves). A bug fix in those tools IS worth\n' +
    '  extracting as problem_solution; but a raw "let me test if recall works" turn is not.\n' +
    '- **Transient status / progress updates** — "building...", "retrying...", "✅ done".\n' +
    '\n' +
    'The single question to ask: **"If I start a fresh project 6 months from now, will\n' +
    'being reminded of this content materially help me?"** If not, do not emit a card.\n' +
    'Returning `"knowledge_cards": []` is a **first-class answer** — prefer it over\n' +
    'fabricating a card from low-signal content.\n' +
    '\n' +
    '## Existing Knowledge Cards (for dedup — do NOT recreate these)\n' +
    cardsJson + '\n' +
    '\n' +
    '## Content to Analyze\n' +
    contentSnippet + '\n' +
    '\n' +
    '## Per-card Required Scores\n' +
    'Every card you emit MUST carry three LLM self-assessed scores (0.0-1.0):\n' +
    '- `novelty_score`: how new is this vs known facts & existing cards above?\n' +
    '  (restating an existing card = 0.1; a fresh decision = 0.9)\n' +
    '- `durability_score`: will this still matter in 6 months? (transient debug state = 0.1;\n' +
    '  architectural decision or user preference = 0.9)\n' +
    '- `specificity_score`: is there concrete substance — file paths, commands, error strings,\n' +
    '  version numbers, exact function names? (vague platitude = 0.1; reproducible recipe = 0.9)\n' +
    '\n' +
    'The daemon will discard any card where `novelty_score < 0.4` OR `durability_score < 0.4`.\n' +
    'This is intentional — score honestly. Under-extraction is much better than noise.\n' +
    '\n' +
    '## Summary Quality (when you DO emit a card)\n' +
    'Each card = a mini wiki entry. A reader 6 months from now must fully understand the\n' +
    'topic from this card alone. Target 400-800 chars of natural Markdown (bullets, `code`,\n' +
    '**bold** for key terms, inline file paths, error strings). No rigid template — let the\n' +
    'category guide structure naturally:\n' +
    '- **decision**: what was chosen, alternatives considered, why this one won, trade-offs\n' +
    '- **problem_solution**: symptom, root cause, fix applied, files/commands involved\n' +
    '- **workflow**: steps in order, prerequisites, key config, gotchas\n' +
    '- **pitfall**: what went wrong, trigger conditions, workaround or avoidance\n' +
    '- **insight**: the pattern or learning, when it applies, concrete example\n' +
    '- **key_point**: the fact, why it matters, where it applies\n' +
    '- **personal_preference**: what the user prefers, scope, specific examples\n' +
    '- **important_detail**: key fact about the user/project, why it matters, how to use it\n' +
    '\n' +
    'GOOD: "Chose PostgreSQL **pgvector** over Pinecone for vector storage. Eliminates an\n' +
    '       external dependency ($70/mo saved), co-locates vectors with relational data for\n' +
    '       JOIN-based hybrid search, supports IVFFlat + HNSW. Trade-off: lower QPS past 10M\n' +
    '       vectors, acceptable at our <1M scale. Setup: `CREATE EXTENSION vector`, table\n' +
    '       `memory_vectors` with `vector(1536)`, cosine distance `<=>`."\n' +
    'BAD:  "Use pgvector instead of Pinecone."\n' +
    '\n' +
    '## Write Guide (category hints from awareness-spec.json)\n' +
    (writeGuide || '(no additional guide loaded)') + '\n' +
    '\n' +
    '## Expected JSON Output\n' +
    '{\n' +
    '  "knowledge_cards": [\n' +
    '    {\n' +
    '      "category": "decision|problem_solution|workflow|key_point|pitfall|insight|personal_preference|important_detail",\n' +
    '      "title": "Declarative sentence naming the insight",\n' +
    '      "summary": "400-800 char wiki-style Markdown entry",\n' +
    '      "tags": ["optional", "topic", "tags"],\n' +
    '      "confidence": 0.85,\n' +
    '      "novelty_score": 0.8,\n' +
    '      "durability_score": 0.9,\n' +
    '      "specificity_score": 0.7,\n' +
    '      "salience_reason": "decision_made|error_fixed|preference_stated|pitfall_discovered|first_encounter|routine"\n' +
    '    }\n' +
    '  ],\n' +
    '  "action_items": [{"title":"...","priority":"high|medium|low","status":"open"}],\n' +
    '  "risks": [{"title":"...","level":"high|medium|low","detail":"..."}]\n' +
    '}\n' +
    '\n' +
    'All three arrays MAY be empty. An empty response is the correct answer when the\n' +
    'content is raw log, metadata, or a low-signal turn.\n' +
    '--- END EXTRACTION REQUEST ---'
  );
}
