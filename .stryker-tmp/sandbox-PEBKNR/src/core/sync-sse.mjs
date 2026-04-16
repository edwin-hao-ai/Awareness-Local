/**
 * sync-sse.mjs — Server-Sent Events (SSE) layer for CloudSync.
 *
 * Extracted from cloud-sync.mjs.  Functions receive a context object and an
 * explicit sseState reference instead of mutating `this`.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Errors are caught internally — SSE failures must never crash the daemon.
 */
// @ts-nocheck


// Re-export the low-level SSE helpers from cloud-sync.mjs so consumers can
// import everything SSE-related from a single module.
export { openSSEStream, parseSSE } from './cloud-sync.mjs';

const LOG_PREFIX = '[SyncSSE]';
const SSE_RECONNECT_BASE_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// SSE state factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SSE state object.
 * The coordinator stores this and passes it into every SSE function so that
 * connection lifecycle is managed without class-level `this` mutation.
 *
 * @returns {object}
 */
export function createSSEState() {
  return {
    /** @type {import('node:http').ClientRequest|null} */
    req: null,
    reconnectMs: SSE_RECONNECT_BASE_MS,
    /** @type {ReturnType<typeof setTimeout>|null} */
    reconnectTimer: null,
    stopped: false,
    retryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Start SSE
// ---------------------------------------------------------------------------

/**
 * Connect to the cloud SSE endpoint for real-time event streaming.
 * Automatically reconnects on disconnect with exponential backoff (up to 3
 * retries before falling back to periodic sync only).
 *
 * @param {object} ctx
 * @param {string}   ctx.apiBase       — Cloud API base URL
 * @param {string}   ctx.apiKey        — Cloud API key
 * @param {string}   ctx.memoryId      — Cloud memory ID
 * @param {string}   ctx.deviceId      — Local device identifier
 * @param {function} ctx.handleSSEEvent — async (parsedEvent) => void
 * @param {function} ctx.openSSEStream  — (url, headers) => Promise<{ req, res }>
 * @param {function} ctx.parseSSE       — (buffer) => { parsed, remainder }
 * @param {object}  sseState — Mutable state object from createSSEState()
 */
export async function startSSE(ctx, sseState) {
  const { apiBase, apiKey, memoryId, deviceId, handleSSEEvent, openSSEStream: openStream, parseSSE: parse } = ctx;

  if (!apiBase || !apiKey || !memoryId) return;
  sseState.stopped = false;

  const url = `${apiBase}/memories/${memoryId}/events/stream`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'X-Awareness-Device-Id': deviceId,
  };

  try {
    const { req, res } = await openStream(url, headers);
    sseState.req = req;
    sseState.reconnectMs = SSE_RECONNECT_BASE_MS; // Reset backoff on success

    console.log(`${LOG_PREFIX} SSE connected to cloud`);

    let buffer = '';
    res.setEncoding('utf-8');

    res.on('data', (chunk) => {
      buffer += chunk;
      // SECURITY: Cap SSE buffer to prevent unbounded memory growth
      if (buffer.length > 1024 * 1024) {
        console.warn(`${LOG_PREFIX} SSE buffer overflow (>1MB) — dropping`);
        buffer = '';
        return;
      }
      const { parsed, remainder } = parse(buffer);
      buffer = remainder;

      for (const event of parsed) {
        // Handle event asynchronously — don't block the stream
        handleSSEEvent(event).catch((err) => {
          console.warn(`${LOG_PREFIX} SSE event handler error:`, err.message);
        });
      }
    });

    res.on('end', () => {
      console.warn(`${LOG_PREFIX} SSE stream ended`);
      scheduleSSEReconnect(ctx, sseState);
    });

    res.on('error', (err) => {
      console.warn(`${LOG_PREFIX} SSE stream error:`, err.message);
      scheduleSSEReconnect(ctx, sseState);
    });
  } catch (err) {
    // SSE is optional (server may not support it yet) — silently fall back
    if (err.message && err.message.includes('404')) {
      if (!sseState.retryCount) {
        console.log(`${LOG_PREFIX} SSE not available on server — using periodic sync only`);
      }
      return; // Don't retry on 404; periodic sync is the fallback
    }
    console.warn(`${LOG_PREFIX} SSE connection failed:`, err.message);
    scheduleSSEReconnect(ctx, sseState);
  }
}

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

/**
 * Schedule an SSE reconnection with exponential backoff.
 * Stops retrying after 3 attempts — periodic sync compensates.
 *
 * @param {object} ctx   — Same context as startSSE
 * @param {object} sseState — Mutable SSE state
 */
export function scheduleSSEReconnect(ctx, sseState) {
  if (sseState.stopped) return;

  // Clean up current request
  if (sseState.req) {
    try {
      sseState.req.destroy();
    } catch {
      // ignore
    }
    sseState.req = null;
  }

  const delay = sseState.reconnectMs;
  sseState.reconnectMs = Math.min(sseState.reconnectMs * 2, SSE_RECONNECT_MAX_MS);

  sseState.retryCount = (sseState.retryCount || 0) + 1;
  if (sseState.retryCount >= 3) {
    console.log(`${LOG_PREFIX} SSE unavailable after 3 retries — falling back to periodic sync only`);
    return; // Stop retrying; periodic sync will compensate
  }

  console.log(
    `${LOG_PREFIX} SSE reconnecting in ${Math.round(delay / 1000)}s... (retry ${sseState.retryCount}/3)`
  );

  sseState.reconnectTimer = setTimeout(() => {
    sseState.reconnectTimer = null;
    startSSE(ctx, sseState);
  }, delay);
}

// ---------------------------------------------------------------------------
// Stop SSE
// ---------------------------------------------------------------------------

/**
 * Stop an active SSE connection and cancel pending reconnects.
 *
 * @param {object} sseState — Mutable SSE state from createSSEState()
 */
export function stopSSE(sseState) {
  sseState.stopped = true;

  // Abort SSE connection
  if (sseState.req) {
    try {
      sseState.req.destroy();
    } catch {
      // ignore
    }
    sseState.req = null;
  }

  // Clear SSE reconnect timer
  if (sseState.reconnectTimer) {
    clearTimeout(sseState.reconnectTimer);
    sseState.reconnectTimer = null;
  }

  console.log(`${LOG_PREFIX} SSE stopped`);
}
