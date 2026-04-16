/**
 * Public API for @awareness-sdk/local
 *
 * Exports high-level functions for external callers (setup-cli, plugins, etc.).
 * This is the package's main entry point (package.json "main" / "exports").
 *
 * Two categories:
 *   1. Re-exports from core/ — directory management & config
 *   2. Daemon management   — lightweight HTTP-based checks (no heavy imports)
 */
// @ts-nocheck


import http from 'node:http';

// ---------------------------------------------------------------------------
// Re-exports from core modules
// ---------------------------------------------------------------------------

export {
  ensureLocalDirs,
  initLocalConfig,
  loadLocalConfig,
  saveCloudConfig,
  getConfigPath,
  generateDeviceId,
} from './core/config.mjs';

// ---------------------------------------------------------------------------
// Daemon management (HTTP-based, no import of daemon internals)
// ---------------------------------------------------------------------------

/**
 * Build the daemon base URL.
 *
 * @param {number} [port=37800]
 * @returns {string} e.g. "http://localhost:37800"
 */
export function getDaemonUrl(port = 37800) {
  return `http://localhost:${port}`;
}

/**
 * Check if the local daemon is healthy.
 * Performs a GET to localhost:{port}/healthz and returns true if status 200.
 *
 * @param {number} [port=37800]
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<boolean>}
 */
export async function checkDaemonHealth(port = 37800, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/healthz',
        timeout: timeoutMs,
      },
      (res) => {
        // Drain the response body
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Get the daemon status including stats.
 * Returns the parsed /healthz JSON, or null if the daemon is not reachable.
 *
 * @param {number} [port=37800]
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<object|null>} — { status, mode, version, uptime, pid, port, project_dir, stats } or null
 */
export async function getDaemonStatus(port = 37800, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/healthz',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Get the MCP endpoint URL for the local daemon.
 *
 * @param {number} [port=37800]
 * @returns {string} e.g. "http://localhost:37800/mcp"
 */
export function getMcpUrl(port = 37800) {
  return `http://localhost:${port}/mcp`;
}
