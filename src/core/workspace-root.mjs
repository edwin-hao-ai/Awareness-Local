import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function normalizeWorkspaceRoot(projectDir) {
  const resolved = path.resolve(projectDir || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isUnsafeWorkspaceRoot(projectDir) {
  const resolved = normalizeWorkspaceRoot(projectDir);
  const homeDir = normalizeWorkspaceRoot(os.homedir());
  return resolved === homeDir;
}

export function assertSafeWorkspaceRoot(projectDir, context = 'workspace') {
  const resolved = normalizeWorkspaceRoot(projectDir);
  if (isUnsafeWorkspaceRoot(resolved)) {
    throw new Error(
      `Refusing to use home directory as ${context}: ${resolved}. ` +
      'Pass a concrete project/workspace directory instead.'
    );
  }
  return resolved;
}