import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  assertSafeWorkspaceRoot,
  isUnsafeWorkspaceRoot,
  normalizeWorkspaceRoot,
} from '../src/core/workspace-root.mjs';

test('workspace root guard rejects exact home directory', () => {
  const homeDir = normalizeWorkspaceRoot(os.homedir());
  assert.equal(isUnsafeWorkspaceRoot(homeDir), true);
  assert.throws(
    () => assertSafeWorkspaceRoot(homeDir, 'daemon workspace'),
    /Refusing to use home directory/
  );
});

test('workspace root guard allows nested project directories under home', () => {
  const nested = path.join(os.homedir(), 'workspace', 'demo-project');
  assert.equal(isUnsafeWorkspaceRoot(nested), false);
  assert.equal(assertSafeWorkspaceRoot(nested), path.resolve(nested));
});