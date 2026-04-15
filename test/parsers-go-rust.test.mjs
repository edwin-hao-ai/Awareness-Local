/**
 * Tests for parsers/go.mjs and parsers/rust.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractGo, extractGoImports } from '../src/core/parsers/go.mjs';
import { extractRust, extractRustImports } from '../src/core/parsers/rust.mjs';

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe('extractGo — symbols', () => {
  it('extracts package declaration', () => {
    const src = `package main`;
    const syms = extractGo(src);
    assert.ok(syms.find(s => s.name === 'main' && s.symbol_type === 'package'));
  });

  it('extracts function', () => {
    const src = `package main\n\nfunc HandleRequest(w http.ResponseWriter, r *http.Request) {}`;
    const syms = extractGo(src);
    const fn = syms.find(s => s.name === 'HandleRequest');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'function');
    assert.equal(fn.exported, true);
  });

  it('detects unexported function', () => {
    const src = `func helper(x int) int { return x }`;
    const syms = extractGo(src);
    const fn = syms.find(s => s.name === 'helper');
    assert.ok(fn);
    assert.equal(fn.exported, false);
  });

  it('extracts method with receiver', () => {
    const src = `func (s *Server) Start(port int) error {}`;
    const syms = extractGo(src);
    const fn = syms.find(s => s.name === 'Start');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'method');
    assert.ok(fn.signature.includes('*Server'));
  });

  it('extracts struct', () => {
    const src = `type Config struct {\n\tPort int\n}`;
    const syms = extractGo(src);
    const s = syms.find(s => s.name === 'Config');
    assert.ok(s);
    assert.equal(s.symbol_type, 'struct');
    assert.equal(s.exported, true);
  });

  it('extracts interface', () => {
    const src = `type Handler interface {\n\tServeHTTP(w, r)\n}`;
    const syms = extractGo(src);
    const iface = syms.find(s => s.name === 'Handler');
    assert.ok(iface);
    assert.equal(iface.symbol_type, 'interface');
  });

  it('extracts doc comment above function', () => {
    const src = `// Serve starts the HTTP server.\n// It binds to the given port.\nfunc Serve(port int) {}`;
    const syms = extractGo(src);
    const fn = syms.find(s => s.name === 'Serve');
    assert.ok(fn);
    assert.ok(fn.doc_comment?.includes('starts the HTTP server'));
  });

  it('extracts TODO annotations', () => {
    const src = `// TODO: implement caching\nfunc Cache() {}`;
    const syms = extractGo(src);
    assert.ok(syms.find(s => s.symbol_type === 'annotation'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractGo(''), []);
  });
});

describe('extractGoImports', () => {
  it('extracts single import', () => {
    const src = `import "fmt"`;
    const imps = extractGoImports(src);
    assert.ok(imps.find(i => i.path === 'fmt'));
  });

  it('extracts block import', () => {
    const src = `import (\n\t"fmt"\n\t"os"\n\t"net/http"\n)`;
    const imps = extractGoImports(src);
    assert.ok(imps.find(i => i.path === 'fmt'));
    assert.ok(imps.find(i => i.path === 'os'));
    assert.ok(imps.find(i => i.path === 'net/http'));
  });

  it('extracts aliased import', () => {
    const src = `import (\n\tpb "google.golang.org/protobuf"\n)`;
    const imps = extractGoImports(src);
    assert.ok(imps.find(i => i.path === 'google.golang.org/protobuf'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractGoImports(''), []);
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe('extractRust — symbols', () => {
  it('extracts pub fn', () => {
    const src = `pub fn process(data: &[u8]) -> Result<(), Error> {}`;
    const syms = extractRust(src);
    const fn = syms.find(s => s.name === 'process');
    assert.ok(fn);
    assert.equal(fn.symbol_type, 'function');
    assert.equal(fn.exported, true);
    assert.ok(fn.signature.includes('-> Result<(), Error>'));
  });

  it('extracts private fn', () => {
    const src = `fn helper(x: i32) -> i32 { x + 1 }`;
    const syms = extractRust(src);
    const fn = syms.find(s => s.name === 'helper');
    assert.ok(fn);
    assert.equal(fn.exported, false);
  });

  it('extracts async fn', () => {
    const src = `pub async fn fetch(url: &str) -> Response {}`;
    const syms = extractRust(src);
    const fn = syms.find(s => s.name === 'fetch');
    assert.ok(fn);
    assert.ok(fn.signature.includes('async'));
  });

  it('extracts struct', () => {
    const src = `pub struct Config {\n    port: u16,\n}`;
    const syms = extractRust(src);
    const s = syms.find(s => s.name === 'Config');
    assert.ok(s);
    assert.equal(s.symbol_type, 'struct');
    assert.equal(s.exported, true);
  });

  it('extracts enum', () => {
    const src = `pub enum Status {\n    Active,\n    Inactive,\n}`;
    const syms = extractRust(src);
    const e = syms.find(s => s.name === 'Status');
    assert.ok(e);
    assert.equal(e.symbol_type, 'enum');
  });

  it('extracts trait', () => {
    const src = `pub trait Handler {\n    fn handle(&self);\n}`;
    const syms = extractRust(src);
    const t = syms.find(s => s.name === 'Handler');
    assert.ok(t);
    assert.equal(t.symbol_type, 'trait');
  });

  it('extracts impl block', () => {
    const src = `impl Handler for Server {}`;
    const syms = extractRust(src);
    const imp = syms.find(s => s.symbol_type === 'impl');
    assert.ok(imp);
    assert.ok(imp.signature.includes('Handler for Server'));
  });

  it('extracts module declaration', () => {
    const src = `pub mod routes;`;
    const syms = extractRust(src);
    const mod = syms.find(s => s.name === 'routes');
    assert.ok(mod);
    assert.equal(mod.symbol_type, 'module');
  });

  it('extracts /// doc comment', () => {
    const src = `/// Process incoming data.\n/// Returns processed result.\npub fn process() {}`;
    const syms = extractRust(src);
    const fn = syms.find(s => s.name === 'process');
    assert.ok(fn);
    assert.ok(fn.doc_comment?.includes('Process incoming data'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractRust(''), []);
  });
});

describe('extractRustImports', () => {
  it('extracts use statement', () => {
    const src = `use std::collections::HashMap;`;
    const imps = extractRustImports(src);
    assert.ok(imps.find(i => i.path === 'std::collections::HashMap'));
  });

  it('extracts use with braces', () => {
    const src = `use std::io::{Read, Write};`;
    const imps = extractRustImports(src);
    assert.ok(imps.find(i => i.path.includes('std::io')));
  });

  it('extracts mod declaration', () => {
    const src = `mod config;`;
    const imps = extractRustImports(src);
    assert.ok(imps.find(i => i.path === 'config' && i.type === 'mod'));
  });

  it('returns empty for empty content', () => {
    assert.deepEqual(extractRustImports(''), []);
  });
});
