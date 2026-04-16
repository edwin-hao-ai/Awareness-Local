/**
 * Tests for pushDocumentsToCloud in sync-push.mjs — T-023.
 *
 * Tests the document push logic with mock HTTP + mock indexer.
 */
// @ts-nocheck


import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { pushDocumentsToCloud } from '../src/core/sync-push.mjs';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockCtx(overrides = {}) {
  const posts = [];
  const syncState = {};
  const syncEvents = [];

  return {
    indexer: createMockIndexer(overrides.nodes || []),
    memoryStore: {},
    apiBase: 'https://mock.api',
    apiKey: 'test-key',
    memoryId: 'mem_123',
    deviceId: 'dev_test',
    httpPost: async (endpoint, data) => {
      posts.push({ endpoint, data });
      return overrides.postResponse || { success: true };
    },
    getSyncState: (key) => syncState[key] || null,
    setSyncState: (key, value) => { syncState[key] = value; },
    recordSyncEvent: (type, details) => { syncEvents.push({ type, details }); },
    parseTags: (s) => s ? JSON.parse(s) : [],
    // test inspection
    _posts: posts,
    _syncState: syncState,
    _syncEvents: syncEvents,
    ...overrides,
  };
}

function createMockIndexer(graphNodes = []) {
  const stmts = {};
  return {
    db: {
      prepare: (sql) => {
        if (sql.includes('graph_nodes') && sql.includes('SELECT')) {
          return {
            all: () => graphNodes,
          };
        }
        if (sql.includes('UPDATE graph_nodes')) {
          return {
            run: (...args) => { stmts.lastUpdate = args; },
          };
        }
        return { all: () => [], run: () => {} };
      },
    },
    _stmts: stmts,
  };
}

// ---------------------------------------------------------------------------
// pushDocumentsToCloud
// ---------------------------------------------------------------------------

describe('pushDocumentsToCloud', () => {
  it('pushes unsynced document nodes in batches', async () => {
    const nodes = [
      { id: 'file:readme.md', node_type: 'doc', title: 'readme.md', content: '# Readme', content_hash: 'abc123', metadata: '{"relativePath":"readme.md","category":"convertible"}', sync_hash: null },
      { id: 'file:notes.txt', node_type: 'doc', title: 'notes.txt', content: 'Some notes', content_hash: 'def456', metadata: '{"relativePath":"notes.txt","category":"convertible"}', sync_hash: null },
    ];
    const ctx = createMockCtx({ nodes });
    const result = await pushDocumentsToCloud(ctx);

    assert.equal(result.synced, 2);
    assert.equal(result.errors, 0);
    assert.ok(ctx._posts.length >= 1);
  });

  it('skips nodes where sync_hash matches content_hash', async () => {
    const nodes = [
      { id: 'file:synced.md', node_type: 'doc', title: 'synced.md', content: '# Already synced', content_hash: 'same', metadata: '{"relativePath":"synced.md"}', sync_hash: 'same' },
      { id: 'file:new.txt', node_type: 'doc', title: 'new.txt', content: 'New content', content_hash: 'new123', metadata: '{"relativePath":"new.txt"}', sync_hash: null },
    ];
    const ctx = createMockCtx({ nodes });
    const result = await pushDocumentsToCloud(ctx);

    assert.equal(result.synced, 1);
    assert.equal(result.skipped, 1);
  });

  it('returns zero when cloud sync is disabled', async () => {
    const ctx = createMockCtx({ nodes: [] });
    const result = await pushDocumentsToCloud(ctx);
    assert.equal(result.synced, 0);
    assert.equal(result.errors, 0);
  });

  it('handles HTTP errors gracefully', async () => {
    const nodes = [
      { id: 'file:fail.md', node_type: 'doc', title: 'fail.md', content: '# Fail', content_hash: 'x', metadata: '{"relativePath":"fail.md"}', sync_hash: null },
    ];
    const ctx = createMockCtx({
      nodes,
      httpPost: async () => { throw new Error('network error'); },
    });
    const result = await pushDocumentsToCloud(ctx);

    assert.equal(result.synced, 0);
    assert.equal(result.errors, 1);
  });

  it('sends correct payload structure', async () => {
    const nodes = [
      { id: 'file:doc.md', node_type: 'doc', title: 'doc.md', content: '# Doc', content_hash: 'h1', metadata: '{"relativePath":"docs/doc.md","category":"convertible"}', sync_hash: null },
    ];
    const ctx = createMockCtx({ nodes });
    await pushDocumentsToCloud(ctx);

    assert.ok(ctx._posts.length >= 1);
    const post = ctx._posts[0];
    assert.ok(post.endpoint.includes('documents/sync'));
    assert.ok(Array.isArray(post.data.documents));
    const doc = post.data.documents[0];
    assert.equal(doc.title, 'doc.md');
    assert.equal(doc.content, '# Doc');
    assert.equal(doc.source_type, 'workspace_scan');
    assert.ok(doc.content_hash);
  });

  it('batches documents (max 10 per request)', async () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      id: `file:doc${i}.txt`,
      node_type: 'doc',
      title: `doc${i}.txt`,
      content: `Content ${i}`,
      content_hash: `hash${i}`,
      metadata: `{"relativePath":"doc${i}.txt"}`,
      sync_hash: null,
    }));
    const ctx = createMockCtx({ nodes });
    const result = await pushDocumentsToCloud(ctx);

    assert.equal(result.synced, 15);
    assert.equal(ctx._posts.length, 2); // 10 + 5
  });
});
