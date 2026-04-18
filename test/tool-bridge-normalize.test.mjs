/**
 * tool-bridge-normalize.test.mjs — L2 tests for defensive arg normalization.
 *
 * Bug locked down here (2026-04-18):
 *   Some MCP clients (incl. older Claude Code stdio bridge paths) stringify
 *   nested object arguments on the wire. When `awareness_record` receives
 *   `insights` as a JSON string instead of an object, the daemon must still
 *   reach the `_remember` handler with `insights` restored to native form,
 *   so downstream extraction pipelines work.
 *
 *   Before the fix: stringified insights flowed through unchanged; the
 *   daemon accepted the request but silently dropped the pre-extracted
 *   cards because they weren't recognized as an object.
 *
 * These tests call tool-bridge.callMcpTool() with a minimal daemon mock
 * and verify that the `awareness_record` handler receives `insights`,
 * `items`, `tags`, etc. as native objects/arrays regardless of wire shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { callMcpTool } from '../src/daemon/tool-bridge.mjs';

function makeDaemon(rememberCalls, options = {}) {
  return {
    _remember: async (args) => { rememberCalls.push({ args }); return { status: 'ok', id: 'mem_test' }; },
    _rememberBatch: async (args) => { rememberCalls.push({ fn: 'batch', args }); return { status: 'ok' }; },
    _updateTask: async (args) => { rememberCalls.push({ fn: 'updateTask', args }); return { status: 'ok' }; },
    _submitInsights: async (args) => { rememberCalls.push({ fn: 'submitInsights', args }); return { status: 'ok' }; },
    _createSession: () => 'ses_test',
    _loadSpec: () => ({ agent_profiles: [] }),
    _lookup: () => ({ items: [] }),
    _ensureArchetypeIndex: () => null,
    indexer: null,
    search: { recall: async () => [], unifiedCascadeSearch: async () => ({ results: [] }) },
    ...options,
  };
}

describe('tool-bridge · defensive normalize of structured args (2026-04-18 bug fix)', () => {
  it('awareness_record: accepts insights as native object (baseline)', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    const insightsObj = { knowledge_cards: [{ title: 'test', summary: 'x'.repeat(50), category: 'insight' }] };
    await callMcpTool(daemon, 'awareness_record', {
      content: 'baseline object insights',
      insights: insightsObj,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.insights, insightsObj);
  });

  it('awareness_record: auto-parses insights when passed as JSON string', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    const insightsObj = { knowledge_cards: [{ title: 'stringified', summary: 'y'.repeat(50), category: 'decision' }], action_items: [] };
    await callMcpTool(daemon, 'awareness_record', {
      content: 'stringified insights from buggy wire',
      insights: JSON.stringify(insightsObj),
    });
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].args.insights, 'object', 'insights must be parsed to object');
    assert.deepEqual(calls[0].args.insights, insightsObj);
  });

  it('awareness_record: auto-parses items when passed as JSON string (remember_batch)', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    const itemsArr = [{ content: 'a', title: 't1' }, { content: 'b', title: 't2' }];
    await callMcpTool(daemon, 'awareness_record', {
      action: 'remember_batch',
      items: JSON.stringify(itemsArr),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'batch');
    assert.ok(Array.isArray(calls[0].args.items), 'items must be parsed to array');
    assert.deepEqual(calls[0].args.items, itemsArr);
  });

  it('awareness_record: auto-parses tags when passed as JSON string', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    await callMcpTool(daemon, 'awareness_record', {
      content: 'with stringified tags',
      tags: JSON.stringify(['bug', 'fix', 'f-053']),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.tags, ['bug', 'fix', 'f-053']);
  });

  it('awareness_record: leaves plain strings alone (does not try to parse non-JSON)', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    // A bare word or sentence must not be misparsed. Only { / [ prefixed strings attempt JSON.parse.
    await callMcpTool(daemon, 'awareness_record', {
      content: 'plain',
      insights: 'just a plain sentence, not JSON',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.insights, 'just a plain sentence, not JSON');
  });

  it('awareness_record: invalid JSON string stays as string (no throw)', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    await callMcpTool(daemon, 'awareness_record', {
      content: 'bad json',
      insights: '{ this is not: valid json',
    });
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].args.insights, 'string', 'malformed JSON stays as string');
  });

  it('awareness_record: passes through when no structured fields present', async () => {
    const calls = [];
    const daemon = makeDaemon(calls);
    await callMcpTool(daemon, 'awareness_record', { content: 'simple content only' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.content, 'simple content only');
    assert.equal(calls[0].args.insights, undefined);
  });
});
