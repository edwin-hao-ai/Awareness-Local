/**
 * Tests for parsers/python.mjs — Python symbol + import extraction.
 */
// @ts-nocheck


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractPython, extractPyImports } from '../src/core/parsers/python.mjs';

describe('extractPython — symbols', () => {
  it('extracts function definition', () => {
    const src = `def greet(name):\n    return f"Hello {name}"`;
    const syms = extractPython(src);
    const fn = syms.find(s => s.name === 'greet');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'function');
    assert.equal(fn.signature, 'def greet(name)');
    assert.equal(fn.exported, true);
  });

  it('extracts async function', () => {
    const src = `async def fetch_data(url: str) -> dict:\n    pass`;
    const syms = extractPython(src);
    const fn = syms.find(s => s.name === 'fetch_data');
    assert.ok(fn);
    assert.ok(fn.signature.includes('async'));
    assert.ok(fn.signature.includes('-> dict'));
  });

  it('marks private functions as not exported', () => {
    const src = `def _internal_helper(x):\n    pass`;
    const syms = extractPython(src);
    const fn = syms.find(s => s.name === '_internal_helper');
    assert.ok(fn);
    assert.equal(fn.exported, false);
  });

  it('detects methods (indented def)', () => {
    const src = `class Foo:\n    def bar(self):\n        pass`;
    const syms = extractPython(src);
    const method = syms.find(s => s.name === 'bar');
    assert.ok(method);
    assert.equal(method.symbol_type, 'method');
  });

  it('extracts class definition', () => {
    const src = `class UserService:\n    pass`;
    const syms = extractPython(src);
    const cls = syms.find(s => s.name === 'UserService');
    assert.ok(cls);
    assert.equal(cls.symbol_type, 'class');
  });

  it('extracts class with base classes', () => {
    const src = `class Admin(User, PermissionMixin):\n    pass`;
    const syms = extractPython(src);
    const cls = syms.find(s => s.name === 'Admin');
    assert.ok(cls);
    assert.ok(cls.signature.includes('User, PermissionMixin'));
  });

  it('extracts decorators', () => {
    const src = `@app.route("/api")\n@login_required\ndef api_handler():\n    pass`;
    const syms = extractPython(src);
    const fn = syms.find(s => s.name === 'api_handler');
    assert.ok(fn);
    assert.ok(fn.decorators.length >= 1);
  });

  it('extracts single-line docstring', () => {
    const src = `def add(a, b):\n    """Add two numbers."""\n    return a + b`;
    const syms = extractPython(src);
    const fn = syms.find(s => s.name === 'add');
    assert.ok(fn);
    assert.ok(fn.doc_comment?.includes('Add two numbers'));
  });

  it('extracts TODO annotations', () => {
    const src = `# TODO: refactor this\ndef messy():\n    pass`;
    const syms = extractPython(src);
    const todo = syms.find(s => s.symbol_type === 'annotation');
    assert.ok(todo);
    assert.ok(todo.signature.includes('refactor this'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractPython(''), []);
    assert.deepEqual(extractPython(null), []);
  });

  it('handles real-world Python code', () => {
    const src = `
from fastapi import FastAPI

app = FastAPI()

class MemoryService:
    """Manages memory operations."""

    def __init__(self, db):
        self.db = db

    async def create_memory(self, name: str) -> dict:
        """Create a new memory."""
        return await self.db.create(name=name)

    def _validate(self, data):
        pass

# TODO: add caching
def get_cache_key(prefix: str, id: str) -> str:
    return f"{prefix}:{id}"
`;
    const syms = extractPython(src);
    assert.ok(syms.find(s => s.name === 'MemoryService' && s.symbol_type === 'class'));
    assert.ok(syms.find(s => s.name === 'create_memory' && s.symbol_type === 'method'));
    assert.ok(syms.find(s => s.name === '_validate' && !s.exported));
    assert.ok(syms.find(s => s.name === 'get_cache_key' && s.symbol_type === 'function'));
    assert.ok(syms.find(s => s.symbol_type === 'annotation'));
  });
});

describe('extractPyImports', () => {
  it('extracts from...import', () => {
    const src = `from fastapi import FastAPI, Request`;
    const imps = extractPyImports(src);
    assert.ok(imps.find(i => i.path === 'fastapi' && i.type === 'from'));
    assert.ok(imps[0].names.includes('FastAPI'));
  });

  it('extracts bare import', () => {
    const src = `import os`;
    const imps = extractPyImports(src);
    assert.ok(imps.find(i => i.path === 'os' && i.type === 'import'));
  });

  it('extracts dotted import', () => {
    const src = `from awareness.api.services import memory_service`;
    const imps = extractPyImports(src);
    assert.ok(imps.find(i => i.path === 'awareness.api.services'));
  });

  it('extracts import with alias', () => {
    const src = `import numpy as np`;
    const imps = extractPyImports(src);
    assert.ok(imps.find(i => i.path === 'numpy'));
  });

  it('deduplicates imports', () => {
    const src = `import os\nimport os`;
    const imps = extractPyImports(src);
    assert.equal(imps.filter(i => i.path === 'os').length, 1);
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractPyImports(''), []);
  });
});
