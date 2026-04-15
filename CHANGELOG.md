# Changelog

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
