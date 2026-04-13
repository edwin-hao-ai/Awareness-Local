/**
 * Tests for lang-detect.mjs — language detection from file extension and shebang.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectLanguage, getSupportedLanguages } from '../src/core/lang-detect.mjs';

describe('detectLanguage', () => {
  describe('JavaScript / TypeScript', () => {
    it('detects .js as javascript', () => {
      const r = detectLanguage('app.js');
      assert.equal(r.language, 'javascript');
      assert.equal(r.category, 'code');
    });

    it('detects .mjs as javascript', () => {
      assert.equal(detectLanguage('daemon.mjs').language, 'javascript');
    });

    it('detects .cjs as javascript', () => {
      assert.equal(detectLanguage('config.cjs').language, 'javascript');
    });

    it('detects .jsx as javascript', () => {
      assert.equal(detectLanguage('App.jsx').language, 'javascript');
    });

    it('detects .ts as typescript', () => {
      const r = detectLanguage('types.ts');
      assert.equal(r.language, 'typescript');
      assert.equal(r.category, 'code');
    });

    it('detects .tsx as typescript', () => {
      assert.equal(detectLanguage('Component.tsx').language, 'typescript');
    });

    it('detects .d.ts as typescript', () => {
      assert.equal(detectLanguage('index.d.ts').language, 'typescript');
    });
  });

  describe('Python', () => {
    it('detects .py as python', () => {
      const r = detectLanguage('main.py');
      assert.equal(r.language, 'python');
      assert.equal(r.category, 'code');
    });

    it('detects .pyi as python', () => {
      assert.equal(detectLanguage('types.pyi').language, 'python');
    });

    it('detects .pyw as python', () => {
      assert.equal(detectLanguage('gui.pyw').language, 'python');
    });
  });

  describe('Go', () => {
    it('detects .go as go', () => {
      const r = detectLanguage('main.go');
      assert.equal(r.language, 'go');
      assert.equal(r.category, 'code');
    });
  });

  describe('Rust', () => {
    it('detects .rs as rust', () => {
      const r = detectLanguage('lib.rs');
      assert.equal(r.language, 'rust');
      assert.equal(r.category, 'code');
    });
  });

  describe('other languages', () => {
    it('detects .java as java', () => {
      assert.equal(detectLanguage('Main.java').language, 'java');
    });

    it('detects .kt as kotlin', () => {
      assert.equal(detectLanguage('App.kt').language, 'kotlin');
    });

    it('detects .rb as ruby', () => {
      assert.equal(detectLanguage('app.rb').language, 'ruby');
    });

    it('detects .php as php', () => {
      assert.equal(detectLanguage('index.php').language, 'php');
    });

    it('detects .swift as swift', () => {
      assert.equal(detectLanguage('ViewController.swift').language, 'swift');
    });

    it('detects .c as c', () => {
      assert.equal(detectLanguage('main.c').language, 'c');
    });

    it('detects .h as c', () => {
      assert.equal(detectLanguage('header.h').language, 'c');
    });

    it('detects .cpp as cpp', () => {
      assert.equal(detectLanguage('main.cpp').language, 'cpp');
    });

    it('detects .hpp as cpp', () => {
      assert.equal(detectLanguage('utils.hpp').language, 'cpp');
    });

    it('detects .cs as csharp', () => {
      assert.equal(detectLanguage('Program.cs').language, 'csharp');
    });

    it('detects .dart as dart', () => {
      assert.equal(detectLanguage('main.dart').language, 'dart');
    });

    it('detects .lua as lua', () => {
      assert.equal(detectLanguage('init.lua').language, 'lua');
    });

    it('detects .r as r', () => {
      assert.equal(detectLanguage('analysis.r').language, 'r');
    });

    it('detects .R as r (case insensitive)', () => {
      assert.equal(detectLanguage('stats.R').language, 'r');
    });

    it('detects .scala as scala', () => {
      assert.equal(detectLanguage('App.scala').language, 'scala');
    });

    it('detects .ex as elixir', () => {
      assert.equal(detectLanguage('app.ex').language, 'elixir');
    });

    it('detects .exs as elixir', () => {
      assert.equal(detectLanguage('test.exs').language, 'elixir');
    });
  });

  describe('shell / scripting', () => {
    it('detects .sh as shell', () => {
      assert.equal(detectLanguage('deploy.sh').language, 'shell');
    });

    it('detects .bash as shell', () => {
      assert.equal(detectLanguage('build.bash').language, 'shell');
    });

    it('detects .zsh as shell', () => {
      assert.equal(detectLanguage('setup.zsh').language, 'shell');
    });
  });

  describe('markup / data', () => {
    it('detects .md as markdown', () => {
      const r = detectLanguage('README.md');
      assert.equal(r.language, 'markdown');
      assert.equal(r.category, 'docs');
    });

    it('detects .mdx as markdown', () => {
      assert.equal(detectLanguage('page.mdx').language, 'markdown');
    });

    it('detects .json as json', () => {
      const r = detectLanguage('config.json');
      assert.equal(r.language, 'json');
      assert.equal(r.category, 'data');
    });

    it('detects .yaml as yaml', () => {
      assert.equal(detectLanguage('docker-compose.yaml').language, 'yaml');
    });

    it('detects .yml as yaml', () => {
      assert.equal(detectLanguage('ci.yml').language, 'yaml');
    });

    it('detects .toml as toml', () => {
      assert.equal(detectLanguage('Cargo.toml').language, 'toml');
    });

    it('detects .xml as xml', () => {
      assert.equal(detectLanguage('pom.xml').language, 'xml');
    });

    it('detects .html as html', () => {
      assert.equal(detectLanguage('index.html').language, 'html');
    });

    it('detects .css as css', () => {
      assert.equal(detectLanguage('styles.css').language, 'css');
    });

    it('detects .scss as css', () => {
      assert.equal(detectLanguage('theme.scss').language, 'css');
    });

    it('detects .sql as sql', () => {
      assert.equal(detectLanguage('migration.sql').language, 'sql');
    });

    it('detects .graphql as graphql', () => {
      assert.equal(detectLanguage('schema.graphql').language, 'graphql');
    });

    it('detects .proto as protobuf', () => {
      assert.equal(detectLanguage('service.proto').language, 'protobuf');
    });
  });

  describe('edge cases', () => {
    it('returns null for unknown extension', () => {
      assert.equal(detectLanguage('data.xyz'), null);
    });

    it('returns null for binary extension', () => {
      assert.equal(detectLanguage('image.png'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(detectLanguage(''), null);
    });

    it('returns null for file with no extension', () => {
      assert.equal(detectLanguage('Makefile'), null);
    });

    it('handles paths with directories', () => {
      const r = detectLanguage('src/core/indexer.mjs');
      assert.equal(r.language, 'javascript');
    });

    it('handles dotfiles', () => {
      assert.equal(detectLanguage('.eslintrc.js').language, 'javascript');
    });

    it('handles double extensions (.d.ts)', () => {
      assert.equal(detectLanguage('globals.d.ts').language, 'typescript');
    });
  });

  describe('shebang detection', () => {
    it('detects python shebang', () => {
      const r = detectLanguage('script', '#!/usr/bin/env python3\nprint("hi")');
      assert.equal(r.language, 'python');
    });

    it('detects node shebang', () => {
      const r = detectLanguage('script', '#!/usr/bin/env node\nconsole.log("hi")');
      assert.equal(r.language, 'javascript');
    });

    it('detects bash shebang', () => {
      const r = detectLanguage('script', '#!/bin/bash\necho hi');
      assert.equal(r.language, 'shell');
    });

    it('detects sh shebang', () => {
      const r = detectLanguage('script', '#!/bin/sh\necho hi');
      assert.equal(r.language, 'shell');
    });

    it('detects ruby shebang', () => {
      const r = detectLanguage('script', '#!/usr/bin/env ruby\nputs "hi"');
      assert.equal(r.language, 'ruby');
    });

    it('detects perl shebang', () => {
      const r = detectLanguage('script', '#!/usr/bin/perl\nprint "hi"');
      assert.equal(r.language, 'perl');
    });

    it('returns null for no shebang and no extension', () => {
      assert.equal(detectLanguage('script', 'just some text'), null);
    });

    it('extension takes precedence over shebang', () => {
      const r = detectLanguage('app.py', '#!/usr/bin/env node\nconsole.log("hi")');
      assert.equal(r.language, 'python');
    });
  });
});

describe('getSupportedLanguages', () => {
  it('returns an array of language names', () => {
    const langs = getSupportedLanguages();
    assert.ok(Array.isArray(langs));
    assert.ok(langs.length > 10);
    assert.ok(langs.includes('javascript'));
    assert.ok(langs.includes('python'));
    assert.ok(langs.includes('go'));
    assert.ok(langs.includes('rust'));
  });
});
