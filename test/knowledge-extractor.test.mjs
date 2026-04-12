/**
 * knowledge-extractor.test.mjs — Tests for KnowledgeExtractor
 *
 * Covers:
 *   - isStructurallyValidKnowledgeCard() — prose quality gate
 *   - normalizeCategory() — category validation/normalization (tested via processPreExtracted)
 *   - KnowledgeExtractor.processPreExtracted() — Layer 1 agent insights
 *   - KnowledgeExtractor.extractByRules() — Layer 2 regex fallback
 *   - KnowledgeExtractor.extract() — main entry orchestration
 *
 * Uses node:test + node:assert/strict. Mock indexer and store — no disk I/O.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStructurallyValidKnowledgeCard,
  KnowledgeExtractor,
} from '../src/core/knowledge-extractor.mjs';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockIndexer(overrides = {}) {
  return {
    db: {
      prepare: () => ({
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    },
    indexKnowledgeCard: () => {},
    indexTask: () => {},
    getOpenTasks: () => [],
    searchKnowledge: () => [],
    getRecentKnowledge: () => [],
    storeEmbedding: () => {},
    getEmbedding: () => null,
    getAllEmbeddings: () => [],
    supersedeCard: () => false,
    ...overrides,
  };
}

function createMockStore() {
  return {
    awarenessDir: '/tmp/test-awareness',
    saveKnowledgeCard: async () => true,
    saveTask: async () => true,
    saveRisk: async () => true,
  };
}

const baseMeta = {
  id: 'mem_test_001',
  tags: ['test'],
  source: 'unit-test',
};

// ---------------------------------------------------------------------------
// isStructurallyValidKnowledgeCard
// ---------------------------------------------------------------------------

describe('isStructurallyValidKnowledgeCard', () => {
  it('accepts a card with sufficient unique prose tokens (≥5)', () => {
    const card = {
      title: 'Database connection pooling strategy',
      summary: 'Use pgBouncer for connection pooling to reduce overhead on PostgreSQL.',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), true);
  });

  it('rejects a card with too few unique tokens', () => {
    const card = {
      title: 'Test',
      summary: 'ok yes',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), false);
  });

  it('strips code fences before counting prose tokens', () => {
    // The body is mostly a code fence — only the title contributes prose.
    // Title alone: "Config fix" = 2 unique tokens → not enough.
    const card = {
      title: 'Config fix',
      content: '```json\n{"key": "value", "host": "localhost"}\n```',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), false);

    // Now add real prose outside the fence → should pass
    const cardWithProse = {
      title: 'Config fix for production environment',
      content: 'Updated the database config to use connection pooling.\n```json\n{"pool": 10}\n```',
    };
    assert.equal(isStructurallyValidKnowledgeCard(cardWithProse), true);
  });

  it('handles CJK content correctly', () => {
    const card = {
      title: '数据库连接池配置修复',
      summary: '使用 pgBouncer 减少 PostgreSQL 连接开销，提升并发性能。',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), true);
  });

  it('rejects pure metadata/noise like "Request: Sender (untrusted)"', () => {
    // 4 tokens: "request:", "sender", "(untrusted)", and maybe "metadata:" repeated
    const card = {
      title: 'Request: Sender (untrusted metadata):',
      summary: 'Request: Sender (untrusted metadata):',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), false);
  });

  it('rejects a card where title and body share the same few tokens (unique count low)', () => {
    const card = {
      title: 'API key',
      summary: 'API key token',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), false);
  });

  it('accepts a card using content field instead of summary', () => {
    const card = {
      title: 'Webpack configuration for code splitting',
      content: 'Configure dynamic imports and split chunks to reduce bundle size.',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), true);
  });

  it('rejects a card with only whitespace and symbols', () => {
    const card = {
      title: '---',
      summary: '... === ??? !!!',
    };
    assert.equal(isStructurallyValidKnowledgeCard(card), false);
  });

  it('strips inline code backticks before counting', () => {
    // Body prose is minimal; inline code tokens don't count
    const card = {
      title: 'Fix',
      content: 'Use `npm install` then `npm run build` and `npm test` to verify.',
    };
    // After stripping inline code: "Use  then  and  to verify."
    // Unique tokens from title+body: "fix", "use", "then", "and", "to", "verify" = 6 → pass
    assert.equal(isStructurallyValidKnowledgeCard(card), true);
  });
});

// ---------------------------------------------------------------------------
// normalizeCategory — tested indirectly via processPreExtracted
// ---------------------------------------------------------------------------

describe('normalizeCategory (via processPreExtracted)', () => {
  let extractor;

  beforeEach(() => {
    extractor = new KnowledgeExtractor(createMockStore(), createMockIndexer());
  });

  it('valid categories pass through unchanged', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Decided to use PostgreSQL for the main database',
        summary: 'PostgreSQL was chosen over MySQL for its pgvector support and JSON operations.',
        category: 'decision',
      }],
    };
    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].category, 'decision');
  });

  it('invalid category defaults to key_point', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Something interesting about the project architecture',
        summary: 'The architecture uses a layered approach with clear separation of concerns.',
        category: 'nonexistent_category',
      }],
    };
    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards[0].category, 'key_point');
  });

  it('case and whitespace are normalized', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Problem solved: database connection timeout',
        summary: 'Increased the connection timeout from 5s to 30s to fix intermittent failures.',
        category: '  Problem_Solution  ',
      }],
    };
    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards[0].category, 'problem_solution');
  });

  it('null/undefined category defaults to key_point', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Useful information about deployment pipeline',
        summary: 'The pipeline runs lint, test, build, and deploy stages in sequence.',
        category: null,
      }],
    };
    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards[0].category, 'key_point');

    const insights2 = {
      knowledge_cards: [{
        title: 'Another useful fact about the CI system',
        summary: 'CI runs on GitHub Actions with a matrix of Node 18 and Node 20.',
      }],
    };
    const result2 = extractor.processPreExtracted(insights2, baseMeta);
    assert.equal(result2.cards[0].category, 'key_point');
  });

  it('hyphenated categories are normalized with underscore', () => {
    const insights = {
      knowledge_cards: [{
        title: 'User prefers dark mode for all dev tools',
        summary: 'The user indicated a strong preference for dark mode across all interfaces.',
        category: 'personal-preference',
      }],
    };
    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards[0].category, 'personal_preference');
  });
});

// ---------------------------------------------------------------------------
// KnowledgeExtractor.processPreExtracted — Layer 1
// ---------------------------------------------------------------------------

describe('KnowledgeExtractor.processPreExtracted', () => {
  let extractor;

  beforeEach(() => {
    extractor = new KnowledgeExtractor(createMockStore(), createMockIndexer());
  });

  it('creates cards from valid knowledge_cards', () => {
    const insights = {
      knowledge_cards: [
        {
          title: 'Redis caching strategy for session management',
          summary: 'Use Redis with 15-minute TTL for session tokens to reduce DB load.',
          category: 'decision',
          confidence: 0.9,
          tags: ['redis', 'caching'],
        },
        {
          title: 'PostgreSQL connection pooling with pgBouncer',
          content: 'pgBouncer reduces connection overhead significantly for high-concurrency apps.',
          category: 'insight',
        },
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards.length, 2);
    assert.equal(result.cards[0].category, 'decision');
    assert.equal(result.cards[0].confidence, 0.9);
    assert.deepEqual(result.cards[0].tags, ['redis', 'caching']);
    assert.equal(result.cards[0].source_memory_id, 'mem_test_001');
    assert.ok(result.cards[0].id.startsWith('kc_'));
    // Second card uses content field
    assert.equal(result.cards[1].category, 'insight');
    assert.ok(result.cards[1].summary.includes('pgBouncer'));
  });

  it('skips structurally invalid cards', () => {
    const insights = {
      knowledge_cards: [
        { title: 'ok', summary: 'yes' },  // too few tokens
        {
          title: 'Valid card about authentication flow design',
          summary: 'JWT tokens with refresh rotation provide secure stateless authentication.',
          category: 'decision',
        },
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].title, 'Valid card about authentication flow design');
  });

  it('creates tasks from action_items with quality gate', () => {
    const insights = {
      action_items: [
        { title: 'Implement rate limiting on the /api/auth endpoint', priority: 'high' },
        { title: 'Update the deployment documentation for staging', priority: 'low' },
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].title, 'Implement rate limiting on the /api/auth endpoint');
    assert.equal(result.tasks[0].priority, 'high');
    assert.equal(result.tasks[0].status, 'open');
    assert.ok(result.tasks[0].id.startsWith('task_'));
    assert.equal(result.tasks[1].priority, 'low');
  });

  it('skips noise tasks via validateTaskQuality', () => {
    const insights = {
      action_items: [
        { title: 'short' },  // too short (<15 chars)
        { title: 'Request: fetch the latest news from API endpoint' },  // noise pattern
        { title: 'Implement proper error handling for file uploads' },  // valid
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].title, 'Implement proper error handling for file uploads');
  });

  it('deduplicates tasks via checkTaskDedup mock', () => {
    // Create indexer that reports a duplicate for any title containing "authentication"
    const dedupIndexer = createMockIndexer();
    dedupIndexer.db = {
      prepare: (sql) => ({
        get: () => undefined,
        all: () => {
          if (sql.includes("status = 'open'")) {
            return [{ id: 'existing_task', title: 'Fix the authentication flow for users', status: 'open' }];
          }
          return [];
        },
        run: () => ({ changes: 0 }),
      }),
    };

    const ext = new KnowledgeExtractor(createMockStore(), dedupIndexer);

    const insights = {
      action_items: [
        { title: 'Fix the authentication flow for users' },  // exact dup
        { title: 'Add logging to the payment processing service' },  // unique
      ],
    };

    const result = ext.processPreExtracted(insights, baseMeta);
    assert.equal(result.tasks.length, 1);
    assert.ok(result.tasks[0].title.includes('logging'));
  });

  it('creates risks from risks array', () => {
    const insights = {
      risks: [
        { title: 'API rate limit may cause data loss during peak hours', severity: 'high' },
        { title: 'Memory leak in WebSocket handler under sustained load', description: 'Connections not cleaned up' },
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.risks.length, 2);
    assert.equal(result.risks[0].severity, 'high');
    assert.equal(result.risks[0].source_memory_id, 'mem_test_001');
    assert.ok(result.risks[0].id.startsWith('risk_'));
    assert.equal(result.risks[1].severity, 'medium');  // default
    assert.equal(result.risks[1].description, 'Connections not cleaned up');
  });

  it('collects completed_tasks for auto-completion', () => {
    const insights = {
      completed_tasks: [
        { task_id: 'task_abc_123', reason: 'Authentication module shipped' },
        { task_id: 'task_def_456', reason: '' },
        { task_id: '', reason: 'no id' },  // should be ignored (empty task_id)
      ],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.completedTasks.length, 2);
    assert.equal(result.completedTasks[0].task_id, 'task_abc_123');
    assert.equal(result.completedTasks[0].reason, 'Authentication module shipped');
    assert.equal(result.completedTasks[1].task_id, 'task_def_456');
  });

  it('empty insights returns empty arrays', () => {
    const result = extractor.processPreExtracted({}, baseMeta);
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('uses default confidence 0.85 when not provided', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Caching reduces database load significantly',
        summary: 'Adding a Redis cache layer cut query times by 80 percent on the dashboard.',
        category: 'insight',
      }],
    };

    const result = extractor.processPreExtracted(insights, baseMeta);
    assert.equal(result.cards[0].confidence, 0.85);
  });

  it('falls back to metadata.tags when card has no tags', () => {
    const insights = {
      knowledge_cards: [{
        title: 'Deploy with zero-downtime rolling updates',
        summary: 'Use Kubernetes rolling updates strategy for zero-downtime deployments.',
        category: 'workflow',
      }],
    };

    const meta = { ...baseMeta, tags: ['devops', 'k8s'] };
    const result = extractor.processPreExtracted(insights, meta);
    assert.deepEqual(result.cards[0].tags, ['devops', 'k8s']);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeExtractor.extractByRules — Layer 2 fallback
// ---------------------------------------------------------------------------

describe('KnowledgeExtractor.extractByRules', () => {
  let extractor;

  beforeEach(() => {
    extractor = new KnowledgeExtractor(createMockStore(), createMockIndexer());
  });

  it('detects decision patterns in English', () => {
    const result = extractor.extractByRules(
      'We decided to migrate from MySQL to PostgreSQL for better JSON support.',
      baseMeta
    );
    const decisionCards = result.cards.filter((c) => c.category === 'decision');
    assert.ok(decisionCards.length >= 1, 'should detect decision pattern');
  });

  it('detects decision patterns in mixed CJK+ASCII content', () => {
    // Note: \b in JS regex requires \w↔\W boundary; pure CJK chars are \W,
    // so Chinese keywords only trigger when adjacent to ASCII word chars.
    // Real-world CJK content often mixes English terms, making this work.
    const result = extractor.extractByRules(
      'Team switched to Redis for caching, 提升性能。',
      baseMeta
    );
    const decisionCards = result.cards.filter((c) => c.category === 'decision');
    assert.ok(decisionCards.length >= 1, 'should detect decision via "switched to" pattern');
  });

  it('detects problem/solution patterns', () => {
    const result = extractor.extractByRules(
      'Fixed the bug where users could not log in after password reset.',
      baseMeta
    );
    const solutionCards = result.cards.filter((c) => c.category === 'problem_solution');
    assert.ok(solutionCards.length >= 1, 'should detect problem_solution pattern');
  });

  it('detects workflow patterns', () => {
    const result = extractor.extractByRules(
      'Step 1: Configure the database. Step 2: Run migrations. Step 3: Start the server.',
      baseMeta
    );
    const workflowCards = result.cards.filter((c) => c.category === 'workflow');
    assert.ok(workflowCards.length >= 1, 'should detect workflow pattern');
  });

  it('extracts TODO checkboxes as tasks', () => {
    const content = [
      'Some intro text about the project plan:',
      '- [ ] Add unit tests for auth module',
      '- [x] Deploy to staging',
      '- [ ] Write API documentation',
    ].join('\n');

    const result = extractor.extractByRules(content, baseMeta);
    // Only unchecked checkboxes should be extracted
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].title, 'Add unit tests for auth module');
    assert.equal(result.tasks[1].title, 'Write API documentation');
    assert.equal(result.tasks[0].priority, 'medium');
  });

  it('extracts FIXME as high-priority task', () => {
    const content = 'FIXME: memory leak in event listener cleanup causes OOM after 24h';
    const result = extractor.extractByRules(content, baseMeta);
    assert.ok(result.tasks.length >= 1, 'should extract FIXME as task');
    assert.equal(result.tasks[0].priority, 'high');
    assert.ok(result.tasks[0].title.includes('memory leak'));
  });

  it('extracts TODO as medium-priority task', () => {
    const content = 'TODO: add pagination to the /api/users endpoint';
    const result = extractor.extractByRules(content, baseMeta);
    assert.ok(result.tasks.length >= 1);
    assert.equal(result.tasks[0].priority, 'medium');
  });

  it('extracts risk/warning patterns', () => {
    const content = 'Warning: the current implementation has no rate limiting on the auth endpoint.';
    const result = extractor.extractByRules(content, baseMeta);
    assert.ok(result.risks.length >= 1, 'should extract risk from warning pattern');
    assert.ok(result.risks[0].title.includes('rate limiting'));
  });

  it('infers high severity for danger/critical keywords', () => {
    const content = 'Danger: credentials are stored in plaintext in the config file.';
    const result = extractor.extractByRules(content, baseMeta);
    assert.ok(result.risks.length >= 1);
    assert.equal(result.risks[0].severity, 'high');
  });

  it('infers medium severity for warning/caution keywords', () => {
    const content = 'Caution: this API endpoint has no input validation.';
    const result = extractor.extractByRules(content, baseMeta);
    assert.ok(result.risks.length >= 1);
    assert.equal(result.risks[0].severity, 'medium');
  });

  it('avoids double-tagging: workflow NOT added if decision already matched', () => {
    // Content matches both decision ("decided") and workflow ("first", "then")
    const content = 'We decided to restructure the pipeline. First we remove the old code, then deploy the new version.';
    const result = extractor.extractByRules(content, baseMeta);
    const categories = result.cards.map((c) => c.category);
    assert.ok(categories.includes('decision'), 'should tag as decision');
    assert.ok(!categories.includes('workflow'), 'should NOT double-tag as workflow');
  });

  it('empty content returns empty arrays', () => {
    const result = extractor.extractByRules('', baseMeta);
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('null content returns empty arrays', () => {
    const result = extractor.extractByRules(null, baseMeta);
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('non-string content returns empty arrays', () => {
    const result = extractor.extractByRules(12345, baseMeta);
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('rule-based cards have confidence 0.7', () => {
    const result = extractor.extractByRules(
      'Resolved the timeout issue by increasing the connection pool size.',
      baseMeta
    );
    assert.ok(result.cards.length >= 1);
    assert.equal(result.cards[0].confidence, 0.7);
  });
});

// ---------------------------------------------------------------------------
// KnowledgeExtractor.extract — main entry
// ---------------------------------------------------------------------------

describe('KnowledgeExtractor.extract', () => {
  let extractor;
  let persistCalls;

  beforeEach(() => {
    // Stub _persistAll to avoid disk I/O and track calls
    persistCalls = [];
    extractor = new KnowledgeExtractor(createMockStore(), createMockIndexer());
    extractor._persistAll = async (result, metadata) => {
      persistCalls.push({ result, metadata });
    };
  });

  it('uses Layer 1 (pre-extracted insights) when available', async () => {
    const insights = {
      knowledge_cards: [{
        title: 'Switched from REST to GraphQL for the dashboard API',
        summary: 'GraphQL reduces over-fetching and enables flexible client queries.',
        category: 'decision',
      }],
    };

    const result = await extractor.extract(
      'We migrated from REST to GraphQL.',
      baseMeta,
      insights
    );
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].category, 'decision');
    // Verify _persistAll was called
    assert.equal(persistCalls.length, 1);
  });

  it('falls back to Layer 2 (rules) when no insights provided', async () => {
    const result = await extractor.extract(
      'Fixed the authentication bug that caused login failures.',
      baseMeta,
      null
    );
    // Rule engine should pick up "Fixed" + "bug" → problem_solution
    const solutionCards = result.cards.filter((c) => c.category === 'problem_solution');
    assert.ok(solutionCards.length >= 1, 'should fall back to rule engine');
  });

  it('falls back to Layer 2 when insights object is empty', async () => {
    const result = await extractor.extract(
      'Decided to use TypeScript for all new modules.',
      baseMeta,
      {}  // empty insights, _hasInsights returns false
    );
    const decisionCards = result.cards.filter((c) => c.category === 'decision');
    assert.ok(decisionCards.length >= 1, 'should fall back to rules for empty insights');
  });

  it('skips rule engine for tool_use metadata type', async () => {
    const result = await extractor.extract(
      'Fixed a critical bug in the deployment pipeline.',
      { ...baseMeta, type: 'tool_use' },
      null
    );
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('skips rule engine for code_change metadata type', async () => {
    const result = await extractor.extract(
      'Decided to refactor the entire auth module.',
      { ...baseMeta, type: 'code_change' },
      null
    );
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('skips rule engine for session_checkpoint metadata type', async () => {
    const result = await extractor.extract(
      'Warning: potential memory leak detected in worker process.',
      { ...baseMeta, type: 'session_checkpoint' },
      null
    );
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.risks, []);
  });

  it('prefers Layer 1 over Layer 2 even if content has rule-matching patterns', async () => {
    // Content matches rule patterns, but insights are provided → use insights only
    const insights = {
      knowledge_cards: [{
        title: 'Migrated the deployment to Kubernetes cluster',
        summary: 'K8s provides better scaling and rolling updates than bare Docker Compose.',
        category: 'workflow',
      }],
    };

    const result = await extractor.extract(
      'We decided to fix the bug. Step 1 is to identify the root cause. Warning: the risk is high.',
      baseMeta,
      insights
    );
    // Only 1 card from insights, not additional cards from rules
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].category, 'workflow');
  });
});

// ---------------------------------------------------------------------------
// _checkConflict merge verdict tests (vector cosine simulation)
// ---------------------------------------------------------------------------

describe('KnowledgeExtractor._checkConflict merge verdict', () => {
  /** Create a mock embedder that returns predictable cosine similarities. */
  function createMockEmbedder(similarityMap = {}) {
    // Simple: embed returns a fixed vector based on the first word
    const vectors = new Map();
    let dim = 4;
    return {
      MODEL_MAP: { english: 'mock-model' },
      async isEmbeddingAvailable() { return true; },
      async embed(text) {
        if (!vectors.has(text)) {
          // Random-ish but deterministic per text
          const seed = [...text].reduce((s, c) => s + c.charCodeAt(0), 0);
          vectors.set(text, new Float32Array([
            Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 3),
          ]));
        }
        return vectors.get(text);
      },
      cosineSimilarity(a, b) {
        // Use the similarity map if available, else compute real cosine
        const key = `${a[0].toFixed(2)}_${b[0].toFixed(2)}`;
        if (similarityMap[key] !== undefined) return similarityMap[key];
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2;
        }
        const d = Math.sqrt(na) * Math.sqrt(nb);
        return d === 0 ? 0 : dot / d;
      },
    };
  }

  it('returns merge verdict when cosine >= 0.70, same category, and tags overlap', async () => {
    const existingCard = {
      id: 'kc_existing_001',
      title: 'Docker optimization guide',
      summary: 'Docker multi-stage builds reduce image size.',
      category: 'workflow',
      tags: JSON.stringify(['docker', 'optimization']),
      status: 'active',
    };

    // Embedder that forces high similarity for any pair
    const embedder = createMockEmbedder();
    // Override cosineSimilarity to return 0.75 (merge zone)
    embedder.cosineSimilarity = () => 0.75;

    const indexer = createMockIndexer({
      searchKnowledge: () => [],  // BM25 finds nothing
      getRecentKnowledge: () => [existingCard],
    });

    const extractor = new KnowledgeExtractor(createMockStore(), indexer, embedder);
    const result = await extractor._checkConflict({
      title: 'Docker build best practices',
      summary: 'Multi-stage builds separate compilation from runtime.',
      category: 'workflow',
      tags: ['docker', 'optimization'],
    });

    assert.equal(result.verdict, 'merge');
    assert.equal(result.matchId, 'kc_existing_001');
  });

  it('returns new when cosine >= 0.70 but tags do NOT overlap', async () => {
    const existingCard = {
      id: 'kc_existing_002',
      title: 'Docker optimization guide',
      summary: 'Docker stuff.',
      category: 'workflow',
      tags: JSON.stringify(['docker', 'optimization']),
      status: 'active',
    };

    const embedder = createMockEmbedder();
    embedder.cosineSimilarity = () => 0.75;

    const indexer = createMockIndexer({
      searchKnowledge: () => [],
      getRecentKnowledge: () => [existingCard],
    });

    const extractor = new KnowledgeExtractor(createMockStore(), indexer, embedder);
    const result = await extractor._checkConflict({
      title: 'Kubernetes deployment',
      summary: 'K8s rolling updates.',
      category: 'workflow',
      tags: ['kubernetes', 'deployment'],  // no overlap with docker/optimization
    });

    assert.equal(result.verdict, 'new');
  });

  it('returns merge in 0.85+ zone when new summary is shorter and tags overlap', async () => {
    const existingCard = {
      id: 'kc_existing_003',
      title: 'Docker optimization guide',
      summary: 'A very long and detailed summary about Docker multi-stage builds and optimization techniques.',
      category: 'workflow',
      tags: JSON.stringify(['docker', 'optimization']),
      status: 'active',
    };

    const embedder = createMockEmbedder();
    embedder.cosineSimilarity = () => 0.88;  // update zone

    const indexer = createMockIndexer({
      searchKnowledge: () => [],
      getRecentKnowledge: () => [existingCard],
    });

    const extractor = new KnowledgeExtractor(createMockStore(), indexer, embedder);
    const result = await extractor._checkConflict({
      title: 'Docker build tips',
      summary: 'Short tip.',  // shorter than existing
      category: 'workflow',
      tags: ['docker'],  // overlaps with existing
    });

    assert.equal(result.verdict, 'merge');
    assert.equal(result.matchId, 'kc_existing_003');
  });

  it('returns update in 0.85+ zone when new summary is longer', async () => {
    const existingCard = {
      id: 'kc_existing_004',
      title: 'Docker optimization',
      summary: 'Short.',
      category: 'workflow',
      tags: JSON.stringify(['docker']),
      status: 'active',
    };

    const embedder = createMockEmbedder();
    embedder.cosineSimilarity = () => 0.88;

    const indexer = createMockIndexer({
      searchKnowledge: () => [],
      getRecentKnowledge: () => [existingCard],
    });

    const extractor = new KnowledgeExtractor(createMockStore(), indexer, embedder);
    const result = await extractor._checkConflict({
      title: 'Docker optimization expanded',
      summary: 'A much longer and more detailed summary that supersedes the short existing one.',
      category: 'workflow',
      tags: ['docker'],
    });

    assert.equal(result.verdict, 'update');
  });

  it('returns new when cosine < 0.70', async () => {
    const existingCard = {
      id: 'kc_existing_005',
      title: 'Docker stuff',
      summary: 'Something about Docker.',
      category: 'workflow',
      tags: JSON.stringify(['docker']),
      status: 'active',
    };

    const embedder = createMockEmbedder();
    embedder.cosineSimilarity = () => 0.55;

    const indexer = createMockIndexer({
      searchKnowledge: () => [],
      getRecentKnowledge: () => [existingCard],
    });

    const extractor = new KnowledgeExtractor(createMockStore(), indexer, embedder);
    const result = await extractor._checkConflict({
      title: 'PostgreSQL query optimization',
      summary: 'Index design for large tables.',
      category: 'workflow',
      tags: ['docker'],
    });

    assert.equal(result.verdict, 'new');
  });

  it('skips vector check when no embedder', async () => {
    const indexer = createMockIndexer({ searchKnowledge: () => [] });
    const extractor = new KnowledgeExtractor(createMockStore(), indexer, null);
    const result = await extractor._checkConflict({
      title: 'Anything',
      summary: 'Whatever.',
      category: 'workflow',
      tags: [],
    });
    assert.equal(result.verdict, 'new');
  });
});
