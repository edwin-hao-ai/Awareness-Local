/**
 * Tests for parsers/javascript.mjs — JS/TS symbol + import extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractJavaScript, extractJSImports } from '../src/core/parsers/javascript.mjs';

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

describe('extractJavaScript — symbols', () => {
  it('extracts function declaration', () => {
    const src = `function greet(name) {\n  return "hi " + name;\n}`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'greet');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'function');
    assert.equal(fn.signature, 'function greet(name)');
    assert.equal(fn.exported, false);
    assert.equal(fn.line_start, 1);
  });

  it('extracts exported function', () => {
    const src = `export function doStuff(a, b) {}`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'doStuff');
    assert.ok(fn);
    assert.equal(fn.exported, true);
  });

  it('extracts async function', () => {
    const src = `async function fetchData(url) {}`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'fetchData');
    assert.ok(fn);
    assert.ok(fn.signature.includes('async'));
  });

  it('extracts export default function', () => {
    const src = `export default function handler(req, res) {}`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'handler');
    assert.ok(fn);
    assert.equal(fn.exported, true);
  });

  it('extracts const arrow function', () => {
    const src = `const add = (a, b) => a + b;`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'add');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'function');
  });

  it('extracts exported const function', () => {
    const src = `export const multiply = (x, y) => x * y;`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'multiply');
    assert.ok(fn);
    assert.equal(fn.exported, true);
  });

  it('extracts const function assignment', () => {
    const src = `const handler = function(req) { return req; };`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'handler');
    assert.ok(fn);
  });

  it('extracts class declaration', () => {
    const src = `class UserService {\n  constructor() {}\n}`;
    const syms = extractJavaScript(src);
    const cls = syms.find(s => s.name === 'UserService');
    assert.ok(cls);
    assert.equal(cls.symbol_type, 'class');
    assert.equal(cls.signature, 'class UserService');
  });

  it('extracts class with extends', () => {
    const src = `export class AdminService extends UserService {}`;
    const syms = extractJavaScript(src);
    const cls = syms.find(s => s.name === 'AdminService');
    assert.ok(cls);
    assert.ok(cls.signature.includes('extends UserService'));
    assert.equal(cls.exported, true);
  });

  it('extracts TypeScript interface', () => {
    const src = `export interface Config {\n  port: number;\n  host: string;\n}`;
    const syms = extractJavaScript(src);
    const iface = syms.find(s => s.name === 'Config');
    assert.ok(iface);
    assert.equal(iface.symbol_type, 'interface');
    assert.equal(iface.exported, true);
  });

  it('extracts TypeScript type alias', () => {
    const src = `export type UserId = string;`;
    const syms = extractJavaScript(src);
    const typ = syms.find(s => s.name === 'UserId');
    assert.ok(typ);
    assert.equal(typ.symbol_type, 'type');
  });

  it('extracts TypeScript enum', () => {
    const src = `export enum Status {\n  Active,\n  Inactive\n}`;
    const syms = extractJavaScript(src);
    const en = syms.find(s => s.name === 'Status');
    assert.ok(en);
    assert.equal(en.symbol_type, 'enum');
  });

  it('extracts JSDoc comment above function', () => {
    const src = `/**\n * Compute the sum.\n * @param {number} a\n */\nfunction sum(a, b) {}`;
    const syms = extractJavaScript(src);
    const fn = syms.find(s => s.name === 'sum');
    assert.ok(fn);
    assert.ok(fn.doc_comment);
    assert.ok(fn.doc_comment.includes('Compute the sum'));
  });

  it('extracts TODO annotations', () => {
    const src = `// TODO: fix this later\nfunction broken() {}`;
    const syms = extractJavaScript(src);
    const todo = syms.find(s => s.symbol_type === 'annotation');
    assert.ok(todo);
    assert.equal(todo.name, 'TODO');
    assert.ok(todo.signature.includes('fix this later'));
  });

  it('extracts FIXME annotations', () => {
    const src = `// FIXME: memory leak here`;
    const syms = extractJavaScript(src);
    const fixme = syms.find(s => s.name === 'FIXME');
    assert.ok(fixme);
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractJavaScript(''), []);
    assert.deepEqual(extractJavaScript(null), []);
  });

  it('handles complex real-world code', () => {
    const src = `
import path from 'node:path';

/**
 * Main indexer class.
 */
export class Indexer {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  /**
   * Insert a node into the graph.
   */
  graphInsertNode(node) {
    // TODO: add validation
    return this.db.run('INSERT ...');
  }
}

export type NodeType = 'file' | 'symbol';

export const DEFAULT_LIMIT = 50;

const helper = (x) => x * 2;
`;
    const syms = extractJavaScript(src);
    assert.ok(syms.find(s => s.name === 'Indexer' && s.symbol_type === 'class'));
    assert.ok(syms.find(s => s.name === 'NodeType' && s.symbol_type === 'type'));
    assert.ok(syms.find(s => s.name === 'helper' && s.symbol_type === 'function'));
    assert.ok(syms.find(s => s.symbol_type === 'annotation'));
  });
});

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

describe('extractJSImports', () => {
  it('extracts ESM import', () => {
    const src = `import path from 'node:path';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === 'node:path'));
    assert.equal(imps[0].type, 'esm');
  });

  it('extracts named ESM import', () => {
    const src = `import { readFileSync, writeFileSync } from 'node:fs';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === 'node:fs'));
  });

  it('extracts relative import', () => {
    const src = `import { foo } from './utils/helpers.mjs';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === './utils/helpers.mjs'));
  });

  it('extracts dynamic import', () => {
    const src = `const gsap = await import('gsap');`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === 'gsap' && i.type === 'dynamic'));
  });

  it('extracts CommonJS require', () => {
    const src = `const fs = require('fs');`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === 'fs' && i.type === 'cjs'));
  });

  it('extracts re-export', () => {
    const src = `export { default } from './other.mjs';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === './other.mjs' && i.type === 're-export'));
  });

  it('extracts export * from', () => {
    const src = `export * from './types.mjs';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === './types.mjs'));
  });

  it('extracts import type (TypeScript)', () => {
    const src = `import type { Config } from './config.ts';`;
    const imps = extractJSImports(src);
    assert.ok(imps.find(i => i.path === './config.ts'));
  });

  it('deduplicates imports', () => {
    const src = `import { a } from './mod.mjs';\nimport { b } from './mod.mjs';`;
    const imps = extractJSImports(src);
    const modImps = imps.filter(i => i.path === './mod.mjs');
    assert.equal(modImps.length, 1);
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractJSImports(''), []);
    assert.deepEqual(extractJSImports(null), []);
  });

  it('handles multiple import types in one file', () => {
    const src = `
import fs from 'node:fs';
import { join } from 'node:path';
const chalk = require('chalk');
const mod = await import('./lazy.mjs');
export { helper } from './helpers.mjs';
`;
    const imps = extractJSImports(src);
    assert.ok(imps.length >= 5);
  });
});
