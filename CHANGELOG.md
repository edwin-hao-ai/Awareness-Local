# Changelog

## [0.9.9] - 2026-04-19

### Fixed — P1: cloud sync cards push silently 404'd on production
- v2 sync modules (`sync-push-optimistic`, `sync-pull-cards`,
  `sync-handshake`, `sync-conflict`) built endpoints starting with
  `/api/v1/…`. Production config ships `api_base =
  https://awareness.market/api/v1`, so the final URL double-prefixed
  to `https://awareness.market/api/v1/api/v1/…` → HTTP 404. Every
  user running sync on the default cloud endpoint saw recurring
  `[CloudSync] Card push failed: HTTP 404` lines and no card would
  ever sync to the cloud, even though memories / tasks / skills /
  documents did.
- Fix: strip the redundant `/api/v1` prefix from those four modules;
  match the convention already used by `sync-push.mjs`
  (`/memories/…` relative to `apiBase`). Test mocks updated to
  use production-shaped apiBase (`https://api.test/api/v1`) so the
  bug cannot re-enter.
- Regression guard: `test/sync-url-no-double-prefix.test.mjs`
  asserts each v2 URL contains exactly one `/api/v1/` segment.

### Fixed — P1: `/api/v1/workspaces` returned 450KB of 2600+ entries
- The handler returned the full `Record<path, entry>` map on every
  request. Power users who had navigated many projects accumulated
  multi-thousand-entry registries, ballooning the payload and
  slowing the AwarenessClaw Memory tab's initial load.
- Fix: accept `?limit=<N>` (capped at 500) and `?q=<substr>`. When
  either is present the response shape becomes
  `{ workspaces: [{ path, …entry }], total }`, sorted by
  `lastUsed` desc. With no params the legacy map shape is preserved
  (clients that hit the endpoint without params still work).
- Tests: `test/api-workspaces-pagination.test.mjs` — 4/4.

## [0.9.8] - 2026-04-19

### Fixed — P0: graph-embedder blocking Memory tab for 2+ minutes
- `generateSimilarityEdges` was fully synchronous. On workspaces with
  ~10K graph nodes (e.g. Awareness repo), the O(n²) comparison blocked
  the Node event loop for ~152 s. All concurrent HTTP / MCP requests
  (Memory tab knowledge loads, workspace switches, health checks)
  queued behind it, presenting as "the app is frozen".
- Fix: `generateSimilarityEdges` is now `async` and yields with
  `await setImmediate()` every `yieldEvery=50` outer-loop iterations.
  Total compute stays ≈ the same (~132 s for 10.9K nodes) but MCP
  calls issued during compute now return in ~1–4 s instead of 144 s,
  making the Memory tab responsive throughout. Callers that `await`
  `runGraphEmbeddingPipeline` already propagate correctly; one
  in-module caller updated to `await generateSimilarityEdges`.
- Tests: 17/17 `test/graph-embedder.test.mjs` green. Four test call
  sites updated from sync to `await`.

## [0.9.7] - 2026-04-19

### Fixed — CRITICAL: fresh npm install crash
- `submit_insights` and `apply_skill` imported `scripts/skill-quality-score.mjs`
  via a cross-directory relative path. The npm tarball's `files` whitelist
  did NOT include that particular script, so **any user on 0.9.6 would hit
  `Cannot find module '.../scripts/skill-quality-score.mjs'` on the first
  skill-related call**.
- Fix: moved the scorer into `src/daemon/skill-quality-score.mjs` (library
  copy). `scripts/skill-quality-score.mjs` keeps its CLI entry for dev use.
  No behaviour change — just unbroken imports.

## [0.9.6] - 2026-04-19

### Added — F-060 client-side HyDE + spec init_guides sync

- **HyDE support (`hyde_hint` parameter)** — client agents with their own
  LLM can now pass a hypothetical-answer string to `awareness_recall`.
  When provided, the daemon embeds the hint instead of the raw query so
  the semantic channel matches card summaries better. Purely opt-in; daemon
  itself never calls an LLM. Mirrored in both local daemon and cloud MCP.
- **`init_guides.search_guide`** now documents the HyDE field so Claude Code
  / OpenClaw agents learn to use it spontaneously. 3 spec copies synced.
- **Python SDK 3 pre-existing failures fixed** — `extraction_request` now
  hoisted to top-level on `client.record()` (was nested under `ingest`);
  `test_export_reader` updated to use current API (`_build_record_events`
  replaces the v2.0.0-removed `_coerce_history_to_events`). 126/126 pass.

## [0.9.5] - 2026-04-19

### Added — F-059 phase 3: recall accuracy lift

Recall eval on 12-card / 12-query fixture corpus:
- **Before**: Recall@1 58% · Recall@3 83% · MRR 0.725 · NDCG@3 0.722
- **After**:  Recall@1 58% · Recall@3 **100%** · MRR **0.778** · NDCG@3 **0.835**

Changes:
- **Card embeddings now stored** via new `card_embeddings` table (SQLite).
  Previously only raw memories had vectors; cards ingested via
  `submit_insights` had no semantic channel, fell back to FTS5 BM25 only.
  Search fuses memory + card vectors in one pass.
- **Default embedder switched to `Xenova/multilingual-e5-small`** (384-dim,
  118 MB). Same dim as previous MiniLM-L6-v2 → no schema change. Cross-
  lingual queries (CJK query → EN card) now get a real semantic bridge.
  Opt-out `AWARENESS_EMBEDDER=english` restores 23 MB MiniLM for English-
  heavy users.
- **Title×2 embed trick**: when embedding a memory/card, prepend title
  twice so the vector weights title tokens more (titles are the most
  query-aligned surface on small corpora).
- **RRF k: 60 → 10 (default)**. A 4-point grid search (k ∈ {10, 30, 60,
  100}) on our eval showed k=10 lifts Recall@3 from 83% to 100% while
  keeping Recall@1 stable. Small k gives top-ranked hits steeper RRF
  contribution, which matters for short limits (5-10) on personal-memory
  corpora. Classic k=60 is tuned for TREC-scale runs.
- **Env-configurable**: `AWARENESS_RRF_K` lets power users override.
- **New `scripts/rrf-k-sweep.mjs`**: re-runs the grid search end-to-end
  so future tuning can verify on a user's real corpus.

## [0.9.4] - 2026-04-19

### Added — F-059 phase 2: realtime task auto-close + personal_preference contradiction

- **Task auto-close on every record (no cron)**: `submit_insights` now runs
  `runLifecycleChecks` (hybrid BM25 + real-vector cosine + RRF), closes open
  tasks matched by completion-signal content. Previously only fired on
  `remember` action.
- **Real vector channel for auto-resolve**: new `task_embeddings` table caches
  task vectors on `indexTask`; lifecycle's "vector" channel now uses real
  cosine instead of Jaccard word-overlap proxy. Paraphrases like "fix npm
  ENEEDAUTH" now resolve open task "Investigate npm publish bug".
- **Personal preference contradiction supersedes old card**: `classifyCard`
  detects divergent identity tags (vim ↔ zed, macOS ↔ linux) on
  personal_preference / plan_intention / activity_preference / health_info /
  career_info cards and promotes them to `update` verdict (supersedes old).
  Also drops the classifier threshold from 0.70 → 0.50 for these categories
  because preference summaries are shorter.
- **Recall accuracy scorecard**: new `scripts/recall-accuracy-eval.mjs` seeds
  12 fixture cards + issues 12 golden-labeled queries, measures Recall@1 /
  Recall@3 / MRR / NDCG@3. Current baseline: **Recall@1 58% · Recall@3 83% ·
  MRR 0.725 · NDCG@3 0.722**.

### Tests
- `f059-personal-preference-evolution.test.mjs` — 3 scenarios (dedup, merge,
  contradiction supersede), all pass.

## [0.9.3] - 2026-04-19

### Added — F-059 skill growth stage + bidirectional card linkage

- **Skill self-growth (no cron)**: `skills.growth_stage` column (`seedling` → `budding` → `evergreen`).
  Promotion fires on every `submit_insights` and `apply_skill`:
  - `seedling → budding`: ≥ 2 `source_card_ids` AND rubric ≥ 20/40
  - `budding → evergreen`: ≥ 5 `source_card_ids` AND `usage_count` ≥ 2
  - Never demotes. No batch job — incremental evaluation per call.
- **Weighted, not hard-filtered**: `extractActiveSkills` ranks by `stage_weight × decay_score`
  (evergreen × 1.0 > budding × 0.6 > seedling × 0.3). In-progress skills still surface but
  bias towards mature ones.
- **Card ↔ Skill bidirectional link**: new `knowledge_cards.linked_skill_ids` column.
  Populated on skill insert/update so card hydration can show "skills that reference this card"
  without a reverse scan of all skills.
- **New `pitfalls[]` + `verification[]` skill columns**: persisted alongside methods.
  Rubric scorer now recognizes dedicated arrays (previously only regex-scanned free-text).
- **`apply_skill` hydration**: returns top-3 linked source cards (id + category + title + summary)
  so the LLM has supporting context, not just card IDs. Also returns `growth_stage` and
  `pitfalls`/`verification` arrays.

### Changed — extraction prompt (SSOT · 10 surfaces synced)
- Skill extraction prompt now mandates ≥ 1 concrete pitfall with avoidance, ≥ 1 verification
  signal with a checkable check, and every step naming a concrete token (file/command/flag/
  version). Vague skills are discarded.

### Fixed
- F-057 awk-extraction JSDoc terminator bug: new `f057-jsdoc-integrity.test.mjs` regression
  test scans every `.mjs` under `src/` for dangling `/**` without a matching `*/`.

## [0.9.2] - 2026-04-19

### Added — prepublish gate (blocks publish on SSOT drift)
- New `scripts/prepublish-gate.mjs` runs automatically on `npm publish`
  via `prepublishOnly`. Blocks the publish if:
  - `sdks/_shared/prompts/` has drifted from any of the 10 wired surfaces
    (F-056 parity)
  - `sdks/_shared/scripts/` has drifted from `awareness-memory` or
    `claudecode` copies (F-036 parity)
  - `awareness-spec.json` 3 copies (backend / local / setup-cli) aren't
    byte-identical
  - Any default `api_base` in `config.mjs` / `cloud-sync.mjs` /
    `daemon.mjs` contains `localhost` or `127.0.0.1`
- Prevents the "developer forgot to sync before publishing so users
  get stale prompts" failure mode.

### Fixed — card-quality-report reported `Skills: 0` incorrectly
- `scripts/card-quality-report.mjs` queried non-existent columns
  (`reusability_score`, `durability_score`, `specificity_score`) on
  the `skills` table, silently catching and returning `[]`.
- Real schema only has `decay_score` + `confidence`. Query fixed to
  select existing columns. Skills count now accurate.
- Also added `console.warn` when the skills query legitimately fails
  (older DB with no skills table), instead of silent swallow.

### Docs — CLAUDE.md covers cross-SDK prompt SSOT rules
- Added F-056 `_shared/prompts/` rule block alongside the existing
  F-036 `_shared/scripts/` rule.
- Added explicit note on **development vs runtime**: `_shared/` is
  development-time organisation; ship targets (`sdks/local/` etc)
  carry the injected content. Developers MUST sync before publish
  or users receive stale prompts. (The new prepublish gate enforces.)
- Added 3 new pre-publish check-list items (F-056 parity, 3-copy
  spec-json alignment).

## [0.9.1] - 2026-04-19

### Added — F-058 · card-quality-report (product-level eval tool)
- New `scripts/card-quality-report.mjs` — scores every active card in
  a real daemon database against the F-056 rubric (R1-R8). **The data
  is the user's own LLM's real extraction output**, because our
  architecture injects prompts into every surface (Claude Code /
  OpenClaw / ClawHub / MCP) and the user's LLM does the extraction.
- No API key needed. No LLM call. Just runs checks over stored cards.
- Surfaces per-source / per-category breakdown + worst-N cards so
  users can see which agents produce high-quality cards vs low.
- Invocation:
  ```bash
  npx -p @awareness-sdk/local node_modules/@awareness-sdk/local/scripts/card-quality-report.mjs
  # or
  cd <project> && node node_modules/@awareness-sdk/local/scripts/card-quality-report.mjs
  ```

### Why this matters
- Our product is **prompt injection at the surface** — every agent
  (OpenClaw plugin, Claude Code skill, ClawHub skill, MCP server) reads
  the shared F-056 SSOT prompt and has its own LLM do extraction.
- Real "is the prompt working?" feedback comes from the user's daemon
  data, not a benchmark we pre-run. `card-quality-report` is how that
  feedback loop closes.
- First real-user dogfooding surfaced: `Skills = 0` after many
  sessions — meaning although `skill-extraction` was wired to every
  surface, user LLMs never emitted any. That's a product gap worth
  investigating, not a claim we can hand-wave.

## [0.9.0] - 2026-04-19

### Added — F-056 Phase 2.5: recall-friendliness signals (R6-R8)
- Shared prompt SSOT now guides the extraction LLM on **what makes a
  card retrievable**, not just structurally valid:
  - **R6 grep-friendly title** — title must carry a concrete search term
    (product/file/function/error), not a vague "Decision made".
  - **R7 topic-specific tags** — 3-5 tags, stop-words banned
    (`general`, `note`, `misc`…).
  - **R8 multilingual keyword diversity** — cross-language concepts must
    appear in both EN + CJK form so queries in either language match.
- Per-category overview now carries **one GOOD + one BAD title example**
  per category (13 categories), letting the LLM mimic exact patterns.
- Pipeline lift target: precision@3 baseline 45.5 % → expected 55-60 %
  once LLMs actually follow the new signals. Raise the regression guard
  when real-user data confirms the lift.
- Extraction prompt size: 11.5 KB → **10.1 KB** after trimming (-12 %).

### Added — Web UI /search + multi-turn OpenClaw session quality tests
- `f056-web-ui-search.test.mjs` — 7 assertions covering the dashboard
  `/api/v1/search` endpoint: shape, precision@3 with distractors,
  distractor suppression, CJK query, field completeness.
- `f056-openclaw-session-quality.test.mjs` — 5-turn simulated OpenClaw
  session (EN + 中文 mix). Asserts envelope-strip holds every turn, pure
  pleasantries don't produce cards, and turn-5 recall surfaces turn-1
  decision card.

### Added — quantitative retrieval metrics with regression gates
- `f056-retrieval-metrics.test.mjs` — 11 queries across EN / 中文 / 日本語
  produce concrete numbers:
  - precision@3 = **45.5 %** (baseline ≥ 45 %)
  - recall@10 = **100 %** (baseline ≥ 70 %)
  - MRR = **0.689** (baseline ≥ 0.55)
- CI gates on regression, not on aspiration.

### Added — multilingual extraction fixture corpus
- 29 extraction eval cases × 3 languages (English / 中文 / 日本語) × 15
  card categories + 5 noise cases. Used by
  `f056-extraction-eval-offline.test.mjs` (static) and
  `scripts/eval-extraction.mjs --live` (real-LLM, opt-in).

### Added — 10th prompt-surface wire
- `sdks/awareness-memory/SKILL.md` now carries the 5 SSOT slots too;
  previous version only had a trivial example with the
  no-longer-existing `category:"architecture"`. ClawHub users now get
  the same extraction guidance as Claude Code / OpenClaw.

## [0.9.0-rc.1] - 2026-04-18

### Added — F-056 Phase 1+2: cross-SDK prompt SSOT
- New `sdks/_shared/prompts/*.md` — **6 atomic prompt templates** that
  are the single source of truth for every client LLM instruction:
  `extraction-when-to-extract`, `extraction-when-not-to-extract`,
  `extraction-scoring`, `extraction-quality-gate`, `category-overview`,
  `skill-extraction`. One concept per file, live-or-die rule (unwired
  templates get deleted).
- New `scripts/sync-shared-prompts.mjs` — fans the templates out into
  `<!-- SHARED:name BEGIN/END -->` slot markers across **all 9 surfaces**:
  local daemon extraction-instruction, shared recall.js record-rule,
  openclaw tools.ts step 4, Claude Code harness-builder (×2), Claude
  Code save/done SKILL.md, Python backend `extraction_v1.py` +
  `extraction_v2_pass2_synthesis.py`. Backtick-safe for JS/TS template
  literals, `--check` mode for CI parity.
- **Biggest effect for card quality**: skill extraction guidance was
  previously only on the backend — now wired into every client-LLM
  surface, so `insights.skills[]` actually gets populated from
  `awareness_record` flows.
- Runtime budget: ~9.2 KB extraction prompt (≈ 2.3K tokens), hard
  ceiling 12 KB enforced by test.

### Added — F-057 Phase 0: daemon refactor safety net
- New `sdks/local/test/f057-golden-mcp.test.mjs` — 10 shape-level
  golden contracts covering `awareness_init`, `_record` (plain,
  pre-extracted, envelope-only, oversized), `_recall`, `_lookup`
  (context + skills), `_mark_skill_used`. Refactor PRs that touch
  `daemon.mjs` must keep these green.

### Fixed — F-055 bug A: cross-topic persona pollution in `<who-you-are>`
- `awareness_init` no longer injects every recent `personal_preference`
  card into the rendered context. The old behavior meant a card like
  "user enjoys making beef noodle on weekends" leaked into unrelated
  sessions (e.g. a "debug daemon perf" query), corrupting the agent's
  focus.
- New gate (`helpers.filterPersonaByRelevance`): persona cards are
  injected only when **(a) BM25-relevant to the current focus query**
  or **(b) `confidence ≥ 0.9`** (high-signal long-term preferences).
  Empty query mode keeps only (b). Hard cap at 3 cards.

### Added — F-055 bug D: inbound knowledge card quality validator
- `_submitInsights` now runs each client-submitted card through
  `validateCardQuality` (in `core/lifecycle-manager.mjs`):
  - R1 length gate — `summary_too_short` (≥80 chars technical / ≥40
    chars personal-category)
  - R2 summary-equals-title dedup — `summary_equals_title`
  - R3 envelope defense — `envelope_pattern_in_content` (rejects
    `Request:`, `Sender (untrusted metadata):`, `[Operational context
    metadata …]`, `[Subagent Context]`)
  - R4 placeholder — `placeholder_content` (TODO, lorem ipsum,
    example.com)
  - R5 soft warning — `no_markdown_structure` on long plain-text
    summaries (logged, not blocked)
- Rejected cards appear in `response.cards_skipped[]` so the client can
  see why; other valid cards in the same batch still persist.

### Fixed — F-055 bug C1: aggregator pages stealing Top1 in recall
- `workspace_wiki` and `wiki_concept` auto-generated pages concatenate
  child-card titles + tags into their own embeddings, which made them
  out-rank source cards on direct-hit queries (observed 2026-04-18:
  "清汤牛肉面" → aggregator 36 % > recipe card 34 %).
- `unifiedCascadeSearch` now applies a `-0.10` RRF-score offset to
  items of type `workspace_wiki` / `wiki_concept` before shape. Direct
  hits again land at Top1; aggregators still appear in Top3-5 for
  concept-browse queries.

### Fixed — F-055 bug C2: perception pulling unrelated prior decisions
- `_buildPerception.related_decision` used to fire whenever any tag
  overlapped between the new card and an existing decision, which
  mis-matched cross-topic cards that happened to share a generic tag
  (observed 2026-04-18: recording a beef-noodle-recipe card pulled a
  pgvector-decision card).
- Now uses a **language-agnostic embedding cosine gate** via the new
  `isSemanticallyRelated({newText, candidateText}, {embedFn, cosineFn,
  threshold=0.55})` helper. Zero stop-word lists, zero per-language
  dictionaries — the E5-multilingual embedder handles 100+ languages
  out of the box. Graceful skip when the embedder is unavailable.

### Added — shared enum in `constants.mjs`
- New `PERSONAL_CARD_CATEGORIES` Set is the single source of truth for
  all personal-card categories. Used by `filterPersonaByRelevance`,
  `validateCardQuality`, and `buildInitResult`. Avoid inlining the
  category list elsewhere.

### Test coverage
- +110 new unit tests across 10 files:
  - `f055-persona-gate.test.mjs` — 12
  - `f055-persona-gate-perf.test.mjs` — 3 (10k persona load < 50 ms)
  - `f055-card-quality-gate.test.mjs` — 18
  - `f055-submit-insights-gate.test.mjs` — 4
  - `f055-aggregator-penalty.test.mjs` — 3
  - `f055-perception-tag-gate.test.mjs` — 10
  - `f055-defense-in-depth.test.mjs` — 6
  - `f055-extraction-prompt.test.mjs` — 6
  - `f056-extraction-prompt-quality.test.mjs` — 14
  - `f056-shared-prompts-parity.test.mjs` — 3
  - `f056-extraction-eval-offline.test.mjs` — 19
  - `f057-golden-mcp.test.mjs` — 10
- Updated 2 existing tests for new persona-gate behavior
  (`mcp-handlers.test.mjs`, `mcp-contract.test.mjs`) — explicit
  `confidence: 0.95` on persona fixtures.
- Guard detector tests switched to `await _buildPerception(...)` after
  the function became async (needed for embedding cosine gate).
- Full suite: **1128/1128 tests pass** (+23 over 0.8.2 baseline).

### Scope note
- F-055 bug A/C/D, F-056 Phase 1+2, F-057 Phase 0 — all landed
  together. F-055 bug B already shipped in
  `@awareness-sdk/openclaw-memory@0.6.14`. F-055b (AwarenessClaw
  desktop workspace) is code-only (DMG not rebuilt in this release).
- Backend Python prompts (`extraction_v1.py`,
  `extraction_v2_pass2_synthesis.py`) now use the SSOT markers but no
  behavioural change — same canonical text, just deduplicated.
- Live-LLM prompt-quality eval: `scripts/eval-extraction.mjs` (not in
  the default test run — needs an API key). Use it when tuning prompts.

## [0.8.2] - 2026-04-18

### Fixed — CJK/emoji project paths crashing memory saves (Windows + macOS)
- **User-reported bug**: Windows users with Chinese usernames (`C:\Users\张三\...`)
  and macOS users with localized workspace folders (`Awareness 文件夹`, `Project 🚀`)
  saw `记忆保存失败：Invalid character in header content ["X-Awareness-Project-Dir"]`
  on every `awareness_record` / `awareness_recall` / `awareness_init` call.
- **Root cause**: Node's `http.request()` rejects non-ISO-8859-1 bytes + control
  chars in raw header values and throws `TypeError` **synchronously** from the
  `http.request(...)` call site — which means the TypeError bypasses
  `req.on('error')` entirely and bubbles up as "memory save failed" in the UI.
  Affected every OS (not Windows-specific), just surfaces more often on Windows.
- **Fix (daemon side, backward-compatible)**:
  - `daemon.mjs::_handleRequest` now reads `X-Awareness-Project-Dir-B64` first
    (base64 of UTF-8 bytes), decodes it, and falls back to the legacy
    `X-Awareness-Project-Dir` header only when B64 is absent or malformed.
  - Legacy ASCII clients continue to work unchanged.
  - CORS `Access-Control-Allow-Headers` now permits the new B64 header.
  - The decoder ignores malformed base64 rather than returning 500.

### Added — regression tests
- `test/project-dir-header-decode.test.mjs` — 7 tests covering:
  ASCII plain, B64-CJK round-trip, emoji round-trip, B64-priority-over-legacy,
  malformed-B64 fallback, missing-header pass-through, mismatched-path rejection.
- All 1019 existing tests still pass (0 regressions).

### Client pairing
- This ships in tandem with `AwarenessClaw` desktop `memory-client.ts`
  `applyProjectDirHeader()` — ASCII paths keep the legacy header, CJK/emoji
  paths switch to B64, encoding failures silently degrade to "no header"
  instead of crashing. See `AwarenessClaw/packages/desktop/CHANGELOG.md`.

## [0.8.1] - 2026-04-18

### Fixed — AwarenessClaw desktop envelope leaking into card titles
- **User-reported bug**: screenshot audit showed knowledge-card titles
  literally starting with `Request: 你现在能做什么?` — the OpenClaw-style
  `Request: <user>\nResult: <assistant>` envelope from AwarenessClaw
  desktop's chat turn_briefs was leaking straight into auto-generated
  card titles.
- **Root cause**: `daemon._remember()` called `classifyNoiseEvent()` to
  decide skip-or-keep, but NEVER called `cleanContent()` (defined in
  `noise-filter.mjs:109`) to actually strip the envelope. So the raw
  `Request:` prefix survived into (a) auto-title derivation
  (first sentence of content), (b) SQLite FTS index, (c) vector embed,
  and (d) LLM extraction prompt — which then produced cards with the
  envelope prefix in the title field.
- **Fix**: `_remember()` now runs `cleanContent()` after the noise-reason
  check. The sanitized content is used for title auto-gen, persistence,
  FTS indexing, embedding, and extraction.

### Added — tests + scorecard
- `test/remember-envelope-strip.test.mjs` — 7 unit tests (4 on cleanContent
  regex + 3 on daemon._remember integration path). All pass.
- `test/remember-envelope-scorecard.test.mjs` — realistic 8-turn
  AwarenessClaw batch, measures:
  - Clean titles:      8/8 = 100%
  - Clean contents:    8/8 = 100%
  - Body preserved:    8/8 = 100%
  - Token savings:     14.3% (45/315 tokens saved)
  - Composite score:   9.95 / 10.00

### Regression
- sdks/local full suite: 1023 tests, 1018 pass, 5 skipped, 0 fail
  (+7 new vs 0.8.0 baseline).

### Compatibility
- Pure daemon-side fix, no schema change, no new API. AwarenessClaw
  desktop keeps sending the same `Request:/Result:` envelope — daemon
  now silently strips it before persistence. No client update required.

## [0.8.0] - 2026-04-18

### Added — single-parameter recall/record (F-053 Phase 1+2)
- **`awareness_recall(query)` and `awareness_record(content)` are now real
  single-parameter APIs.** The daemon decides scope, detail, recall mode,
  token-tier shape, and action — not the caller. Example:
  `awareness_recall({ query: "why did we choose pgvector?" })` just works.
- **Legacy multi-parameter clients keep working** (8-week deprecation
  window). Passing `semantic_query`, `keyword_query`, `detail`, `ids`,
  `scope`, `recall_mode`, `multi_level`, `cluster_expand`, `action`,
  etc. still returns results, but logs a rate-limited
  `[deprecated param used] <name>` warning so migration signal surfaces
  without log spam.
- **Token-budget drives the raw-vs-card mix automatically.**
  Sub-20K budgets → compressed card summaries; 20K-50K → mixed
  top-3 raw + top-5 card; 50K+ → raw-heavy verbatim (MemPalace-style).
- **Three-source cascade under the hood.** `unifiedCascadeSearch` fuses
  memory + knowledge-card + workspace-graph hits via RRF with opacity —
  callers cannot tell which channel produced a result.

### Changed — retrieval defaults (post-benchmark evidence)
- **Default embedder flipped from `all-MiniLM-L6-v2` (English-only, 23 MB)
  to `multilingual-e5-small` (100+ langs, 118 MB).** Same English quality
  (+2pp MTEB) with usable Chinese/Japanese/Korean/etc. The 95 MB extra
  one-time download is worth it for anyone outside pure English.
  Backwards-compat: the search engine is now model-aware — existing
  `all-MiniLM` embeddings continue to recall via their own query vector;
  new writes use multilingual. No forced reindex.
- **Default rerank flipped from `fusion` to `none`.** Internal benchmark
  (20Q LongMemEval) showed the fusion formula dropping R@5 from 90% to
  60% — it mixes growth_stage / card_type / recency signals that help
  card retrieval but hurt long-document session retrieval.
  Users who want fusion can still opt in via `RERANK_METHOD=fusion`.

### Added — benchmarking infrastructure
- New `benchmarks/longmemeval/run_f053_daemon_path.mjs` drives
  `unifiedCascadeSearch` end-to-end on LongMemEval_S. Unlike the existing
  Python runner (which independently re-implements RRF), this exercises
  the actual daemon retrieval path. Flags: `--limit=N`, `--stratified=N`
  (every question type × N), `--phase3` (enable archetype routing),
  `--budget=N`.
- New L5 mutation-testing baseline doc lives at
  `docs/features/f-053/L5_MUTATION_BASELINE.md` — target score ≥ 80%,
  first Stryker run due 2026-07-17.

### Internal
- L1 guards added: `verify-recall-single-param-guard.mjs` pins the MCP
  schema `required` field; `verify-query-router-no-hardcode.mjs` fails
  CI if the Phase 3 classifier grows any keyword hard-code.
- 1000 test suite green in `sdks/local/`; 169 green in `openclaw/`;
  84 green in `setup-cli/`. Zero regressions.
- Phase 3 archetype-routing code is on main but disabled by default
  (feature-flag via daemon config) while we wait for a card-heavy
  benchmark that can quantify its lift. LongMemEval alone can't measure
  Phase 3 because the haystack is pure raw sessions with no knowledge
  cards — shape is mathematically a no-op when one bucket is empty.

### Web UI
- **Web UI search now benefits from Phase 3 query-type routing.** The REST
  endpoints `/api/v1/search` (used by the main memory search, the Cmd+K
  panel, and the onboarding recall-suggestions card) and
  `/api/v1/memories/search` previously bypassed Phase 3 by calling
  `search.recall(...)` with the old multi-parameter shape. They now hit
  `unifiedCascadeSearch` on the primary path, so recency channel,
  budget-tier bucket shaping, and cross-encoder rerank are active for
  everyone — not just MCP `awareness_recall` callers. Pre-Phase-3 daemons
  fall back to the legacy `recall` path transparently.
  - New optional `budget` query param lets operators tune the raw/card
    mix per request (default 20000 = mixed tier).
  - New L1 guard `scripts/verify-web-search-cascade-aligned.mjs` fails
    CI if either handler regresses.
- `renderMd()` now tolerates JSON-injected content where `\n` was
  encoded as a literal backslash-n pair (common when `awareness_record`
  is invoked from a shell with double-escaped JSON). Markdown renders
  correctly without requiring callers to fix their escape layer.

### Fixed — stringified `insights` no longer rejected (2026-04-18 bug)
- **Root cause**: some MCP clients (observed in Claude Code with large
  `insights` payloads) serialize nested object arguments as JSON strings
  on the wire. The old stdio schema declared `insights: { type: 'object' }`
  with `required: ['action']` — client-side Zod validation then rejected
  the call with `-32602 Input validation error: expected object, received
  string` before the request ever reached the daemon.
- **Fix** (three layers):
  1. `sdks/claudecode/mcp-stdio.cjs` (sync'd to `sdks/awareness-memory/`)
     — schema now matches F-053 (`required: ['content']` /
     `required: ['query']`) and `insights` drops its strict `type`
     declaration so wire-stringified payloads pass validation.
  2. `mcp-stdio.cjs` `proxyToolCall` now calls `normalizeToolArgs`,
     which auto-parses stringified `insights` / `items` / `tags` /
     `ids` / `source_exclude` before forwarding to the daemon.
  3. Daemon `tool-bridge.mjs` applies the same `normalizeStructuredArgs`
     defense on the `awareness_record` path — so even clients that skip
     the stdio bridge (direct HTTP to `/mcp`) get the same safety net.
- **New L1 guard** `scripts/verify-mcp-stdio-schema-aligned.mjs` pins
  the F-053 single-param schema + permissive insights shape across both
  stdio entry points, preventing schema drift.
- **New L2 tests** lock the behavior: `sdks/local/test/tool-bridge-normalize.test.mjs`
  (7 tests) and `sdks/claudecode/test-mcp-stdio-normalize.cjs` (11 tests).

### Fixed — Web UI + Onboarding search aligned to Phase 3 cascade (2026-04-18)
- The REST endpoints `/api/v1/search` and `/api/v1/memories/search` now
  route through `unifiedCascadeSearch` as their primary path. This closes
  the gap where the MCP `awareness_recall` path had Phase 3 query-type
  auto routing + recency channel + budget-tier shaping but the Web UI
  (`index.html` line 1972 main search, line 2891 Cmd+K panel) and the
  onboarding "try recall" card (`recall-suggestions.js` line 103) were
  silently falling back to the old `search.recall` path.
- Optional `?budget=N` query parameter (default 20000) lets callers pick
  the raw/card mix tier without editing code.
- New L1 guard `scripts/verify-web-search-cascade-aligned.mjs`.
- New L2 tests `sdks/local/test/api-hybrid-search.test.mjs` (10 tests
  covering primary path, budget forwarding, result unwrap, legacy
  fallback, L3 chaos, FTS-only fallback, empty-query short-circuit).

### Test totals (2026-04-18)
- `sdks/local` unit suite: **1016 total / 1011 pass / 5 skipped / 0 fail**
  (up from 994 pre-fix; +17 new tests from this release).
- 5 L1 guards all green:
  `verify-recall-single-param-guard.mjs`,
  `verify-query-router-no-hardcode.mjs`,
  `verify-backend-zero-llm.mjs`,
  `verify-web-search-cascade-aligned.mjs`,
  `verify-mcp-stdio-schema-aligned.mjs`.
- Multi-turn recall scorecard: **10.00 / 10.00** (unchanged across three
  regression runs).

### Known limitations carried over
- Cloud sync still uses the legacy multi-parameter surface internally
  (retargets to single-param in a follow-up).
- Phase 4 promotion cron is designed (`PHASE_4_DESIGN.md`) but not
  implemented — waiting on multi-week usage data to validate the
  promote/archive thresholds.

## [0.7.3] - 2026-04-17

### Fixed — memory quality (shipping the OpenClaw "distilled essence" philosophy)
- **Polluted knowledge cards no longer pass the noise filter**. Pre-0.7.3 the
  `classifyNoiseEvent` hard-block list (`Sender (untrusted metadata)`,
  `[Operational context metadata ...]`, `[Subagent Context]`, …) was matched
  against the raw content via `startsWith`, but the OpenClaw plugin wraps its
  turn payloads in `Request: <metadata>` / `Result: <metadata>` envelopes. The
  envelope prefix made every framework-metadata block slip past the filter
  and end up as a `problem_solution` card titled `"Request: Sender
  (untrusted metadata): { label: AwarenessClaw Desktop... }"`. Fix:
  `SYSTEM_METADATA_PREFIXES` is now matched against both the raw trim and a
  copy with the `Request:` / `Result:` / `Send:` / `Received:` / `User:` /
  `Assistant:` / `Tool:` envelope stripped. `turn_brief` and `[turn_brief`
  variants added to the prefix list. Real user requests that merely start
  with `Request:` still pass — only framework-metadata payloads are blocked.
- **Extraction is salience-aware, not greedy**. The old prompt told the client
  LLM "HIGH_SALIENCE — always create cards for …", which drove it to emit a
  `problem_solution` card for every turn that had any content at all —
  including bare user prompts like "test if recall works". The new prompt
  borrows the OpenClaw native `MEMORY.md` philosophy (*distilled essence, not
  raw logs*): the LLM is first asked whether the content is worth recalling
  six months from now, and `knowledge_cards: []` is a **first-class answer**.
- **Per-card salience scores**. Every emitted card must now carry three
  LLM self-assessed scores (0.0-1.0): `novelty_score`, `durability_score`,
  `specificity_score`. The daemon discards any card where
  `novelty_score < 0.4` or `durability_score < 0.4` before insertion. Missing
  scores (legacy LLM clients) are waved through for compatibility.
- **No more character-length gate**. Dropped the old
  `MIN_EXTRACTABLE_CHARS = 150` hard-coded floor. A 15-character user
  preference can be more valuable than a 5000-character log dump — the LLM is
  trusted to judge value on substance, not size.

### Added
- **`sdks/_shared/prompts/extraction-salience.md`** — canonical single source of
  truth for the extraction philosophy. All 10 extraction surfaces (see
  `Awareness/CLAUDE.md` → "Skill / MCP 工具变更必须全表面同步") now carry the
  same natural-language guidance. A future
  `scripts/verify-extraction-prompt-parity.mjs` will gate CI on parity.
- **`sdks/local/scripts/clean-noise-cards.mjs`** — one-shot audit tool that
  re-runs the 0.7.3 noise filter against every active card. Cards matching
  framework-metadata patterns are archived (not deleted; fully reversible via
  `UPDATE knowledge_cards SET status='active'`). Supports `--dry-run` and
  `--db PATH`. Run once per upgrade to clean up pre-0.7.3 pollution.
- **Backend extraction prompts updated** (`extraction_v1.py`): backend is
  zero-LLM — this file is a template the backend hands back to the client's
  LLM. Same salience-aware framing now lives there too so cloud users see the
  same behavior change as local users.

### Synced surfaces (10 of 10 for extraction guidance)
1. `backend/awareness/prompts/extraction_v1.py`
2. `backend/awareness-spec.json → init_guides.write_guide`
3. `sdks/local/src/daemon/extraction-instruction.mjs`
4. `sdks/_shared/scripts/recall.js` (record-rule)
5. `sdks/claudecode/scripts/harness-builder.mjs` (fallback record-rule)
6. `sdks/awareness-memory/scripts/harness-builder.mjs` (mirror of #5)
7. `sdks/openclaw/src/tools.ts` (workflow step 4)
8. `sdks/claudecode/skills/save/SKILL.md`
9. `sdks/claudecode/skills/done/SKILL.md`
10. `sdks/_shared/prompts/extraction-salience.md` (canonical)

The v2 two-pass synthesis prompt (`extraction_v2_pass2_synthesis.py`) is still
on the legacy framing and will be synced in 0.7.4.

## [0.7.2] - 2026-04-17

### Fixed — memory recovers after 0.7.0 regression
- **Missing `local_id` / `updated_at` columns on `knowledge_cards`** — commit `7bc6f0da` introduced `SELECT ... local_id FROM knowledge_cards` for cloud-sync v2 optimistic pushes but shipped without an `ALTER TABLE` migration. Every upgraded user saw `_pushCardsV2 query failed: no such column: local_id` and `[lifecycle-manager] garbage collection failed: no such column: updated_at` on each sync tick. 0.7.2 adds an idempotent migration that backfills both columns on first open (`local_id = id`, `updated_at = created_at`). Old DBs heal themselves on restart.
- **Daemon crash on some npm installs** — `@modelcontextprotocol/sdk` was declared as `^1.27.0` (caret). When npm's dedup logic hoisted parts of the SDK to top-level `node_modules` while leaving `mcp.js` nested, the ESM relative import of `./completable.js` broke with `ERR_MODULE_NOT_FOUND`. Now pinned to `1.29.0` to stabilise the dedup outcome.
- **"database connection is not open" log flood on shutdown** — periodic `CloudSync.fullSync()` ran via unawaited `setInterval` callbacks. When `stop()` was called the interval was cleared, but in-flight syncs still hit the SQLite handle after the daemon closed it. `stop()` is now async and awaits the in-flight promise before returning; the interval body short-circuits once `_stopped` is set.

### Added — bounded index.db growth
- **Graph edge cap + VACUUM job** — workspace scanner was writing unbounded `doc_reference` edges (observed 31k nodes → 611k edges → 750 MB DB on a real user). New daily `indexer.pruneGraphEdges({ maxPerNode: 50 })` keeps the top-50 edges per node by weight and triggers `VACUUM` when the prune removes >1000 rows. First run is deferred 60 s after daemon start.
- **L1 schema-column parity guard** — `scripts/verify-schema-columns.mjs` spins up an in-memory SQLite, runs `initSchema()`, and verifies every column referenced by `SELECT/INSERT/UPDATE` statements in the rest of the codebase actually exists. Wired into the root `ship-gate.sh`.
- **L2 migration forward-compat test** — `test/migration-forward-compat.test.mjs` builds a pre-0.7.2 schema, opens it with the new `Indexer`, and asserts `_pushCardsV2`-shaped queries + lifecycle-manager GC UPDATEs no longer throw.
- **L3 shutdown-race chaos test** — `test/cloud-sync-shutdown-race.test.mjs` pins the async-`stop()` contract: awaits in-flight, tolerates `"not open"` rejections, no-ops any queued tick.
- **L4 clean-tempdir daemon-boot E2E** — `test/e2e/user-journeys/clean-tempdir-daemon-boot.spec.mjs` does a real `npm pack` + install into a fresh tempdir, spawns the daemon, and asserts `/healthz` + `/mcp tools/list` both return 200.

## [0.7.1] - 2026-04-16

### Changed
- **Embedding model installation**: @huggingface/transformers is now installed via postinstall script to ensure vector search works out of the box. The package is now a required dependency instead of optional, guaranteeing users get full embedding functionality upon installation.

## [0.7.0] - 2026-04-16

### Added
- **Per-request project isolation** — requests carrying `X-Awareness-Project-Dir` header are validated against the daemon's current `projectDir`. Mismatched requests return 409 `project_mismatch` instead of silently operating on the wrong project.
- **Project-switching guard** — while `switchProject()` is in progress, all incoming requests are rejected with 503 `project_switching`. `_switching` flag is reset in a `finally` block to prevent deadlock.
- **CORS update** — `X-Awareness-Project-Dir` added to `Access-Control-Allow-Headers`.

## [0.6.8] - 2026-04-16

### Changed
- **Category-aware natural prompts** — replaced the rigid WHAT/WHY/HOW/CONTEXT/EVIDENCE template with per-category guidance (decision→alternatives+trade-offs; problem_solution→symptom+fix+files; personal_preference→preference+scope+examples). LLMs now write naturally structured Markdown entries.
- **All SDK surfaces aligned** — extraction quality guidance synchronized across local daemon, awareness-spec.json write_guide, record-rule injection, harness-builder fallback, OpenClaw tools.ts, and Claude Code SKILL.md.

## [0.6.7] - 2026-04-16

### Added
- **Skill outcome validation (F-043)** — `awareness_mark_skill_used` now accepts `outcome` parameter (success/partial/failed). Outcomes adjust decay score, confidence tracking, and consecutive failure counting. 3+ consecutive failures auto-flag skill as `needs_review`.
- **SQLite migration** — `confidence` (REAL DEFAULT 1.0) and `consecutive_failures` (INTEGER DEFAULT 0) columns added to skills table.

### Changed
- **Wiki-style knowledge cards** — extraction prompts now produce rich 200-800 char Markdown entries instead of one-sentence summaries. Each category (decision, problem_solution, personal_preference, etc.) has natural structure guidance, no rigid template.
- **Removed all summary truncation** — 22 `.slice()`/`[:N]` truncations removed across daemon, indexer, reranker, and mcp-handlers. Summary is the primary vector search content; truncation destroyed recall quality.
- **Higher relevance threshold** — `CARD_RELEVANCE_THRESHOLD` raised from 0.3 to 0.5 to filter noise. Context injects max 8 cards (was 20) with progressive reduction under token budget.
- **Card evolution** — UPDATE and CONTRADICTION paths now merge old card content instead of discarding, with anti-nesting protection.
- **Category-aware minimum length** — personal categories (30 chars min), technical categories (100 chars min) enforced before card storage.

## [0.6.6] - 2026-04-15

### Changed
- **Local daemon now returns `_extraction_instruction` when insights are missing** — `awareness_record` on the local daemon now mirrors the cloud MCP flow. When a caller submits rich content without pre-extracted insights, the daemon returns a structured extraction instruction so the client LLM can extract cards/tasks/risks and submit them back with `submit_insights`.
- **Knowledge card writes are now compatible with salience metadata** — the SQLite upsert path accepts `novelty_score` and `salience_reason` without breaking older callers that do not send those fields. This fixes write failures in recall, wiki, cloud-sync, and alignment scenarios after the salience-aware schema expansion.
- **Device-auth links are hardened in both onboarding and the Sync panel** — the UI now prefers `verification_url` when present, shows a retry state on upstream 502s, and defangs unsafe schemes like `javascript:` to `about:blank` instead of opening a broken or dangerous URL.

### Tested
- `bash scripts/ship-gate.sh` — passed (L1 guards, `sdks/local` integration suite, AwarenessClaw desktop Vitest coverage, L3 device-auth failure tests, L4 zero-mock journeys).
- `node --test test/f031-alignment.test.mjs`
- `node --test test/session-context-recall.test.mjs test/recall-context-comparison.test.mjs test/memory-store-compat.test.mjs`

## [0.6.5] - 2026-04-15

### Changed
- **Salience-aware extraction guidance**: bundled `awareness-spec.json` now includes HIGH_SALIENCE signals and `novelty_score`/`salience_reason` fields in `write_guide`. Local daemon users now receive the same extraction quality improvements as cloud MCP users.

## [0.6.4] - 2026-04-15

### Added — Skill export (F-032 extension)
- **`GET /api/v1/skills/<id>/export?format=skillmd`** — downloads the
  skill as an OpenClaw / Claude Code compatible `SKILL.md` file.
  Response includes `Content-Type: text/markdown`, `Content-Disposition:
  attachment; filename="<slug>.skill.md"`.
- **Dashboard download icon (💾)** on each skill card in the Wiki →
  Skills view. One click → browser saves `<slug>.skill.md`.
- **Spec-compliant formatter** (`src/core/skill-md-formatter.mjs`):
  frontmatter is exactly `name` + `description` (no extra keys, per
  Claude/OpenClaw spec research). Description is pushy ("Does X. Use
  when …"). Body uses imperative-voice section headings chosen to
  match our data shape (`## When to use this skill` + `## How to apply`
  numbered list with optional `(use <tool>)` hints).
- 16 unit tests for the formatter (slug sanitization, description
  length cap, frontmatter key parity, empty-section handling).
- 3 zero-mock user-journey specs (happy / 404 / 400) proving the real
  browser download experience.

### Process (ship-gate methodology in action)
- Wrote `docs/features/f-032-skills-export/ACCEPTANCE.md` BEFORE
  coding, including research notes from fetching
  `anthropics/skills` and `openclaw/openclaw` real SKILL.md files.
- `verify-endpoints.mjs` (L1) caught the new route automatically.
- Zero-mock journey spec added to `test/e2e/user-journeys/`.
- `scripts/ship-gate.sh` green before publish.

## [0.6.3] - 2026-04-15

### Fixed
- **Switching workspaces no longer jumps to a dead port** — `switchWorkspace()` always POSTs `/workspace/switch` to the current daemon instead of navigating to a per-project port from the legacy `~/.awareness/workspaces.json`. Stale ports (37801/37802/…) no longer break the picker.
- **Status chip now flips to "Cloud synced" within ~300 ms** of a successful cloud connect. Listens for a new `awareness:cloud-changed` custom event the onboarding flow dispatches after `Auth.connect()` succeeds. Also refreshes on window focus so returning from the auth browser tab just works.
- **Onboarding Step 5 auto-skips when cloud is already connected** — checks `/api/v1/sync/status`'s `cloud_enabled` and jumps straight to Done. Fixes "I already connected — why am I being asked again?"
- **Dashboard sidebar now shows ~30 topics, not 1** — `/api/v1/topics` used to fall back to tag-hotness only when **no** MOC existed. With even one MOC present the fallback was suppressed and all other tag-based themes disappeared. Now MOCs + unique tag topics are merged (dedup by tag name).

### Added — shipping gate methodology
- `CLAUDE.md` gains a full "上线门禁方法论：5 层测试金字塔" section (Testing Trophy + chaos + mutation + zero-mock journey). Same methodology appended to `AwarenessClaw/CLAUDE.md`.
- `scripts/verify-endpoints.mjs` — fails CI on any `fetch('/api/v1/..')` that has no matching server route. Caught a drift in this very PR (`/cloud/status` → `/sync/status`).
- `scripts/verify-buttons.mjs` — fails CI on any orphan `data-action` button (the exact class of bug that broke Step 5 skip in 0.6.1).
- `scripts/verify-zero-mock.mjs` — forbids `page.route`, `page.routeFromHAR`, and mock helpers in `test/e2e/user-journeys/` specs.
- `scripts/ship-gate.sh` — one-command L1+L2+L3+L4 runner, intended to block `npm publish` and prod deploys.
- `.githooks/pre-push` + `git config core.hooksPath .githooks` — runs L1 + zero-mock + shared-scripts sync on every `git push`. Emergency bypass: `git push --no-verify`.
- `docs/features/onboarding-and-telemetry/ACCEPTANCE.md` — Given/When/Then per user journey with 1:1 mapping to each spec file.
- `test/e2e/user-journeys/` (new folder, zero-mock policy enforced):
  - `first-time-visit.spec.mjs`
  - `switch-workspace.spec.mjs` (pins Bug A fix)
  - `status-chip-reflects-cloud.spec.mjs` (pins Bug B fix)
  - `recall-returns-real-results.spec.mjs`

### Tested
- 887 unit + 4 user-journey E2E (zero-mock) + 26 legacy E2E — all green.
- Ship-gate passes on main.

## [0.6.2] - 2026-04-15

### Fixed
- **`undefined?code=undefined` opens in the browser when cloud backend is unreachable** — `cloud-http.mjs` used to resolve with the raw HTML 502 body on non-2xx statuses. Downstream destructuring read all fields as `undefined`, then the onboarding `startDeviceAuth` built a bogus link. Non-2xx responses now reject with a clear `HTTP <status> <url> — <preview>` error so the onboarding catches it and shows the Retry banner instead.
- 5 new unit tests in `test/cloud-http.test.mjs` pin this contract (200/204/500/502 + header forwarding).

## [0.6.1] - 2026-04-15

### Fixed
- **Step 5 Cloud: header "skip, finish" button was a no-op** — the button rendered but had no click wiring. Every step using `header()` with `onSkipAll` now calls the new `wireHeader()` helper, so orphan buttons can't happen again.
- **Step 3 Recall hit the phantom `/api/v1/recall` endpoint** — switched to the real daemon endpoint `GET /api/v1/search?q=…&limit=…`. A regression test pins the URL so this can't drift silently.
- **CLI no longer spawns a second daemon on a new port** — when an Awareness daemon is already running on the default port, `start` now POSTs `/api/v1/workspace/switch` instead of auto-allocating 37801/37802/…. Matches the "one dashboard, switch workspaces via UI" contract.
- **Config drift: `cloud.api_base` pointing at localhost** caused cloud-auth to generate codes on the local backend while the user's browser approved against `awareness.market` — different Redis instances. No code change; manual fix documented in CLAUDE.md.

### Changed
- **Telemetry is now default-on** (opt-out via Welcome uncheck or Settings → Privacy). Label and hint copy updated: "Enabled by default" / "默认开启". Matches VS Code / Homebrew / Raycast norms. Still honours explicit opt-out.
- **Step 3 Recall results are now content-driven and readable**:
  - Questions come from tag hotness + recent decision/pitfall card titles (falls back to old meta templates when cards are sparse). Zero LLM, zero network beyond the existing `/knowledge?limit=30`.
  - Result cards pass through a new formatter that drops noisy items (raw chat logs, heavy-code-density summaries, stubs), shortens file paths to basename, strips `"""` wrappers, smart-truncates at sentence boundaries, and adds a type chip + relative timestamp ("2 天前").
  - New "⚡ 41 ms · 找到 8 条 · 来自你 1334 条记忆" stats bar above the cards.

### Added
- `result-formatter.js` (9 pure helpers: `normalizeWhitespace`, `stripDecorative`, `smartTruncate`, `isNoisy`, `prettyTitle`, `typeBadge`, `relativeTime`, `parseTags`, `tagHotness`, `buildContentQuestions`, `formatResult`, `formatResults`) with 20 unit tests.
- `wireHeader()` helper in `steps.js` + 11 Playwright click-path E2E (`onboarding-click-paths.spec.mjs`) covering every clickable element on every step. Explicit regression for the Step 5 orphan-skip bug.
- 2 new `telemetry-core-extra` cases pinning default-on + explicit-off.
- 4 CLI tests (`cli-single-daemon.test.mjs`) covering probe-and-switch vs. spawn-new daemon behavior.

### Tested
- **882 unit tests + 26 Playwright E2E** — 0 failures.
- Production smoke still green against `https://awareness.market/api/v1`.

## [0.6.0] - 2026-04-15

### Added
- **F-040 Onboarding MVP** — 6-step dashboard onboarding (Welcome → Scan → Recall → Wiki → Cloud → Done) as decoupled modules under `src/web/onboarding/` (7 files, each <300 lines). Auto-launches on first dashboard visit, skippable at every step.
- **Step 5 reuses device-auth** (`/cloud/auth/start` + poll + connect) — not OAuth. Unregistered users are redirected to signup by awareness.market.
- **Step 3 recall suggestions** are dynamically generated from scan metadata (README/wiki titles/top language) so the first query always has answers.
- **i18n**: en + zh dictionaries merged into existing `window.LOCALES`; zero new language infrastructure.
- **Static asset routing**: `handleWebUi` now serves `index.html` + whitelisted `/web/onboarding/*` files with MIME detection and path-traversal protection.
- **Tests**: `test/web-static-handler.test.mjs` — 6 cases (200 / 400 / 404 coverage).
- **F-040 Phase 2 — opt-in telemetry + Privacy UI**:
  - `src/core/telemetry.mjs`: opt-in batched event reporter. Anonymous `installation_id = SHA-256(device_id + salt)`. Persists queue to `.awareness/telemetry-queue.json`; fire-and-forget POST, never blocks daemon. Whitelisted event_types + property keys.
  - `src/daemon/telemetry-api-handlers.mjs`: `GET/POST /api/v1/telemetry/{status,enable,recent}`, `DELETE /api/v1/telemetry/data` for opt-in toggle, queue inspection, and self-deletion.
  - Wired into `daemon.mjs` startup (emits `daemon_started` with version/os/node/arch/locale).
  - Welcome step adds opt-in checkbox; persists via `/api/v1/telemetry/enable`.
  - `src/web/onboarding/status-chip.js`: persistent floating widget showing local/cloud mode + memory count + "Connect cloud" CTA.
  - `src/web/onboarding/privacy-settings.js`: injects "Usage Analytics" section into Settings panel (toggle / view recent events / delete data).
- **Endpoint alignment**: onboarding now calls real scan endpoints (`/api/v1/scan/trigger`, `/api/v1/scan/status`, `/api/v1/scan/files?category=wiki`) — earlier draft used non-existent paths.

### Tested (F-040 deep coverage)
- **48 unit tests** for onboarding modules: state machine (8), recall-suggestions strategy + endpoint fallback + result normalization (20), i18n en/zh alignment + interpolation parity (5), XSS attack-string injection across 5 render functions (5), static-handler whitelist + URL-decode + NUL byte + symlink escape (10).
- **11 unit tests** for `src/core/telemetry.mjs`: opt-in default, event_type whitelist, property whitelist + leak guard, deterministic SHA-256 installation_id, queue persistence, batched flush, deleteLocal forget call, MAX_QUEUE cap.
- **15 Playwright E2E tests** under `test/e2e/`: happy-path (auto-launch + 6-step walkthrough), skip-all + reload persistence + reset(), zh/en locale switch, device-auth user_code rendering + memory selection + `javascript:` URL defang regression, status chip local/cloud states + CTA re-launch, Privacy section rendering + toggle POST + recent-events expand.
- **3 real bugs found and fixed by tests**: (1) `pickSuggestions(null)` crash on default-param bypass; (2) `renderAuthPending` `javascript:` URL XSS in `href` (now defanged to `about:blank` if not `https?://`); (3) ZH dictionary missing chip keys.

### Security
- `handleWebUi` hardened: `decodeURIComponent` to catch `%2e%2e` traversal, NUL byte rejection, malformed URL → 400, `fs.realpathSync` symlink-escape protection.
- New `playwright.config.mjs` + `npm run test:e2e` script; pinned `@playwright/test@1.58.2` (matches cached Chromium 1208).

## [0.5.28] - 2026-04-14

### Improved
- **Hybrid search for task/risk auto-closure**: FTS5 BM25 + Jaccard word-overlap → Reciprocal Rank Fusion (RRF). Two channels combined for higher accuracy than either alone. Embedder vector similarity wired in as optional third channel when available.
- **`runLifecycleChecks` is now async**: Accepts optional `embedFn`/`cosineFn` for hybrid search. Backward-compatible — works without embedder (FTS5+Jaccard only).
- **6 new hybrid test scenarios**: Partial keyword overlap, unrelated task rejection, multi-task precision, Chinese risk mitigation, empty list handling, already-done task safety.

## [0.5.27] - 2026-04-14

### Improved
- **Task auto-resolve upgraded to FTS5 BM25**: Previously used Jaccard word-overlap (less accurate). Now uses SQLite FTS5 BM25 ranking (same approach as risk auto-mitigate), with Jaccard as fallback for older databases without `tasks_fts` index.
- **New `tasks_fts` FTS5 index**: Tasks are now indexed in a dedicated FTS5 virtual table with trigram tokenizer for accurate Chinese/CJK matching. Synced on every `indexTask()` call.

## [0.5.26] - 2026-04-14

### Fixed
- **Document cloud sync missing from fullSync**: `pushDocumentsToCloud()` was implemented in sync-push.mjs (Phase 3) but never called in `fullSync()`. Documents were silently not syncing to cloud. Now included in the full sync pipeline.

## [0.5.25] - 2026-04-14

### Added
- **`awareness_workspace_search` MCP tool**: New tool to search workspace files, code symbols, wiki pages, and documents via graph_nodes FTS5. Supports `node_types` filter and `include_neighbors` option for 1-hop similarity/doc_reference graph traversal expansion.
- **Workspace graph expansion in recall**: `awareness_recall` now automatically searches graph_nodes (20% of FTS quota in scope='all') and appends up to 5 related workspace files/wiki/docs via graph traversal after primary results. Results are tagged as `workspace_file`/`workspace_wiki`/`workspace_doc`.
- **`workspace_summary` in `awareness_init`**: Init response now includes project workspace statistics (node counts by type, total edges) when workspace has been scanned.

### Fixed
- **Reranker test assertions**: Fixed 2 pre-existing test failures where tests expected `_rerankSignals.salience` but the fusion formula outputs `cardType` and `growth`. Removed unused `extractSalienceScore()` dead code.

## [0.5.24] - 2026-04-12

### Added
- **`awareness_apply_skill` MCP tool**: LLM can now actively call skills instead of passively reading injected text. Returns structured execution plan with methods, trigger conditions, and context-adapted guidance. Automatically marks skill as used (resets decay).
- **Skill recommendations in recall**: When `awareness_recall` results match active skills by tag overlap, matched skills are appended with `awareness_apply_skill(skill_id=...)` call instructions. LLM can then invoke the skill tool directly.
- **Skill ID in rendered context**: `<skills>` XML now includes `id` attribute and call hint for each skill.

## [0.5.23] - 2026-04-12

### Added
- **Skill auto-evolution** (`knowledge-extractor.mjs`, `daemon.mjs`): When a new knowledge card shares ≥2 tags with an existing skill, the skill automatically evolves. Dual path: cloud-connected uses LLM re-synthesis via `/skills/extract` API for precision; offline fallback appends the new card as a method step. 1-hour debounce prevents excessive updates.

## [0.5.22] - 2026-04-12

### Fixed
- **ONNX model auto-recovery** (`embedder.mjs`): When the cached ONNX model is corrupted (e.g. interrupted download, disk issue), the embedder now automatically clears the corrupted cache and re-downloads the model on next use. Previously, a corrupted model file caused "Protobuf parsing failed" errors indefinitely until the user manually ran `rm -rf ~/.cache/huggingface/hub`. The auto-recovery covers both `getEmbedder()` pipeline loading and `warmupEmbedder()` startup path.

## [0.5.21] - 2026-04-12

### Added
- **0.85+ merge zone** (`knowledge-extractor.mjs`): When vector cosine ≥ 0.85 but new summary is NOT longer AND tags overlap, merge into existing card instead of creating an evolution chain. Prevents barely-different update cards from accumulating.

### Fixed
- **NULL version column safety** (`knowledge-extractor.mjs`): Merge SQL now uses `COALESCE(version, 1) + 1` instead of `version + 1`, preventing silent NULL propagation on pre-migration databases.

## [0.5.20] - 2026-04-12

### Added
- **Merge-first writing** (`knowledge-extractor.mjs`): New `merge` verdict triggered when vector cosine ≥ 0.70 **and** cards share ≥1 tag **and** same category. Instead of creating a duplicate card, the new content is appended to the existing card's summary (separated by `---`). Prevents topic fragmentation for related notes on the same subject.

### Fixed
- **`growth_stage` not synced from cloud** (`cloud-sync.mjs`): Pull path now saves the cloud-computed `growth_stage` when updating or inserting cards. Previously all pulled cards stayed `seedling` indefinitely.
- **Backend sync pull missing `growth_stage`** (`sync_service.py`): `_CARD_COLUMNS` now includes `growth_stage` so `GET /cards/sync` returns the cloud-computed stage.

## [0.5.19] - 2026-04-12

### Fixed
- **Skills cloud sync broken since F-032**: `_syncSkills()` read `cloudSkills.items` but the REST API returns `{skills: [...], total: N}`. The fallback chain iterated object keys instead of the skill array, so skills were never actually pulled from cloud. Fixed to `cloudSkills.items || cloudSkills.skills || (Array.isArray(cloudSkills) ? cloudSkills : [])`. Also applied to the push-check path.
- Skills insert errors are now logged instead of silently swallowed.

## [0.5.18] - 2026-04-12

### Added (F-035 — headless device auth proxy)
- `/api/v1/cloud/auth/start` response now includes `verification_url` (a ready-to-click link with `?code=…` pre-filled) and `is_headless` (true when the daemon is running on SSH / Codespaces / Gitpod / no-DISPLAY Linux / explicit `AWARENESS_HEADLESS=1`). UI layers (AwarenessClaw desktop Memory UI, setup wizards) can use `is_headless` to skip their own `open-browser` attempt and show the code + URL directly.
- `/api/v1/cloud/auth/poll` accepts a new optional `total_wait_ms` parameter (clamped to `[30s, 900s]`). Previous hard cap was 30 seconds — far too short for cross-device flows where the user has to switch to a phone / second laptop to approve. Default stays at 60s for backward compat.

### Fixed (pre-existing bugs surfaced while wiring F-035)
- `apiCloudAuthStart` and `apiCloudListMemories` used `daemon.config?.cloud?.api_base` to read the backend URL, but `daemon.config` is never actually assigned — so these handlers silently fell back to the production URL even when users configured a local backend in `.awareness/config.json`. Fixed to use `daemon._loadConfig()?.cloud?.api_base`, matching the rest of the handlers.

## [0.5.17] - 2026-04-11

### Changed
- `apiListTopics` now includes `tags` field in each topic item, enabling client-side fast-path matching without requiring the MOC card to be in the preloaded card list.

## [0.5.16] - 2026-04-11

### Added
- **Perception Center — full lifecycle**: new `perception_state` SQLite table with exposure cap (3 exposures → auto-hidden), weight decay (−0.2 per exposure, dormant at <0.3), snooze (7 days), dismiss (permanent), and restore. Stable `signal_id` hashing so signals dedupe across sessions. Surfaces in the wiki dashboard sidebar with a red badge when there are active guards.
- **LLM auto-resolve**: when `_remember` writes a new memory, `_checkPerceptionResolution` fires a batched LLM call (via cloud chat endpoint) that pre-filters candidates by tag/keyword/source_card overlap, then asks the model whether each active guard/contradiction/pattern/staleness signal has been resolved by the new memory. Resolved signals are marked `auto_resolved` with a `resolution_reason` and excluded from future context.
- **5 new REST endpoints** on the local daemon: `GET /api/v1/perceptions`, `POST /api/v1/perceptions/:id/{acknowledge,dismiss,restore}`, `POST /api/v1/perceptions/refresh`. All actions are idempotent and user-restorable.
- **Full Perception Center UI** in the web dashboard (sidebar entry, Overview attention bar, filter tabs, per-signal cards with exposure/weight, Snooze/Dismiss/Restore/Jump-to-card actions).
- **Lightweight i18n** (EN/ZH): zero-dependency inline `LOCALES` dictionary + `t(key, vars)` translator with variable interpolation. Auto-detects `navigator.language` (zh-* → zh), persists to `localStorage`, hot-reloads the current view on locale change (no page refresh). Language picker in the header (🇬🇧/🇨🇳) and in Settings. 92 `t(...)` call sites cover sidebar, overview, sync, settings, perception, memories.
- **F-034 `_skill_crystallization_hint` propagation**: `awareness-spec.json` step 5 is now documented in the bundled spec, and the workflow guide shows agents how to synthesize repeated cards into a skill via `awareness_record(insights={skills:[...]})`.

### Changed
- `awareness-spec.json` synced to the backend SSOT (skill category deprecated, step 5 crystallization added).
- `_buildPerception` and `_buildInitPerception` now filter through `shouldShowPerception` and call `touchPerceptionState` so every surfaced signal increments exposure and decays weight — same signal can never spam the agent across sessions.

### Tests
- 20 new node:test cases in `perception-lifecycle.test.mjs` covering CRUD, exposure cap, snooze, auto-resolve, restore, cleanup, and the 5 REST endpoints.
- Local daemon suite: **100 tests pass** (29 wiki + 20 perception + 49 f031 alignment + 2 other suites).

## [0.5.15] - 2026-04-11

### Fixed
- **Topic member counts are now always accurate**: `GET /api/v1/topics` no longer trusts the stored `link_count_outgoing` column (which can go stale when member cards are deleted or superseded — `tryAutoMoc` only runs on write, not on delete). The endpoint now recomputes the live member count for every MOC on every read using the exact same tag-LIKE query as `apiGetKnowledgeCard.members`, so the sidebar badge always matches what the topic detail page renders.
- **Empty MOCs are hidden**: MOC cards whose live member count is 0 are dropped from the topics list so orphaned MOCs (members all deleted) don't clutter the sidebar.
- Added tests covering stale-count drift and the empty-MOC drop rule.

## [0.5.14] - 2026-04-11

### Fixed
- **MOC topic cards now return their full member list**: `GET /api/v1/knowledge/:id` on a MOC card (card_type='moc') now returns a `members` array resolved via tag-match (every non-MOC active card that shares at least one tag with the MOC). Previously the endpoint only returned the MOC row itself, so clients had no way to discover topic members and had to fall back to fragile keyword matching. Added a test covering the 3-member case in `wiki-api.test.mjs`. Fixes the "Topic says 15 cards but only 4 shown" bug reported by the AwarenessClaw desktop UI.

## [0.5.13] - 2026-04-08

### Fixed
- **Dashboard auto-open no longer spams browser windows**: The local daemon now uses a global `~/.awareness/.dashboard-opened` first-run flag instead of a per-project one, so new workspaces don't keep re-opening `http://localhost:37800/`. Auto-open is also removed from `@awareness-sdk/setup`, leaving the daemon as the single source of truth for this behavior.

## [0.5.12] - 2026-04-07

### Fixed
- **Context confusion in recall**: Short, ambiguous prompts (e.g. "make it responsive") no longer pull in unrelated knowledge cards from different conversation contexts. The recall system now enriches the semantic query with topic keywords from the last hour of memories, giving contextual grounding to any client without requiring workspace metadata.
- **Source tracking on knowledge cards**: Cards now carry the originating client source (mcp/openclaw-plugin/desktop). During recall, cards from the same client as the caller receive a 1.3× relevance boost, reducing cross-client pollution between Claude Code and OpenClaw sessions.
- **Structural quality gate for knowledge cards**: Cards whose body (after stripping code fences) has fewer than 5 unique prose tokens are rejected at write time. Prevents raw system metadata (e.g. sender JSON payloads) from being stored as knowledge without hardcoding any specific strings.

## [0.5.10] - 2026-04-06

### Fixed
- **Cloud sync memory name display**: After connecting to cloud sync and selecting a memory, the UI now shows the memory name instead of just the memory ID. Name is saved to config on connect and displayed in the Sync panel status.

## [0.5.9] - 2026-04-06

### Fixed
- **Auto-rebuild better-sqlite3**: When Node.js major version upgrades (e.g. v23→v24), the native C++ addon becomes incompatible. Daemon now auto-detects NODE_MODULE_VERSION mismatch and runs `npm rebuild` before falling back to no-op mode. Prevents memory appearing empty after a Node.js upgrade.

## [0.5.8] - 2026-04-05

### Changed
- **Zero-truncation recall**: Summary mode now returns full content instead of snippets. Token budget controlled by reducing item count, not cutting content. Prevents context pollution when conclusions appear at the end of long content.

## [0.5.7] - 2026-04-05

### Changed
- **Recall snippet length**: Increased default from 250→600 chars, summary search from 400→800 chars. Short content now fully returned without truncation.
- **Perception guard detail**: Increased pitfall/risk summary from 150→300 chars for readable warnings.

## [0.5.6] - 2026-04-05

### Fixed
- **awareness-spec.json**: Added DO NOT record exclusion list (API keys, credentials, system bootstrap, sender metadata) to the single source of truth spec file.
- **CLAUDE.md alignment**: Added all 7 personal categories + DO NOT record list to STEP 4.

## [0.5.5] - 2026-04-05

### Fixed
- **Record-rule prompt quality**: Added few-shot examples with correct/wrong annotations, explicit DO NOT SAVE exclusion list (greetings, metadata, news), organized categories into [Technical] and [Personal] groups.
- **Full 13-category alignment**: Added missing 5 personal categories (plan_intention, activity_preference, health_info, career_info, custom_misc) and skill category to record-rule prompt.
- **stripMarkdownPrefix regex**: Fixed `\w+` matching only first word in bold markers like `**Hacker News**`, changed to `[^*]+` for multi-word support.

## [0.5.4] - 2026-04-05

### Added
- **Init perception injection**: `_buildInitPerception()` in mcp-handlers generates staleness + pitfall guard signals at session start (was empty array).
- **Keyword-context snippets**: search results show a window around the first matching term instead of always truncating from start.
- **Metadata hydration**: embedding-only search results now get title/type/tags/source from DB lookup.
- **Auto-title generation**: untitled results get a preview title from first content sentence.
- **Recall eval benchmark**: `recall-eval.mjs` with 20-query dataset, Recall@5=80%.

### Changed
- **RRF normalization**: scores normalized to 0-1 range with type-specific boost multipliers (knowledge_card=1.5x, decision=1.3x, turn_brief=0.4x).
- **CJK trigram threshold**: lowered from >4 to >=3 chars; short CJK terms (2-4 chars) also kept as-is for exact match.
- **Pattern detection**: tag co-occurrence (3+ in 7 days) replaces simple category count.
- **Staleness threshold**: unified to 30 days using COALESCE(updated_at, created_at).
- **Recall summary format**: now shows score%, days ago, ~tokens per result.
- **Perception messages**: English (was hardcoded Chinese).

### Fixed
- **session_checkpoint noise**: filtered from recall results by default (DEFAULT_TYPE_EXCLUDE).
- **Guard detector test**: mock now includes recentActiveCards for pattern signal generation.

## [0.5.2] - 2026-04-03

### Changed
- **Freshness from source timestamps**: `memory_profile_service.py` now derives profile freshness from the newest source card/risk timestamp instead of profile rebuild time, so stale knowledge stays marked stale after regeneration.
- **Concept-level recall anchors**: `query-planner.mjs` now expands paraphrase anchors by concept groups and intent-level anchors instead of tighter benchmark-phrase coupling, reducing overfit while keeping robust recall at full hit rate on the current fixture set.
- **Profile-gated repo guards**: repo-specific deployment guards now activate only for the Awareness repository profile; generic SDK usage no longer inherits Awareness-only docker/prisma deployment warnings by default.

### Fixed
- **Summary/object-view drift**: memory profile summaries now prefer rendered `Me / Goal / Context / Pattern` sections and avoid repeating lower-value legacy sections when object-view data is available.
- **Guard benchmark isolation**: perception benchmark and daemon perception now pass an explicit guard profile so repo-specific guard rules are tested and applied only when intended.

## [0.5.1] - 2026-04-03

### Added
- **Robust multilingual recall benchmark**: Added `tests/memory-benchmark/datasets/universal_robust.jsonl` plus `benchmark:universal:robust` to measure paraphrase/noisy-query recall on the universal fixture corpus.

### Changed
- **Chinese paraphrase recall normalization**: `query-planner.mjs` now derives stronger anchor fallback queries for continuation, report-structure, and tool-decision prompts, improving recall on rewritten Chinese queries.

### Fixed
- **Robust benchmark misses resolved**: The three Chinese paraphrase misses in the robust universal benchmark are now resolved, bringing the builtin robust baseline to full recall/answer hit on the current 20-case dataset.

## [0.5.0] - 2026-04-01

### Changed
- **Major daemon refactor**: Extracted 1500+ lines from monolithic `daemon.mjs` into 12 focused modules under `daemon/` directory — constants, helpers, loaders, MCP contract/handlers, HTTP handlers, API handlers, tool bridge, cloud HTTP, file watcher, embedding helpers.
- **MCP server simplified**: `mcp-server.mjs` now delegates result building to `daemon/mcp-handlers.mjs`, reducing duplication between HTTP and stdio transports.
- **MCP stdio cleanup**: `mcp-stdio.mjs` uses shared enum constants and error helpers from `daemon/mcp-contract.mjs`.

### Added
- **Noise filter**: New `core/noise-filter.mjs` filters low-signal events (empty session checkpoints, terse untitled content) before storage, reducing memory clutter.
- **Knowledge card evolution**: Semantic dedup via embedding cosine similarity during card extraction — detects duplicates, updates, and contradictions.
- **Test suite**: 14 unit tests covering MCP contract, HTTP dispatch, noise filter, recall regressions, and embedding compatibility.

### Fixed
- **Port resolution bug**: `cmdStatus` and `cmdReindex` now correctly pass `projectDir` to `resolvePort()` for workspace registry lookup.

## [0.4.6] - 2026-04-01

### Added
- **CJK auto-detection + multilingual embedding lazy loading**: `detectNeedsCJK()` samples text for CJK character ratio (>5% threshold). When CJK content is detected, automatically loads `multilingual-e5-small` model on demand. English-only `all-MiniLM-L6-v2` remains the fast default.
- **Shared lang-detect module**: Extracted `detectNeedsCJK()` to `core/lang-detect.mjs` to avoid logic drift between daemon and search.
- **Model-aware vector search**: `search.mjs` now reads `model_id` from stored embeddings and matches each against the correct query vector — no more cross-model-space similarity comparisons.
- **Status endpoint enhancements**: `/status` now reports `multilingual_model` name and `auto_cjk_detection: true`.

### Changed
- `indexer.mjs`: `getAllEmbeddings()` now returns `model_id` field for each embedding.

## [0.4.5] - 2026-03-31

### Fixed
- **26-issue audit**: Data safety, dedup, i18n, and test fixes.

## [0.4.4] - 2026-03-31

### Fixed
- **Source isolation and sourceExclude filtering**.

## [0.4.3] - 2026-03-30

### Fixed
- **Content truncation removed**: Added 20k token budget, multi-project workspace isolation.

## [0.4.2] - 2026-03-30

### Added
- **healthz embedding diagnostics**: `/healthz` endpoint now includes `embedding` object with `available` boolean and `model` name, making it easier for desktop apps to display embedding status.

### Improved
- **Embedding warmup diagnostics**: When embedding model warmup fails, daemon now logs specific causes (network timeout, disk full, corrupted cache) and suggests fix commands (`rm -rf ~/.cache/huggingface/hub`). Previously only showed generic error message.
- **Warmup timing**: Logs exact warmup duration in seconds for performance monitoring.

## [0.4.0] - 2026-03-29

### Added
- **Hybrid vector+FTS5 search (out of the box)**: SearchEngine now receives the embedder module, enabling dual-channel search (BM25 keyword + embedding cosine similarity) with Reciprocal Rank Fusion (RRF). Previously only FTS5 was active despite the code being present.
- **Auto embedding on write**: Every new memory is automatically embedded and stored in SQLite on `awareness_record`, no manual step needed.
- **Startup model pre-warming**: Embedding model (~23MB, Xenova/all-MiniLM-L6-v2) is downloaded and warmed up in the background on first daemon start. Subsequent starts use cached model.
- **Automatic embedding backfill**: On startup, memories without embeddings are backfilled in the background — existing users get vector search for all historical memories without any action.
- **healthz search_mode field**: `/healthz` endpoint now reports `search_mode: "hybrid"` or `"fts5-only"` so plugins can detect search capabilities.

### Changed
- **@huggingface/transformers promoted to required dependency**: Moved from `optionalDependencies` to `dependencies` to ensure vector search works out of the box via `npx`.
- **Shared embedder loading**: `_loadEmbedder()` is now a shared lazy-loader used by both SearchEngine and KnowledgeExtractor (was duplicated before).

## [0.3.12] - 2026-03-27

### Fixed
- **Knowledge card category fix (proper approach)**: Replaced hardcoded English alias map with proper fix at source — `awareness_record` MCP tool schema now explicitly enumerates all 13 valid categories in `describe()`. LLMs read the schema and output valid values directly. `normalizeCategory()` simplified to case/whitespace normalization + strict `VALID_CATEGORIES` lookup + fallback `key_point`. No language-specific aliases needed.

## [0.3.11] - 2026-03-27

### Fixed
- **Windows Chinese/CJK text rendering**: Force UTF-8 encoding on Windows for daemon process stdout/stderr and MCP stdio stdin/stdout/stderr — prevents Chinese characters from becoming "????" on Windows systems with non-UTF-8 code pages (e.g., CP936/GBK)

### Fixed (knowledge-extractor)
- **Non-standard knowledge card categories**: `processPreExtracted()` now normalizes LLM-generated categories via `normalizeCategory()`. Maps TROUBLESHOOTING → `problem_solution`, BEST-PRACTICE → `insight`, SETUP → `workflow`, etc. — no more unlisted categories appearing in the dashboard or being silently downgraded to `key_point` during cloud sync

## [0.3.10] - 2026-03-27

### Added
- Initial CHANGELOG (backfilled from git history)
