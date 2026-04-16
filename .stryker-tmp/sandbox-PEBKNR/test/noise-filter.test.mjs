// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyNoiseEvent, shouldStoreMemoryEvent, cleanContent } from '../src/core/noise-filter.mjs';

// ---- Original tests (structural noise) ----

test('classifyNoiseEvent filters obvious session checkpoints and structurally low-signal content', () => {
  assert.equal(
    classifyNoiseEvent({
      event_type: 'session_checkpoint',
      content: 'partial assistant output',
    }),
    'session_checkpoint filtered',
  );

  // 'ok' is now caught by greeting filter (more specific) before low_signal
  assert.equal(
    classifyNoiseEvent({
      content: 'ok',
    }),
    'only_greeting filtered',
  );
});

test('classifyNoiseEvent filters terse untitled content but keeps intentional titled content', () => {
  assert.equal(
    classifyNoiseEvent({
      content: '收到',
    }),
    'low_signal_noise filtered',
  );

  assert.equal(
    classifyNoiseEvent({
      content: '已完成',
    }),
    'low_signal_noise filtered',
  );

  assert.equal(
    classifyNoiseEvent({
      title: 'User Preference',
      content: 'Use tabs',
    }),
    null,
  );
});

test('shouldStoreMemoryEvent keeps meaningful detailed records and structured insights', () => {
  assert.equal(
    shouldStoreMemoryEvent({
      content: 'We switched auth refresh handling to sliding sessions after verifying token expiry behavior.',
    }),
    true,
  );

  assert.equal(
    shouldStoreMemoryEvent({
      content: 'done',
      insights: {
        completed_tasks: [{ task_id: 'task_1', reason: 'implemented and verified' }],
      },
    }),
    true,
  );
});

// ---- B-004 Layer 1: System metadata prefix ----

test('B-004: blocks system metadata prefixes', () => {
  assert.equal(
    classifyNoiseEvent({ content: 'Sender (untrusted metadata): {"label":"test"}' }),
    'system_metadata filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> some data here' }),
    'system_metadata filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: '[Subagent Context] You are running as a subagent' }),
    'system_metadata filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: '[Current project directory: /Users/test/project' }),
    'system_metadata filtered',
  );
});

// ---- B-004 Layer 1: Refusal/hallucination ----

test('B-004: blocks short refusal/hallucination phrases', () => {
  assert.equal(
    classifyNoiseEvent({ content: 'I cannot access the file system' }),
    'refusal_hallucination filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: '无法访问目标文件' }),
    'refusal_hallucination filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: 'The tool is broken, trying again' }),
    'refusal_hallucination filtered',
  );
});

test('B-004: allows long content even if it contains refusal phrases', () => {
  const longContent = 'I cannot access the file system directly, but I found a workaround. ' +
    'By using the node:fs module with proper permissions, we can read the config file. ' +
    'Here is the implementation that resolved the issue...';
  assert.equal(classifyNoiseEvent({ content: longContent }), null);
});

// ---- B-004: XML tag cleanup ----

test('B-004: strips XML tag blocks before content check', () => {
  const xmlWrapped = '<system-reminder>This is noise</system-reminder>\n' +
    '<function_calls><invoke name="Read"><parameter name="path">/test</parameter></invoke></function_calls>';
  assert.equal(
    classifyNoiseEvent({ content: xmlWrapped }),
    'empty_after_cleanup filtered',
  );
});

test('B-004: preserves meaningful content after XML stripping', () => {
  const mixedContent = '<system-reminder>system noise</system-reminder>\n' +
    'We decided to use JWT tokens for authentication because they are stateless and work well with microservices.';
  assert.equal(classifyNoiseEvent({ content: mixedContent }), null);
});

// ---- B-004: Greeting-only ----

test('B-004: blocks greeting-only content', () => {
  assert.equal(
    classifyNoiseEvent({ content: 'hello!' }),
    'only_greeting filtered',
  );
  assert.equal(
    classifyNoiseEvent({ content: 'thanks' }),
    'only_greeting filtered',
  );
});

// ---- B-004: Tool-activity-only ----

test('B-004: blocks content that is only tool activity after cleanup', () => {
  const toolOnly = 'Tool call: Read /Users/test/file.ts\nTool call: Grep pattern\nTool call: Bash ls';
  // After cleanup, all lines become tool activity → dropped → empty
  assert.notEqual(classifyNoiseEvent({ content: toolOnly }), null);
});

// ---- cleanContent function ----

test('cleanContent strips XML tags and noise lines', () => {
  const raw = '<system-reminder>noise</system-reminder>\nRequest: some data\nActual content here.';
  const cleaned = cleanContent(raw);
  assert.ok(!cleaned.includes('<system-reminder>'));
  assert.ok(!cleaned.includes('Request:'));
  assert.ok(cleaned.includes('Actual content here.'));
});

test('cleanContent strips Sender and Conversation info lines', () => {
  const raw = 'Conversation info: test\nSender (untrusted metadata): {}\nReal content about architecture.';
  const cleaned = cleanContent(raw);
  assert.ok(!cleaned.includes('Conversation info'));
  assert.ok(!cleaned.includes('Sender'));
  assert.ok(cleaned.includes('Real content about architecture.'));
});
