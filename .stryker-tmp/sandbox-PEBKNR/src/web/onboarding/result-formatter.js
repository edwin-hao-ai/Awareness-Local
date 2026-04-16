/* Awareness Onboarding — result + question formatters
 *
 * Pure helpers to turn raw /search and /knowledge payloads into
 * human-readable Step 3 content. Zero LLM, zero network, deterministic.
 *
 * Exposed via window.AwarenessOnboardingFormat for step renderers + tests.
 */
// @ts-nocheck

(function () {
  const TYPE_META = {
    decision:           { icon: '🎯', labelKey: 'onb.type.decision' },
    problem_solution:   { icon: '🛠️', labelKey: 'onb.type.problem_solution' },
    pitfall:            { icon: '⚠️', labelKey: 'onb.type.pitfall' },
    insight:            { icon: '💡', labelKey: 'onb.type.insight' },
    workflow:           { icon: '📋', labelKey: 'onb.type.workflow' },
    key_point:          { icon: '📌', labelKey: 'onb.type.key_point' },
    workspace_file:     { icon: '📂', labelKey: 'onb.type.workspace_file' },
    workspace_wiki:     { icon: '📖', labelKey: 'onb.type.workspace_wiki' },
    workspace_doc:      { icon: '📄', labelKey: 'onb.type.workspace_doc' },
    code_change:        { icon: '🧩', labelKey: 'onb.type.code_change' },
  };

  function t(key, vars) {
    return (typeof window !== 'undefined' && window.t) ? window.t(key, vars) : key;
  }

  function normalizeWhitespace(s) {
    return String(s == null ? '' : s).replace(/[\s\n\r\t]+/g, ' ').trim();
  }

  /** Strip wrapping quotes and decorative prefixes that look ugly to users. */
  function stripDecorative(s) {
    return String(s || '')
      .replace(/^[`"'\s]+|[`"'\s]+$/g, '')
      .replace(/^\"\"\"|\"\"\"$/g, '')
      .replace(/^'''|'''$/g, '')
      .replace(/^>\s*/gm, ''); // blockquote markers
  }

  /** Truncate at the nearest word/sentence boundary ≤ maxChars, append ellipsis. */
  function smartTruncate(s, maxChars = 140) {
    const str = String(s || '');
    if (str.length <= maxChars) return str;
    // Prefer a full sentence break within budget
    const hardStops = ['. ', '。', '! ', '！', '? ', '？', '; ', '；'];
    let best = -1;
    for (const stop of hardStops) {
      const idx = str.lastIndexOf(stop, maxChars);
      if (idx > best) best = idx + stop.length;
    }
    if (best > maxChars * 0.5) return str.slice(0, best).trimEnd() + '…';
    // Otherwise fall back to whitespace
    const space = str.lastIndexOf(' ', maxChars);
    if (space > maxChars * 0.5) return str.slice(0, space) + '…';
    return str.slice(0, maxChars) + '…';
  }

  /**
   * Detect "noisy" results that would confuse a first-time onboarding user:
   *   - raw chat logs starting with "Request:" / "Prompt:"
   *   - heavy code density (>30% symbols/brackets)
   *   - near-empty stubs
   */
  function isNoisy(item) {
    const title = String(item?.title || '').trim();
    const summary = String(item?.summary || '').trim();
    if (title.length === 0 && summary.length === 0) return true;
    if (/^(Request|Prompt|Input):/i.test(title)) return true;
    if (summary.length < 15) return true;
    // Count common code-ish punctuation to spot raw source in summaries.
    const codeSyms = (summary.match(/[{}()\[\];=<>:.]/g) || []).length;
    if (summary.length > 40 && codeSyms / summary.length > 0.2) return true;
    return false;
  }

  /** Shorten a file path to its basename; leave non-path strings alone. */
  function prettyTitle(rawTitle) {
    const t0 = normalizeWhitespace(rawTitle);
    if (!t0) return t('onb.result.untitled') || '(untitled)';
    // Strip "File changed: " prefix common in timeline events
    const cleaned = t0.replace(/^File changed:\s*/i, '');
    // Any path with two or more segments shortens to its basename. Keeps
    // single-word titles (common for knowledge card titles) untouched.
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const base = segments[segments.length - 1];
      if (base && base.length >= 3) return base;
    }
    return smartTruncate(cleaned, 80);
  }

  /** Turn "problem_solution" → "🛠️ 解决方案" using i18n when available. */
  function typeBadge(itemType) {
    const key = String(itemType || '').toLowerCase();
    const meta = TYPE_META[key] || { icon: '💡', labelKey: 'onb.type.note' };
    const label = t(meta.labelKey);
    // If no translation exists, fall back to a humanized type
    const friendly = label === meta.labelKey ? key.replace(/_/g, ' ') : label;
    return { icon: meta.icon, label: friendly };
  }

  /** Relative-time string: "2 天前" / "刚刚" / "昨天". */
  function relativeTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return t('onb.time.just_now') || 'just now';
    if (mins < 60) return t('onb.time.minutes_ago', { n: mins }) || `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return t('onb.time.hours_ago', { n: hrs }) || `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days === 1) return t('onb.time.yesterday') || 'yesterday';
    if (days < 30) return t('onb.time.days_ago', { n: days }) || `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return t('onb.time.months_ago', { n: months }) || `${months}mo ago`;
    return t('onb.time.long_ago') || 'long ago';
  }

  /**
   * Shape a /search item into a clean display object. Returns null if noisy.
   */
  function formatResult(item, { summaryMax = 140 } = {}) {
    if (!item) return null;
    if (isNoisy(item)) return null;
    const typeInfo = typeBadge(item.type);
    const title = prettyTitle(item.title || item.filepath || item.id);
    const summaryRaw = stripDecorative(normalizeWhitespace(item.summary));
    const summary = smartTruncate(summaryRaw, summaryMax);
    return {
      id: item.id,
      icon: typeInfo.icon,
      type: typeInfo.label,
      title,
      summary,
      score: Number(item.score || 0),
      createdAt: item.created_at || null,
      relativeTime: relativeTime(item.created_at),
    };
  }

  /**
   * Format a batch of results, drop noisy ones, cap length.
   */
  function formatResults(items, { limit = 3, summaryMax = 140 } = {}) {
    if (!Array.isArray(items)) return [];
    const cleaned = [];
    for (const it of items) {
      const f = formatResult(it, { summaryMax });
      if (f) cleaned.push(f);
      if (cleaned.length >= limit) break;
    }
    return cleaned;
  }

  // ── Tag-hotness question generation ────────────────────────────────

  /**
   * Parse tags field — the /knowledge endpoint returns it as a JSON-encoded
   * string rather than an array. Tolerate both shapes.
   */
  function parseTags(raw) {
    if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string');
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /** Count tag frequency across cards; return sorted [tag, count] pairs. */
  function tagHotness(cards) {
    const counts = Object.create(null);
    for (const c of (cards || [])) {
      for (const tag of parseTags(c.tags)) {
        const key = String(tag).trim().toLowerCase();
        if (!key || key.length < 2) continue;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  /**
   * Build up to `limit` content-driven questions from recent knowledge cards.
   * Strategy:
   *   1. Pick top-hot tag → "介绍一下 {tag}" / "Tell me about {tag}"
   *   2. Pick a decision card title → "为什么做了这个决定?"
   *   3. Pick a pitfall card title keyword → "踩过什么坑?"
   *
   * Falls back to meta-driven templates when cards are sparse.
   */
  function buildContentQuestions(cards, meta, { limit = 3 } = {}) {
    const picks = [];
    const hot = tagHotness(cards || []);
    if (hot.length > 0 && picks.length < limit) {
      picks.push(t('onb.q.tag', { tag: hot[0][0] }) || `Tell me about ${hot[0][0]}`);
    }
    // A decision card if any
    const decision = (cards || []).find((c) => c.category === 'decision' && c.title);
    if (decision && picks.length < limit) {
      picks.push(t('onb.q.recent_decision') || 'What was recently decided?');
    }
    // A pitfall card if any
    const pitfall = (cards || []).find((c) => c.category === 'pitfall' && c.title);
    if (pitfall && picks.length < limit) {
      picks.push(t('onb.q.recent_pitfall') || 'Any recent pitfalls to watch out for?');
    }
    // Second hot tag (if still need more)
    if (hot.length > 1 && picks.length < limit) {
      picks.push(t('onb.q.tag', { tag: hot[1][0] }) || `Tell me about ${hot[1][0]}`);
    }
    // Fall back to meta-driven templates
    if (picks.length < limit && meta && Array.isArray(meta.wiki_titles) && meta.wiki_titles[0]) {
      picks.push(t('onb.q.wiki_page', { title: meta.wiki_titles[0] }));
    }
    if (picks.length < limit && meta?.has_readme) picks.push(t('onb.q.readme'));
    if (picks.length < limit && meta?.has_docs) picks.push(t('onb.q.architecture'));
    if (picks.length < limit && meta?.top_language) {
      picks.push(t('onb.q.lang', { lang: meta.top_language }));
    }
    if (picks.length < limit && (meta?.total_cards || 0) > 0) picks.push(t('onb.q.decisions'));
    // Dedupe while preserving order
    const seen = new Set();
    const out = [];
    for (const q of picks) {
      const key = (q || '').trim();
      if (key && !seen.has(key)) { seen.add(key); out.push(key); }
      if (out.length >= limit) break;
    }
    return out;
  }

  window.AwarenessOnboardingFormat = {
    normalizeWhitespace,
    stripDecorative,
    smartTruncate,
    isNoisy,
    prettyTitle,
    typeBadge,
    relativeTime,
    formatResult,
    formatResults,
    parseTags,
    tagHotness,
    buildContentQuestions,
  };
})();
