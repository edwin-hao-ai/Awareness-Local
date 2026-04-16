---
id: mem_20260415_234928_2b57
type: session_summary
session_id: null
agent_role: builder_agent
tags: []
created_at: "2026-04-15T15:49:28.052Z"
updated_at: "2026-04-15T15:49:28.052Z"
source: mcp
status: active
related: []
---

Session edit summary: 34 changes across 23 file(s)
- 34 edits, 0 file writes
Files changed: /Users/edwinhao/Awareness/sdks/local/src/daemon/extraction-instruction.mjs, /Users/edwinhao/Awareness/sdks/_shared/scripts/save-memory.js, /Users/edwinhao/Awareness/sdks/local/src/core/indexer.mjs, /Users/edwinhao/Awareness/sdks/local/src/daemon.mjs, /Users/edwinhao/Awareness/backend/awareness/prompts/extraction_v1.py, /Users/edwinhao/Awareness/backend/awareness/prompts/extraction_v2_pass2_synthesis.py, /Users/edwinhao/Awareness/backend/awareness/prompts/card_merge.py, /Users/edwinhao/Awareness/backend/mcp_tools/server_utils.py, /Users/edwinhao/Awareness/backend/mcp_tools/get_handlers.py, /Users/edwinhao/Awareness/backend/awareness/tasks_extraction.py (+13 more)

Change details:
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/daemon/extraction-instruction.mjs:     'Then call: awareness_record(action="submit_insights", content=<json_result> →     'Then call: awareness_record(action="submit_insights", insights=<json_result
  [Edit] /Users/edwinhao/Awareness/sdks/_shared/scripts/save-memory.js:     process.stdout.write(JSON.stringify({ status: "saved", id: result.id }) + "\ →     const out = { status: "saved", id: result.id };
    if (result._extraction_i
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/core/indexer.mjs:   /**
   * F-038 T-023: Add sync_hash column to graph_nodes for cloud sync dedup →   /**
   * Add novelty_score and salience_reason columns for HIGH_SALIENCE quali
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/core/indexer.mjs:     this._migrateRecallCount();
    this._migrateGraphNodesSyncHash(); →     this._migrateRecallCount();
    this._migrateGraphNodesSyncHash();
    // Ad
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/core/indexer.mjs:     this._stmtUpsertKnowledge = this.db.prepare(`
      INSERT INTO knowledge_ca →     this._stmtUpsertKnowledge = this.db.prepare(`
      INSERT INTO knowledge_ca
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/daemon.mjs:         const cardData = {
          id: cardId,
          category: card.catego →         const cardData = {
          id: cardId,
          category: card.catego
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/daemon/extraction-instruction.mjs:     '## Expected JSON Output\n' +
    '{\n' +
    '  "knowledge_cards": [{"categ →     '## CRITICAL: Summary Quality Requirements\n' +
    'Each knowledge card sum
  [Edit] /Users/edwinhao/Awareness/sdks/local/src/daemon/extraction-instruction.mjs:           summary: (c.summary || '').slice(0, 200), →           summary: c.summary || '',
  [Edit] /Users/edwinhao/Awareness/backend/awareness/prompts/extraction_v1.py:       "summary": "5-7 sentences with context, rationale, details, and applicabil →       "summary": "RICH wiki-style entry, minimum 200 characters, target 400-800 
  [Edit] /Users/edwinhao/Awareness/backend/awareness/prompts/extraction_v2_pass2_synthesis.py:       "body": "2-5 sentences arguing the claim with WHY. Use Markdown (headings, →       "body": "RICH wiki-style Markdown entry, minimum 300 characters, target 50
  [Edit] /Users/edwinhao/Awareness/backend/awareness/prompts/card_merge.py: Rules:
1. Keep EVERY fact, detail, and example from both cards. Do NOT drop info → Rules:
1. Keep EVERY fact, detail, and example from both cards. Do NOT drop info
  [Edit] /Users/edwinhao/Awareness/backend/mcp_tools/server_utils.py:     if isinstance(cards, list) and total > max_chars:
        for card in cards: →     if isinstance(cards, list) and total > max_chars:
        # Reduce card coun
  [Edit] /Users/edwinhao/Awareness/backend/mcp_tools/get_handlers.py:         {"title": c["title"], "summary": c["summary"][:200] + ("..." if len(c.ge →         {"title": c["title"], "summary": c.get("summary", "")}
        for c in 
  [Edit] /Users/edwinhao/Awareness/backend/awareness/tasks_extraction.py:                 new_candidates.append({
                    "id": cid,
          →                 new_candidates.append({
                    "id": cid,
         
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/context_assembler.py:             # Truncate content to ~150 chars for summary
            raw = item. →             raw = item.content.strip()
            summary_text = raw
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/harness_builder.py:             summary = _esc(str(card.get("summary", ""))[:200]) →             summary = _esc(str(card.get("summary", "")))
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/actionable_rule_builder.py:     summary = _truncate(summary or "", 200) →     summary = (summary or "").strip()
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/memory_profile_service.py:             lines = [f"  - {item['title']}: {item['summary'][:120]}" for item in →             lines = [f"  - {item['title']}: {item['summary']}" for item in items
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/moc_incremental.py:         f"- {m.get('title', '?')}: {(m.get('summary') or '')[:100]}" →         f"- {m.get('title', '?')}: {m.get('summary') or ''}"
  [Edit] /Users/edwinhao/Awareness/backend/awareness/api/services/crystallization_service.py:             {"id": new_card_id, "title": new_card_title, "summary": new_card_sum →             {"id": new_card_id, "title": new_card_title, "summary": new_card_sum
  ... and 14 more changes
