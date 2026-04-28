/**
 * Unit tests for wiki-link.mjs (F-082 Phase 0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  relativeLink,
  readMarkdownFile,
  writeMarkdownFile,
  appendToSection,
  appendBacklink,
} from '../src/core/wiki-link.mjs';

function freshDir(suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-wiki-link-' + suffix));
  return dir;
}

test('relativeLink: produces forward-slash relative path', () => {
  const r = relativeLink('/tmp/aw/cards/2026/04/foo.md', '/tmp/aw/topics/bar.md');
  assert.equal(r, '../../../topics/bar.md');
});

test('readMarkdownFile: missing file returns existed:false', () => {
  const dir = freshDir('read');
  const r = readMarkdownFile(path.join(dir, 'nope.md'));
  assert.equal(r.existed, false);
  assert.equal(r.body, '');
  assert.deepEqual(r.frontmatter, {});
});

test('writeMarkdownFile: writes frontmatter + body atomically', () => {
  const dir = freshDir('write');
  const p = path.join(dir, 'sub', 'card.md');
  writeMarkdownFile(p, { id: 'kc_x', category: 'decision' }, '# Title\n\nBody.');
  const text = fs.readFileSync(p, 'utf-8');
  assert.match(text, /^---\nid: kc_x\ncategory: decision\n---\n\n# Title/);
});

test('appendToSection: adds new section if missing', () => {
  const out = appendToSection('# Foo\n\nintro.', '## Related', '- [a](a.md)');
  assert.match(out, /## Related/);
  assert.match(out, /- \[a\]\(a\.md\)/);
});

test('appendToSection: appends within existing section', () => {
  const body = '# Foo\n\n## Related\n\n- [a](a.md)\n\n## Other\n\nx';
  const out = appendToSection(body, '## Related', '- [b](b.md)');
  // b should come after a, but before "## Other"
  const aIdx = out.indexOf('[a](a.md)');
  const bIdx = out.indexOf('[b](b.md)');
  const otherIdx = out.indexOf('## Other');
  assert.ok(aIdx < bIdx && bIdx < otherIdx, `bad order: a=${aIdx} b=${bIdx} other=${otherIdx}\n${out}`);
});

test('appendToSection: idempotent on repeated entries', () => {
  let body = '# Foo';
  body = appendToSection(body, '## Related', '- [a](a.md)');
  const second = appendToSection(body, '## Related', '- [a](a.md)');
  assert.equal(second, body, 'should be no-op when entry already present');
});

test('appendBacklink: creates target file if absent', () => {
  const dir = freshDir('backlink-create');
  const target = path.join(dir, 'topics', 'foo.md');
  const r = appendBacklink({
    targetAbsPath: target,
    entry: '- [Card title](../cards/foo.md)',
    skeletonFrontmatter: { id: 'foo', type: 'topic' },
    skeletonBody: '# Foo\n\nThis is the foo topic.',
  });
  assert.equal(r.created, true);
  assert.equal(r.changed, true);
  const text = fs.readFileSync(target, 'utf-8');
  assert.match(text, /id: foo/);
  assert.match(text, /## Related/);
  assert.match(text, /Card title/);
});

test('appendBacklink: idempotent on existing file with same entry', () => {
  const dir = freshDir('backlink-idem');
  const target = path.join(dir, 'topics', 'foo.md');
  appendBacklink({
    targetAbsPath: target,
    entry: '- [A](a.md)',
    skeletonFrontmatter: { id: 'foo' },
    skeletonBody: '# Foo',
  });
  const r2 = appendBacklink({
    targetAbsPath: target,
    entry: '- [A](a.md)',
  });
  assert.equal(r2.created, false);
  assert.equal(r2.changed, false);
});
