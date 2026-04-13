/**
 * Gitignore Parser — wraps the `ignore` npm package to provide
 * gitignore-aware path filtering for workspace scanning.
 *
 * Handles:
 *   - Global gitignore (~/.config/git/ignore or core.excludesFile)
 *   - Project root .gitignore
 *   - Subdirectory .gitignore files (loaded on demand during traversal)
 *   - Custom exclude patterns from scan-config.json
 */

import ignore from 'ignore';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load gitignore rules for a project directory.
 * Reads the global gitignore + project root .gitignore.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {Object} [options]
 * @param {string[]} [options.extraPatterns] - Additional patterns to add (from scan-config)
 * @returns {{ isIgnored: (relativePath: string) => boolean, addPatterns: (patterns: string[]) => void }}
 */
export function loadGitignoreRules(projectDir, options = {}) {
  const ig = ignore();

  // 1. Global gitignore
  const globalPath = resolveGlobalGitignore();
  if (globalPath && existsSync(globalPath)) {
    const content = safeReadFile(globalPath);
    if (content) ig.add(content);
  }

  // 2. Project root .gitignore
  const rootGitignore = path.join(projectDir, '.gitignore');
  if (existsSync(rootGitignore)) {
    const content = safeReadFile(rootGitignore);
    if (content) ig.add(content);
  }

  // 3. Extra patterns from scan-config
  if (Array.isArray(options.extraPatterns) && options.extraPatterns.length > 0) {
    ig.add(options.extraPatterns);
  }

  return {
    /**
     * Check if a relative path is ignored.
     * @param {string} relativePath - Path relative to projectDir (forward slashes)
     * @returns {boolean}
     */
    isIgnored(relativePath) {
      if (!relativePath) return false;
      // Normalize to forward slashes for cross-platform compatibility
      const normalized = relativePath.split(path.sep).join('/');
      return ig.ignores(normalized);
    },

    /**
     * Add more patterns (e.g., from a subdirectory .gitignore).
     * @param {string[]} patterns
     */
    addPatterns(patterns) {
      ig.add(patterns);
    },
  };
}

/**
 * Load a subdirectory .gitignore and return a scoped filter.
 * Patterns in subdirectory .gitignore apply relative to that directory.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {string} subDir - Absolute path to the subdirectory
 * @returns {{ isIgnored: (relativePath: string) => boolean } | null}
 */
export function loadSubdirGitignore(projectDir, subDir) {
  const gitignorePath = path.join(subDir, '.gitignore');
  if (!existsSync(gitignorePath)) return null;

  const content = safeReadFile(gitignorePath);
  if (!content) return null;

  const ig = ignore();
  ig.add(content);

  const subDirRelative = path.relative(projectDir, subDir);

  return {
    /**
     * Check if a path (relative to projectDir) is ignored by this subdirectory's .gitignore.
     * @param {string} relativePath - Path relative to projectDir
     * @returns {boolean}
     */
    isIgnored(relativePath) {
      const normalized = relativePath.split(path.sep).join('/');
      const prefix = subDirRelative.split(path.sep).join('/');
      // Only applies to paths within this subdirectory
      if (!normalized.startsWith(prefix + '/')) return false;
      // Make path relative to the subdirectory
      const relToSubDir = normalized.slice(prefix.length + 1);
      return ig.ignores(relToSubDir);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Resolve the global gitignore path from git config.
 * Falls back to ~/.config/git/ignore if git config doesn't specify one.
 * @returns {string|null}
 */
function resolveGlobalGitignore() {
  try {
    const configured = execSync('git config --global core.excludesFile', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (configured) {
      // Expand ~ to home directory
      if (configured.startsWith('~')) {
        return configured.replace('~', os.homedir());
      }
      return configured;
    }
  } catch {
    // git config not set or git not available
  }

  // Fallback: XDG default location
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const defaultPath = path.join(xdgConfig, 'git', 'ignore');
  return existsSync(defaultPath) ? defaultPath : null;
}

/**
 * Read a file, returning null on any error.
 * @param {string} filePath
 * @returns {string|null}
 */
function safeReadFile(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
