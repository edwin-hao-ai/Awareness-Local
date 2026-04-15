/**
 * Telemetry API Handlers — HTTP endpoints for opt-in analytics (F-040 Phase 2).
 *
 * Endpoints:
 *   GET    /api/v1/telemetry/status   — {enabled, installation_id}
 *   POST   /api/v1/telemetry/enable   — {enabled: boolean} (also persists to config.telemetry.enabled)
 *   POST   /api/v1/telemetry/track    — {event_type, properties?} forward to core Telemetry.track()
 *   GET    /api/v1/telemetry/recent   — list last 50 queued/unsent events
 *   DELETE /api/v1/telemetry/data     — clear local queue + request server-side delete
 */

import fs from 'node:fs';
import path from 'node:path';
import { jsonResponse, readBody } from './helpers.mjs';
import { getTelemetry } from '../core/telemetry.mjs';

function updateConfigTelemetryFlag(projectDir, enabled) {
  const configPath = path.join(projectDir, '.awareness', 'config.json');
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    cfg.telemetry = { ...(cfg.telemetry || {}), enabled: !!enabled };
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath);
    return true;
  } catch {
    return false;
  }
}

export function apiTelemetryStatus(daemon, _req, res) {
  const tel = getTelemetry();
  return jsonResponse(res, {
    enabled: !!tel?.enabled,
    installation_id: tel?.installationId || null,
  });
}

export async function apiTelemetryEnable(daemon, req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }
  const enabled = body.enabled === true;
  const tel = getTelemetry();
  tel?.setEnabled(enabled);
  const persisted = updateConfigTelemetryFlag(daemon.projectDir, enabled);
  return jsonResponse(res, { enabled, persisted });
}

export function apiTelemetryRecent(_daemon, _req, res) {
  const tel = getTelemetry();
  const events = tel?.listRecent(50) || [];
  return jsonResponse(res, { events, installation_id: tel?.installationId || null });
}

export async function apiTelemetryDelete(_daemon, _req, res) {
  const tel = getTelemetry();
  if (!tel) return jsonResponse(res, { ok: false, error: 'telemetry not initialized' }, 503);
  await tel.deleteLocal();
  return jsonResponse(res, { ok: true });
}

/**
 * POST /api/v1/telemetry/track — forward a browser-side event into the local queue.
 * Used by web onboarding (steps.js) so that onboarding_step, onboarding_completed,
 * onboarding_skipped events are queued exactly like server-side events.
 *
 * Body: { event_type: string, properties?: Record<string,unknown> }
 */
export async function apiTelemetryTrack(_daemon, req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }
  const { event_type, properties } = body;
  if (!event_type || typeof event_type !== 'string') {
    return jsonResponse(res, { error: 'event_type must be a non-empty string' }, 400);
  }
  const tel = getTelemetry();
  if (!tel) return jsonResponse(res, { ok: false, error: 'telemetry not initialized' }, 503);
  tel.track(event_type, typeof properties === 'object' && properties !== null ? properties : {});
  return jsonResponse(res, { ok: true });
}
