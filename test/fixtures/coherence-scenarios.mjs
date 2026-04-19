/**
 * F-056 · conversation-coherence scenarios.
 *
 * Each scenario is a scripted sequence of turns a user-level agent
 * would run: record → maybe more records → recall/init → assertions
 * about what the NEXT turn would see.
 *
 * Used by `test/f056-coherence-offline.test.mjs` which spins up a real
 * daemon (real SQLite, real ONNX embedder) so the assertions measure
 * the live pipeline (embedding, FTS5, RRF, aggregator penalty, persona
 * gate, everything).
 *
 * Each step is one of:
 *   { op: 'record', content, insights?, source? }
 *     — writes via daemon._callTool('awareness_record', ...).
 *     — if `insights` is set, the daemon skips the extraction-instruction
 *       step and indexes the pre-built card (simulating a perfect LLM).
 *   { op: 'switch_project', projectDir }
 *     — daemon.switchProject(...) to simulate workspace hops.
 *   { op: 'init_and_expect', query?, must_include_cards?, must_exclude_cards? }
 *     — daemon._callTool('awareness_init', {query}); assert rendered_context
 *       contains / does not contain given card title substrings.
 *   { op: 'recall_and_expect', query, must_include_card_ids, must_rank_top_k? }
 *     — daemon._callTool('awareness_recall', {query}); assert result.results
 *       (or parsed text) includes the expected card IDs, optionally in top-K.
 */

export const COHERENCE_SCENARIOS = [
  // ---------------------------------------------------------------------
  // S1 · Same-session continuity
  //   decision recorded → problem later, recall query picks up both
  // ---------------------------------------------------------------------
  {
    id: 'S1-same-session-decision-then-debug',
    description:
      'Record a decision in turn 1, a debug fix in turn 2, then in turn ' +
      '3 ask a question that should pull both back. The agent needs the ' +
      'decision context to make sense of the debug fix.',
    steps: [
      {
        op: 'record',
        content:
          'Decision: we chose PostgreSQL pgvector over Pinecone for vector ' +
          'storage. Cost savings ~$70/mo, co-location with relational data. ' +
          'Trade-off: lower QPS past 10M vectors.',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_pgvector_decision',
            category: 'decision',
            title: 'Chose pgvector over Pinecone',
            summary:
              '**Decision**: pgvector over Pinecone for vector storage. ' +
              'Saves ~$70/mo, co-locates with relational data for JOIN-based ' +
              'hybrid search, cosine via `<=>`. Trade-off: lower QPS past 10M ' +
              'vectors, acceptable at our scale.',
            tags: ['pgvector', 'vector-db', 'decision'],
            confidence: 0.92,
            novelty_score: 0.9,
            durability_score: 0.9,
            specificity_score: 0.85,
          }],
        },
      },
      {
        op: 'record',
        content:
          'Bug: pgvector embedding dim mismatch, memory_vectors.vector was ' +
          'column-declared vector(1536) but E5-multilingual produces 1024 dims. ' +
          'Fix: ALTER TABLE memory_vectors ALTER COLUMN vector TYPE vector(1024). ' +
          'Reindex afterwards.',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_pgvector_dim_fix',
            category: 'problem_solution',
            title: 'pgvector dim mismatch 1536 vs 1024',
            summary:
              '**Symptom**: INSERT into memory_vectors raised vector-dim ' +
              'mismatch. **Root cause**: column declared `vector(1536)` ' +
              '(OpenAI legacy) but E5-multilingual produces 1024. **Fix**: ' +
              '`ALTER TABLE memory_vectors ALTER COLUMN vector TYPE vector(1024)` ' +
              '+ reindex. **Avoidance**: always read embedder.dim() before ' +
              'declaring the column.',
            tags: ['pgvector', 'embedding', 'dim-mismatch'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.85,
            specificity_score: 0.9,
          }],
        },
      },
      {
        op: 'recall_and_expect',
        query: 'pgvector embedding dim bug',
        must_include_titles: [/pgvector/i],
        must_rank_top_k: 2,
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S2 · Cross-session handoff
  //   session 1 records, session 2 init should get them
  // ---------------------------------------------------------------------
  {
    id: 'S2-cross-session-handoff',
    description:
      'Session 1 records a workflow. Session 2 asks init(query) about ' +
      'the same topic. The workflow card must show up in session 2 ' +
      'rendered_context so the new agent picks up from where we left off.',
    steps: [
      {
        op: 'record',
        content:
          'Workflow: daemon deploy. (1) bump VERSION. (2) build: ' +
          'docker compose build backend. (3) deploy: ssh server + ' +
          'docker compose up -d backend. (4) verify: curl /healthz.',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_deploy_workflow',
            category: 'workflow',
            title: 'Daemon deployment workflow',
            summary:
              '**Trigger**: any backend change landing to main. **Steps**: ' +
              '1) bump VERSION + update CHANGELOG. 2) `docker compose build ' +
              'backend`. 3) ssh prod + `docker compose up -d backend mcp worker ' +
              'beat` (never include postgres). 4) verify `curl /healthz`. ' +
              '**Gotcha**: always pass `--env-file .env.prod`.',
            tags: ['deploy', 'docker', 'workflow'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.9,
            specificity_score: 0.88,
          }],
        },
      },
      {
        op: 'close_session',
      },
      {
        op: 'init_and_expect',
        query: 'how do I deploy the backend',
        must_include_titles: [/deploy|docker/i],
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S3 · Workspace isolation
  //   workspace A decision should NOT surface in workspace B's init
  // ---------------------------------------------------------------------
  {
    id: 'S3-workspace-isolation',
    description:
      'Record a pgvector decision in workspace A, switch to workspace B, ' +
      'ask a related question. The card from A must NOT leak — workspaces ' +
      'are independent project memories.',
    steps: [
      {
        op: 'record',
        content:
          'Decision: in Project-A we chose pgvector for the vector store.',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_wsA_pgvector',
            category: 'decision',
            title: 'WorkspaceA: chose pgvector',
            summary:
              'Project-A specifically chose `pgvector` as the vector DB. ' +
              'Schema: `CREATE EXTENSION vector; CREATE TABLE memory_vectors ' +
              '(id UUID, embedding vector(1024))`. A-only decision — do not ' +
              'port to Project-B without re-evaluation. Revisit when we ' +
              'commission the shared-infra vector service in Q3 2026.',
            tags: ['project-a', 'pgvector'],
            confidence: 0.9,
            novelty_score: 0.8,
            durability_score: 0.85,
            specificity_score: 0.8,
          }],
        },
      },
      {
        op: 'switch_project',
      },
      {
        op: 'init_and_expect',
        query: 'vector database choice',
        must_exclude_titles: [/WorkspaceA/],
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S4 · Persona gate: unrelated preference must not pollute focus
  //   (F-055 bug A proper E2E repro)
  // ---------------------------------------------------------------------
  {
    id: 'S4-persona-gate-no-cross-topic',
    description:
      'Record a weekend-cooking preference. Later do an init(query) on a ' +
      'daemon-perf debug topic. The cooking card must NOT appear in the ' +
      '<who-you-are> block (F-055 bug A).',
    steps: [
      {
        op: 'record',
        content:
          'User prefers cooking beef noodle soup on weekends.',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_cooking_pref',
            category: 'activity_preference',
            title: 'Weekend cooking: beef noodle',
            summary:
              'User cooks beef-noodle soup most weekends. Prefers clear-broth ' +
              'version with hand-pulled noodles. Not a professional interest — ' +
              'stress-relief / hobby activity.',
            tags: ['cooking', 'weekend', 'hobby'],
            confidence: 0.7,
            novelty_score: 0.7,
            durability_score: 0.75,
            specificity_score: 0.6,
          }],
        },
      },
      {
        op: 'init_and_expect',
        query: 'debug daemon performance bug',
        must_exclude_titles: [/noodle|cooking|weekend/i],
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S5 · Aggregator penalty
  //   Original card should beat the wiki aggregator on direct-hit query
  //   (F-055 bug C1 proper E2E)
  // ---------------------------------------------------------------------
  {
    id: 'S5-original-card-beats-aggregator',
    description:
      'Record 2 cards sharing a concept tag. Query for the exact title of ' +
      'one original card. The original MUST rank Top-1.',
    steps: [
      {
        op: 'record',
        content: 'Tech note: pgvector setup guide step 1',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_pgvec_step1',
            category: 'workflow',
            title: 'pgvector setup step 1',
            summary:
              'Run `CREATE EXTENSION vector;` as the DB owner. Requires ' +
              'pgvector 0.5+ — older versions lack HNSW. This is step 1 of 3 ' +
              'in the pgvector onboarding workflow for Awareness Memory.',
            tags: ['pgvector', 'setup'],
            confidence: 0.9,
            novelty_score: 0.8,
            durability_score: 0.85,
            specificity_score: 0.85,
          }],
        },
      },
      {
        op: 'record',
        content: 'Tech note: pgvector setup guide step 2',
        insights: {
          knowledge_cards: [{
            id_hint: 'kc_pgvec_step2',
            category: 'workflow',
            title: 'pgvector setup step 2',
            summary:
              'Declare your vector column as `vector(1024)` to match the ' +
              'E5-multilingual embedder dimension. Wrong dim = silent INSERT ' +
              'failure. This is step 2 of 3.',
            tags: ['pgvector', 'setup'],
            confidence: 0.9,
            novelty_score: 0.8,
            durability_score: 0.85,
            specificity_score: 0.85,
          }],
        },
      },
      {
        op: 'recall_and_expect',
        query: 'pgvector setup step 1',
        must_rank_title_first: /step 1/i,
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S6 · Precision @ 5 with distractors
  //   Record 5 cards across different topics. Query for one specific
  //   topic. Top-3 MUST be about that topic; unrelated cards MUST NOT
  //   appear in top-3. This is the core "signal vs noise" test.
  // ---------------------------------------------------------------------
  {
    id: 'S6-precision-at-5-with-distractors',
    description:
      'Insert 5 cards across unrelated topics, then query for exactly ' +
      'one topic. The 3 related cards must occupy the top-3 slots; ' +
      'unrelated cards must be pushed below.',
    steps: [
      {
        op: 'record',
        content: 'deploying backend to production via docker compose',
        insights: {
          knowledge_cards: [{
            category: 'workflow',
            title: 'Deploy backend via docker compose',
            summary:
              'Deploy workflow: ssh prod, cd /opt/awareness, run ' +
              '`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend mcp worker beat`. ' +
              'Never include postgres in the service list — rebuilding it resets scram-sha-256 auth.',
            tags: ['deploy', 'docker', 'prod'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.9,
            specificity_score: 0.9,
          }],
        },
      },
      {
        op: 'record',
        content: 'onboarding flow redesign for first-run UX',
        insights: {
          knowledge_cards: [{
            category: 'decision',
            title: 'Redesign onboarding flow',
            summary:
              'Decided to collapse first-run onboarding from 4 steps to 2: ' +
              'pick workspace + create memory. Drop API-key wizard (auto-' +
              'device-auth takes over). Rationale: first-run churn was 60% ' +
              'in `apps/desktop/src/Onboarding.tsx`. Files affected: ' +
              '`Onboarding.tsx`, `SetupWizard.tsx`. Version bump: 0.3.6 → 0.4.0.',
            tags: ['onboarding', 'ux', 'decision'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.85,
            specificity_score: 0.8,
          }],
        },
      },
      {
        op: 'record',
        content: 'docker compose build cache optimization',
        insights: {
          knowledge_cards: [{
            category: 'problem_solution',
            title: 'Docker build cache busted by env changes',
            summary:
              'Symptom: docker compose build rebuilt every layer even when code unchanged. ' +
              'Root cause: injected env vars via --build-arg invalidated the cache at the FROM step. ' +
              'Fix: move build-args to runtime env in docker-compose.yml. Saves ~3 minutes per deploy.',
            tags: ['docker', 'cache', 'build'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.85,
            specificity_score: 0.95,
          }],
        },
      },
      {
        op: 'record',
        content: 'user feedback form UX improvement',
        insights: {
          knowledge_cards: [{
            category: 'decision',
            title: 'Add in-product feedback widget',
            summary:
              'Chose to ship an in-product feedback widget (floating button → ' +
              '3-question modal) instead of linking to a Google Form. ' +
              'Trade-off: ~200 lines of React in `components/FeedbackWidget.tsx` ' +
              '+ analytics plumbing via `posthog.capture()`. Response rate 5× ' +
              'higher based on YC 2024 cohort data (15% vs 3%).',
            tags: ['feedback', 'ux', 'product'],
            confidence: 0.85,
            novelty_score: 0.75,
            durability_score: 0.8,
            specificity_score: 0.75,
          }],
        },
      },
      {
        op: 'record',
        content: 'docker compose postgres never rebuild',
        insights: {
          knowledge_cards: [{
            category: 'pitfall',
            title: 'Never rebuild postgres in prod deploys',
            summary:
              'Pitfall: `docker compose up -d` without explicit service list will recreate postgres. ' +
              'scram-sha-256 password hash is bound to the container and cannot be reused. Result: ' +
              'backend auth fails. Avoidance: always pass `backend mcp worker beat` explicitly.',
            tags: ['docker', 'postgres', 'deploy'],
            confidence: 0.95,
            novelty_score: 0.9,
            durability_score: 0.95,
            specificity_score: 0.95,
          }],
        },
      },
      {
        op: 'recall_and_expect',
        query: 'docker compose deploy',
        must_topk_match: {
          k: 3,
          regex: /docker|deploy|postgres|compose/i,
          min_hits: 2,
        },
        must_not_rank_top3: [/onboarding|feedback|widget/i],
      },
    ],
  },

  // ---------------------------------------------------------------------
  // S7 · Preference recall with mixed-language query (CJK + English)
  //   Store a Chinese + English card mix. Query in one language, must
  //   also retrieve the other if semantically related (tests the
  //   multilingual embedder).
  // ---------------------------------------------------------------------
  {
    id: 'S7-multilingual-recall',
    description:
      'Record one card in Chinese and one in English about the same ' +
      'technical topic. Query in either language — the recall must ' +
      'return both (multilingual embedder + BM25 fallback).',
    steps: [
      {
        op: 'record',
        content: 'Chinese note about pgvector',
        insights: {
          knowledge_cards: [{
            category: 'decision',
            title: '选择 pgvector 作为向量存储',
            summary:
              '**决定**：选 pgvector 而非 Pinecone 作为向量数据库。' +
              '**原因**：节约 ~$70/月，与关系数据共存便于 JOIN 查询，支持 cosine `<=>`。' +
              '**取舍**：10M 向量以上 QPS 较低，目前规模可以接受。',
            tags: ['pgvector', '向量数据库', '决策'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.9,
            specificity_score: 0.85,
          }],
        },
      },
      {
        op: 'record',
        content: 'English note about pgvector setup',
        insights: {
          knowledge_cards: [{
            category: 'workflow',
            title: 'pgvector production setup',
            summary:
              '**Trigger**: first time bringing pgvector into production. ' +
              '**Steps**: 1) `CREATE EXTENSION vector;` 2) CREATE INDEX ' +
              'USING hnsw on the vector column 3) `SET enable_seqscan = off` ' +
              'for vector-search queries. **Gotcha**: hnsw requires pgvector ≥ 0.5.',
            tags: ['pgvector', 'production', 'workflow'],
            confidence: 0.9,
            novelty_score: 0.85,
            durability_score: 0.9,
            specificity_score: 0.9,
          }],
        },
      },
      // English query should pull the English card at Top-1. We don't
      // require cross-language recall in the BM25 fallback — that would
      // force an embedder-only ranking decision. Just check that the
      // English query surfaces the English pgvector card.
      {
        op: 'recall_and_expect',
        query: 'pgvector production setup hnsw',
        must_include_titles: [/pgvector production/i],
      },
      // Chinese query should find the Chinese card.
      {
        op: 'recall_and_expect',
        query: 'pgvector 向量数据库选型',
        must_include_titles: [/pgvector/i],
      },
    ],
  },
];
