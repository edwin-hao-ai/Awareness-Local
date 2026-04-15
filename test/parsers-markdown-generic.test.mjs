/**
 * Tests for parsers/markdown.mjs and parsers/generic.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkdown, extractMarkdownRefs } from '../src/core/parsers/markdown.mjs';
import { extractGeneric } from '../src/core/parsers/generic.mjs';
import { extractFile, getParserLanguages } from '../src/core/parsers/index.mjs';

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('extractMarkdown — symbols', () => {
  it('extracts headings', () => {
    const src = `# Title\n\n## Section One\n\n### Subsection`;
    const syms = extractMarkdown(src);
    const headings = syms.filter(s => s.symbol_type === 'heading');
    assert.equal(headings.length, 3);
    assert.equal(headings[0].name, 'Title');
    assert.equal(headings[0].level, 1);
    assert.equal(headings[1].name, 'Section One');
    assert.equal(headings[1].level, 2);
  });

  it('extracts frontmatter', () => {
    const src = `---\ntitle: My Doc\ndate: 2026-04-13\n---\n\n# Content`;
    const syms = extractMarkdown(src);
    const fm = syms.find(s => s.symbol_type === 'frontmatter');
    assert.ok(fm);
    assert.ok(fm.doc_comment.includes('title: My Doc'));
  });

  it('extracts links', () => {
    const src = `Check [the docs](./docs/guide.md) and [API](https://api.example.com).`;
    const syms = extractMarkdown(src);
    const links = syms.filter(s => s.symbol_type === 'link');
    assert.equal(links.length, 2);
    assert.ok(links.find(l => l.target === './docs/guide.md'));
  });

  it('extracts code blocks with language', () => {
    const src = "```python\nprint('hi')\n```\n\n```javascript\nconsole.log('hi')\n```";
    const syms = extractMarkdown(src);
    const blocks = syms.filter(s => s.symbol_type === 'code_block');
    assert.equal(blocks.length, 2);
    assert.ok(blocks.find(b => b.language === 'python'));
    assert.ok(blocks.find(b => b.language === 'javascript'));
  });

  it('extracts TODO annotations', () => {
    const src = `# Plan\n\nTODO: implement feature X`;
    const syms = extractMarkdown(src);
    const todo = syms.find(s => s.symbol_type === 'annotation');
    assert.ok(todo);
    assert.ok(todo.signature.includes('implement feature X'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractMarkdown(''), []);
  });
});

describe('extractMarkdownRefs', () => {
  it('extracts relative link targets', () => {
    const src = `See [guide](./docs/guide.md) and [API](https://api.example.com).`;
    const refs = extractMarkdownRefs(src);
    assert.ok(refs.find(r => r.path === './docs/guide.md' && r.type === 'link'));
    // HTTP links should be excluded
    assert.ok(!refs.find(r => r.path.startsWith('http')));
  });

  it('strips anchors from link targets', () => {
    const src = `See [section](./doc.md#section-one).`;
    const refs = extractMarkdownRefs(src);
    assert.ok(refs.find(r => r.path === './doc.md'));
  });

  it('extracts file path references in backticks', () => {
    const src = 'Check `src/core/indexer.mjs` for details.';
    const refs = extractMarkdownRefs(src);
    assert.ok(refs.find(r => r.path === 'src/core/indexer.mjs' && r.type === 'reference'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractMarkdownRefs(''), []);
  });
});

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

describe('extractGeneric', () => {
  it('extracts block comments', () => {
    const src = `/**\n * This is a long documentation block\n * that spans multiple lines.\n */\nsome code here`;
    const syms = extractGeneric(src);
    const block = syms.find(s => s.symbol_type === 'comment_block');
    assert.ok(block);
    assert.ok(block.doc_comment.includes('documentation block'));
  });

  it('extracts TODO with // prefix', () => {
    const src = `// TODO: fix this`;
    const syms = extractGeneric(src);
    assert.ok(syms.find(s => s.name === 'TODO'));
  });

  it('extracts TODO with # prefix', () => {
    const src = `# FIXME: broken logic`;
    const syms = extractGeneric(src);
    assert.ok(syms.find(s => s.name === 'FIXME'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractGeneric(''), []);
  });
});

// ---------------------------------------------------------------------------
// Parser index (extractFile)
// ---------------------------------------------------------------------------

describe('extractFile router', () => {
  it('routes javascript to JS extractor', () => {
    const { symbols } = extractFile('function foo() {}', 'javascript');
    assert.ok(symbols.find(s => s.name === 'foo'));
  });

  it('routes typescript to JS extractor', () => {
    const { symbols } = extractFile('interface Config {}', 'typescript');
    assert.ok(symbols.find(s => s.name === 'Config'));
  });

  it('routes python to Python extractor', () => {
    const { symbols } = extractFile('def bar():\n    pass', 'python');
    assert.ok(symbols.find(s => s.name === 'bar'));
  });

  it('routes go to Go extractor', () => {
    const { symbols } = extractFile('func Main() {}', 'go');
    assert.ok(symbols.find(s => s.name === 'Main'));
  });

  it('routes rust to Rust extractor', () => {
    const { symbols } = extractFile('fn main() {}', 'rust');
    assert.ok(symbols.find(s => s.name === 'main'));
  });

  it('routes markdown to Markdown extractor', () => {
    const { symbols } = extractFile('# Hello', 'markdown');
    assert.ok(symbols.find(s => s.name === 'Hello'));
  });

  it('falls back to generic for unknown language', () => {
    const { symbols } = extractFile('// TODO: fix\nsome code', 'haskell');
    assert.ok(symbols.find(s => s.symbol_type === 'annotation'));
  });

  it('returns empty for no content', () => {
    const { symbols, imports } = extractFile('', 'javascript');
    assert.equal(symbols.length, 0);
    assert.equal(imports.length, 0);
  });
});

describe('getParserLanguages', () => {
  it('includes all dedicated parsers', () => {
    const langs = getParserLanguages();
    assert.ok(langs.includes('javascript'));
    assert.ok(langs.includes('typescript'));
    assert.ok(langs.includes('python'));
    assert.ok(langs.includes('go'));
    assert.ok(langs.includes('rust'));
    assert.ok(langs.includes('markdown'));
  });
});
