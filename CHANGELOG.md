# Changelog

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
