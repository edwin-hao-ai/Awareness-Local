/**
 * 15 diverse real-world skill fixtures for quality rubric eval.
 * Span: dev tools, DB, deployment, frontend, debugging, docs, ML ops,
 *       CI/CD, security, data pipelines, testing, 3 "bad" examples
 *       as negative controls.
 */

export const SKILL_FIXTURES = [
  // ========= GOOD SKILLS (10) =========

  {
    name: 'publish @awareness-sdk/* to npm',
    summary:
      'Release a @awareness-sdk/* package to the public npm registry. **Why** China mirror (npmmirror) accepts only reads — publish to it silently 403s. **When** any scoped package under @awareness-sdk needs a new version.',
    methods: [
      { step: 1, description: 'Bump `sdks/<pkg>/package.json` version + prepend a user-visible CHANGELOG.md entry under `## [x.y.z] - YYYY-MM-DD`.' },
      { step: 2, description: 'Run `npm publish --access public --registry=https://registry.npmjs.org/ "--//registry.npmjs.org/:_authToken=$NPM_TOKEN"` — the explicit registry flag bypasses any npmrc pointing to a mirror.' },
      { step: 3, description: 'Verify with `npm view @awareness-sdk/<pkg> version --registry=https://registry.npmjs.org/` — must print the new version within ~10s.' },
    ],
    trigger_conditions: [
      { pattern: 'publish @awareness-sdk', weight: 0.95 },
      { pattern: 'release SDK to npm', weight: 0.9 },
      { pattern: 'ship npm package', weight: 0.7 },
    ],
    tags: ['npm', 'publish', 'awareness-sdk', 'release', 'china-mirror'],
    reusability_score: 0.95,
    durability_score: 0.9,
    specificity_score: 0.9,
  },

  {
    name: 'diagnose "daemon not responding" in Awareness local',
    summary:
      '3-step triage for `MCP server not connected` or recall hangs. **Covers**: daemon crashed, port conflict, stale PID. **Time to resolution**: under 2 min for 80% of cases.',
    methods: [
      { step: 1, description: 'Check liveness: `curl -sf http://localhost:37800/healthz` — 200 = daemon alive (MCP client side issue, run `/mcp` reconnect in Claude Code or restart IDE).' },
      { step: 2, description: 'If healthz times out: `lsof -nP -iTCP:37800 -sTCP:LISTEN` — if PID exists but not daemon, kill it `kill -9 $(cat ~/.awareness/daemon.pid)`.' },
      { step: 3, description: 'Restart clean: `rm ~/.awareness/daemon.pid ~/.awareness/daemon.log` then `npx awareness-local start` — log `Embedder loaded` line confirms vector search is live.' },
    ],
    trigger_conditions: [
      { pattern: 'daemon not responding', weight: 0.95 },
      { pattern: 'MCP server not connected', weight: 0.9 },
      { pattern: 'awareness_recall hangs', weight: 0.85 },
    ],
    tags: ['awareness-local', 'daemon', 'debugging', 'mcp', 'port-37800'],
    reusability_score: 0.85,
    durability_score: 0.8,
    specificity_score: 0.95,
  },

  {
    name: 'add a Prisma migration without dropping memory_vectors',
    summary:
      'Add a new column / table to the Awareness backend without letting Prisma nuke the manually-managed `memory_vectors` / `memory_centroids` / `card_similarities` / `skills` tables. **Never** run `prisma db push` — use explicit migrations + raw SQL.',
    methods: [
      { step: 1, description: 'Edit `backend/prisma/schema.prisma` to add the new model/field. Do NOT touch any model referencing memory_vectors, memory_centroids, card_similarities, or skills.' },
      { step: 2, description: 'Generate migration: `docker exec awareness-backend python -m prisma migrate dev --name <slug>`. Review the SQL in `backend/prisma/migrations/<ts>_<slug>/migration.sql` — if it contains `DROP TABLE memory_vectors`, abort and hand-edit.' },
      { step: 3, description: 'If hand-editing, make sure `REFERENCES memories(id)` uses the real PostgreSQL table name (lowercase + @@map), not the Prisma model name `"Memory"`. Column types must match: `memories.id` is TEXT, not UUID.' },
      { step: 4, description: 'Local verify first: `docker exec awareness-backend python -m prisma migrate deploy --schema=prisma/schema.prisma`. Never push untested migrations to prod.' },
    ],
    trigger_conditions: [
      { pattern: 'add prisma migration', weight: 0.9 },
      { pattern: 'schema.prisma change', weight: 0.8 },
      { pattern: 'database migration awareness', weight: 0.7 },
    ],
    tags: ['prisma', 'migration', 'postgresql', 'memory_vectors', 'schema'],
    reusability_score: 0.9,
    durability_score: 0.85,
    specificity_score: 0.95,
  },

  {
    name: 'deploy Awareness backend to prod without recreating postgres',
    summary:
      'Zero-downtime prod deploy for backend / mcp / worker / beat. **Critical pitfall**: including `postgres` in `docker compose up` will scram the scram-sha-256 password hash and lock backend out.',
    methods: [
      { step: 1, description: 'SSH to server `ssh -i server-key/awareness_teammate_key root@66.42.50.14`, `cd /opt/awareness && git pull origin main`.' },
      { step: 2, description: 'Build + restart backend services ONLY, background via nohup since compose build is slow: `nohup bash -c "docker compose --env-file .env.prod build backend && docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d backend mcp worker beat" > /tmp/deploy.log 2>&1 &` — DO NOT include postgres in the up list.' },
      { step: 3, description: 'Watch progress: `tail -f /tmp/deploy.log` in a separate ssh session. Success marker: `healthy` status for all 4 services within ~3min.' },
      { step: 4, description: 'Verify: `curl https://awareness.market/health` returns 200 with `{"status":"ok"}`. If frontend also changed: `docker compose ... up -d --no-deps frontend` — `--no-deps` prevents dep services from restarting.' },
    ],
    trigger_conditions: [
      { pattern: 'deploy backend to prod', weight: 0.95 },
      { pattern: 'ship to awareness.market', weight: 0.9 },
      { pattern: 'docker compose production deploy', weight: 0.7 },
    ],
    tags: ['deploy', 'docker-compose', 'production', 'postgres', 'backend'],
    reusability_score: 0.95,
    durability_score: 0.9,
    specificity_score: 0.95,
  },

  {
    name: 'run awareness test pyramid (L1-L4) before PR merge',
    summary:
      '5-layer test pyramid enforced by CLAUDE.md: L0 anti-hallucination, L1 static/contract guards, L2 integration, L3 chaos/failure-mode, L4 user-journey E2E. Never merge without all 4 layers passing.',
    methods: [
      { step: 1, description: 'L1 static: `bash scripts/sync-shared-scripts.sh --check && node scripts/sync-shared-prompts.mjs --check && node scripts/verify-buttons.mjs && node scripts/verify-endpoints.mjs` — all exit 0.' },
      { step: 2, description: 'L2 integration (per affected SDK): `cd sdks/local && node --test test/*.test.mjs` plus openclaw `npx vitest run`.' },
      { step: 3, description: 'L3 chaos: grep the diff for any new `fetch(` / `axios.` / DB call without a matching 5xx + timeout test in test/cloud-http.test.mjs or sibling — CI `verify-chaos-tests.mjs` catches this.' },
      { step: 4, description: 'L4 real-browser journeys: `cd frontend && npx playwright test tests/e2e/user-journeys/ --project=chromium` — zero `page.route` / HAR mocks allowed in these.' },
    ],
    trigger_conditions: [
      { pattern: 'pre-PR test run', weight: 0.9 },
      { pattern: 'verify test pyramid', weight: 0.85 },
      { pattern: 'ready to merge to main', weight: 0.75 },
    ],
    tags: ['testing', 'pyramid', 'L1', 'L2', 'L3', 'L4', 'playwright', 'ci'],
    reusability_score: 0.95,
    durability_score: 0.95,
    specificity_score: 0.85,
  },

  {
    name: 'sync F-056 shared prompts before npm publish',
    summary:
      'Cross-SDK prompt SSOT lives in `sdks/_shared/prompts/*.md`. Before publishing any client-facing package, sync must run or users get stale extraction prompts. Prepublish-gate enforces.',
    methods: [
      { step: 1, description: 'Edit prompt templates in `sdks/_shared/prompts/*.md` — never edit the `<!-- SHARED:... BEGIN/END -->` slot contents in downstream surfaces directly.' },
      { step: 2, description: 'Run `node scripts/sync-shared-prompts.mjs` — distributes to 10 surfaces (local daemon / tools.ts / recall.js / harness-builder / SKILL.md × 3 / backend × 2).' },
      { step: 3, description: 'Verify parity: `node scripts/sync-shared-prompts.mjs --check` must exit 0. Also diff `awareness-spec.json` 3 copies are byte-identical.' },
      { step: 4, description: 'Now publish. `sdks/local/scripts/prepublish-gate.mjs` runs via `prepublishOnly` and blocks any drift from reaching npm.' },
    ],
    trigger_conditions: [
      { pattern: 'update extraction prompt', weight: 0.9 },
      { pattern: 'edit _shared/prompts', weight: 0.95 },
      { pattern: 'F-056 sync', weight: 0.85 },
    ],
    tags: ['f-056', 'prompt-ssot', 'sync-script', 'publish-gate', 'monorepo'],
    reusability_score: 0.9,
    durability_score: 0.9,
    specificity_score: 0.95,
  },

  {
    name: 'resolve "Unknown action: remember" when LLM hits awareness_record',
    summary:
      'openclaw client.ts v0.6.13 and earlier only accept action="write"/"update_task". qwen + others default to "remember" and die. Fix is client-side (plugin upgrade) not daemon-side.',
    methods: [
      { step: 1, description: 'Reproduce: `openclaw agent --local -m "..." --verbose on --json` — look for `awareness_record returned non-standard result` + `Unknown action: remember` in assistant `thinking` payload.' },
      { step: 2, description: 'Upgrade plugin: `npx clawhub install @awareness-sdk/openclaw-memory@latest --force` then restart openclaw. Minimum v0.6.15 has the fix (client.ts accepts remember/remember_batch/submit_insights).' },
      { step: 3, description: 'Confirm fixed: rerun the same prompt, assistant should NOT fall back to writing markdown files; daemon `totalKnowledge` count should increase by 1+.' },
    ],
    trigger_conditions: [
      { pattern: 'Unknown action: remember', weight: 0.95 },
      { pattern: 'awareness_record broken', weight: 0.85 },
      { pattern: 'LLM wrote to file instead of memory', weight: 0.75 },
    ],
    tags: ['openclaw', 'plugin', 'awareness_record', 'qwen', 'debugging'],
    reusability_score: 0.85,
    durability_score: 0.8,
    specificity_score: 0.95,
  },

  {
    name: 'cut an AwarenessClaw macOS DMG release (signed + notarized)',
    summary:
      'Signed + notarized DMG cut for `AwarenessClaw/packages/desktop`. Unnotarized builds trigger Gatekeeper warnings that users cannot bypass. Never ship raw packages.',
    methods: [
      { step: 1, description: 'Bump `AwarenessClaw/packages/desktop/package.json` version + prepend user-visible CHANGELOG entry.' },
      { step: 2, description: 'Package: `cd AwarenessClaw/packages/desktop && PYTHON_PATH=/usr/bin/python3 CSC_IDENTITY_AUTO_DISCOVERY=true CSC_NAME="Beijing VGO Co;Ltd (5XNDF727Y6)" APPLE_KEYCHAIN_PROFILE="AwarenessClawNotary" npm run package:mac`. Expect ~3-5min — notarytool waits on Apple.' },
      { step: 3, description: 'Verify signature: `spctl -a -vv release/AwarenessClaw-<v>-arm64.dmg` prints `Notarized Developer ID`. Then `stapler validate <dmg>` confirms the ticket is attached.' },
      { step: 4, description: 'Upload to GitHub Release: `cp release/AwarenessClaw-<v>-arm64.dmg /tmp/AwarenessClaw.dmg && gh release upload v0.3.0 /tmp/AwarenessClaw.dmg --repo everest-an/AwarenessClaw-Download --clobber` — filename MUST stay AwarenessClaw.dmg (official download link anchor).' },
      { step: 5, description: 'SSH update app-versions.json on prod: `ssh server \'cat > /opt/awareness/data/app-versions.json << EOF\n{"awarenessclaw":{"latestVersion":"x.y.z","downloadUrl":"https://awareness.market/"}}\nEOF\'` — hot update, no container restart.' },
    ],
    trigger_conditions: [
      { pattern: 'release AwarenessClaw DMG', weight: 0.95 },
      { pattern: 'sign and notarize macOS', weight: 0.85 },
      { pattern: 'ship desktop app', weight: 0.8 },
    ],
    tags: ['awarenessclaw', 'macos', 'dmg', 'notarization', 'release', 'electron'],
    reusability_score: 0.9,
    durability_score: 0.85,
    specificity_score: 0.95,
  },

  {
    name: 'triage flaky playwright E2E without turning off the test',
    summary:
      'When `test/e2e/user-journeys/*.spec.mjs` fails only in CI: do NOT add `test.skip`. CLAUDE.md prohibits mocking in L4. Root-cause via the artifact trail.',
    methods: [
      { step: 1, description: 'Download the playwright report + trace from the CI run: `gh run download <run_id> -n playwright-report`. Open `playwright-report/index.html` locally.' },
      { step: 2, description: 'Inspect trace.zip in the UI; look for the first failing step. Common causes: (a) selector race — element visible but not attached; (b) stale auth cookie — login state drifted; (c) 5xx upstream not handled in journey.' },
      { step: 3, description: 'Reproduce locally at the exact CI viewport + headful: `npx playwright test <spec> --headed --project=chromium`. Add `page.waitForLoadState("networkidle")` ONLY at the failing step — not everywhere.' },
      { step: 4, description: 'If intermittent, add `test.retry(2)` ONLY to this test (not global) + file a ticket. If deterministic, fix the real cause (waits, server-side retry banner, etc.) — never `page.route` mock the failure away.' },
    ],
    trigger_conditions: [
      { pattern: 'flaky playwright test', weight: 0.9 },
      { pattern: 'E2E fails in CI only', weight: 0.85 },
      { pattern: 'L4 user-journey flake', weight: 0.9 },
    ],
    tags: ['playwright', 'e2e', 'flaky', 'ci', 'debugging', 'L4'],
    reusability_score: 0.9,
    durability_score: 0.85,
    specificity_score: 0.9,
  },

  {
    name: 'decouple a > 2000-line daemon module via engine/ pattern',
    summary:
      'F-057 playbook for shrinking daemon.mjs-style monoliths. Keep class surface intact, each method becomes a 1-line delegation. Protected by the 10 MCP golden tests.',
    methods: [
      { step: 1, description: 'Record baseline: `node --test test/f057-golden-mcp.test.mjs` must be 10/10 before touching anything.' },
      { step: 2, description: 'For each target method, read its full body. Create `daemon/engine/<name>.mjs` with `export async function <name>(daemon, ...args) { … }`. Replace `this.` → `daemon.`, `this.indexer` → `daemon.indexer`, imports stay relative.' },
      { step: 3, description: 'Replace class method body with `return <name>Engine(this, args);`. Keep the method name + signature so the rest of daemon.mjs and callers are untouched.' },
      { step: 4, description: 'Re-run goldens after EACH extraction — catches regressions early. One failing golden = revert that phase before moving on.' },
      { step: 5, description: 'After every phase commit: include the new line count in the commit message (e.g., 2621 → 1323 = -49%). Makes progress visible in git log.' },
    ],
    trigger_conditions: [
      { pattern: 'extract engine from daemon', weight: 0.9 },
      { pattern: 'F-057 decouple phase', weight: 0.95 },
      { pattern: 'shrink daemon.mjs', weight: 0.85 },
    ],
    tags: ['f-057', 'refactor', 'daemon-mjs', 'mechanical-extraction', 'goldens'],
    reusability_score: 0.85,
    durability_score: 0.9,
    specificity_score: 0.9,
  },

  // ========= BAD SKILLS (5 · negative controls) =========

  {
    name: 'handle stuff',
    summary: 'handle things that come up',
    methods: [
      { step: 1, description: 'do it' },
    ],
    trigger_conditions: [
      { pattern: 'stuff', weight: 0.5 },
    ],
    tags: ['general', 'misc'],
    reusability_score: 0.5,
    durability_score: 0.3,
    specificity_score: 0.1,
  },

  {
    name: 'test',
    summary: 'test summary',
    methods: [
      { step: 1, description: 'test' },
      { step: 2, description: 'test' },
    ],
    trigger_conditions: [
      { pattern: 'test', weight: 0.5 },
    ],
    tags: ['test'],
    reusability_score: 0.3,
    durability_score: 0.2,
    specificity_score: 0.1,
  },

  {
    name: 'fix the bug',
    summary: 'When a bug appears, find it and fix it using the tools.',
    methods: [
      { step: 1, description: 'find the bug' },
      { step: 2, description: 'fix the bug' },
      { step: 3, description: 'verify' },
    ],
    trigger_conditions: [
      { pattern: 'fix', weight: 0.4 },
    ],
    tags: ['debug'],
    reusability_score: 0.4,
    durability_score: 0.4,
    specificity_score: 0.2,
  },

  {
    name: 'deploy the app',
    summary:
      'Deploy the application to production when ready. Be careful with databases and make sure to back up first.',
    methods: [
      { step: 1, description: 'prepare' },
      { step: 2, description: 'deploy' },
      { step: 3, description: 'check' },
    ],
    trigger_conditions: [
      { pattern: 'deploy', weight: 0.6 },
    ],
    tags: ['deployment', 'production'],
    reusability_score: 0.5,
    durability_score: 0.5,
    specificity_score: 0.3,
  },

  {
    name: 'process data',
    summary: 'process data efficiently',
    methods: [
      { step: 1, description: 'load' },
      { step: 2, description: 'process' },
      { step: 3, description: 'save' },
    ],
    trigger_conditions: [
      { pattern: 'data', weight: 0.5 },
    ],
    tags: ['data'],
    reusability_score: 0.4,
    durability_score: 0.3,
    specificity_score: 0.1,
  },
];
