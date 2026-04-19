/**
 * F-057 Phase 1 · bootstrap helpers extracted from daemon.mjs.
 *
 * Each helper takes the daemon instance (or minimal args) as first arg —
 * same style as daemon/embedding-helpers.mjs — so the daemon class method
 * becomes a one-line delegation. No behaviour change; guarded by the
 * 10 MCP golden tests in test/f057-golden-mcp.test.mjs.
 */

/**
 * F-053 Phase 3 · lazy-build and cache the archetype classifier index.
 *
 * Returns null (not an error) when the embedder module is unavailable,
 * so recall gracefully falls back to Phase 1c budget-tier default.
 *
 * Thread-safety: if two recalls race in parallel on a cold daemon, the
 * in-flight promise is shared so we don't double-embed the archetypes.
 *
 * @param {object} daemon - AwarenessLocalDaemon instance
 * @returns {Promise<object|null>}
 */
export async function ensureArchetypeIndex(daemon) {
  if (daemon._archetypeIndex) return daemon._archetypeIndex;
  if (daemon._archetypeIndexBuildInFlight) return daemon._archetypeIndexBuildInFlight;

  daemon._archetypeIndexBuildInFlight = (async () => {
    try {
      if (!daemon._embedder) return null;
      const { buildArchetypeIndex } = await import('../core/query-type-router.mjs');
      daemon._archetypeIndex = await buildArchetypeIndex({
        embed: (t, type, lang) => daemon._embedder.embed(t, type, lang),
      });
      return daemon._archetypeIndex;
    } catch {
      return null;
    } finally {
      daemon._archetypeIndexBuildInFlight = null;
    }
  })();
  return daemon._archetypeIndexBuildInFlight;
}

/**
 * Auto-rebuild better-sqlite3 when Node.js version has changed.
 *
 * Parses the module path out of the NODE_MODULE_VERSION error message,
 * runs `npm rebuild` in that dir, returns true on success. Pure utility
 * — no daemon state needed.
 *
 * @param {string} errMsg - error.message from the failed require/new Database
 * @returns {Promise<boolean>} true if rebuild succeeded
 */
export async function tryRebuildBetterSqlite(errMsg) {
  try {
    const match = errMsg.match(/The module '(.+?better-sqlite3.+?\.node)'/);
    if (!match) return false;
    const moduleDir = match[1].split('/build/')[0];
    const { execSync } = await import('node:child_process');
    console.log(`[awareness-local] Node.js version changed — auto-rebuilding better-sqlite3 for ${process.version}...`);
    execSync('npm rebuild', { cwd: moduleDir, stdio: 'pipe' });
    console.log('[awareness-local] better-sqlite3 rebuilt successfully');
    return true;
  } catch (rebuildErr) {
    console.error(`[awareness-local] Auto-rebuild failed: ${rebuildErr.message}`);
    console.error('[awareness-local] Falling back to file-only mode (no search)');
    return false;
  }
}
