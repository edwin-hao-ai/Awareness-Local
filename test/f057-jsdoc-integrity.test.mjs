/**
 * F-057 regression — JSDoc comment block integrity.
 *
 * Background: during the daemon refactor, `awk 'NR<X || NR>Y' > tmp`
 * was used to cut methods out of `daemon.mjs`. The awk range
 * accidentally ate the `*∕` terminator of JSDoc blocks preceding the
 * extracted methods, so the next method definition was swallowed into
 * the JSDoc body. The file still passed `node -c` (comments are legal
 * anywhere) but blew up at runtime with
 * `TypeError: this._handleRequest is not a function`.
 *
 * This test scans every `.mjs` under `sdks/local/src/` and asserts that
 * every `∕**` opener has a matching `*∕` closer before the next opener
 * or EOF. Cheap static guard that would have caught the refactor bug
 * instantly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');

/** Walk a directory recursively and yield every `.mjs` file path. */
function collectMjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...collectMjsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find dangling `/**` openers in source code.
 *
 * Walks left-to-right: every `/**` must have a `*∕` closer somewhere
 * after it (any closer will do — nested `/**` inside JSDoc prose is
 * legal and commonly appears in doc-comment examples). Returns one
 * entry per unterminated opener that reaches EOF without seeing a
 * closer. Empty list = healthy file.
 *
 * The refactor bug that motivated this guard produced an opener with
 * NO closer at all before EOF (awk sliced the `*∕` line away), so the
 * "reaches EOF without closer" check is exactly the signal we need.
 */
export function findDanglingJsDocOpeners(source) {
  const dangling = [];
  let i = 0;
  const OPEN = '/**';
  const CLOSE = '*/';
  while (i < source.length) {
    const openIdx = source.indexOf(OPEN, i);
    if (openIdx === -1) break;
    const closeIdx = source.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      const line = source.slice(0, openIdx).split('\n').length;
      dangling.push({ line });
      break; // nothing left to scan past EOF
    }
    i = closeIdx + CLOSE.length;
  }
  return dangling;
}

describe('F-057 · JSDoc integrity across sdks/local/src', () => {
  it('every /** has a matching */ before the next /** or EOF', () => {
    const files = collectMjsFiles(SRC_DIR);
    assert.ok(files.length > 0, `no .mjs files discovered under ${SRC_DIR}`);
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const dangling = findDanglingJsDocOpeners(src);
      if (dangling.length > 0) {
        offenders.push({ file, dangling });
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}: dangling /** at line(s) ${o.dangling.map((d) => d.line).join(', ')}`)
        .join('\n');
      assert.fail(`Unterminated JSDoc blocks found:\n${msg}`);
    }
  });
});

describe('F-057 · findDanglingJsDocOpeners unit smoke', () => {
  it('detects a deliberately-broken /** with no closing */', () => {
    const broken = [
      'export class Foo {',
      '  /**',
      '   * dangling — awk ate the terminator',
      '  async bar() { return 1; }',
      '  async baz() { return 2; }',
      '}',
    ].join('\n');
    const result = findDanglingJsDocOpeners(broken);
    assert.equal(result.length, 1, 'should detect one dangling opener');
    assert.equal(result[0].line, 2, 'dangling opener should report line 2');
  });

  it('accepts a well-formed JSDoc block', () => {
    const clean = [
      '/**',
      ' * Well-formed block.',
      ' */',
      'export function ok() { return 1; }',
    ].join('\n');
    assert.deepEqual(findDanglingJsDocOpeners(clean), []);
  });

  it('accepts multiple adjacent JSDoc blocks', () => {
    const clean = [
      '/** one */',
      'function a() {}',
      '/** two',
      ' * still ok',
      ' */',
      'function b() {}',
    ].join('\n');
    assert.deepEqual(findDanglingJsDocOpeners(clean), []);
  });
});
