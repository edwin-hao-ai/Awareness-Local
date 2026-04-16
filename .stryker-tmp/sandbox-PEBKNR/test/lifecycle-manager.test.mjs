/**
 * lifecycle-manager.test.mjs — Tests for Smart Lifecycle Manager
 *
 * F-031 Phase 1: task quality validation, dedup, auto-resolve, auto-mitigate, garbage collection.
 * Uses node:test + node:assert/strict with in-memory SQLite mock.
 */
// @ts-nocheck


import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runLifecycleChecks,
  checkTaskDedup,
  validateTaskQuality,
} from '../src/core/lifecycle-manager.mjs';

// ---------------------------------------------------------------------------
// Mock indexer — minimal SQLite-like stub with in-memory state
// ---------------------------------------------------------------------------

function createMockIndexer() {
  const tasks = [];
  const knowledgeCards = [];

  const indexer = {
    db: {
      prepare(sql) {
        return {
          all(...args) {
            // tasks_fts MATCH for task auto-resolve (must be before generic 'FROM tasks' check)
            if (sql.includes('tasks_fts') && sql.includes('MATCH')) {
              const query = (args[0] || '').toLowerCase();
              const queryWords = new Set(
                query.split(/\s+or\s+/i).map(w => w.trim().toLowerCase()).filter(w => w.length >= 3)
              );
              return tasks
                .filter((t) => t.status === 'open')
                .map((t) => {
                  const taskText = `${t.title || ''} ${t.description || ''}`.toLowerCase();
                  const taskWords = taskText.split(/\s+/);
                  let matches = 0;
                  for (const w of queryWords) {
                    if (taskWords.some(tw => tw.includes(w))) matches++;
                  }
                  // Require at least 2 keyword matches for a meaningful FTS hit
                  return { ...t, rank: matches >= 2 ? -10 * matches : 0 };
                })
                .filter((t) => t.rank < 0)
                .sort((a, b) => a.rank - b.rank)
                .slice(0, 3);
            }
            // SELECT ... FROM tasks WHERE status = 'open'
            if (sql.includes('FROM tasks') && sql.includes("status = 'open'")) {
              return tasks.filter((t) => t.status === 'open');
            }
            // SELECT * FROM tasks WHERE id = ?
            if (sql.includes('FROM tasks') && sql.includes('WHERE id')) {
              return tasks.filter((t) => t.id === args[0]);
            }
            // knowledge_fts MATCH for pitfall/risk
            if (sql.includes('knowledge_fts') && sql.includes('pitfall')) {
              const query = (args[0] || '').toLowerCase();
              const queryWords = new Set(
                query.split(/\s+or\s+/i).map(w => w.trim().toLowerCase()).filter(w => w.length >= 3)
              );
              return knowledgeCards
                .filter((kc) =>
                  kc.status === 'active' &&
                  ['pitfall', 'risk'].includes(kc.category)
                )
                .map((kc) => {
                  const cardText = `${kc.title} ${kc.summary || ''}`.toLowerCase();
                  const cardWords = cardText.split(/\s+/);
                  let matches = 0;
                  for (const w of queryWords) {
                    if (cardWords.some(cw => cw.includes(w))) matches++;
                  }
                  return { ...kc, rank: matches >= 2 ? -10 * matches : 0 };
                })
                .filter((kc) => kc.rank < 0)
                .sort((a, b) => a.rank - b.rank)
                .slice(0, 3);
            }
            return [];
          },
          get(...args) {
            // SELECT * FROM tasks WHERE id = ?
            if (sql.includes('FROM tasks') && sql.includes('WHERE id')) {
              return tasks.find((t) => t.id === args[0]) || null;
            }
            // Fallback: try to find by id in tasks
            if (sql.includes('FROM tasks')) {
              return tasks.find((t) => t.id === args[0]) || null;
            }
            return null;
          },
          run(...args) {
            // UPDATE tasks SET status = 'archived' WHERE id = ?
            if (sql.includes('UPDATE tasks') && sql.includes("'archived'") && sql.includes('WHERE id')) {
              const id = args[args.length - 1];
              const task = tasks.find((t) => t.id === id);
              if (task) {
                task.status = 'archived';
                task.updated_at = args[0];
                return { changes: 1 };
              }
              return { changes: 0 };
            }
            // UPDATE tasks SET status = 'archived' (bulk stale)
            if (sql.includes('UPDATE tasks') && sql.includes("'archived'")) {
              let changes = 0;
              const cutoff = args[1];
              for (const t of tasks) {
                if (t.status === 'open' && t.updated_at < cutoff && t.created_at < cutoff) {
                  t.status = 'archived';
                  changes++;
                }
              }
              return { changes };
            }
            // UPDATE knowledge_cards SET status = 'resolved'
            if (sql.includes('UPDATE knowledge_cards') && sql.includes("'resolved'")) {
              const id = args[args.length - 1];
              const card = knowledgeCards.find((kc) => kc.id === id);
              if (card) {
                card.status = 'resolved';
                return { changes: 1 };
              }
              return { changes: 0 };
            }
            // UPDATE knowledge_cards SET status = 'archived'
            if (sql.includes('UPDATE knowledge_cards') && sql.includes("'archived'")) {
              let changes = 0;
              const cutoff = args[1];
              for (const kc of knowledgeCards) {
                if (
                  kc.status === 'active' &&
                  ['pitfall', 'risk'].includes(kc.category) &&
                  kc.confidence < 0.6 &&
                  kc.updated_at < cutoff &&
                  kc.created_at < cutoff
                ) {
                  kc.status = 'archived';
                  changes++;
                }
              }
              return { changes };
            }
            return { changes: 0 };
          },
        };
      },
    },
    indexTask(taskData) {
      const existing = tasks.find((t) => t.id === taskData.id);
      if (existing) {
        Object.assign(existing, taskData);
      } else {
        tasks.push({ ...taskData });
      }
    },
    _tasks: tasks,
    _knowledgeCards: knowledgeCards,
  };

  return indexer;
}

// ---------------------------------------------------------------------------
// validateTaskQuality
// ---------------------------------------------------------------------------

describe('validateTaskQuality', () => {
  it('rejects null/undefined titles', async () => {
    assert.equal(validateTaskQuality(null), 'empty_title');
    assert.equal(validateTaskQuality(undefined), 'empty_title');
    assert.equal(validateTaskQuality(''), 'empty_title');
  });

  it('rejects titles shorter than 15 chars', async () => {
    assert.equal(validateTaskQuality('short'), 'too_short');
    assert.equal(validateTaskQuality('too small task'), 'too_short');
  });

  it('accepts valid titles of sufficient length', async () => {
    assert.equal(validateTaskQuality('Implement user authentication flow'), null);
    assert.equal(validateTaskQuality('Fix the database connection bug'), null);
  });

  it('rejects noise patterns — er/hacker news', async () => {
    assert.equal(
      validateTaskQuality('er News 前几条技术新闻非常有意思'),
      'noise_pattern'
    );
    assert.equal(
      validateTaskQuality('Hacker News RSS feed is unavailable'),
      'noise_pattern'
    );
  });

  it('rejects noise patterns — request/result prefix', async () => {
    assert.equal(validateTaskQuality('Request: fetch the latest data'), 'noise_pattern');
    assert.equal(validateTaskQuality('Result: output from the server'), 'noise_pattern');
  });

  it('rejects noise patterns — curl command', async () => {
    assert.equal(
      validateTaskQuality('The `curl` command is not working correctly'),
      'noise_pattern'
    );
  });

  it('rejects URL-only titles (caught by noise pattern)', async () => {
    assert.equal(validateTaskQuality('https://example.com/some/path'), 'noise_pattern');
  });

  it('accepts URLs with description text', async () => {
    assert.equal(
      validateTaskQuality('https://example.com check this page for errors'),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// checkTaskDedup
// ---------------------------------------------------------------------------

describe('checkTaskDedup', () => {
  let indexer;

  beforeEach(() => {
    indexer = createMockIndexer();
  });

  it('returns false for empty indexer', async () => {
    const result = checkTaskDedup(null, 'some task title here');
    assert.equal(result.isDuplicate, false);
  });

  it('returns false for very short titles', async () => {
    const result = checkTaskDedup(indexer, 'hi');
    assert.equal(result.isDuplicate, false);
  });

  it('detects exact title match (case-insensitive)', async () => {
    indexer._tasks.push({
      id: 'task_001',
      title: 'Fix the authentication bug in login',
      status: 'open',
    });

    const result = checkTaskDedup(indexer, 'fix the authentication bug in login');
    assert.equal(result.isDuplicate, true);
    assert.equal(result.existingTaskId, 'task_001');
  });

  it('detects word-overlap duplicate (≥50% Jaccard)', async () => {
    indexer._tasks.push({
      id: 'task_002',
      title: 'Implement user authentication with JWT tokens',
      status: 'open',
    });

    // High overlap — shares most significant words
    const result = checkTaskDedup(
      indexer,
      'Implement user authentication using JWT tokens for the API'
    );
    assert.equal(result.isDuplicate, true);
    assert.equal(result.existingTaskId, 'task_002');
  });

  it('does not flag unrelated tasks as duplicates', async () => {
    indexer._tasks.push({
      id: 'task_003',
      title: 'Fix the database connection pooling issue',
      status: 'open',
    });

    const result = checkTaskDedup(
      indexer,
      'Add new REST API endpoint for user profiles'
    );
    assert.equal(result.isDuplicate, false);
  });

  it('ignores non-open tasks', async () => {
    indexer._tasks.push({
      id: 'task_004',
      title: 'Fix the authentication bug exactly',
      status: 'done',
    });

    const result = checkTaskDedup(indexer, 'Fix the authentication bug exactly');
    assert.equal(result.isDuplicate, false);
  });
});

// ---------------------------------------------------------------------------
// runLifecycleChecks — garbage collection
// ---------------------------------------------------------------------------

describe('runLifecycleChecks — garbage collection', () => {
  let indexer;

  beforeEach(() => {
    indexer = createMockIndexer();
  });

  it('returns empty result for null indexer', async () => {
    const result = await runLifecycleChecks(null, 'content', 'title');
    assert.deepEqual(result, {
      resolved_tasks: [],
      mitigated_risks: [],
      archived: 0,
      deduped: 0,
    });
  });

  it('archives noise tasks matching NOISE_TASK_PATTERNS', async () => {
    indexer._tasks.push(
      { id: 't1', title: 'er News 前几条技术新闻', status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 't2', title: 'Implement proper error handling', status: 'open', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    );

    const result = await runLifecycleChecks(indexer, 'some content', 'title');
    assert.equal(result.archived >= 1, true, 'should archive at least 1 noise task');
    assert.equal(indexer._tasks.find((t) => t.id === 't1').status, 'archived');
    assert.equal(indexer._tasks.find((t) => t.id === 't2').status, 'open');
  });

  it('archives stale tasks older than 14 days', async () => {
    const oldDate = new Date(Date.now() - 20 * 86400000).toISOString();
    indexer._tasks.push({
      id: 't_stale',
      title: 'A valid but very stale task title here',
      status: 'open',
      created_at: oldDate,
      updated_at: oldDate,
    });

    const result = await runLifecycleChecks(indexer, 'some content', 'title');
    assert.equal(result.archived >= 1, true);
    assert.equal(indexer._tasks.find((t) => t.id === 't_stale').status, 'archived');
  });

  it('archives stale risk/pitfall cards with low confidence', async () => {
    const oldDate = new Date(Date.now() - 35 * 86400000).toISOString(); // 35 days ago (> 30 day threshold)
    indexer._knowledgeCards.push({
      id: 'kc_stale_pitfall',
      title: 'Potential memory leak in event listener cleanup',
      summary: 'Event listeners may not be removed on component unmount',
      category: 'pitfall',
      status: 'active',
      confidence: 0.4, // Below the 0.6 threshold
      created_at: oldDate,
      updated_at: oldDate,
    });

    const result = await runLifecycleChecks(indexer, 'some unrelated content', 'unrelated title');
    assert.equal(result.archived >= 1, true,
      'should archive at least 1 stale low-confidence pitfall card');
    assert.equal(
      indexer._knowledgeCards.find((kc) => kc.id === 'kc_stale_pitfall').status,
      'archived'
    );
  });

  it('does NOT archive recent valid tasks', async () => {
    const now = new Date().toISOString();
    indexer._tasks.push({
      id: 't_fresh',
      title: 'A perfectly valid recent task title',
      status: 'open',
      created_at: now,
      updated_at: now,
    });

    await runLifecycleChecks(indexer, 'some content', 'title');
    assert.equal(indexer._tasks.find((t) => t.id === 't_fresh').status, 'open');
  });
});

// ---------------------------------------------------------------------------
// runLifecycleChecks — task auto-resolve
// ---------------------------------------------------------------------------

describe('runLifecycleChecks — task auto-resolve', () => {
  let indexer;

  beforeEach(() => {
    indexer = createMockIndexer();
  });

  it('does NOT resolve tasks when no completion signal in content', async () => {
    indexer._tasks.push({
      id: 'task_auth',
      title: 'Fix the authentication bug in login flow',
      status: 'open',
      description: 'authentication login flow bug',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Working on authentication bug in login flow',
      'auth work'
    );
    assert.deepEqual(result.resolved_tasks, []);
    assert.equal(indexer._tasks.find((t) => t.id === 'task_auth').status, 'open');
  });

  it('auto-resolves task when content has completion signal + word overlap', async () => {
    indexer._tasks.push({
      id: 'task_auth',
      title: 'Fix authentication bug in login',
      status: 'open',
      description: 'authentication login bug fix',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Fixed authentication bug in login flow. Done.',
      'authentication login fix'
    );
    assert.equal(result.resolved_tasks.length >= 1, true, 'should resolve at least 1 task');
    assert.equal(indexer._tasks.find((t) => t.id === 'task_auth').status, 'done');
  });

  it('does NOT resolve unrelated tasks even with completion signal', async () => {
    indexer._tasks.push({
      id: 'task_db',
      title: 'Fix database connection pooling issue',
      status: 'open',
      description: 'database pooling',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Completed the UI redesign for the settings page.',
      'UI redesign done'
    );
    assert.deepEqual(result.resolved_tasks, []);
    assert.equal(indexer._tasks.find((t) => t.id === 'task_db').status, 'open');
  });

  it('auto-resolve limits to 3 tasks maximum', async () => {
    const now = new Date().toISOString();
    // Create 5 open tasks that all share significant word overlap with the content
    for (let i = 1; i <= 5; i++) {
      indexer._tasks.push({
        id: `task_limit_${i}`,
        title: `Fix authentication login validation error handler ${i}`,
        status: 'open',
        description: 'authentication login validation error handler',
        created_at: now,
        updated_at: now,
      });
    }

    // Content has completion signal ("Fixed") and shares high Jaccard overlap with all 5 tasks
    const result = await runLifecycleChecks(
      indexer,
      'Fixed the authentication login validation error handler completely. Done.',
      'authentication login validation error handler fixed'
    );
    assert.equal(result.resolved_tasks.length, 3,
      'should resolve exactly 3 tasks (the hard limit), not all 5');
    // Verify that exactly 3 tasks became 'done' and 2 remain 'open'
    const doneTasks = indexer._tasks.filter(
      (t) => t.id.startsWith('task_limit_') && t.status === 'done'
    );
    const openTasks = indexer._tasks.filter(
      (t) => t.id.startsWith('task_limit_') && t.status === 'open'
    );
    assert.equal(doneTasks.length, 3);
    assert.equal(openTasks.length, 2);
  });

  it('supports Chinese completion signals with space-separated terms', async () => {
    // Note: Jaccard works on whitespace-separated tokens, so CJK terms need spaces
    indexer._tasks.push({
      id: 'task_cn',
      title: '实现 用户认证 功能 登录流程',
      status: 'open',
      description: '用户认证 登录 流程',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      '已完成 用户认证 登录流程 实现',
      '用户认证 已完成'
    );
    assert.equal(result.resolved_tasks.length >= 1, true, 'should resolve Chinese task');
  });
});

// ---------------------------------------------------------------------------
// runLifecycleChecks — risk auto-mitigate
// ---------------------------------------------------------------------------

describe('runLifecycleChecks — risk auto-mitigate', () => {
  let indexer;

  beforeEach(() => {
    indexer = createMockIndexer();
  });

  it('does NOT mitigate risks when no mitigation signal', async () => {
    indexer._knowledgeCards.push({
      id: 'kc_risk1',
      title: 'SQL injection vulnerability in user input',
      summary: 'SQL injection risk in user input handling',
      category: 'pitfall',
      status: 'active',
      confidence: 0.8,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Looking at the SQL injection issue in user input',
      'investigating SQL'
    );
    assert.deepEqual(result.mitigated_risks, []);
  });

  it('auto-mitigates risk when content has mitigation signal + FTS match', async () => {
    indexer._knowledgeCards.push({
      id: 'kc_risk2',
      title: 'SQL injection vulnerability in user input',
      summary: 'SQL injection risk from unsanitized user input',
      category: 'pitfall',
      status: 'active',
      confidence: 0.8,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Fixed the SQL injection vulnerability by adding parameterized queries for all user input.',
      'SQL injection fixed'
    );
    assert.equal(result.mitigated_risks.length >= 1, true);
    assert.equal(indexer._knowledgeCards.find((kc) => kc.id === 'kc_risk2').status, 'resolved');
  });

  it('does not mitigate non pitfall/risk category cards', async () => {
    indexer._knowledgeCards.push({
      id: 'kc_insight',
      title: 'SQL best practices for performance',
      summary: 'SQL optimization techniques',
      category: 'insight',
      status: 'active',
      confidence: 0.9,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Fixed all SQL performance issues using index optimization.',
      'SQL fixed'
    );
    assert.deepEqual(result.mitigated_risks, []);
  });

  it('_sanitizeFts lowercases to avoid FTS5 reserved words', async () => {
    // "NOT" is an FTS5 reserved word that would break MATCH if not lowercased.
    // We test indirectly: content containing "NOT important SQL injection" should
    // still match a pitfall card about SQL injection (because _sanitizeFts lowercases
    // "NOT" to "not", turning it into an ordinary search term joined with OR).
    indexer._knowledgeCards.push({
      id: 'kc_fts_reserved',
      title: 'SQL injection vulnerability in user input',
      summary: 'important SQL injection risk from unsanitized input',
      category: 'pitfall',
      status: 'active',
      confidence: 0.9,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Content has mitigation signal ("fixed") and words "NOT important SQL injection"
    const result = await runLifecycleChecks(
      indexer,
      'Fixed the NOT important SQL injection issue by adding parameterized queries.',
      'NOT important SQL injection fixed'
    );
    // The key assertion: mitigation still works because _sanitizeFts lowercased "NOT"
    // so FTS5 treats it as a regular token, not the boolean operator
    assert.equal(result.mitigated_risks.length >= 1, true,
      '_sanitizeFts should lowercase FTS5 reserved words so matching still works');
    assert.equal(
      indexer._knowledgeCards.find((kc) => kc.id === 'kc_fts_reserved').status,
      'resolved'
    );
  });
});


// ---------------------------------------------------------------------------
// Hybrid search scenarios — RRF fusion (FTS5 + Jaccard proxy)
// ---------------------------------------------------------------------------

describe('runLifecycleChecks — hybrid scenarios', () => {
  let indexer;

  beforeEach(() => {
    indexer = createMockIndexer();
  });

  it('resolves task with partial keyword overlap via RRF boost', async () => {
    // Task uses different wording but same topic. FTS5 gives weak match,
    // Jaccard gives some overlap → RRF fusion combines both signals.
    indexer._tasks.push({
      id: 'task_deploy',
      title: 'Deploy the recall_count migration to production server',
      status: 'open',
      description: 'production deployment recall_count migration',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Completed the recall_count migration deployment to production. Done.',
      'recall_count deployment done'
    );
    assert.equal(result.resolved_tasks.length >= 1, true,
      'should resolve via RRF even with partial keyword overlap');
  });

  it('does NOT resolve task when content is about a completely different topic', async () => {
    indexer._tasks.push({
      id: 'task_frontend',
      title: 'Refactor the React dashboard component',
      status: 'open',
      description: 'React dashboard component refactor',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Fixed the Docker nginx upstream DNS resolution issue. Done.',
      'nginx DNS fix done'
    );
    assert.deepEqual(result.resolved_tasks, [],
      'should NOT resolve unrelated task even with completion signal');
  });

  it('resolves most relevant task when multiple open tasks exist', async () => {
    const now = new Date().toISOString();
    indexer._tasks.push(
      {
        id: 'task_db',
        title: 'Fix database connection pooling timeout',
        status: 'open',
        description: 'database pooling timeout fix',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'task_auth',
        title: 'Implement OAuth2 authentication flow',
        status: 'open',
        description: 'OAuth2 authentication implementation',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'task_css',
        title: 'Fix CSS layout issue on mobile',
        status: 'open',
        description: 'CSS mobile layout fix',
        created_at: now,
        updated_at: now,
      }
    );

    const result = await runLifecycleChecks(
      indexer,
      'Fixed the database connection pooling timeout by adjusting pool size. Done.',
      'database pooling fix'
    );
    assert.equal(result.resolved_tasks.includes('task_db'), true,
      'should resolve the matching database task');
    assert.equal(result.resolved_tasks.includes('task_auth'), false,
      'should NOT resolve unrelated auth task');
    assert.equal(result.resolved_tasks.includes('task_css'), false,
      'should NOT resolve unrelated CSS task');
  });

  it('mitigates risk with Chinese content', async () => {
    indexer._knowledgeCards.push({
      id: 'kc_risk_cn',
      title: 'Nginx DNS 缓存导致 upstream 解析失败',
      summary: 'Nginx DNS 缓存问题导致容器重启后 upstream 解析失败',
      category: 'pitfall',
      status: 'active',
      confidence: 0.8,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      '已修复 Nginx DNS 缓存问题，添加 resolver 127.0.0.11 valid=10s 配置',
      'Nginx DNS 已修复'
    );
    assert.equal(result.mitigated_risks.length >= 1, true,
      'should mitigate Chinese risk card');
    assert.equal(indexer._knowledgeCards.find((kc) => kc.id === 'kc_risk_cn').status, 'resolved');
  });

  it('handles empty task/risk lists gracefully', async () => {
    // No tasks or risks exist — should return empty results without errors
    const result = await runLifecycleChecks(
      indexer,
      'Completed all the work. Everything is done and fixed.',
      'all done'
    );
    assert.deepEqual(result.resolved_tasks, []);
    assert.deepEqual(result.mitigated_risks, []);
    assert.equal(result.archived, 0);
  });

  it('does not auto-resolve done tasks (already closed)', async () => {
    indexer._tasks.push({
      id: 'task_already_done',
      title: 'Fix the authentication bug in login',
      status: 'done',
      description: 'authentication login bug fix',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await runLifecycleChecks(
      indexer,
      'Fixed authentication bug in login flow. Done.',
      'authentication login fix'
    );
    assert.deepEqual(result.resolved_tasks, [],
      'should not re-resolve already done tasks');
  });
});
