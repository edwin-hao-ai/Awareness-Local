/**
 * Workspace scanner bootstrap + triggerScan + graph-embedding trigger.
 * F-057 Phase 5 extraction from daemon.mjs.
 *
 * No behaviour change — the three class methods in daemon.mjs
 * (_initWorkspaceScanner / triggerScan / _triggerGraphEmbedding) delegate
 * to these functions. Module-private dependencies (scan config loader,
 * git/fs helpers, scan-state mutators) come from existing modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  scanWorkspace,
  indexWorkspaceFiles,
  getGitChanges,
  getCurrentCommit,
  isGitRepo,
  markDeletedFiles,
  handleRenamedFiles,
} from '../core/workspace-scanner.mjs';
import {
  loadScanState,
  saveScanState,
  updateScanState,
  appendScanError,
} from '../core/scan-state.mjs';
import { loadScanConfig } from '../core/scan-config.mjs';
import { loadGitignoreRules } from '../core/gitignore-parser.mjs';
import { classifyFile } from '../core/scan-defaults.mjs';
import { startWorkspaceWatcher, startGitHeadWatcher } from './file-watcher.mjs';
import { runGraphEmbeddingPipeline } from './graph-embedder.mjs';

/**
 * Initialize workspace scanner: load state, start watchers, queue first scan.
 */
export function initWorkspaceScanner(daemon) {
  try {
    daemon.scanConfig = loadScanConfig(daemon.projectDir);
    if (!daemon.scanConfig.enabled) {
      console.log('[workspace-scanner] disabled via scan-config.json');
      return;
    }

    daemon.scanState = loadScanState(daemon.projectDir);
    daemon._workspaceWatcher = startWorkspaceWatcher(daemon);

    if (isGitRepo(daemon.projectDir)) {
      daemon._gitHeadWatcher = startGitHeadWatcher(daemon);
    }

    // Trigger initial scan in background (deferred 3s to avoid blocking startup)
    setTimeout(() => {
      daemon.triggerScan('incremental').catch((err) => {
        console.error('[workspace-scanner] initial scan failed:', err.message);
      });
    }, 3000);

    console.log('[workspace-scanner] initialized, first scan in 3s');
  } catch (err) {
    console.error('[workspace-scanner] init failed (degraded):', err.message);
  }
}

/**
 * Run a workspace scan (full or git-incremental).
 *
 * @param {object} daemon
 * @param {'full'|'incremental'} [mode='incremental']
 */
export async function triggerScan(daemon, mode = 'incremental') {
  if (!daemon.indexer || !daemon.scanConfig?.enabled) {
    return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
  }

  if (daemon.scanState.status === 'scanning' || daemon.scanState.status === 'indexing') {
    console.log('[workspace-scanner] scan already in progress, skipping');
    return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
  }

  const startTime = Date.now();
  daemon._scanAbortController = new AbortController();

  try {
    daemon.scanState = updateScanState(daemon.scanState, {
      status: 'scanning',
      phase: 'discovering',
    });

    const config = daemon.scanConfig;
    const gitignore = loadGitignoreRules(daemon.projectDir, {
      extraPatterns: config.exclude,
    });

    let filesToIndex;

    if (mode === 'incremental' && config.git_incremental && isGitRepo(daemon.projectDir)) {
      const currentCommit = getCurrentCommit(daemon.projectDir);
      const lastCommit = daemon.scanState.last_git_commit;

      if (currentCommit && currentCommit === lastCommit) {
        daemon.scanState = updateScanState(daemon.scanState, {
          status: 'idle',
          phase: null,
          last_incremental_at: new Date().toISOString(),
        });
        return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
      }

      const gitChanges = getGitChanges(daemon.projectDir, lastCommit);

      if (gitChanges) {
        if (gitChanges.deleted.length > 0) {
          markDeletedFiles(gitChanges.deleted, daemon.indexer);
        }
        if (gitChanges.renamed.length > 0) {
          handleRenamedFiles(gitChanges.renamed, daemon.indexer);
        }

        const changedPaths = [
          ...gitChanges.added,
          ...gitChanges.modified,
          ...gitChanges.renamed.map((r) => r.to),
        ];

        filesToIndex = changedPaths
          .map((relPath) => {
            const absPath = path.join(daemon.projectDir, relPath);
            if (!fs.existsSync(absPath)) return null;

            const classification = classifyFile(relPath, config);
            if (classification.excluded) return null;
            if (gitignore.isIgnored(relPath)) return null;

            let stat;
            try { stat = fs.statSync(absPath); } catch { return null; }

            return {
              absolutePath: absPath,
              relativePath: relPath,
              category: classification.category,
              size: stat.size,
              mtime: stat.mtimeMs,
              oversized: stat.size > (config.max_file_size_kb || 500) * 1024,
            };
          })
          .filter(Boolean);

        if (currentCommit) {
          daemon.scanState = updateScanState(daemon.scanState, {
            last_git_commit: currentCommit,
          });
        }
      } else {
        filesToIndex = scanWorkspace(daemon.projectDir, {
          config,
          gitignore,
          signal: daemon._scanAbortController.signal,
        });
      }
    } else {
      filesToIndex = scanWorkspace(daemon.projectDir, {
        config,
        gitignore,
        signal: daemon._scanAbortController.signal,
      });
    }

    daemon.scanState = updateScanState(daemon.scanState, {
      status: 'indexing',
      phase: 'parsing',
      discovered_total: filesToIndex.length,
      index_total: filesToIndex.length,
      index_done: 0,
      index_skipped: 0,
    });

    const result = await indexWorkspaceFiles(filesToIndex, daemon.indexer, {
      signal: daemon._scanAbortController.signal,
      onProgress: (progress) => {
        daemon.scanState = updateScanState(daemon.scanState, {
          index_done: progress.done,
          index_skipped: progress.skipped,
        });
      },
    });

    if (!daemon.scanState.last_git_commit && isGitRepo(daemon.projectDir)) {
      const headCommit = getCurrentCommit(daemon.projectDir);
      if (headCommit) {
        daemon.scanState = updateScanState(daemon.scanState, {
          last_git_commit: headCommit,
        });
      }
    }

    let totalFiles = 0;
    let totalCodeFiles = 0;
    let totalDocFiles = 0;
    let totalSymbols = 0;
    try {
      totalFiles = daemon.indexer.db.prepare(
        "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active'"
      ).get().c;
      totalCodeFiles = daemon.indexer.db.prepare(
        "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'code'"
      ).get().c;
      totalDocFiles = daemon.indexer.db.prepare(
        "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'docs'"
      ).get().c;
      totalSymbols = daemon.indexer.db.prepare(
        "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'symbol' AND status = 'active'"
      ).get().c;
    } catch { /* stats are non-critical */ }

    const duration = Date.now() - startTime;
    const scanType = mode === 'full' ? 'last_full_scan_at' : 'last_incremental_at';

    daemon.scanState = updateScanState(daemon.scanState, {
      status: 'idle',
      phase: null,
      total_files: totalFiles,
      total_code_files: totalCodeFiles,
      total_doc_files: totalDocFiles,
      total_symbols: totalSymbols,
      scan_duration_ms: duration,
      [scanType]: new Date().toISOString(),
    });

    saveScanState(daemon.projectDir, daemon.scanState);

    if (result.indexed > 0 || result.edges > 0) {
      console.log(
        `[workspace-scanner] ${mode} scan done: ${result.indexed} indexed, ${result.skipped} skipped, ${result.edges} edges (${duration}ms)`
      );
    }

    if (result.indexed > 0 && daemon._embedder) {
      daemon._triggerGraphEmbedding();
    }

    return result;
  } catch (err) {
    daemon.scanState = appendScanError(
      updateScanState(daemon.scanState, { status: 'error', phase: null }),
      err.message
    );
    saveScanState(daemon.projectDir, daemon.scanState);
    console.error('[workspace-scanner] scan error:', err.message);
    return { indexed: 0, skipped: 0, errors: 1, edges: 0 };
  }
}

/**
 * Kick off the background graph-embedding pipeline.
 */
export function triggerGraphEmbedding(daemon) {
  daemon.scanState = updateScanState(daemon.scanState, {
    status: 'indexing',
    phase: 'embedding',
    embed_total: 0,
    embed_done: 0,
  });

  runGraphEmbeddingPipeline(daemon, {
    onProgress: (done, total) => {
      daemon.scanState = updateScanState(daemon.scanState, {
        embed_total: total,
        embed_done: done,
      });
    },
  })
    .then(({ embedding, similarity }) => {
      daemon.scanState = updateScanState(daemon.scanState, {
        status: 'idle',
        phase: null,
        embed_total: embedding.total,
        embed_done: embedding.embedded,
      });
      saveScanState(daemon.projectDir, daemon.scanState);
    })
    .catch((err) => {
      console.warn('[graph-embedder] pipeline error:', err.message);
      daemon.scanState = updateScanState(daemon.scanState, {
        status: 'idle',
        phase: null,
      });
      saveScanState(daemon.projectDir, daemon.scanState);
    });
}
