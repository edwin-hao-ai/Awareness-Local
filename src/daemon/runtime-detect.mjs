// F-080 · Runtime detection (11-runtime Day-1)
// Priority:
//   1. X-Awareness-Source request header (explicit, highest priority) — handled by caller
//   2. process.env.AWARENESS_SOURCE (explicit override)
//   3. runtime-specific env vars
//   4. parent process name (ps -p $PPID)
//   5. fallback 'mcp-generic'
// Result cached in ~/.awareness/runtime.json; recomputed on daemon boot.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KNOWN_RUNTIMES = Object.freeze([
  'claude-code',
  'cursor',
  'openclaw',
  'windsurf',
  'cline',
  'continue',
  'aider',
  'zed',
  'copilot-chat',
  'jetbrains',
  'mcp-generic',
]);

const ENV_SIGNATURES = Object.freeze([
  { runtime: 'claude-code', keys: ['CLAUDE_CODE_SESSION', 'CLAUDE_CODE', 'CLAUDECODE'] },
  { runtime: 'cursor', keys: ['CURSOR_AGENT_TOOLS', 'CURSOR_SESSION_ID', 'CURSOR'] },
  { runtime: 'windsurf', keys: ['WINDSURF_SESSION', 'WINDSURF'] },
  { runtime: 'openclaw', keys: ['OPENCLAW_SESSION', 'OPENCLAW'] },
  { runtime: 'cline', keys: ['CLINE_SESSION', 'CLINE'] },
  { runtime: 'continue', keys: ['CONTINUE_SESSION', 'CONTINUE_DEV'] },
  { runtime: 'aider', keys: ['AIDER_SESSION', 'AIDER'] },
  { runtime: 'zed', keys: ['ZED_SESSION', 'ZED_AI'] },
  { runtime: 'copilot-chat', keys: ['GITHUB_COPILOT_CHAT', 'COPILOT_CHAT_SESSION'] },
  { runtime: 'jetbrains', keys: ['JETBRAINS_AI', 'IDEA_AI_SESSION'] },
]);

const PARENT_NAME_MAP = Object.freeze([
  [/claude[-_ ]?code/i, 'claude-code'],
  [/cursor/i, 'cursor'],
  [/windsurf/i, 'windsurf'],
  [/openclaw/i, 'openclaw'],
  [/cline/i, 'cline'],
  [/continue/i, 'continue'],
  [/aider/i, 'aider'],
  [/zed/i, 'zed'],
  [/copilot/i, 'copilot-chat'],
  [/idea|pycharm|goland|webstorm|rider|clion|rubymine|phpstorm/i, 'jetbrains'],
]);

const CACHE_PATH = join(homedir(), '.awareness', 'runtime.json');

function normalizeRuntime(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  return KNOWN_RUNTIMES.includes(slug) ? slug : null;
}

function fromEnvOverride(env) {
  return normalizeRuntime(env.AWARENESS_SOURCE);
}

function fromEnvSignature(env) {
  for (const { runtime, keys } of ENV_SIGNATURES) {
    if (keys.some((k) => env[k])) return runtime;
  }
  return null;
}

function fromParentProcess() {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const out = execSync(`ps -p ${ppid} -o comm=`, { encoding: 'utf8', timeout: 1000 }).trim();
    if (!out) return null;
    for (const [pattern, runtime] of PARENT_NAME_MAP) {
      if (pattern.test(out)) return runtime;
    }
  } catch {
    // ps may fail on Windows / restricted shells — fall through.
  }
  return null;
}

export function detectRuntime({ env = process.env, useCache = true, headerSource = null } = {}) {
  const headerHit = normalizeRuntime(headerSource);
  if (headerHit) return { runtime: headerHit, via: 'header' };

  if (useCache && existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      const pid = cached?.pid;
      if (cached?.runtime && normalizeRuntime(cached.runtime) && pid === process.ppid) {
        return { runtime: cached.runtime, via: 'cache' };
      }
    } catch {
      // cache corrupt — ignore
    }
  }

  const envOverride = fromEnvOverride(env);
  if (envOverride) return persist({ runtime: envOverride, via: 'env-override' });

  const envSig = fromEnvSignature(env);
  if (envSig) return persist({ runtime: envSig, via: 'env-signature' });

  const parent = fromParentProcess();
  if (parent) return persist({ runtime: parent, via: 'parent-process' });

  return persist({ runtime: 'mcp-generic', via: 'fallback' });
}

function persist(result) {
  try {
    mkdirSync(join(homedir(), '.awareness'), { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ ...result, pid: process.ppid, detected_at: new Date().toISOString() }, null, 2),
    );
  } catch {
    // best-effort cache; never throw
  }
  return result;
}

export function clearRuntimeCache() {
  try {
    if (existsSync(CACHE_PATH)) writeFileSync(CACHE_PATH, '{}');
  } catch {
    // ignore
  }
}
