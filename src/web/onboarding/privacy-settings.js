/* Awareness — Privacy Settings injector (F-040 Phase 2).
 * Watches #settings-panel-inner for re-renders and appends a Usage Analytics block.
 * Uses /api/v1/telemetry/{status,enable,recent,data} endpoints.
 * Decoupled: zero coupling to the main renderSettingsPanel() function.
 */
(function () {
  if (typeof window === 'undefined' || !document) return;

  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  const SECTION_ID = 'awareness-privacy-section';

  async function fetchJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function buildSection() {
    const status = (await fetchJson('/api/v1/telemetry/status')) || { enabled: false, installation_id: null };
    const enabled = !!status.enabled;
    const instId = status.installation_id || '—';

    const wrap = document.createElement('div');
    wrap.id = SECTION_ID;
    wrap.className = 'settings-section';
    wrap.innerHTML = `
      <h3>${t('privacy.title') || '📊 Usage Analytics'}</h3>
      <div class="setting-row">
        <div class="setting-label">
          ${t('privacy.toggle_label') || 'Send anonymous usage data'}
          <small>${t('privacy.toggle_desc') || 'Helps us prioritize features. Opt-in. No memory content / paths / queries / IPs collected.'}</small>
        </div>
        <label style="display:inline-flex;align-items:center;gap:8px">
          <input type="checkbox" id="awareness-privacy-toggle" ${enabled ? 'checked' : ''}>
          <span id="awareness-privacy-status" style="font-size:0.8rem;color:var(--text-secondary)">${enabled ? (t('privacy.enabled') || 'Enabled') : (t('privacy.disabled') || 'Disabled')}</span>
        </label>
      </div>
      <div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">
        ${t('privacy.install_id') || 'Installation ID'}:
        <code style="background:var(--bg-tertiary);padding:1px 6px;border-radius:4px">${String(instId).slice(0, 16)}…</code>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-secondary" id="awareness-privacy-view" type="button">${t('privacy.view_recent') || 'View recent events'}</button>
        <button class="btn-secondary" id="awareness-privacy-delete" type="button" style="color:var(--red,#e0524d)">${t('privacy.delete_data') || 'Delete my data'}</button>
      </div>
      <pre id="awareness-privacy-events" style="display:none;margin-top:10px;background:var(--bg-tertiary);padding:10px;border-radius:6px;font-size:0.72rem;max-height:240px;overflow:auto"></pre>
    `;

    wrap.querySelector('#awareness-privacy-toggle').addEventListener('change', async (e) => {
      const newEnabled = !!e.target.checked;
      await fetchJson('/api/v1/telemetry/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      wrap.querySelector('#awareness-privacy-status').textContent = newEnabled
        ? (t('privacy.enabled') || 'Enabled')
        : (t('privacy.disabled') || 'Disabled');
    });

    wrap.querySelector('#awareness-privacy-view').addEventListener('click', async () => {
      const data = (await fetchJson('/api/v1/telemetry/recent')) || { events: [] };
      const pre = wrap.querySelector('#awareness-privacy-events');
      pre.style.display = 'block';
      pre.textContent = JSON.stringify(data.events, null, 2) || '(no events queued)';
    });

    wrap.querySelector('#awareness-privacy-delete').addEventListener('click', async () => {
      if (!confirm(t('privacy.confirm_delete') || 'Delete all telemetry data for this installation?')) return;
      await fetchJson('/api/v1/telemetry/data', { method: 'DELETE' });
      const pre = wrap.querySelector('#awareness-privacy-events');
      pre.style.display = 'block';
      pre.textContent = t('privacy.deleted_msg') || 'Local queue cleared. Server-side delete requested.';
    });

    return wrap;
  }

  async function injectIfMissing() {
    const container = document.getElementById('settings-panel-inner');
    if (!container) return;
    if (container.querySelector('#' + SECTION_ID)) return;
    if (!container.children.length) return; // wait for main render
    const section = await buildSection();
    container.appendChild(section);
  }

  function start() {
    const target = document.getElementById('settings-panel-inner');
    if (!target) {
      window.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    // Observer: re-inject every time settings panel is re-rendered.
    const obs = new MutationObserver(() => { injectIfMissing(); });
    obs.observe(target, { childList: true });
    injectIfMissing();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(start, 200);
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
