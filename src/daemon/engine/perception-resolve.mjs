/**
 * LLM-assisted perception auto-resolution · extracted from
 * daemon.mjs::_checkPerceptionResolution (F-057 Phase 8).
 *
 * Behaviour preserved verbatim — rate limit + cloud-gated + filtered
 * candidate list + JSON prompt + autoResolvePerception on "resolved".
 */

export async function checkPerceptionResolution(daemon, newMemoryId, newMemory) {
  // Rate limit: 1 check per memory per 60s
  const now = Date.now();
  if (!daemon._lastResolveCheckAt) daemon._lastResolveCheckAt = 0;
  if (now - daemon._lastResolveCheckAt < 60000) return;
  daemon._lastResolveCheckAt = now;

  // Only if cloud is enabled (we route LLM calls through cloud API)
  const config = daemon._loadConfig();
  if (!config.cloud?.enabled || !config.cloud?.api_key) return;

  // Fetch active perceptions that support auto-resolution
  if (!daemon.indexer?.listPerceptionStates) return;
  const activeStates = daemon.indexer.listPerceptionStates({
    state: ['active', 'snoozed'],
    limit: 50,
  });
  const candidates = activeStates.filter((s) =>
    ['guard', 'contradiction', 'pattern', 'staleness'].includes(s.signal_type)
  );
  if (candidates.length === 0) return;

  const memTags = new Set((newMemory.tags || []).map((t) => String(t).toLowerCase()));
  const memText = `${newMemory.title || ''} ${newMemory.content || ''}`.toLowerCase();
  const newCategory = newMemory.insights?.knowledge_cards?.[0]?.category;
  const isFixCategory = ['problem_solution', 'decision'].includes(newCategory);
  if (!isFixCategory && newCategory) return;

  const filtered = candidates.filter((sig) => {
    let sigTags = [];
    try { sigTags = JSON.parse(sig.metadata || '{}').tags || []; } catch {}
    const hasTagOverlap = sigTags.some((t) => memTags.has(String(t).toLowerCase()));
    const sigWords = (sig.title || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const hasKeyword = sigWords.some((w) => memText.includes(w));
    const sourceMemories = newMemory.insights?.knowledge_cards?.[0]?.source_memories || [];
    const refsSourceCard = sig.source_card_id && sourceMemories.includes(sig.source_card_id);
    return hasTagOverlap || hasKeyword || refsSourceCard;
  });

  if (filtered.length === 0) return;

  const systemPrompt = `You are analyzing whether a new memory resolves previously-flagged awareness signals.

A "signal" is a warning or insight the system surfaced to the user:
- GUARD: a known pitfall (e.g., "Electron shell must use --norc")
- CONTRADICTION: conflicting beliefs in the memory
- PATTERN: recurring theme suggesting systematic action
- STALENESS: knowledge that may be outdated

Given each signal + the new memory, classify:
- "resolved": new memory shows CLEAR evidence the issue was fixed or addressed
- "irrelevant": new memory is unrelated to this signal
- "still_active": signal is still relevant (DEFAULT — be conservative)

Rules:
- Only mark "resolved" when there's explicit evidence (fix, refactor, decision made)
- Related but not resolved → "still_active"
- When in doubt → "still_active"

Return JSON only: {"results": [{"signal_id":"...","status":"resolved|irrelevant|still_active","reason":"..."}]}`;

  const userContent = `NEW MEMORY:
Title: ${newMemory.title || '(no title)'}
Content: ${(newMemory.content || '').slice(0, 500)}
Tags: ${[...memTags].join(', ') || '(none)'}

SIGNALS TO CHECK:
${filtered.map((s) => `[${s.signal_id}] (${s.signal_type}) ${s.title || s.signal_id}`).join('\n')}`;

  try {
    const { httpJson } = await import('../cloud-http.mjs');
    const apiBase = config.cloud.api_base || 'https://awareness.market/api/v1';
    const memoryId = config.cloud.memory_id;
    const apiKey = config.cloud.api_key;
    const resp = await httpJson('POST', `${apiBase}/memories/${memoryId}/chat`, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 500,
    }, { Authorization: `Bearer ${apiKey}` });

    const raw = typeof resp === 'string' ? resp
      : resp?.content || resp?.choices?.[0]?.message?.content || '';
    if (!raw) return;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);
    const results = Array.isArray(parsed.results) ? parsed.results : [];

    for (const r of results) {
      if (r.status === 'resolved' && r.signal_id) {
        daemon.indexer.autoResolvePerception(r.signal_id, newMemoryId, r.reason || 'Auto-resolved by LLM');
        console.log(`[awareness-local] perception auto-resolved: ${r.signal_id} — ${(r.reason || '').slice(0, 80)}`);
      }
    }
  } catch (err) {
    if (process.env.DEBUG) {
      console.warn(`[awareness-local] LLM perception resolve failed: ${err.message}`);
    }
  }
}
