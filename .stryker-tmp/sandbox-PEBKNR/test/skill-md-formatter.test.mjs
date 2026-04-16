/**
 * Unit tests for src/core/skill-md-formatter.mjs.
 * Verifies the emitted SKILL.md matches OpenClaw/Claude spec rules.
 */
// @ts-nocheck


import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  buildDescription,
  buildBody,
  buildSkillMd,
} from '../src/core/skill-md-formatter.mjs';

// ── slugify ──────────────────────────────────────────────

test('slugify: lowercase + hyphen-separates tokens', () => {
  assert.equal(slugify('React Hooks Refactoring'), 'react-hooks-refactoring');
});

test('slugify: strips unsafe chars, never produces consecutive hyphens', () => {
  assert.equal(slugify('React Hooks!!  & Stuff'), 'react-hooks-stuff');
  assert.equal(slugify('  foo  bar  '), 'foo-bar');
});

test('slugify: empty/null falls back to "skill"', () => {
  assert.equal(slugify(''), 'skill');
  assert.equal(slugify(null), 'skill');
  assert.equal(slugify('!!!@@@'), 'skill');
});

test('slugify: caps at 60 chars', () => {
  const long = 'x'.repeat(200);
  assert.ok(slugify(long).length <= 60);
});

// ── buildDescription ─────────────────────────────────────

test('buildDescription: starts with first sentence of summary', () => {
  const d = buildDescription({ summary: 'Refactor class components to hooks. Uses useEffect + useState.' });
  assert.ok(d.startsWith('Refactor class components to hooks.'));
});

test('buildDescription: appends "Use when <triggers>" if triggers exist', () => {
  const d = buildDescription({
    summary: 'Do X.',
    trigger_conditions: [
      { pattern: 'legacy class component' },
      { pattern: 'this.setState' },
    ],
  });
  assert.match(d, /Use when legacy class component; this\.setState\.$/);
});

test('buildDescription: is single-line (no newlines) within 1024 chars', () => {
  const huge = 'A'.repeat(2000);
  const d = buildDescription({ summary: huge });
  assert.ok(d.length <= 1024, `got ${d.length}`);
  assert.ok(!d.includes('\n'));
});

test('buildDescription: empty summary → placeholder but never throws', () => {
  const d = buildDescription({});
  assert.ok(d.length > 0);
});

// ── buildBody ────────────────────────────────────────────

test('buildBody: contains H1 title + summary paragraph', () => {
  const body = buildBody({ name: 'React Hooks', summary: 'Short summary here.' });
  assert.match(body, /^# React Hooks/);
  assert.ok(body.includes('Short summary here.'));
});

test('buildBody: emits "When to use this skill" when triggers present', () => {
  const body = buildBody({
    name: 'X',
    summary: 's',
    trigger_conditions: [{ pattern: 'class extends Component' }, { pattern: 'componentDidMount' }],
  });
  assert.ok(body.includes('## When to use this skill'));
  assert.ok(body.includes('- class extends Component'));
  assert.ok(body.includes('- componentDidMount'));
});

test('buildBody: emits "How to apply" numbered list with tool hints', () => {
  const body = buildBody({
    name: 'X',
    summary: 's',
    methods: [
      { step: 1, description: 'Read the class source', tool_hint: 'Read' },
      { step: 2, description: 'Replace state with hooks' },
    ],
  });
  assert.ok(body.includes('## How to apply'));
  assert.match(body, /1\. Read the class source \(use Read\)/);
  assert.match(body, /2\. Replace state with hooks\n/);
});

test('buildBody: omits section when the data is empty', () => {
  const body = buildBody({ name: 'X', summary: 's', methods: [], trigger_conditions: [] });
  assert.ok(!body.includes('## When to use'));
  assert.ok(!body.includes('## How to apply'));
});

// ── buildSkillMd (full doc) ──────────────────────────────

test('buildSkillMd: frontmatter has exactly name + description (no extra keys)', () => {
  const { content } = buildSkillMd({ name: 'My Skill', summary: 'Does X.' });
  const fm = content.match(/^---\n([\s\S]*?)\n---/)[1];
  const keys = fm.split('\n').map((l) => l.split(':')[0].trim());
  assert.deepEqual(keys.sort(), ['description', 'name']);
});

test('buildSkillMd: slug matches frontmatter name', () => {
  const { slug, content } = buildSkillMd({ name: 'My Skill', summary: 's' });
  assert.equal(slug, 'my-skill');
  assert.match(content, /^---\nname: my-skill\n/);
});

test('buildSkillMd: ends with trailing newline (POSIX-friendly)', () => {
  const { content } = buildSkillMd({ name: 'x', summary: 's' });
  assert.ok(content.endsWith('\n'));
});

test('buildSkillMd: does NOT emit a "## Tags" section (rejected by spec)', () => {
  const { content } = buildSkillMd({
    name: 'x', summary: 's', tags: ['react', 'hooks'],
  });
  assert.ok(!content.includes('## Tags'));
});
