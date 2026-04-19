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
 *
 * F-056 — prompt body below is composed from atomic templates in
 * `sdks/_shared/prompts/`. Each `<!-- SHARED:... BEGIN/END -->` block
 * is kept in sync by `scripts/sync-shared-prompts.mjs`. Edit the .md
 * files there, NOT the marker contents below. The outer template
 * literal (backticks) lets the sync script drop in multi-line
 * Markdown without breaking JS syntax.
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

  return `--- INSIGHT EXTRACTION REQUEST (local) ---

## Your Task
Review the conversation snippet below. Your job is **not** "generate cards for this turn" —
it is "identify the distilled essence worth recalling in 6 months on a fresh project".

Then call: awareness_record(action="submit_insights", insights=<json_result>)
If submit_insights fails, retry once; if it still fails, continue working.

## When to Extract (real insights)
<!-- SHARED:extraction-when-to-extract BEGIN -->
- The user **made a decision** — chose X over Y, with a stated reason
- A **non-obvious bug was fixed** — symptom + root cause + fix + how to avoid recurring
- A **workflow / convention was established** — ordered steps, preconditions, gotchas
- The user stated a **preference or hard constraint** — "I prefer X", "never do Y"
- A **pitfall was encountered and a workaround found** — trigger + impact + avoidance
- An **important fact about the user or project** surfaced for the first time
<!-- SHARED:extraction-when-to-extract END -->

## When NOT to Extract (raw logs — return empty cards array)
<!-- SHARED:extraction-when-not-to-extract BEGIN -->
- **Agent framework metadata**: content beginning with \`Sender (untrusted metadata)\`,
  \`turn_brief\`, \`[Operational context metadata ...]\`, \`[Subagent Context]\`, or wrapped
  inside \`Request:\` / \`Result:\` / \`Send:\` envelopes that only carry such metadata.
  Strip those wrappers mentally and judge what remains.
- **Greetings / command invocations**: "hi", "run tests", "save this", "try again".
- **"What can you do" / AI self-introduction turns**.
- **Code restatement**: code itself lives in git; only extract the *lesson* if one exists.
- **Test / debug sessions where the user is verifying the tool works** (including tests
  of awareness_record / awareness_recall themselves). A bug fix in those tools IS worth
  extracting as problem_solution; a raw "let me test if recall works" turn is not.
- **Transient status / progress updates** — "building...", "retrying...", "✅ done".

The single question to ask: **"If I start a fresh project 6 months from now, will being
reminded of this content materially help me?"** If not, do not emit a card.
Returning \`"knowledge_cards": []\` is a **first-class answer** — prefer it over fabricating
a card from low-signal content.
<!-- SHARED:extraction-when-not-to-extract END -->

## Existing Knowledge Cards (for dedup — do NOT recreate these)
${cardsJson}

## Content to Analyze
${contentSnippet}

## Per-card Required Scores
<!-- SHARED:extraction-scoring BEGIN -->
Every card you emit MUST carry three LLM self-assessed scores (0.0-1.0):

- \`novelty_score\`: how new is this vs known facts & existing cards?
  (restating an existing card = 0.1; a fresh decision = 0.9)
- \`durability_score\`: will this still matter in 6 months? (transient debug state = 0.1;
  architectural decision or user preference = 0.9)
- \`specificity_score\`: is there concrete substance — file paths, commands, error strings,
  version numbers, exact function names? (vague platitude = 0.1; reproducible recipe = 0.9)

The daemon will discard any card where \`novelty_score < 0.4\` OR \`durability_score < 0.4\`.
This is intentional — score honestly. Under-extraction is much better than noise.
<!-- SHARED:extraction-scoring END -->

## Daemon Quality Gate (self-check before you submit)
<!-- SHARED:extraction-quality-gate BEGIN -->
Drop the card rather than submit if it would fail any of these:

- **R1 length**: \`summary\` ≥ 80 chars (technical: decision / problem_solution
  / workflow / pitfall / insight / key_point); ≥ 40 chars (personal:
  personal_preference / important_detail / plan_intention /
  activity_preference / health_info / career_info / custom_misc).
- **R2 no duplication**: \`summary\` not byte-identical to \`title\`.
- **R3 no envelope leakage**: neither \`title\` nor \`summary\` starts with
  \`Request:\`, \`Result:\`, \`Send:\`, \`Sender (untrusted metadata)\`,
  \`[Operational context metadata\`, or \`[Subagent Context]\`.
- **R4 no placeholder tokens**: \`summary\` has no \`TODO\`, \`FIXME\`,
  \`lorem ipsum\`, \`example.com\`, or literal \`placeholder\`.
- **R5 Markdown on long summaries**: ≥ 200 chars → use bullets /
  \`inline code\` / **bold**. Soft.

**Recall-friendliness** — without these, a card is "accepted but
invisible" at retrieval time:

- **R6 grep-friendly title**: at least one concrete term you'd search
  for — product (\`pgvector\`), file (\`daemon.mjs\`), error, version,
  function (\`_submitInsights\`), project noun. Vague titles ("Decision
  made", "Bug fixed", "决定") score ~30 % precision@3.
  ❌ "Bug fixed"  ✅ "Fix pgvector dim 1536→1024 mismatch".
- **R7 topic-specific tags**: 3-5 tags, each a specific
  noun/product/concept. Never \`general\`, \`note\`, \`misc\`, \`fix\`,
  \`project\`, \`tech\`. ❌ \`["general","note"]\`  ✅ \`["pgvector","vector-db","cost"]\`.
- **R8 multilingual keyword diversity**: concepts that have both EN +
  CJK names → include BOTH in the summary at least once. Example:
  "用 \`pgvector\` 做向量数据库存储" matches queries in either language.

Rejected cards return in \`response.cards_skipped[]\`. R6-R8 are
warnings, not blocks — use them to self-critique before submitting.
<!-- SHARED:extraction-quality-gate END -->

## Per-category Shape (one-liner reference)
<!-- SHARED:category-overview BEGIN -->
Each line: shape | GOOD ✅ title | BAD ❌ title

- **decision** — choice + rejected alt + why + trade-off + revisit trigger. ✅ "Chose pgvector over Pinecone" ❌ "Decision made"
- **problem_solution** — symptom (quote error) + root cause + fix (file:line) + avoidance. ✅ "Fix pgvector dim 1536→1024 mismatch" ❌ "Bug fixed"
- **workflow** — trigger + prereqs + numbered steps + flags + gotchas + done-signal. ✅ "Deploy backend via docker compose" ❌ "Deploy workflow"
- **pitfall** — false assumption + trigger + impact + avoidance. ✅ "Never rebuild postgres in prod" ❌ "Be careful"
- **insight** — generalised pattern + scope + counter-scope + example. ✅ "Workers need different mutex than commands" ❌ "Learned something"
- **key_point** — the fact + why it matters + where it applies. ✅ "\`openclaw channels add\` enum: 9 specific IDs" ❌ "Important note"
- **personal_preference** — what + scope + concrete example. ✅ "Dark-mode solarized across IDEs" ❌ "UI preference"
- **activity_preference** — hobby/routine + trigger + frequency. ✅ "Weekend beef-noodle cooking" ❌ "Hobby"
- **important_detail** — fact + why it matters + how used. ✅ "Apple Team ID \`5XNDF727Y6\`" ❌ "Team info"
- **plan_intention** — plan + deadline + success metric. ✅ "Apply YC W27 by 2026-09-30" ❌ "Future plan"
- **health_info** — routine/condition + trigger + management. ✅ "10-min Pomodoro break for neck strain" ❌ "Health rule"
- **career_info** — role + background + company fact. ✅ "Founder of Awareness Memory, 10yr backend" ❌ "Background"
- **custom_misc** — specific noun. ✅ "Favourite brand colour \`#4a7882\` teal" ❌ "Color preference"
<!-- SHARED:category-overview END -->

## Skill Extraction (emit under \`insights.skills[]\`, not \`knowledge_cards\`)
<!-- SHARED:skill-extraction BEGIN -->
A \`skill\` is a **reusable procedure the user will invoke again** (e.g. "publish
SDK to npm", "regenerate golden snapshots after schema change"). Skills go in
\`insights.skills[]\`, NOT \`insights.knowledge_cards[]\`.

Emit a skill when ALL three hold:
1. The content describes a **repeated** procedure (2+ earlier cards mention
   the same steps, or the user explicitly says "this is our workflow for X").
2. There is a **stable trigger** you can name — the task / state that makes
   someone reach for this skill.
3. The steps are **executable without improvisation** — concrete files,
   commands, flags, verification signals. "Do it carefully" fails this bar.

Skip (return empty \`skills: []\`) for:
- Single debugging incidents → \`problem_solution\` card instead.
- Generic advice with no concrete steps.
- Configuration snapshots → \`important_detail\` card instead.

Required shape per skill:
\`\`\`json
{
  "name": "3-8 words, action-oriented (\\"Publish SDK to npm\\")",
  "summary": "200-500 chars of second-person imperative — pasteable into an agent prompt. Include WHY in one clause so the agent knows when to deviate.",
  "methods": [{"step": 1, "description": "≥20 chars, names a file/command/flag — no vague verbs"}],
  "pitfalls": ["One-line known failure mode + how to avoid it (e.g. 'npm mirror rejects publish — always pass --registry=https://registry.npmjs.org/')"],
  "verification": ["One-line post-run check (e.g. 'Run \`npm view <pkg> version\` — should match the bumped version')"],
  "trigger_conditions": [{"pattern": "When publishing @awareness-sdk/*", "weight": 0.9}],
  "tags": ["npm", "publish", "release"],
  "reusability_score": 0.0,
  "durability_score": 0.0,
  "specificity_score": 0.0
}
\`\`\`

MANDATORY content bars (daemon scores on 8 dims; skills below 28/40 are
hidden from active_skills[]):
- **≥ 1 pitfall** with a concrete avoidance — NOT "be careful"
- **≥ 1 verification** line with a checkable signal (command output, file
  exists, HTTP 200, etc.) — NOT "check that it worked"
- **Every step mentions a concrete token**: file path, command, flag,
  version number, or URL. "Update the config" fails; "Edit \`foo.json\` and
  bump \`version\` field" passes.
- ≥ 3 steps, ≥ 2 trigger patterns, 3-8 tags, all three scores ≥ 0.5.

Discard if these cannot be satisfied — emitting a vague skill pollutes the
TOC that future agents pick from.
<!-- SHARED:skill-extraction END -->

## Write Guide (category hints from awareness-spec.json)
${writeGuide || '(no additional guide loaded)'}

## Expected JSON Output
{
  "knowledge_cards": [
    {
      "category": "decision|problem_solution|workflow|key_point|pitfall|insight|personal_preference|important_detail|plan_intention|activity_preference|health_info|career_info|custom_misc",
      "title": "Declarative sentence naming the insight",
      "summary": "400-800 char wiki-style Markdown entry",
      "tags": ["optional", "topic", "tags"],
      "confidence": 0.85,
      "novelty_score": 0.8,
      "durability_score": 0.9,
      "specificity_score": 0.7,
      "salience_reason": "decision_made|error_fixed|preference_stated|pitfall_discovered|first_encounter|routine"
    }
  ],
  "skills": [
    {
      "name": "Publish SDK to npm",
      "summary": "200-500 char imperative guidance the agent pastes into a future prompt",
      "methods": [{"step": 1, "description": "Names a file, command, or verification"}],
      "trigger_conditions": [{"pattern": "When publishing ...", "weight": 0.9}],
      "tags": ["npm", "publish"],
      "reusability_score": 0.9,
      "durability_score": 0.85,
      "specificity_score": 0.9
    }
  ],
  "action_items": [{"title":"...","priority":"high|medium|low","status":"open"}],
  "risks": [{"title":"...","level":"high|medium|low","detail":"..."}]
}

All four arrays MAY be empty. An empty response is the correct answer when the
content is raw log, metadata, or a low-signal turn.
--- END EXTRACTION REQUEST ---`;
}
