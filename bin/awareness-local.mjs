#!/usr/bin/env node

/**
 * CLI entry point for Awareness Local daemon.
 *
 * Subcommands:
 *   start   [--project <dir>] [--port <port>] [--foreground]  — start daemon
 *   stop    [--project <dir>]                                 — stop daemon
 *   status  [--project <dir>]                                 — show daemon status + stats
 *   reindex [--project <dir>]                                 — rebuild FTS5 + embedding index
 *   benchmark --dataset <path> [--project <dir>]              — run local recall benchmark
 *
 * Uses process.argv parsing (no dependencies).
 * For `start` without `--foreground`, spawns self as a detached child process.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into { command, flags }.
 * Supports: --flag value, --flag=value, --boolean-flag
 * @param {string[]} argv — typically process.argv.slice(2)
 * @returns {{ command: string, flags: Record<string, string|boolean> }}
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
    i++;
  }

  return {
    command: positional[0] || 'start',
    flags,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AWARENESS_DIR = '.awareness';
const PID_FILENAME = 'daemon.pid';
const LOG_FILENAME = 'daemon.log';

/**
 * Resolve the project directory from flags or cwd.
 * @param {Record<string, string|boolean>} flags
 * @returns {string}
 */
function resolveProjectDir(flags) {
  const dir = typeof flags.project === 'string' ? flags.project : process.cwd();
  return path.resolve(dir);
}

/**
 * Resolve the daemon port from --port flag or default.
 * Single-daemon policy: every project uses 37800 unless user forces otherwise.
 * Workspace switching happens via POST /api/v1/workspace/switch, not new ports.
 * @param {Record<string, string|boolean>} flags
 * @returns {number}
 */
function resolvePort(flags, _projectDir) {
  if (typeof flags.port === 'string') {
    const p = parseInt(flags.port, 10);
    if (!isNaN(p) && p > 0 && p < 65536) return p;
  }
  return 37800;
}

/**
 * HTTP GET to localhost — returns response body as string or null on error.
 * @param {number} port
 * @param {string} urlPath
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ status: number, body: string }|null>}
 */
function httpGet(port, urlPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: urlPath, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
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
 * HTTP POST JSON to localhost.
 * @param {number} port
 * @param {string} urlPath
 * @param {object} body
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ status: number, body: string }|null>}
 */
function httpPostJson(port, urlPath, body, timeoutMs = 3000) {
  const payload = Buffer.from(JSON.stringify(body || {}), 'utf-8');
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') });
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Probe a port to see if it already hosts an Awareness local daemon.
 * Returns healthz info on success, or null when the port is free or
 * occupied by something else.
 * @param {number} port
 * @returns {Promise<{ mode: string, pid: number, project_dir: string, version: string }|null>}
 */
async function probeAwarenessDaemon(port) {
  const resp = await httpGet(port, '/healthz', 1500);
  if (!resp || resp.status !== 200) return null;
  try {
    const info = JSON.parse(resp.body);
    if (info && info.mode === 'local' && info.pid) return info;
  } catch { /* not awareness */ }
  return null;
}

/**
 * Read PID from .awareness/daemon.pid.
 * @param {string} projectDir
 * @returns {number|null}
 */
function readPid(projectDir) {
  const pidPath = path.join(projectDir, AWARENESS_DIR, PID_FILENAME);
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process with the given PID exists.
 * @param {number} pid
 * @returns {boolean}
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Start the daemon.
 * Without --foreground: spawns a new detached process with --foreground flag.
 * With --foreground: imports and runs the daemon in-process.
 */
async function cmdStart(flags) {
  const projectDir = resolveProjectDir(flags);
  const port = resolvePort(flags, projectDir);
  const foreground = flags.foreground === true;

  // Ensure .awareness directory exists
  const awarenessDir = path.join(projectDir, AWARENESS_DIR);
  fs.mkdirSync(awarenessDir, { recursive: true });

  // Record workspace usage (memoryId/lastUsed/name). Port is no longer
  // allocated per-workspace — every workspace shares the default daemon port.
  try {
    const { registerWorkspace } = await import('../src/core/config.mjs');
    registerWorkspace(projectDir, { port });
  } catch { /* best-effort */ }

  // Single-daemon policy: if an Awareness daemon already runs on this port,
  // switch its active workspace instead of spawning a duplicate on a new port.
  const existing = await probeAwarenessDaemon(port);
  if (existing) {
    const existingDir = existing.project_dir ? path.resolve(existing.project_dir) : '';
    if (existingDir === path.resolve(projectDir)) {
      console.log(
        `Awareness Local daemon already running (PID ${existing.pid}, port ${port})`
      );
      process.exit(0);
    }
    // Different project on same port → hot-switch.
    const switchRes = await httpPostJson(port, '/api/v1/workspace/switch', {
      project_dir: projectDir,
    });
    if (switchRes && switchRes.status === 200) {
      console.log(
        `Switched daemon workspace to ${projectDir} (PID ${existing.pid}, port ${port})`
      );
      process.exit(0);
    }
    console.error(
      `[awareness-local] Port ${port} is held by another process but workspace switch failed:\n` +
      `  ${switchRes ? `HTTP ${switchRes.status}: ${switchRes.body.slice(0, 200)}` : 'no response'}\n` +
      `  Stop the existing daemon or pass --port <other> to run a second instance.`
    );
    process.exit(1);
  }

  if (foreground) {
    // Run in foreground — import daemon and start
    const { AwarenessLocalDaemon } = await import('../src/daemon.mjs');
    const daemon = new AwarenessLocalDaemon({ port, projectDir });
    let shuttingDown = false;

    // Handle termination signals
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n[awareness-local] shutting down...');
      await daemon.stop();
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.exitCode = 0;
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await daemon.start();
  } else {
    // Background mode: spawn self with --foreground
    const thisFile = fileURLToPath(import.meta.url);
    const logPath = path.join(awarenessDir, LOG_FILENAME);
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(
      process.execPath,
      [thisFile, 'start', '--foreground', '--project', projectDir, '--port', String(port)],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: projectDir,
        env: { ...process.env },
      }
    );

    child.unref();
    fs.closeSync(logFd);

    // Wait for daemon to become healthy (up to 15 seconds)
    console.log('Starting Awareness Local daemon...');
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const resp = await httpGet(port, '/healthz');
      if (resp && resp.status === 200) {
        healthy = true;
        break;
      }
    }

    if (healthy) {
      const newPid = readPid(projectDir);
      console.log(`Awareness Local daemon started (PID ${newPid || child.pid}, port ${port})`);
      console.log(`  MCP endpoint: http://localhost:${port}/mcp`);
      console.log(`  Dashboard:    http://localhost:${port}/`);
      console.log(`  Log file:     ${logPath}`);

      // Auto-open dashboard only on the very first daemon start across all projects.
      // Use a global flag in ~/.awareness so new workspaces don't keep re-opening the browser.
      const globalAwarenessDir = path.join(os.homedir(), '.awareness');
      const firstRunFlag = path.join(globalAwarenessDir, '.dashboard-opened');
      if (!fs.existsSync(firstRunFlag)) {
        try {
          fs.mkdirSync(globalAwarenessDir, { recursive: true });
          fs.writeFileSync(firstRunFlag, new Date().toISOString());
          const url = `http://localhost:${port}/`;
          const { exec } = await import('node:child_process');
          if (process.platform === 'darwin') exec(`open "${url}"`);
          else if (process.platform === 'linux') exec(`xdg-open "${url}"`);
          else if (process.platform === 'win32') exec(`start "" "${url}"`);
        } catch { /* ignore open failures */ }
      }
    } else {
      console.error('Failed to start daemon. Check log file:');
      console.error(`  ${logPath}`);
      process.exit(1);
    }
  }
}

/**
 * Stop the daemon.
 */
async function cmdStop(flags) {
  const projectDir = resolveProjectDir(flags);
  const pid = readPid(projectDir);

  if (!pid) {
    console.log('Awareness Local daemon is not running (no PID file found)');
    process.exit(0);
  }

  if (!processExists(pid)) {
    // Stale PID file — clean up
    const pidPath = path.join(projectDir, AWARENESS_DIR, PID_FILENAME);
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    console.log('Awareness Local daemon is not running (stale PID file removed)');
    process.exit(0);
  }

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to stop daemon (PID ${pid}): ${err.message}`);
    process.exit(1);
  }

  // Wait for process to exit (up to 5 seconds)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!processExists(pid)) break;
  }

  // Force kill if still alive
  if (processExists(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  // Clean PID file
  const pidPath = path.join(projectDir, AWARENESS_DIR, PID_FILENAME);
  try { fs.unlinkSync(pidPath); } catch { /* ignore */ }

  console.log(`Awareness Local daemon stopped (was PID ${pid})`);
}

/**
 * Show daemon status and stats.
 */
async function cmdStatus(flags) {
  const projectDir = resolveProjectDir(flags);
  const port = resolvePort(flags, projectDir);
  const pid = readPid(projectDir);

  if (!pid || !processExists(pid)) {
    console.log('Awareness Local: not running');
    if (pid) {
      // Clean stale PID file
      const pidPath = path.join(projectDir, AWARENESS_DIR, PID_FILENAME);
      try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // Fetch health info
  const resp = await httpGet(port, '/healthz');
  if (!resp || resp.status !== 200) {
    console.log(`Awareness Local: PID ${pid} exists but HTTP not responding on port ${port}`);
    process.exit(1);
  }

  try {
    const data = JSON.parse(resp.body);
    const uptime = data.uptime || 0;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}m ${uptime % 60}s`;

    console.log(`Awareness Local: running (PID ${pid}, port ${port})`);
    console.log(`  Uptime:          ${uptimeStr}`);
    console.log(`  Project:         ${data.project_dir || projectDir}`);

    if (data.stats) {
      const s = data.stats;
      console.log(`  Memories:        ${s.totalMemories || 0}`);
      console.log(`  Knowledge Cards: ${s.totalKnowledge || 0}`);
      console.log(`  Open Tasks:      ${s.totalTasks || 0}`);
      console.log(`  Sessions:        ${s.totalSessions || 0}`);
    }

    // Check cloud sync status
    const awarenessDir = path.join(projectDir, AWARENESS_DIR);
    const configPath = path.join(awarenessDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.cloud?.enabled) {
          console.log(`  Cloud Sync:      enabled (${config.cloud.api_base || 'awareness.market'})`);
        } else {
          console.log('  Cloud Sync:      not configured');
        }
      } catch {
        console.log('  Cloud Sync:      unknown');
      }
    } else {
      console.log('  Cloud Sync:      not configured');
    }
  } catch {
    console.log(`Awareness Local: running (PID ${pid})`);
    console.log(`  Raw response: ${resp.body}`);
  }
}

/**
 * Rebuild the FTS5 + embedding index.
 */
async function cmdReindex(flags) {
  const projectDir = resolveProjectDir(flags);
  const port = resolvePort(flags, projectDir);

  // Check if daemon is running — if so, it holds a lock on index.db
  const pid = readPid(projectDir);
  const daemonRunning = pid && processExists(pid);

  if (daemonRunning) {
    console.log('Daemon is running — stopping it first for safe reindex...');
    await cmdStop(flags);
    // Brief pause for SQLite lock release
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('Rebuilding index...');

  const awarenessDir = path.join(projectDir, AWARENESS_DIR);
  const dbPath = path.join(awarenessDir, 'index.db');

  // Remove existing database to force full rebuild
  for (const ext of ['', '-journal', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  Removed: ${path.basename(p)}`);
    }
  }

  // Import and run indexer
  try {
    const { Indexer } = await import('../src/core/indexer.mjs');
    const { MemoryStore } = await import('../src/core/memory-store.mjs');

    const store = new MemoryStore(projectDir);
    const indexer = new Indexer(dbPath);

    const result = await indexer.incrementalIndex(store);
    console.log(`Reindex complete: ${result.indexed} files indexed, ${result.skipped} skipped`);

    indexer.close();
  } catch (err) {
    console.error(`Reindex failed: ${err.message}`);
    process.exit(1);
  }

  // Restart daemon if it was running
  if (daemonRunning) {
    console.log('Restarting daemon...');
    await cmdStart({ ...flags, foreground: undefined });
  }
}

/**
 * Run as a stdio MCP server (for IDE integrations like Claude Code).
 */
async function cmdMcp(flags) {
  const projectDir = resolveProjectDir(flags);
  const port = resolvePort(flags);

  const { startStdioMcp } = await import('../src/mcp-stdio.mjs');
  await startStdioMcp({ port, projectDir });
}

async function cmdBenchmark(flags) {
  const projectDir = resolveProjectDir(flags);
  const datasetPath = typeof flags.dataset === 'string' ? path.resolve(flags.dataset) : null;
  if (!datasetPath || !fs.existsSync(datasetPath)) {
    console.error('Benchmark requires --dataset <jsonl-path>');
    process.exit(1);
  }

  const backendKind = typeof flags.backend === 'string' ? flags.backend : 'builtin';
  const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 5;
  const reportPath = typeof flags.report === 'string' ? path.resolve(flags.report) : null;
  const markdownReportPath = typeof flags['markdown-report'] === 'string'
    ? path.resolve(flags['markdown-report'])
    : (reportPath ? reportPath.replace(/\.json$/i, '.md') : null);

  const { runBenchmarkSuite } = await import('../src/benchmark/benchmark-runner.mjs');
  const { createProjectSearchBenchmarkSystems } = await import('../src/benchmark/systems.mjs');

  const systems = await createProjectSearchBenchmarkSystems({
    projectDir,
    backendKind,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
    reindex: flags.reindex === true,
    qmd: {
      dbPath: process.env.AWARENESS_QMD_DB_PATH,
    },
  });

  const reports = await runBenchmarkSuite({
    systems,
    datasetPath,
    reportPath,
    markdownReportPath,
  });

  if (flags.json === true) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  for (const report of reports) {
    console.log(`Benchmark system: ${report.system}`);
    if (report.skipped) {
      console.log(`  Status:            skipped`);
      if (report.status?.reason) {
        console.log(`  Reason:            ${report.status.reason}`);
      }
      continue;
    }
    console.log(`  Total cases:       ${report.summary.totalCases}`);
    console.log(`  Recall@3:          ${report.summary.recallAt3.toFixed(3)}`);
    console.log(`  Recall@5:          ${report.summary.recallAt5.toFixed(3)}`);
    console.log(`  MRR:               ${report.summary.mrr.toFixed(3)}`);
    console.log(`  nDCG@5:            ${report.summary.ndcgAt5.toFixed(3)}`);
    console.log(`  Avg injected toks: ${report.summary.injectedTokensAvg.toFixed(1)}`);
    console.log(`  Answer hit rate:   ${report.summary.answerHitRate.toFixed(3)}`);
  }

  if (reportPath) {
    console.log(`Report written to ${reportPath}`);
  }
  if (markdownReportPath) {
    console.log(`Markdown report written to ${markdownReportPath}`);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
Awareness Local — AI agent memory daemon

Usage:
  awareness-local <command> [options]

Commands:
  start     Start the daemon (default)
  stop      Stop the daemon
  status    Show daemon status and stats
  reindex   Rebuild the search index
  mcp       Run as stdio MCP server
  benchmark Run recall benchmark against a JSONL dataset

Options:
  --project <dir>   Project directory (default: current directory)
  --port <port>     HTTP port (default: 37800)
  --foreground      Run in foreground (don't detach)
  --dataset <path>  Benchmark JSONL dataset path
  --backend <kind>  builtin | qmd | hybrid | all (benchmark only)
  --report <path>   Write benchmark JSON report
  --markdown-report <path>  Write benchmark Markdown report
  --reindex         Rebuild the benchmark target index before running
  --json            Print benchmark report as JSON
  --help            Show this help message

Examples:
  npx @awareness-sdk/local start
  npx @awareness-sdk/local status
  npx @awareness-sdk/local stop
  npx @awareness-sdk/local reindex --project /path/to/project
  npx @awareness-sdk/local mcp --project /path/to/project --port 37800
  npx @awareness-sdk/local benchmark --project /path/to/project --dataset tests/memory-benchmark/datasets/recall_core.jsonl
  npx @awareness-sdk/local benchmark --project tests/memory-benchmark/projects/core-recall --dataset tests/memory-benchmark/datasets/recall_core.jsonl --backend builtin --reindex
  npx @awareness-sdk/local benchmark --project tests/memory-benchmark/projects/universal-core --dataset tests/memory-benchmark/datasets/universal_core.jsonl --backend all --report tests/memory-benchmark/reports/universal_core.json
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || command === 'help') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'start':
      await cmdStart(flags);
      break;
    case 'stop':
      await cmdStop(flags);
      break;
    case 'status':
      await cmdStatus(flags);
      break;
    case 'reindex':
      await cmdReindex(flags);
      break;
    case 'mcp':
      await cmdMcp(flags);
      break;
    case 'benchmark':
      await cmdBenchmark(flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
