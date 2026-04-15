/* Awareness Onboarding — step renderers (pure functions returning HTML + wiring handlers)
 * Each step renders into a provided root element. Navigation is driven by index.js.
 */
(function () {
  const TOTAL = 6;
  const t = (key, vars) => (window.t ? window.t(key, vars) : key);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function header(stepN, { optional = false, onSkipStep, onSkipAll } = {}) {
    const right = onSkipAll
      ? `<button class="onb-btn onb-btn-secondary" data-action="skip-all">${esc(t('onb.skip_finish'))}</button>`
      : onSkipStep
        ? `<button class="onb-btn onb-btn-secondary" data-action="skip-step">${esc(t('onb.skip_step'))}</button>`
        : '';
    const badge = optional ? `<span class="onb-optional">${esc(t('onb.optional'))}</span>` : '';
    return `<div class="onb-header">
      <span>${esc(t('onb.step_of', { n: stepN, total: TOTAL }))} ${badge}</span>
      ${right}
    </div>`;
  }

  /**
   * Wire up the generic header buttons (skip-step / skip-all) inside `root`.
   * Must be called from every step that used header() with a matching handler.
   * Safe to call even when the handler is absent — it only binds present buttons.
   */
  function wireHeader(root, { onSkipStep, onSkipAll } = {}) {
    if (onSkipAll) {
      root.querySelectorAll('[data-action="skip-all"]').forEach((b) => {
        b.onclick = onSkipAll;
      });
    }
    if (onSkipStep) {
      root.querySelectorAll('[data-action="skip-step"]').forEach((b) => {
        // Don't clobber step-local skip-step bindings added by the step itself.
        if (!b.onclick) b.onclick = onSkipStep;
      });
    }
  }

  // ── Step 1: Welcome ─────────────────────────────────────────────────
  function renderWelcome(root, { onNext, onSkipAll }) {
    root.innerHTML = `
      <div class="onb-modal">
        ${header(1, { onSkipAll })}
        <div style="text-align:center;font-size:2.5rem;margin-bottom:8px">🧠</div>
        <div class="onb-title" style="text-align:center">${esc(t('onb.welcome.title'))}</div>
        <div class="onb-subtitle" style="text-align:center">${esc(t('onb.welcome.subtitle'))}</div>
        <ul class="onb-feature-list">
          <li>${esc(t('onb.welcome.bullet_index'))}</li>
          <li>${esc(t('onb.welcome.bullet_recall'))}</li>
          <li>${esc(t('onb.welcome.bullet_connect'))}</li>
          <li>${esc(t('onb.welcome.bullet_cloud'))}</li>
        </ul>
        <label class="onb-telemetry-row" style="display:flex;align-items:flex-start;gap:8px;margin:14px 4px 4px;font-size:0.82rem;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" id="onb-telemetry-opt" checked style="margin-top:3px">
          <span>
            <strong style="color:var(--text-primary)">${esc(t('onb.welcome.telemetry_label'))}</strong><br>
            <span style="font-size:0.74rem">${esc(t('onb.welcome.telemetry_hint'))}</span>
          </span>
        </label>
        <div class="onb-actions" style="justify-content:center">
          <button class="onb-btn onb-btn-primary" data-action="next">${esc(t('onb.welcome.cta'))} →</button>
        </div>
        <div style="text-align:center;margin-top:12px">
          <button class="onb-btn onb-btn-secondary" data-action="skip-all">${esc(t('onb.welcome.skip_all'))}</button>
        </div>
      </div>`;
    const opt = root.querySelector('#onb-telemetry-opt');
    const persistOptIn = async () => {
      const enabled = !!opt?.checked;
      try {
        await fetch('/api/v1/telemetry/enable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      } catch {}
    };
    root.querySelector('[data-action="next"]').onclick = async () => { await persistOptIn(); onNext(); };
    root.querySelectorAll('[data-action="skip-all"]').forEach((b) => {
      b.onclick = async () => { await persistOptIn(); onSkipAll(); };
    });
  }

  // ── Step 2: Scan ────────────────────────────────────────────────────
  async function renderScan(root, { onNext, onSkipStep, getProjectDir, triggerScan }) {
    const projectDir = await getProjectDir().catch(() => '—');
    root.innerHTML = `
      <div class="onb-modal">
        ${header(2, { onSkipStep })}
        <div class="onb-title">📂 ${esc(t('onb.scan.title'))}</div>
        <div class="onb-subtitle">${esc(t('onb.scan.intro'))}</div>
        <div style="background:var(--bg-tertiary);padding:10px 14px;border-radius:6px;margin-bottom:12px;font-family:ui-monospace,Menlo,monospace;font-size:0.8rem">
          ${esc(t('onb.scan.current_dir'))}: <span style="color:var(--accent)">${esc(projectDir)}</span>
        </div>
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px">🔒 ${esc(t('onb.scan.privacy'))}</div>
        <div id="onb-scan-progress" style="display:none">
          <div class="onb-progress-bar"><div class="onb-progress-fill" id="onb-scan-fill" style="width:0%"></div></div>
          <div id="onb-scan-status" style="font-size:0.85rem;color:var(--text-secondary)"></div>
        </div>
        <div class="onb-actions">
          <button class="onb-btn onb-btn-secondary" data-action="skip-step">${esc(t('onb.skip_step'))}</button>
          <button class="onb-btn onb-btn-primary" data-action="scan">${esc(t('onb.scan.cta'))} →</button>
        </div>
      </div>`;
    root.querySelector('[data-action="skip-step"]').onclick = onSkipStep;
    root.querySelector('[data-action="scan"]').onclick = async () => {
      const progress = root.querySelector('#onb-scan-progress');
      const fill = root.querySelector('#onb-scan-fill');
      const status = root.querySelector('#onb-scan-status');
      progress.style.display = 'block';
      try {
        const result = await triggerScan((p) => {
          fill.style.width = `${p.pct || 0}%`;
          status.textContent = t('onb.scan.progress', { pct: p.pct || 0 });
        });
        status.textContent = t('onb.scan.summary', {
          files: result?.files ?? 0,
          symbols: result?.symbols ?? 0,
          wiki: result?.wiki ?? 0,
        });
        setTimeout(onNext, 800);
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    };
  }

  // ── Step 3: First Recall ────────────────────────────────────────────
  async function renderRecall(root, { onNext, onSkipStep, getSuggestions, runRecall }) {
    const suggestions = await getSuggestions();
    const items = suggestions.map((s) =>
      `<button class="onb-suggestion" data-q="${esc(s)}">💡 ${esc(s)}</button>`
    ).join('');

    root.innerHTML = `
      <div class="onb-modal">
        ${header(3, { onSkipStep })}
        <div class="onb-title">🔍 ${esc(t('onb.recall.title'))}</div>
        <div class="onb-subtitle">${esc(t('onb.recall.hint'))}</div>
        <div>${items || `<div style="color:var(--text-muted);font-size:0.85rem">${esc(t('onb.recall.no_results'))}</div>`}</div>
        <div id="onb-recall-results" style="margin-top:16px"></div>
        <div class="onb-actions">
          <button class="onb-btn onb-btn-secondary" data-action="skip-step">${esc(t('onb.skip_step'))}</button>
          <button class="onb-btn onb-btn-primary" data-action="next">${esc(t('onb.recall.next'))} →</button>
        </div>
      </div>`;
    root.querySelector('[data-action="skip-step"]').onclick = onSkipStep;
    root.querySelector('[data-action="next"]').onclick = onNext;
    root.querySelectorAll('[data-q]').forEach((btn) => {
      btn.onclick = async () => {
        const q = btn.dataset.q;
        const box = root.querySelector('#onb-recall-results');
        box.innerHTML = '<div style="color:var(--text-muted)">…</div>';
        const res = await runRecall(q);
        // runRecall now returns { items, meta } — support legacy shape too.
        const items = Array.isArray(res) ? res : (res?.items || []);
        const meta = (res && res.meta) || {};
        const stats = (items.length && meta.elapsedMs !== undefined)
          ? `<div class="onb-recall-stats">${esc(t('onb.recall.stats', {
              ms: meta.elapsedMs,
              hits: meta.raw_hits || items.length,
              total: meta.total || meta.raw_hits || items.length,
            }))}</div>`
          : '';
        const header = `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:6px">${esc(t('onb.recall.results'))}</div>`;
        const body = items.length
          ? items.map((r) => {
              const rel = r.relativeTime ? ` · ${esc(r.relativeTime)}` : '';
              const type = r.type ? `<span class="onb-result-type">${esc(r.type)}</span>` : '';
              const icon = r.icon || '📄';
              return `<div class="onb-result">
                <div class="onb-result-meta">${type}${rel}</div>
                <div class="onb-result-title">${icon} ${esc(r.title)}</div>
                <div class="onb-result-summary">${esc(r.summary || '')}</div>
              </div>`;
            }).join('')
          : `<div class="onb-result">${esc(t('onb.recall.no_results'))}</div>`;
        box.innerHTML = stats + header + body;
      };
    });
  }

  // ── Step 4: Wiki Aha ────────────────────────────────────────────────
  async function renderWiki(root, { onNext, onSkipStep, getWikiSummary }) {
    const { total, samples } = await getWikiSummary();
    const list = samples.length
      ? samples.map((s) =>
          `<div class="onb-result">
             <div class="onb-result-title">📘 ${esc(s.title)}</div>
             <div class="onb-result-summary">${esc(s.description || '')}</div>
           </div>`
        ).join('')
      : `<div class="onb-result">${esc(t('onb.wiki.empty'))}</div>`;

    root.innerHTML = `
      <div class="onb-modal">
        ${header(4, { onSkipStep })}
        <div class="onb-title">✨ ${esc(t('onb.wiki.title'))}</div>
        <div class="onb-subtitle">${esc(t('onb.wiki.description'))}</div>
        ${list}
        ${total > samples.length ? `<div style="text-align:center;margin-top:10px;font-size:0.85rem;color:var(--text-muted)">${esc(t('onb.wiki.view_all', { n: total }))}</div>` : ''}
        <div class="onb-actions">
          <button class="onb-btn onb-btn-secondary" data-action="skip-step">${esc(t('onb.skip_step'))}</button>
          <button class="onb-btn onb-btn-primary" data-action="next">${esc(t('onb.wiki.next'))} →</button>
        </div>
      </div>`;
    root.querySelector('[data-action="skip-step"]').onclick = onSkipStep;
    root.querySelector('[data-action="next"]').onclick = onNext;
  }

  // ── Step 5: Cloud (device-auth) ─────────────────────────────────────
  function renderCloudIntro(root, { onConnect, onLater }) {
    root.innerHTML = `
      <div class="onb-modal">
        ${header(5, { optional: true, onSkipAll: onLater })}
        <div class="onb-title">☁️ ${esc(t('onb.cloud.title'))}</div>
        <div class="onb-subtitle">${esc(t('onb.cloud.intro'))}</div>
        <div class="onb-feature-list" style="list-style:none">
          <li><strong>🔄 ${esc(t('onb.cloud.feat_sync.title'))}</strong> — ${esc(t('onb.cloud.feat_sync.desc'))}</li>
          <li><strong>👥 ${esc(t('onb.cloud.feat_team.title'))}</strong> — ${esc(t('onb.cloud.feat_team.desc'))}</li>
          <li><strong>📊 ${esc(t('onb.cloud.feat_growth.title'))}</strong> — ${esc(t('onb.cloud.feat_growth.desc'))}</li>
          <li><strong>🛒 ${esc(t('onb.cloud.feat_market.title'))}</strong> — ${esc(t('onb.cloud.feat_market.desc'))}</li>
        </div>
        <div style="text-align:center;color:var(--text-secondary);font-size:0.85rem;margin:12px 0">
          ${esc(t('onb.cloud.free_tier'))}
        </div>
        <div class="onb-actions" style="justify-content:center">
          <button class="onb-btn onb-btn-primary" data-action="connect">${esc(t('onb.cloud.cta_connect'))} →</button>
          <button class="onb-btn onb-btn-secondary" data-action="later">${esc(t('onb.cloud.cta_later'))}</button>
        </div>
        <div style="text-align:center;font-size:0.75rem;color:var(--text-muted);margin-top:12px">
          ${esc(t('onb.cloud.hint_settings'))}
        </div>
      </div>`;
    root.querySelector('[data-action="connect"]').onclick = onConnect;
    root.querySelector('[data-action="later"]').onclick = onLater;
    // Header "skip, finish" button → same effect as "later": skip cloud + go to done.
    wireHeader(root, { onSkipAll: onLater });
  }

  function renderAuthPending(root, { user_code, verification_uri, onCancel, onReopen }) {
    // Force https-only URL — defang javascript:, data:, etc.
    const safeUri = /^https?:\/\//i.test(String(verification_uri || ''))
      ? String(verification_uri)
      : 'about:blank';
    const link = `${safeUri}?code=${encodeURIComponent(user_code)}`;
    root.innerHTML = `
      <div class="onb-modal">
        <div class="onb-title">📱 ${esc(t('onb.auth.title'))}</div>
        <div class="onb-subtitle">${esc(t('onb.auth.body'))}</div>
        <a class="onb-link" href="${esc(link)}" target="_blank" rel="noopener">${esc(safeUri)}</a>
        <div style="margin-top:16px;font-size:0.85rem;color:var(--text-secondary)">${esc(t('onb.auth.code_label'))}</div>
        <div class="onb-code-display">${esc(user_code)}</div>
        <div style="font-size:0.85rem;color:var(--text-muted);text-align:center">⏳ ${esc(t('onb.auth.pending'))}</div>
        <div class="onb-actions">
          <button class="onb-btn onb-btn-secondary" data-action="cancel">${esc(t('onb.auth.cancel'))}</button>
          <button class="onb-btn onb-btn-secondary" data-action="reopen">${esc(t('onb.auth.reopen'))}</button>
        </div>
      </div>`;
    root.querySelector('[data-action="cancel"]').onclick = onCancel;
    root.querySelector('[data-action="reopen"]').onclick = onReopen;
  }

  function renderMemorySelect(root, { memories, onConfirm, onCancel }) {
    const opts = (memories || []).map((m, i) =>
      `<label class="onb-memory-option">
        <input type="radio" name="onb-mem" value="${esc(m.id)}" ${i === 0 ? 'checked' : ''}>
        <span>${esc(m.name || m.id)}</span>
      </label>`
    ).join('') || `<div class="onb-result">No memories yet. Create one on awareness.market first.</div>`;

    root.innerHTML = `
      <div class="onb-modal">
        <div class="onb-title">✓ ${esc(t('onb.auth.select_title'))}</div>
        <div style="margin:16px 0">${opts}</div>
        <div class="onb-actions">
          <button class="onb-btn onb-btn-secondary" data-action="cancel">${esc(t('onb.auth.cancel'))}</button>
          <button class="onb-btn onb-btn-primary" data-action="confirm">${esc(t('onb.auth.confirm'))} →</button>
        </div>
      </div>`;
    root.querySelector('[data-action="cancel"]').onclick = onCancel;
    root.querySelector('[data-action="confirm"]').onclick = () => {
      const sel = root.querySelector('input[name="onb-mem"]:checked');
      const id = sel?.value;
      const name = memories.find((m) => m.id === id)?.name || id;
      if (id) onConfirm({ memory_id: id, memory_name: name });
    };
  }

  // ── Step 6: Done ────────────────────────────────────────────────────
  function renderDone(root, { checks, onFinish }) {
    const items = [
      checks.index && t('onb.done.checked_index'),
      checks.wiki && t('onb.done.checked_wiki'),
      checks.mcp && t('onb.done.checked_mcp'),
      checks.cloud && t('onb.done.checked_cloud'),
    ].filter(Boolean).map((s) => `<li>${esc(s)}</li>`).join('');

    root.innerHTML = `
      <div class="onb-modal">
        <div class="onb-title" style="text-align:center">🎉 ${esc(t('onb.done.title'))}</div>
        <ul class="onb-feature-list">${items}</ul>
        <div style="font-size:0.9rem;color:var(--text-secondary);margin-top:12px">${esc(t('onb.done.next_title'))}</div>
        <ul style="margin:8px 0 16px 20px;color:var(--text-secondary);font-size:0.85rem">
          <li>${esc(t('onb.done.next_connect'))}</li>
          <li>${esc(t('onb.done.next_quickstart'))}</li>
          <li>${esc(t('onb.done.next_community'))}</li>
        </ul>
        <div class="onb-actions" style="justify-content:center">
          <button class="onb-btn onb-btn-primary" data-action="finish">${esc(t('onb.done.cta'))} →</button>
        </div>
      </div>`;
    root.querySelector('[data-action="finish"]').onclick = onFinish;
  }

  window.AwarenessOnboardingSteps = {
    TOTAL,
    renderWelcome,
    renderScan,
    renderRecall,
    renderWiki,
    renderCloudIntro,
    renderAuthPending,
    renderMemorySelect,
    renderDone,
  };
})();
