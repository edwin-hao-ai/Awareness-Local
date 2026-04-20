import fs from 'node:fs';
import path from 'node:path';

/**
 * Start watching the local memories directory and debounce reindexing.
 * Returns the watcher instance or null when watching is unavailable.
 */
export function startFileWatcher(daemon) {
  const memoriesDir = path.join(daemon.awarenessDir, 'memories');
  if (!fs.existsSync(memoriesDir)) return null;

  try {
    return fs.watch(memoriesDir, { recursive: true }, () => {
      if (daemon._reindexTimer) clearTimeout(daemon._reindexTimer);
      daemon._reindexTimer = setTimeout(async () => {
        try {
          if (daemon.indexer && daemon.memoryStore) {
            const result = await daemon.indexer.incrementalIndex(daemon.memoryStore);
            if (result.indexed > 0) {
              console.log(`[awareness-local] auto-indexed ${result.indexed} changed files`);
            }
          }
        } catch (err) {
          console.error('[awareness-local] auto-reindex error:', err.message);
        }
      }, daemon._reindexDebounceMs);
    });
  } catch (err) {
    console.error('[awareness-local] fs.watch setup failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// F-038: Workspace file watching
// ---------------------------------------------------------------------------

const WORKSPACE_DEBOUNCE_MS = 2000;
const GIT_HEAD_DEBOUNCE_MS = 1000;

/**
 * Start watching the project root for file changes.
 * Triggers incremental workspace scans on file save.
 *
 * Uses a longer debounce (2s) than memories watcher (1s) to batch
 * rapid save events from editors.
 *
 * @param {Object} daemon - Daemon instance with triggerScan() method
 * @returns {fs.FSWatcher|null}
 */
export function startWorkspaceWatcher(daemon) {
  if (!daemon.projectDir || !daemon.scanConfig?.watch_enabled) return null;

  // Snapshot at watcher-start so the debounce fire-point can reject stale
  // callbacks after switchProject has moved on — otherwise a 2s debounce
  // set on workspace A can still trigger a scan after daemon already
  // switched to workspace B.
  const projectAtStart = daemon.projectDir;
  let debounceTimer = null;

  try {
    const watcher = fs.watch(daemon.projectDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (daemon.projectDir !== projectAtStart) return; // watcher outlived its workspace

      // Skip changes inside excluded directories
      const parts = filename.split(path.sep);
      const excludedDirs = new Set([
        'node_modules', '.git', '__pycache__', '.next', '.nuxt',
        'dist', 'build', 'out', 'target', '.cache', '.turbo',
        '.awareness', 'venv', '.venv', 'coverage',
      ]);
      if (parts.some(p => excludedDirs.has(p))) return;

      // Debounce
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (daemon.projectDir !== projectAtStart) return;
        if (typeof daemon.triggerScan === 'function') {
          daemon.triggerScan('incremental').catch(err => {
            console.error('[workspace-watcher] scan error:', err.message);
          });
        }
      }, WORKSPACE_DEBOUNCE_MS);
    });

    // Expose debounce cleanup so switchProject's watcher.close() tear-down
    // can cancel the pending setTimeout in addition to closing the handle.
    const origClose = watcher.close.bind(watcher);
    watcher.close = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      return origClose();
    };
    return watcher;
  } catch (err) {
    console.error('[workspace-watcher] setup failed:', err.message);
    return null;
  }
}

/**
 * Watch .git/HEAD for changes to detect git operations
 * (checkout, pull, merge, rebase).
 *
 * @param {Object} daemon - Daemon instance with triggerScan() method
 * @returns {fs.FSWatcher|null}
 */
export function startGitHeadWatcher(daemon) {
  if (!daemon.projectDir) return null;

  const gitHeadPath = path.join(daemon.projectDir, '.git', 'HEAD');
  if (!fs.existsSync(gitHeadPath)) return null;

  const projectAtStart = daemon.projectDir;
  let debounceTimer = null;

  try {
    const watcher = fs.watch(gitHeadPath, () => {
      if (daemon.projectDir !== projectAtStart) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (daemon.projectDir !== projectAtStart) return;
        console.log('[git-watcher] .git/HEAD changed — triggering incremental scan');
        if (typeof daemon.triggerScan === 'function') {
          daemon.triggerScan('incremental').catch(err => {
            console.error('[git-watcher] scan error:', err.message);
          });
        }
      }, GIT_HEAD_DEBOUNCE_MS);
    });

    const origClose = watcher.close.bind(watcher);
    watcher.close = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      return origClose();
    };
    return watcher;
  } catch (err) {
    console.error('[git-watcher] setup failed:', err.message);
    return null;
  }
}
