/* Awareness Onboarding — entry + state machine driver
 * Assembles modules loaded before this file:
 *   i18n.js                (merges keys into window.LOCALES)
 *   state.js               (window.AwarenessOnboardingState)
 *   recall-suggestions.js  (window.AwarenessOnboardingRecall)
 *   device-auth-flow.js    (window.AwarenessOnboardingAuth)
 *   steps.js               (window.AwarenessOnboardingSteps)
 */
(function () {
  const State = window.AwarenessOnboardingState;
  const Recall = window.AwarenessOnboardingRecall;
  const Auth = window.AwarenessOnboardingAuth;
  const Steps = window.AwarenessOnboardingSteps;

  if (!State || !Recall || !Auth || !Steps) {
    console.warn('[onboarding] submodules missing — aborting');
    return;
  }

  let overlayEl = null;
  let pollAbort = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'onb-overlay';
    overlayEl.id = 'awareness-onboarding';
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function tearDown(markComplete = true) {
    if (pollAbort) { try { pollAbort(); } catch {} pollAbort = null; }
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    if (markComplete) {
      State.markCompleted();
      const skippedSteps = State.skippedSteps();
      if (skippedSteps.length > 0) {
        trackOnboarding('onboarding_skipped', { skipped_steps: skippedSteps, at_step: State.currentStep() });
      } else {
        trackOnboarding('onboarding_completed', { at_step: State.currentStep() });
      }
    }
  }

  /** Fire-and-forget telemetry via local daemon endpoint. Silent on failure. */
  function trackOnboarding(event_type, properties) {
    try {
      fetch('/api/v1/telemetry/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type, properties }),
      }).catch(() => {});
    } catch { /* non-fatal */ }
  }

  async function getProjectDir() {
    try {
      const r = await fetch('/healthz');
      const j = await r.json();
      return j?.project_dir || '—';
    } catch { return '—'; }
  }

  async function triggerScan(onProgress) {
    // Uses daemon scan API (scan-api-handlers.mjs): trigger + poll status.
    try {
      await fetch('/api/v1/scan/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'incremental' }),
      }).catch(() => {});
      let lastPct = 0;
      for (let i = 0; i < 60; i++) {
        const r = await fetch('/api/v1/scan/status').catch(() => null);
        if (r && r.ok) {
          const s = await r.json();
          const status = s?.status || 'idle';
          // Heuristic progress: scanning=30%, indexing=70%, idle=100% (after trigger).
          let pct = lastPct;
          if (status === 'scanning') pct = Math.max(pct, 30);
          else if (status === 'indexing') pct = Math.max(pct, 70);
          else if (status === 'idle' && i > 0) pct = 100;
          if (pct !== lastPct) { onProgress({ pct }); lastPct = pct; }
          if (status === 'idle' && i > 0) {
            return {
              files: s?.total_files || 0,
              symbols: s?.total_symbols || 0,
              wiki: s?.total_wiki || 0,
            };
          }
        } else {
          onProgress({ pct: Math.min(90, lastPct + 15) });
          lastPct = Math.min(90, lastPct + 15);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch {}
    onProgress({ pct: 100 });
    return { files: 0, symbols: 0, wiki: 0 };
  }

  async function getWikiSummary() {
    try {
      const r = await fetch('/api/v1/scan/files?category=wiki&limit=10');
      if (r.ok) {
        const data = await r.json();
        const pages = Array.isArray(data?.files) ? data.files : [];
        return {
          total: data?.total || pages.length,
          samples: pages.slice(0, 3).map((p) => ({
            title: p.title || '(untitled)',
            description: p.relativePath || '',
          })),
        };
      }
    } catch {}
    return { total: 0, samples: [] };
  }

  async function runRecall(q) {
    // Returns { items, meta } with elapsedMs/total for the stats bar.
    return Recall.runRecall(q, 3);
  }

  async function getSuggestions() {
    // Prefer content-driven questions (tag hotness + card titles); falls back
    // to meta templates when the workspace has no knowledge cards yet.
    if (Recall.getSuggestions) return Recall.getSuggestions();
    const meta = await Recall.loadScanMeta();
    return Recall.pickSuggestions(meta);
  }

  // ── Step flow ─────────────────────────────────────────────────────
  function go(stepN) {
    State.setStep(stepN);
    // Track step entry — fire-and-forget, never blocks navigation
    trackOnboarding('onboarding_step', { step_number: stepN });
    const root = ensureOverlay();
    switch (stepN) {
      case 1:
        return Steps.renderWelcome(root, {
          onNext: () => go(2),
          onSkipAll: () => tearDown(true),
        });
      case 2:
        return Steps.renderScan(root, {
          onNext: () => go(3),
          onSkipStep: () => { State.skipStep(2); go(3); },
          getProjectDir,
          triggerScan,
        });
      case 3:
        return Steps.renderRecall(root, {
          onNext: () => go(4),
          onSkipStep: () => { State.skipStep(3); go(4); },
          getSuggestions,
          runRecall,
        });
      case 4:
        return Steps.renderWiki(root, {
          onNext: () => go(5),
          onSkipStep: () => { State.skipStep(4); go(5); },
          getWikiSummary,
        });
      case 5:
        // If the user has already connected cloud (either in a prior run or
        // via the dashboard's Settings panel), skip Step 5 silently rather
        // than asking them to "connect cloud" a second time.
        (async () => {
          try {
            const r = await fetch('/api/v1/sync/status');
            if (r.ok) {
              const s = await r.json();
              if (s?.cloud_enabled || s?.enabled || s?.connected) {
                window.__onb_cloud_connected = true;
                return go(6);
              }
            }
          } catch { /* fall through to cloud intro */ }
          return Steps.renderCloudIntro(root, {
            onConnect: () => startDeviceAuth(root),
            onLater: () => go(6),
          });
        })();
        return;
      case 6:
        return Steps.renderDone(root, {
          checks: {
            index: !State.skippedSteps().includes(2),
            wiki: !State.skippedSteps().includes(4),
            mcp: true,
            cloud: !!window.__onb_cloud_connected,
          },
          onFinish: () => tearDown(true),
        });
      default:
        tearDown(true);
    }
  }

  async function startDeviceAuth(root) {
    try {
      const { user_code, verification_uri, device_code, interval } = await Auth.start();
      const link = `${verification_uri}?code=${encodeURIComponent(user_code)}`;
      Auth.openBrowser(link);

      let cancelled = false;
      pollAbort = () => { cancelled = true; };

      Steps.renderAuthPending(root, {
        user_code,
        verification_uri,
        onCancel: () => { cancelled = true; go(5); },
        onReopen: () => Auth.openBrowser(link),
      });

      const result = await Auth.pollUntilAuthorized({ device_code, interval: interval || 5 });
      if (cancelled) return;
      if (!result?.api_key) throw new Error('no api_key returned');

      const memories = await Auth.listMemories(result.api_key);
      Steps.renderMemorySelect(root, {
        memories: memories || [],
        onCancel: () => go(5),
        onConfirm: async ({ memory_id, memory_name }) => {
          await Auth.connect({ api_key: result.api_key, memory_id, memory_name });
          window.__onb_cloud_connected = true;
          // Notify the persistent status chip so it flips from
          // "Local mode" to "Cloud synced" immediately (not after 30s).
          try {
            window.dispatchEvent(new CustomEvent('awareness:cloud-changed', {
              detail: { enabled: true, memory_id, memory_name },
            }));
          } catch { /* older browsers — chip will still update on next tick */ }
          go(6);
        },
      });
    } catch (e) {
      root.innerHTML = `<div class="onb-modal">
        <div class="onb-title" style="color:var(--red)">${(window.t ? window.t('onb.auth.failed') : 'Authorization failed')}</div>
        <div class="onb-subtitle">${e.message}</div>
        <div class="onb-actions"><button class="onb-btn onb-btn-primary" data-retry>Retry</button></div>
      </div>`;
      root.querySelector('[data-retry]').onclick = () => startDeviceAuth(root);
    }
  }

  function launch() {
    const start = State.currentStep();
    go(start);
  }

  function maybeAutoLaunch() {
    if (State.shouldAutoLaunch()) {
      // Defer to after DOM is settled so we never block first paint.
      if (document.readyState === 'complete') {
        setTimeout(launch, 200);
      } else {
        window.addEventListener('load', () => setTimeout(launch, 200), { once: true });
      }
    }
  }

  window.AwarenessOnboarding = {
    launch,
    reset: () => { State.reset(); launch(); },
    isCompleted: () => State.isCompleted(),
  };

  maybeAutoLaunch();
})();
