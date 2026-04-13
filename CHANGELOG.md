# Changelog

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
