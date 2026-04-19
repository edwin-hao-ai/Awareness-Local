/**
 * Perception signals engine · extracted from daemon.mjs::_buildPerception
 * (+ _computeSignalId / _ordinal helpers). F-057 Phase 3.
 *
 * Produces the inline `perception[]` block attached to awareness_record
 * responses. Signals cover: guard hits, resonance (similar past cards),
 * recurring tag-pattern themes, staleness (30d+ related cards),
 * contradictions (superseded / Jaccard-conflicting), related-decision
 * (embedding-cosine based, F-055 bug C2). Each signal is hashed to a
 * stable signal_id, filtered through the dormant/dismissed/snoozed
 * lifecycle, and capped at 5.
 */

import { detectGuardSignals } from '../../core/guard-detector.mjs';
import { isSemanticallyRelated } from '../helpers.mjs';

/**
 * Build the perception signal list for a freshly-written memory.
 *
 * @param {object} daemon
 * @param {string} content
 * @param {string} title
 * @param {object} memory
 * @param {object} insights
 * @returns {Promise<Array<object>>} up to 5 signal objects
 */
export async function buildPerception(daemon, content, title, memory, insights) {
  const signals = detectGuardSignals({
    content,
    title,
    tags: memory?.tags,
    insights,
  }, {
    profile: daemon.guardProfile,
  });

  try {
    // 1. Resonance: find similar existing knowledge cards via FTS5
    if (title && title.length >= 5) {
      const resonanceResults = daemon.indexer.searchKnowledge(title, { limit: 2 });
      for (const r of resonanceResults) {
        if (r.rank > -3.0) {
          const daysAgo = r.created_at
            ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000)
            : 0;
          signals.push({
            type: 'resonance',
            title: r.title,
            summary: r.summary || '',
            category: r.category || '',
            card_id: r.id,
            days_ago: daysAgo,
            message: `🌿 Similar past experience (${daysAgo}d ago): "${r.title}"`,
          });
        }
      }
    }

    // 2. Pattern: detect recurring themes via tag co-occurrence
    if (insights?.knowledge_cards?.length) {
      try {
        const recentCards = daemon.indexer.db
          .prepare(
            `SELECT tags FROM knowledge_cards
             WHERE status = 'active' AND created_at > datetime('now', '-7 days')`
          )
          .all();
        const tagCounts = new Map();
        for (const row of recentCards) {
          let tags = [];
          try { tags = JSON.parse(row.tags || '[]'); } catch { /* skip */ }
          for (const t of tags) {
            if (typeof t === 'string' && t.length >= 2) {
              const k = t.toLowerCase();
              tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
            }
          }
        }
        const themes = [...tagCounts.entries()]
          .filter(([, count]) => count >= 3)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2);
        for (const [tag, count] of themes) {
          signals.push({
            type: 'pattern',
            tag,
            count,
            message: `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`,
          });
        }
      } catch { /* ignore */ }
    }

    // 3. Staleness: find related but old knowledge (30-day threshold)
    if (title && title.length >= 5) {
      try {
        const relatedResults = daemon.indexer.searchKnowledge(title, { limit: 3 });
        for (const r of relatedResults) {
          const ts = r.updated_at || r.created_at;
          if (!ts) continue;
          const daysOld = Math.floor(
            (Date.now() - new Date(ts).getTime()) / 86400000
          );
          if (daysOld >= 30) {
            signals.push({
              type: 'staleness',
              title: r.title,
              category: r.category || '',
              card_id: r.id,
              days_since_update: daysOld,
              message: `⏳ Related knowledge "${r.title}" hasn't been updated in ${daysOld} days — may be outdated`,
            });
            break;
          }
        }
      } catch { /* FTS query may fail on special chars */ }
    }

    // 4a. Contradiction · recently superseded cards (7-day window)
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const superseded = daemon.indexer.db
        .prepare(
          `SELECT id, title, category, summary FROM knowledge_cards
           WHERE status = 'superseded' AND updated_at > ?
           ORDER BY updated_at DESC LIMIT 2`
        )
        .all(sevenDaysAgo);
      for (const r of superseded) {
        signals.push({
          type: 'contradiction',
          title: r.title,
          summary: r.summary || '',
          card_id: r.id,
          message: `⚡ Recently superseded belief: "${r.title}" — verify current approach`,
        });
      }
    } catch { /* ignore */ }

    // 4b. Proactive conflict: new decision/problem_solution vs similar active
    if (insights?.knowledge_cards?.length && title) {
      try {
        const newCard = insights.knowledge_cards[0];
        const cat = newCard?.category;
        if (cat === 'decision' || cat === 'problem_solution') {
          const similar = daemon.indexer.searchKnowledge(title, { limit: 3 });
          for (const existing of similar) {
            if (existing.category !== cat || !existing.summary) continue;
            const newWords = new Set((newCard.summary || '').toLowerCase().split(/\s+/));
            const oldWords = new Set(existing.summary.toLowerCase().split(/\s+/));
            const intersection = [...newWords].filter((w) => oldWords.has(w)).length;
            const union = new Set([...newWords, ...oldWords]).size;
            const jaccard = union > 0 ? intersection / union : 1;
            if (jaccard < 0.3 && existing.id !== newCard.id) {
              signals.push({
                type: 'contradiction',
                title: existing.title,
                summary: existing.summary,
                card_id: existing.id,
                similarity: jaccard,
                message: `⚡ New ${cat} may conflict with existing: "${existing.title}" — verify if the old approach is still valid`,
              });
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // 5. Related_decision: embedding-cosine (F-055 bug C2)
    if (insights?.knowledge_cards?.length && daemon._embedder) {
      try {
        const embedFn = (t, type) => daemon._embedder.embed(t, type);
        const cosineFn = daemon._embedder.cosineSimilarity;
        const newCard = insights.knowledge_cards[0];
        const newText = `${newCard?.title || ''} ${newCard?.summary || ''}`.trim();
        if (newText.length >= 5) {
          const decisions = daemon.indexer.db
            .prepare(
              `SELECT id, title, summary FROM knowledge_cards
               WHERE category = 'decision' AND status = 'active'
               ORDER BY created_at DESC LIMIT 20`,
            )
            .all();
          for (const d of decisions) {
            const cand = `${d.title || ''} ${d.summary || ''}`.trim();
            if (!cand) continue;
            const rel = await isSemanticallyRelated(
              { newText, candidateText: cand },
              { embedFn, cosineFn, threshold: 0.55 },
            );
            if (rel.related) {
              signals.push({
                type: 'related_decision',
                title: d.title,
                summary: d.summary || '',
                card_id: d.id,
                similarity: rel.similarity,
                message: `📌 Related prior decision: "${d.title}"`,
              });
              if (signals.filter((s) => s.type === 'related_decision').length >= 2) break;
            }
          }
        }
      } catch { /* perception is best-effort */ }
    }
  } catch (err) {
    if (process.env.DEBUG) {
      console.warn('[awareness-local] perception failed:', err.message);
    }
  }

  // Lifecycle: compute signal_id, filter dormant/dismissed/snoozed, update state
  const filteredSignals = [];
  for (const sig of signals) {
    try {
      const signalId = computeSignalId(sig);
      sig.signal_id = signalId;
      if (!daemon.indexer?.shouldShowPerception) {
        filteredSignals.push(sig);
        continue;
      }
      if (!daemon.indexer.shouldShowPerception(signalId)) continue;
      daemon.indexer.touchPerceptionState({
        signal_id: signalId,
        signal_type: sig.type,
        source_card_id: sig.card_id || null,
        title: sig.title || sig.message || '',
        metadata: { tag: sig.tag, count: sig.count, category: sig.category },
      });
      filteredSignals.push(sig);
    } catch { /* non-fatal */ }
  }

  return filteredSignals.slice(0, 5);
}

/**
 * Compute a stable signal_id (same signal in two sessions → same id).
 */
export function computeSignalId(sig) {
  const parts = [sig.type];
  if (sig.card_id) parts.push(sig.card_id);
  else if (sig.tag) parts.push(`tag:${sig.tag}`);
  else if (sig.title) parts.push(`title:${sig.title.slice(0, 60)}`);
  else parts.push(sig.message?.slice(0, 60) || '');
  const key = parts.join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `sig_${sig.type}_${Math.abs(hash).toString(36)}`;
}

/**
 * Return ordinal string (1st, 2nd, 3rd, etc.). Kept here so callers that
 * used the class's `_ordinal` can route through the same engine module.
 */
export function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}
