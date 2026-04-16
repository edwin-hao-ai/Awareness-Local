/* Awareness Onboarding — dynamic recall suggestion picker
 * Inspects scan metadata + stats to pick 3 questions the memory can actually answer.
 */
// @ts-nocheck

(function () {
  const t = () => window.t || ((k) => k);

  /**
   * @param {{has_readme?:boolean, wiki_titles?:string[], top_language?:string, has_docs?:boolean, total_cards?:number}} meta
   * @returns {string[]} up to 3 ready-to-click suggestion strings
   */
  function pickSuggestions(meta) {
    const m = meta || {};
    const T = t();
    const picks = [];
    // Normalize to local var for rest of function
    meta = m;

    if (meta.has_readme) {
      picks.push(T('onb.q.readme'));
    }
    if (Array.isArray(meta.wiki_titles) && meta.wiki_titles[0]) {
      picks.push(T('onb.q.wiki_page', { title: meta.wiki_titles[0] }));
    }
    if (meta.has_docs && picks.length < 3) {
      picks.push(T('onb.q.architecture'));
    }
    if (meta.top_language && picks.length < 3) {
      picks.push(T('onb.q.lang', { lang: meta.top_language }));
    }
    if ((meta.total_cards || 0) > 0 && picks.length < 3) {
      picks.push(T('onb.q.decisions'));
    }

    return picks.slice(0, 3);
  }

  /**
   * Gather scan metadata from the daemon.
   * Uses existing endpoints only: /api/v1/stats, /api/v1/scan/status, /api/v1/scan/files?category=wiki.
   */
  async function loadScanMeta() {
    const base = '/api/v1';
    const meta = {
      has_readme: false,
      wiki_titles: [],
      top_language: null,
      has_docs: false,
      total_cards: 0,
    };

    try {
      const r = await fetch(`${base}/stats`);
      if (r.ok) {
        const s = await r.json();
        meta.total_cards = s?.totalKnowledge ?? s?.stats?.totalKnowledge ?? 0;
      }
    } catch {}

    try {
      const r = await fetch(`${base}/scan/status`);
      if (r.ok) {
        const s = await r.json();
        const langs = s?.languages || s?.language_counts || {};
        const top = Object.entries(langs).sort((a, b) => b[1] - a[1])[0];
        if (top) meta.top_language = top[0];
        meta.has_readme = !!s?.has_readme;
        meta.has_docs = !!s?.has_docs || !!s?.doc_count;
      }
    } catch {}

    // Derive has_docs / has_readme from scan/files if scan/status doesn't provide them.
    try {
      const r = await fetch(`${base}/scan/files?category=docs&limit=1`);
      if (r.ok) {
        const d = await r.json();
        if ((d?.total || 0) > 0) meta.has_docs = true;
        if ((d?.files || []).some((f) => /readme/i.test(f.title || f.relativePath || ''))) {
          meta.has_readme = true;
        }
      }
    } catch {}

    try {
      const r = await fetch(`${base}/scan/files?category=wiki&limit=5`);
      if (r.ok) {
        const data = await r.json();
        const pages = Array.isArray(data?.files) ? data.files : [];
        meta.wiki_titles = pages.map((p) => p.title).filter(Boolean).slice(0, 5);
      }
    } catch {}

    return meta;
  }

  /** Run a recall against the daemon, return normalized results.
   * Uses GET /api/v1/search — the real daemon endpoint. There is NO REST
   * /recall route; recall is only exposed via MCP (awareness_recall tool).
   * Returns { items, meta: { elapsedMs, total, raw_hits } } for the stats bar.
   */
  async function runRecall(query, limit = 3) {
    const started = Date.now();
    try {
      const url = `/api/v1/search?q=${encodeURIComponent(query)}&limit=${Math.max(limit, 8)}`;
      const r = await fetch(url);
      const elapsedMs = Date.now() - started;
      if (!r.ok) return { items: [], meta: { elapsedMs, total: 0, raw_hits: 0 } };
      const data = await r.json();
      const raw = data?.items || data?.results || data?.memories || [];
      const fmt = (typeof window !== 'undefined' && window.AwarenessOnboardingFormat) || null;
      const items = fmt
        ? fmt.formatResults(raw, { limit })
        : raw.slice(0, limit).map((it) => ({
            title: it.title || it.filepath || it.id || '(untitled)',
            summary: it.summary || it.content || '',
            score: it.score || it.weighted_rank || 0,
          }));
      return { items, meta: { elapsedMs, total: data?.total || raw.length, raw_hits: raw.length } };
    } catch {
      return { items: [], meta: { elapsedMs: Date.now() - started, total: 0, raw_hits: 0 } };
    }
  }

  /** Fetch recent knowledge cards for tag-hotness based question generation. */
  async function loadKnowledgeMeta({ limit = 30 } = {}) {
    try {
      const r = await fetch(`/api/v1/knowledge?limit=${limit}`);
      if (!r.ok) return [];
      const data = await r.json();
      return data?.items || [];
    } catch {
      return [];
    }
  }

  /**
   * Preferred entry point: returns content-driven questions when knowledge
   * cards are available, falling back to the old meta-template picks.
   */
  async function getSuggestions() {
    const [meta, cards] = await Promise.all([loadScanMeta(), loadKnowledgeMeta({ limit: 30 })]);
    const fmt = (typeof window !== 'undefined' && window.AwarenessOnboardingFormat) || null;
    if (fmt && cards && cards.length > 0) {
      const q = fmt.buildContentQuestions(cards, meta, { limit: 3 });
      if (q.length > 0) return q;
    }
    return pickSuggestions(meta);
  }

  window.AwarenessOnboardingRecall = {
    pickSuggestions,
    loadScanMeta,
    loadKnowledgeMeta,
    runRecall,
    getSuggestions,
  };
})();
