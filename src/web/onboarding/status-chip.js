/* Awareness — persistent status chip (dashboard floating widget).
 * Shows local/cloud mode, memory count, and a "Connect cloud" CTA.
 * Refreshes every 30s. Re-uses /api/v1/stats + /api/v1/cloud/status.
 * Decoupled: no dependency on onboarding overlay. Mounts on DOMContentLoaded.
 */
(function () {
  if (typeof window === 'undefined' || !document) return;

  const REFRESH_MS = 30_000;
  let rootEl = null;
  let timer = null;

  const T = () => (typeof window.t === 'function' ? window.t : (k) => k);

  function ensureMounted() {
    if (rootEl) return rootEl;
    rootEl = document.createElement('div');
    rootEl.className = 'onb-status-chip';
    rootEl.id = 'awareness-status-chip';
    rootEl.innerHTML = `
      <div class="onb-status-row">
        <span class="onb-status-dot" data-dot></span>
        <span class="onb-status-mode" data-mode>Local mode</span>
      </div>
      <div class="onb-status-meta" data-meta>—</div>
      <button class="onb-status-cta" data-cta hidden></button>
    `;
    document.body.appendChild(rootEl);
    rootEl.querySelector('[data-cta]').addEventListener('click', () => {
      if (window.AwarenessOnboarding?.reset) window.AwarenessOnboarding.reset();
      else if (typeof window.startDeviceAuth === 'function') window.startDeviceAuth();
    });
    return rootEl;
  }

  async function fetchJson(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function fmtCount(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  async function refresh() {
    const el = ensureMounted();
    const [stats, cloud] = await Promise.all([
      fetchJson('/api/v1/stats'),
      fetchJson('/api/v1/sync/status'),
    ]);
    const cloudOn = !!(cloud?.cloud_enabled || cloud?.enabled || cloud?.connected);
    const total = stats?.totalKnowledge ?? stats?.stats?.totalKnowledge ?? 0;
    const projects = stats?.projects ?? stats?.stats?.projects ?? 1;

    const dot = el.querySelector('[data-dot]');
    const mode = el.querySelector('[data-mode]');
    const meta = el.querySelector('[data-meta]');
    const cta = el.querySelector('[data-cta]');

    const tr = T();
    if (cloudOn) {
      dot.className = 'onb-status-dot onb-status-dot-cloud';
      mode.textContent = tr('onb.chip.cloud_on') || 'Cloud synced';
      meta.textContent = `${fmtCount(total)} memories · ${projects} project${projects === 1 ? '' : 's'}`;
      cta.hidden = true;
    } else {
      dot.className = 'onb-status-dot onb-status-dot-local';
      mode.textContent = tr('onb.chip.local_mode') || 'Local mode';
      meta.textContent = `${fmtCount(total)} memories · ${projects} project${projects === 1 ? '' : 's'}`;
      cta.hidden = false;
      cta.textContent = tr('onb.chip.connect_cta') || 'Connect cloud →';
    }
  }

  function start() {
    ensureMounted();
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
    // React immediately to cloud connect/disconnect events dispatched by
    // the onboarding flow (or anywhere else that flips cloud state).
    // Without this, the chip stays on "Local mode" for up to 30s after
    // the user finishes cloud auth — a user-visible regression.
    window.addEventListener('awareness:cloud-changed', () => {
      refresh().catch(() => {});
    });
    // Also refresh on tab focus so a user returning from the auth browser
    // tab sees the updated chip without waiting for the poll tick.
    window.addEventListener('focus', () => { refresh().catch(() => {}); });
  }

  // Expose refresh so tests and other modules can force an update.
  window.AwarenessStatusChip = { refresh };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(start, 100);
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }

  window.AwarenessStatusChip = { refresh, destroy: () => { if (timer) clearInterval(timer); rootEl?.remove(); rootEl = null; } };
})();
