/**
 * Locks the AwarenessClaw envelope-strip fix in daemon._remember (2026-04-18).
 *
 * User screenshot showed 3 knowledge-card titles all starting with
 * "Request:" — the envelope prefix leaked from AwarenessClaw desktop's
 * `Request: X\nResult: Y` chat turn_briefs because `_remember` only called
 * `classifyNoiseEvent` (skip-or-keep judgment), never `cleanContent`
 * (strip envelope). These tests verify:
 *
 *   1. envelope is stripped from persisted content
 *   2. auto-generated title does NOT start with "Request:"
 *   3. user-provided title is preserved (strip only affects content)
 *   4. CJK body text survives the strip
 *   5. indexer sees the sanitized content
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanContent } from '../src/core/noise-filter.mjs';


describe('cleanContent — envelope strip (sanity checks before daemon-level test)', () => {
  it('strips Request: prefix', () => {
    assert.equal(cleanContent('Request: 你现在能做什么？'), '你现在能做什么？');
  });

  it('strips both Request: and Result: across lines', () => {
    const raw = 'Request: 我刚睡醒\nResult: 哈哈，睡到下午1点';
    const out = cleanContent(raw);
    assert.match(out, /我刚睡醒/);
    assert.match(out, /哈哈/);
    assert.doesNotMatch(out, /^Request:/);
    assert.doesNotMatch(out, /^Result:/);
  });

  it('preserves user colons (code snippets) inside body', () => {
    const raw = 'Request: 请检查：if (x > 0) { return; }\nResult: 看起来没问题';
    const out = cleanContent(raw);
    assert.match(out, /if \(x > 0\)/);
    assert.match(out, /看起来没问题/);
    assert.doesNotMatch(out, /^Request:/);
  });

  it('returns empty string when input is pure envelope with no body', () => {
    const out = cleanContent('   \nRequest:\nResult:   ');
    // After strip of prefixes, lines are empty → trimmed → ''
    assert.equal(out.replace(/\s+/g, ''), '');
  });
});


describe('daemon._remember — AwarenessClaw envelope integration', () => {
  async function loadDaemonModule() {
    // Dynamic import so we can mock storage + indexer before the daemon
    // instance is constructed.
    return await import('../src/daemon.mjs');
  }

  function makeFakeDaemon(mod) {
    // Reuse the class but stub out side-effectful dependencies.
    const stored = [];
    const indexed = [];

    const fake = Object.create(mod.AwarenessLocalDaemon.prototype);
    fake.memoryStore = {
      write: async (memory) => {
        stored.push(memory);
        return { id: 'mem_test_' + stored.length, filepath: `/tmp/${stored.length}.md` };
      },
    };
    fake.indexer = {
      indexMemory: (id, memory, content) => {
        indexed.push({ id, content, title: memory.title });
      },
    };
    fake._embedAndStore = async () => {};
    fake._extractAndIndex = () => {};
    fake.cloudSync = { isEnabled: () => false };

    return { fake, stored, indexed };
  }

  it('auto-title from AwarenessClaw turn_brief does NOT start with "Request:"', async () => {
    const mod = await loadDaemonModule();
    const { fake, stored, indexed } = makeFakeDaemon(mod);

    const result = await fake._remember({
      content: 'Request: 我刚睡醒\nResult: 哈哈，睡到下午1点，看来是个惬意的周末午觉',
      event_type: 'turn_brief',
      source: 'desktop',
      agent_role: 'builder_agent',
    });

    assert.equal(result.error, undefined, `expected no error, got: ${result.error}`);
    assert.equal(stored.length, 1, 'content should be persisted');
    const saved = stored[0];

    // Title must not start with "Request:" — this is the visible user bug.
    assert.doesNotMatch(saved.title, /^Request:/i,
      `Title should not start with "Request:", got: ${saved.title}`);
    // Title should be derived from the real user message ("我刚睡醒")
    assert.match(saved.title, /我刚睡醒|睡醒/);

    // Stored content also has no envelope prefix
    assert.doesNotMatch(saved.content, /^Request:/);
    assert.doesNotMatch(saved.content, /^Result:/);
    // But body survived
    assert.match(saved.content, /我刚睡醒/);
    assert.match(saved.content, /哈哈|周末午觉/);

    // Indexer gets sanitized content too (so FTS + embeddings don't index envelope)
    assert.equal(indexed.length, 1);
    assert.doesNotMatch(indexed[0].content, /^Request:/);
  });

  it('explicit user-provided title is preserved (strip only affects content)', async () => {
    const mod = await loadDaemonModule();
    const { fake, stored } = makeFakeDaemon(mod);

    await fake._remember({
      title: '周末午觉对话',
      content: 'Request: 我刚睡醒\nResult: 哈哈',
      source: 'desktop',
    });

    assert.equal(stored[0].title, '周末午觉对话');
    assert.doesNotMatch(stored[0].content, /^Request:/);
  });

  it('non-envelope content (no Request:/Result:) passes through unchanged', async () => {
    const mod = await loadDaemonModule();
    const { fake, stored } = makeFakeDaemon(mod);

    await fake._remember({
      content: '决定用 pgvector 替代 Pinecone，原因：省 $70/mo + co-location',
      event_type: 'turn_summary',
      source: 'claude-code',
    });

    assert.match(stored[0].content, /pgvector/);
    assert.match(stored[0].title, /pgvector|Pinecone|决定/);
  });
});
