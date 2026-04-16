/* Awareness Onboarding — device-auth orchestration
 * Thin wrapper over existing /cloud/auth/start, /cloud/auth/poll, /cloud/memories, /cloud/connect.
 * Keeps onboarding UI decoupled from index.html's startDeviceAuth().
 */
// @ts-nocheck

(function () {
  const API = '/api/v1';

  async function post(path, body) {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }
  async function get(path) {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }

  /**
   * Initiate device-auth. Returns { user_code, verification_uri, device_code, interval }.
   * The awareness.market page handles signup redirect for unregistered users.
   */
  async function start() {
    return post('/cloud/auth/start');
  }

  /** Open the verification URL in the user's browser. Non-fatal if it fails. */
  async function openBrowser(url) {
    try {
      await post('/cloud/auth/open-browser', { url });
    } catch {
      try { window.open(url, '_blank'); } catch {}
    }
  }

  /** Poll until the user authorizes or it fails. Returns { api_key }. */
  async function pollUntilAuthorized({ device_code, interval = 5 }) {
    return post('/cloud/auth/poll', { device_code, interval });
  }

  /** List memories visible to this api_key. */
  async function listMemories(apiKey) {
    return get(`/cloud/memories?api_key=${encodeURIComponent(apiKey)}`);
  }

  /** Persist connection: api_key + memory_id. */
  async function connect({ api_key, memory_id, memory_name }) {
    return post('/cloud/connect', { api_key, memory_id, memory_name });
  }

  window.AwarenessOnboardingAuth = {
    start,
    openBrowser,
    pollUntilAuthorized,
    listMemories,
    connect,
  };
})();
