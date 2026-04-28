/**
 * awareness_record(action=submit_insights) engine.
 *
 * Handles the insights-only variant of awareness_record (and the inline
 * insights path when a record call bundles content + insights). Applies
 * the R1-R5 quality gate, card evolution (F-058), and skill UPSERT-by-name
 * before delegating to the indexer.
 *
 * Extracted verbatim from daemon.mjs::_submitInsights + supporting
 * _checkCrystallizationLocal helper (F-057 Phase 2). No behaviour change;
 * `this` → `daemon`.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  validateCardQuality,
  validateTaskQuality,
  checkTaskDedup,
} from '../../core/lifecycle-manager.mjs';
import { nowISO } from '../helpers.mjs';
import { writeCardToWiki } from './wiki-write.mjs';
import {
  findEvolutionTarget,
  supersedeCard,
  classifyCard,
  mergeIntoCard,
} from '../card-evolution.mjs';
import { mergeSkill } from '../skill-merge.mjs';
import { validateSkillQuality } from '../skill-quality-gate.mjs';
import { evaluateSkillGrowth } from '../skill-growth.mjs';
import { scoreSkill } from '../skill-quality-score.mjs';
import { runLifecycleChecks } from '../../core/lifecycle-manager.mjs';

// F-034 crystallization helper constants (kept co-located with the function).
const _CRYST_CATEGORIES = new Set(['workflow', 'decision', 'problem_solution']);
const _CRYST_MIN_SIMILAR = 2;
const _CRYST_MAX_CARDS = 5;

/**
 * Union two string-array fields stored as JSON text (pitfalls/verification)
 * with the incoming runtime array. De-dups by lowercased content.
 * Returns JSON string or null if both inputs are empty.
 */
function unionStringArrays(existingJson, incoming) {
  let existing = [];
  try {
    if (typeof existingJson === 'string' && existingJson.length > 0) {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) existing = parsed;
    }
  } catch { /* ignore malformed legacy data */ }
  const incomingArr = Array.isArray(incoming) ? incoming : [];
  const seen = new Set();
  const out = [];
  for (const item of [...existing, ...incomingArr]) {
    const str = String(item || '').trim();
    if (!str) continue;
    const key = str.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(str);
  }
  return out.length > 0 ? JSON.stringify(out) : null;
}

/**
 * Detect if a newly created card should trigger a skill-crystallization hint.
 * Returns hint object or null.
 */
function _checkCrystallizationLocal(db, newCard) {
  try {
    if (!_CRYST_CATEGORIES.has(newCard.category)) return null;

    const queryText = `${newCard.title} ${(newCard.summary || '').slice(0, 120)}`.trim();
    if (queryText.length < 5) return null;

    const cats = [..._CRYST_CATEGORIES].map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT kc.id, kc.title, kc.summary, kc.category
      FROM knowledge_cards kc
      JOIN knowledge_fts fts ON fts.id = kc.id
      WHERE knowledge_fts MATCH ?
        AND kc.id != ?
        AND kc.category IN (${cats})
        AND kc.status NOT IN ('superseded', 'archived')
      LIMIT ?
    `).all(queryText, newCard.id, ...[..._CRYST_CATEGORIES], _CRYST_MAX_CARDS + 5);

    if (rows.length < _CRYST_MIN_SIMILAR) return null;

    const existingSkill = db.prepare(
      `SELECT id FROM skills WHERE lower(name) LIKE ? AND status != 'archived' LIMIT 1`
    ).get(`%${newCard.title.slice(0, 20).toLowerCase()}%`);
    if (existingSkill) return null;

    const similarCards = rows.slice(0, _CRYST_MAX_CARDS).map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary || '',
    }));

    const categories = [...new Set(rows.map((r) => r.category))];

    return {
      topic: newCard.title,
      similar_cards: similarCards,
      categories,
      instruction: [
        'You detected 3+ similar cards on the same topic. Decide whether they',
        'represent a genuinely REUSABLE procedure (an agent would follow these',
        'steps on future tasks), and if yes synthesize ONE skill. Quality bar:',
        '- name: 3-8 words, action-oriented ("Publish SDK to npm" not "npm stuff").',
        '- summary: 200-500 chars, second-person imperative, injectable into an AI prompt verbatim. Include the WHY in one clause so the agent knows when to deviate.',
        '- methods: ≥3 steps, each with {"step": N, "description": "..."} where description names a file / command / verification check / concrete outcome (50-200 chars per step). Vague verbs like "handle / process / manage" fail the bar.',
        '- trigger_conditions: ≥2 distinct {"pattern": "When ...", "weight": 0-1} covering different phrasings of the same intent.',
        '- tags: 3-8 lowercase keywords.',
        '- source_card_ids: the IDs from similar_cards + this card.',
        'If the cards do NOT meet the bar (e.g. they are 3 incidents of the same bug, not a reusable procedure), DO NOT invent a skill — return awareness_record with insights.skills=[] and a one-line comment. Empty is a first-class answer.',
        'Submit via: awareness_record(content="Crystallized skill: <name>", insights={ skills: [{ name, summary, methods, trigger_conditions, tags, source_card_ids }] })',
      ].join('\n'),
    };
  } catch (err) {
    console.warn('[AwarenessDaemon] Crystallization check failed:', err.message);
    return null;
  }
}

/**
 * Process submitted insights (knowledge_cards, action_items, completed_tasks,
 * skills) under the same quality + evolution + dedup rules used inline.
 *
 * @param {object} daemon - AwarenessLocalDaemon instance
 * @param {object} params - {insights, agent_role}
 * @returns {Promise<object>}
 */
export async function submitInsights(daemon, params) {
  // Accept insights from `params.insights` (preferred) or fall back to
  // `params.content` when an LLM mistakenly serialised the JSON payload
  // into the content slot (matches the legacy extraction-instruction wording
  // shipped by the cloud MCP before the v0.11.x fix).
  let insights = params.insights || {};
  if ((!insights || typeof insights !== 'object' || Object.keys(insights).length === 0) && params.content != null) {
    if (typeof params.content === 'string') {
      const trimmed = params.content.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            insights = parsed;
          }
        } catch {
          /* not JSON — fall through */
        }
      }
    } else if (typeof params.content === 'object' && !Array.isArray(params.content)) {
      const ck = new Set(Object.keys(params.content || {}));
      if (ck.has('knowledge_cards') || ck.has('action_items') || ck.has('risks') || ck.has('skills') || ck.has('turn_brief')) {
        insights = params.content;
      }
    }
  }
  let cardsCreated = 0;
  let tasksCreated = 0;

  // F-055 bug D — track cards rejected by the quality gate so the client
  // can see why. One bad card should NOT block the rest.
  const cardsSkipped = [];

  // F-034: Track newly created eligible cards for crystallization detection
  const CRYSTALLIZATION_CATEGORIES = new Set(['workflow', 'decision', 'problem_solution']);
  const crystallizationCandidates = [];

  // Process knowledge cards
  if (Array.isArray(insights.knowledge_cards)) {
    for (let cardIndex = 0; cardIndex < insights.knowledge_cards.length; cardIndex++) {
      const card = insights.knowledge_cards[cardIndex];

      const gate = validateCardQuality(card);
      if (!gate.ok) {
        cardsSkipped.push({ card_index: cardIndex, reasons: gate.reasons });
        console.warn(`[AwarenessDaemon] Rejected low-quality card (${gate.reasons.join(', ')}): ${(card?.title || '').substring(0, 60)}`);
        continue;
      }
      if (gate.warnings.length > 0) {
        console.warn(`[AwarenessDaemon] Card accepted with warnings (${gate.warnings.join(', ')}): ${(card?.title || '').substring(0, 60)}`);
      }

      // P1 Fix-5b · 4-verdict classification (aligned with rule-based path).
      // Fails OPEN: if no embedder / error, fall through to verdict='new'.
      let verdict = { verdict: 'new' };
      try {
        verdict = await classifyCard(daemon.indexer, card, daemon._embedder);
      } catch (err) {
        console.warn('[AwarenessDaemon] Evolution check failed (non-fatal):', err.message);
      }

      // Drop exact duplicates and record the reason for observability.
      if (verdict.verdict === 'duplicate' && verdict.target?.id) {
        cardsSkipped.push({ card_index: cardIndex, reasons: ['duplicate_card'], matched_id: verdict.target.id });
        console.log(`[AwarenessDaemon] Skipped duplicate card (sim=${verdict.similarity?.toFixed(2)}): '${(card?.title || '').substring(0, 60)}' matches ${verdict.target.id}`);
        continue;
      }

      // Merge content into existing card (append summary below "---").
      if (verdict.verdict === 'merge' && verdict.target?.id) {
        const mergeResult = mergeIntoCard(daemon.indexer, verdict.target.id, card);
        if (mergeResult.merged) {
          console.log(`[AwarenessDaemon] Merged card into ${verdict.target.id} (sim=${verdict.similarity?.toFixed(2)}): '${(card?.title || '').substring(0, 60)}'`);
          cardsCreated++; // count as ingest for the caller's response shape
          continue;
        }
        // If merge failed mid-way, fall through to update path rather than lose the card.
      }

      const isUpdate = verdict.verdict === 'update' && verdict.target?.id;
      const parentCardId = isUpdate ? verdict.target.id : null;
      const evolutionType = isUpdate ? 'update' : 'initial';

      const cardId = `kc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cardFilepath = path.join(
        daemon.awarenessDir,
        'knowledge',
        card.category || 'insights',
        `${cardId}.md`
      );

      fs.mkdirSync(path.dirname(cardFilepath), { recursive: true });

      const cardContent = `---
id: ${cardId}
category: ${card.category || 'insight'}
title: "${(card.title || '').replace(/"/g, '\\"')}"
confidence: ${card.confidence ?? 0.8}
status: ${card.status || 'active'}
tags: ${JSON.stringify(card.tags || [])}
created_at: ${nowISO()}
${parentCardId ? `parent_card_id: ${parentCardId}\nevolution_type: ${evolutionType}\n` : ''}---

${card.summary || card.title || ''}
`;
      fs.mkdirSync(path.dirname(cardFilepath), { recursive: true });
      fs.writeFileSync(cardFilepath, cardContent, 'utf-8');

      const cardData = {
        id: cardId,
        category: card.category || 'insight',
        title: card.title || '',
        summary: card.summary || '',
        source_memories: JSON.stringify([]),
        confidence: card.confidence ?? 0.8,
        status: card.status || 'active',
        tags: card.tags || [],
        created_at: nowISO(),
        filepath: cardFilepath,
        content: card.summary || card.title || '',
        novelty_score: card.novelty_score ?? null,
        salience_reason: card.salience_reason || null,
        parent_card_id: parentCardId,
        evolution_type: evolutionType,
      };
      daemon.indexer.indexKnowledgeCard(cardData);

      // F-082 Phase 0-3 · additive markdown wiki write (event-driven, never blocks main path)
      try {
        const r = writeCardToWiki({
          awarenessDir: daemon.awarenessDir,
          card: {
            id: cardId,
            category: cardData.category,
            title: cardData.title,
            summary: cardData.summary,
            topic: Array.isArray(card.topic) ? card.topic : [],
            entities: Array.isArray(card.entities) ? card.entities : [],
            related: Array.isArray(card.related) ? card.related : [],
            tags: cardData.tags,
            confidence: cardData.confidence,
            status: cardData.status,
            created_at: cardData.created_at,
          },
        });
        if (r.warnings.length && process.env.DEBUG) {
          console.warn('[wiki-write] warnings:', r.warnings.join('; '));
        }
      } catch (err) {
        if (process.env.DEBUG) console.warn('[wiki-write] failed:', err.message);
        // intentionally swallow — markdown is additive, must not block SQLite write
      }

      // F-059 recall boost · also generate an embedding for the card
      // so the semantic channel has material to rank against. Previously
      // only memory.content was embedded (via remember action), leaving
      // submit_insights-ingested cards visible only through FTS5 BM25.
      // Uses the new `card_embeddings` table (no FK on memories) so
      // submit_insights-only callers get semantic coverage.
      if (daemon._embedder) {
        (async () => {
          try {
            const embLanguage = process.env.AWARENESS_EMBEDDER === 'english' ? 'english' : 'multilingual';
            const titleTok = (card.title || '').trim();
            const passage = titleTok
              ? `${titleTok}. ${titleTok}.\n\n${card.summary || ''}`
              : (card.summary || '');
            const vec = await daemon._embedder.embed(passage, 'passage', embLanguage);
            if (vec) {
              const modelId = daemon._embedder.MODEL_MAP?.[embLanguage] || 'Xenova/multilingual-e5-small';
              daemon.indexer.storeCardEmbedding(cardId, vec, modelId);
            }
          } catch (err) {
            if (process.env.DEBUG) console.warn('[submit-insights] card embed failed:', err.message);
          }
        })();
      }

      if (parentCardId) {
        supersedeCard(daemon.indexer, parentCardId, cardId);
      }

      try {
        const newMocIds = daemon.indexer.tryAutoMoc(cardData);
        if (newMocIds.length > 0) {
          daemon._refineMocTitles(newMocIds).catch(() => {});
        }
      } catch (e) {
        console.warn('[awareness-local] autoMoc error:', e.message);
      }

      try {
        if (daemon.extractor) {
          daemon.extractor._checkSkillEvolution(cardData).catch((err) => {
            console.warn('[awareness-local] skill evolution check failed:', err.message);
          });
        }
      } catch { /* non-critical */ }

      if (CRYSTALLIZATION_CATEGORIES.has(card.category)) {
        crystallizationCandidates.push({
          id: cardId,
          title: card.title || '',
          summary: card.summary || '',
          category: card.category,
        });
      }

      cardsCreated++;
    }
  }

  // Process action items / tasks
  if (Array.isArray(insights.action_items)) {
    for (const item of insights.action_items) {
      const rejection = validateTaskQuality(item.title);
      if (rejection) {
        console.warn(`[AwarenessDaemon] Rejected noise task (${rejection}): ${(item.title || '').substring(0, 60)}`);
        continue;
      }

      const { isDuplicate, existingTaskId } = checkTaskDedup(daemon.indexer, item.title);
      if (isDuplicate) {
        console.warn(`[AwarenessDaemon] Skipped duplicate task: "${(item.title || '').substring(0, 60)}" (existing: ${existingTaskId})`);
        continue;
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const taskFilepath = path.join(
        daemon.awarenessDir, 'tasks', 'open', `${taskId}.md`
      );

      const taskContent = `---
id: ${taskId}
title: "${(item.title || '').replace(/"/g, '\\"')}"
priority: ${item.priority || 'medium'}
status: ${item.status || 'open'}
created_at: ${nowISO()}
---

${item.description || item.title || ''}
`;
      fs.mkdirSync(path.dirname(taskFilepath), { recursive: true });
      fs.writeFileSync(taskFilepath, taskContent, 'utf-8');

      daemon.indexer.indexTask({
        id: taskId,
        title: item.title || '',
        description: item.description || '',
        status: item.status || 'open',
        priority: item.priority || 'medium',
        agent_role: params.agent_role || null,
        created_at: nowISO(),
        updated_at: nowISO(),
        filepath: taskFilepath,
      });

      tasksCreated++;
    }
  }

  // Auto-complete tasks identified by the LLM
  let tasksAutoCompleted = 0;
  if (Array.isArray(insights.completed_tasks)) {
    for (const completed of insights.completed_tasks) {
      const taskId = (completed.task_id || '').trim();
      if (!taskId) continue;
      try {
        const existing = daemon.indexer.db
          .prepare('SELECT * FROM tasks WHERE id = ?')
          .get(taskId);
        if (existing && existing.status !== 'done') {
          daemon.indexer.indexTask({
            ...existing,
            status: 'done',
            updated_at: nowISO(),
          });
          tasksAutoCompleted++;
        }
      } catch (err) {
        console.warn(`[AwarenessDaemon] Failed to auto-complete task '${taskId}':`, err.message);
      }
    }
  }

  // F-034 / F-058 skill UPSERT-by-name
  let skillsCreated = 0;
  let skillsUpdated = 0;
  const skillsSkipped = [];
  const submittedSkills = Array.isArray(insights.skills) ? insights.skills : [];
  if (submittedSkills.length > 0) {
    for (let skillIdx = 0; skillIdx < submittedSkills.length; skillIdx++) {
      const skill = submittedSkills[skillIdx];
      if (!skill.name) continue;

      // P1 Fix-6 · inbound skill quality gate. Rewritten 2026-04-19 after
      // user concern "如果 gate 拦截了，怎么保证真的能提取出 skill？": only
      // hard-reject on fundamental structural issues (invalid shape /
      // vague name / <3 methods / steps < 15 chars). Soft warnings
      // (short summary / weak tags / no verify / no pitfall) still let
      // the skill persist with a quality_score attached, so the client
      // LLM gets feedback but extraction isn't blocked.
      const skillGate = validateSkillQuality(skill);
      if (!skillGate.ok) {
        skillsSkipped.push({
          skill_index: skillIdx,
          name: skill.name,
          reasons: skillGate.reasons,
          fix_suggestion: skillGate.fix_suggestion,
        });
        console.warn(`[AwarenessDaemon] Rejected structurally-broken skill (${skillGate.reasons.join(', ')}): '${String(skill.name).substring(0, 60)}' — ${skillGate.fix_suggestion}`);
        continue;
      }
      if (skillGate.warnings.length > 0) {
        console.warn(`[AwarenessDaemon] Skill accepted with warnings (${skillGate.warnings.join(', ')}, quality_score=${skillGate.quality_score}/40): '${String(skill.name).substring(0, 60)}'`);
      }

      try {
        const now = nowISO();
        const existing = daemon.indexer.db.prepare(
          `SELECT id FROM skills WHERE name = ? AND status = 'active' LIMIT 1`
        ).get(skill.name);

        const pitfallsJson = Array.isArray(skill.pitfalls) && skill.pitfalls.length > 0
          ? JSON.stringify(skill.pitfalls) : null;
        const verificationJson = Array.isArray(skill.verification) && skill.verification.length > 0
          ? JSON.stringify(skill.verification) : null;

        let targetId = null;
        if (existing) {
          // P1 Fix-5a · merge (not overwrite): fetch full existing row,
          // combine methods / triggers / tags / card_ids with v2.
          const existingFull = daemon.indexer.db.prepare(
            `SELECT summary, methods, trigger_conditions, tags, source_card_ids, confidence, pitfalls, verification FROM skills WHERE id = ?`
          ).get(existing.id);
          const merged = mergeSkill(existingFull, skill);
          // F-059 · union pitfalls/verification lists across merges
          const mergedPitfalls = unionStringArrays(existingFull?.pitfalls, skill.pitfalls);
          const mergedVerify = unionStringArrays(existingFull?.verification, skill.verification);
          daemon.indexer.db.prepare(`
            UPDATE skills SET
              summary = ?, methods = ?, trigger_conditions = ?, tags = ?,
              source_card_ids = ?, confidence = ?, decay_score = ?,
              pitfalls = ?, verification = ?, updated_at = ?
            WHERE id = ?
          `).run(
            merged.summary,
            merged.methods,
            merged.trigger_conditions,
            merged.tags,
            merged.source_card_ids,
            merged.confidence,
            merged.decay_score,
            mergedPitfalls,
            mergedVerify,
            now,
            existing.id,
          );
          skillsUpdated++;
          targetId = existing.id;
        } else {
          const skillId = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          daemon.indexer.db.prepare(`
            INSERT INTO skills
              (id, name, summary, methods, trigger_conditions, tags, source_card_ids,
               pitfalls, verification,
               decay_score, usage_count, growth_stage, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0, 'seedling', 'active', ?, ?)
          `).run(
            skillId,
            skill.name,
            skill.summary || '',
            skill.methods ? JSON.stringify(skill.methods) : null,
            skill.trigger_conditions ? JSON.stringify(skill.trigger_conditions) : null,
            skill.tags ? JSON.stringify(skill.tags) : null,
            skill.source_card_ids ? JSON.stringify(skill.source_card_ids) : null,
            pitfallsJson,
            verificationJson,
            now,
            now,
          );
          skillsCreated++;
          targetId = skillId;
        }

        // F-059 · immediate self-growth eval (no cron). Rubric score is
        // computed from the just-submitted shape so budding promotion
        // fires on the same call once ≥2 source cards + ≥20/40 rubric.
        if (targetId) {
          try {
            const rubric = scoreSkill({
              name: skill.name,
              summary: skill.summary || '',
              methods: skill.methods || [],
              trigger_conditions: skill.trigger_conditions || [],
              tags: skill.tags || [],
              pitfalls: skill.pitfalls || [],
              verification: skill.verification || [],
            }).total;
            evaluateSkillGrowth(daemon.indexer, targetId, rubric);
          } catch { /* growth eval best-effort */ }

          // F-059 · bidirectional link. When a skill lists source cards,
          // write the skill id back into each card's linked_skill_ids so
          // that card-hydrate / card search can surface "↑ skills that
          // reference this" without scanning the whole skills table.
          if (Array.isArray(skill.source_card_ids) && skill.source_card_ids.length > 0) {
            try {
              const upsertLink = daemon.indexer.db.prepare(`
                UPDATE knowledge_cards
                   SET linked_skill_ids = CASE
                         WHEN linked_skill_ids IS NULL OR linked_skill_ids = ''
                           THEN ?
                         WHEN instr(linked_skill_ids, ?) > 0
                           THEN linked_skill_ids
                         ELSE json_insert(linked_skill_ids, '$[#]', ?)
                       END
                 WHERE id = ?
              `);
              const skillIdJson = JSON.stringify([targetId]);
              for (const cardId of skill.source_card_ids) {
                upsertLink.run(skillIdJson, targetId, targetId, cardId);
              }
            } catch { /* non-fatal */ }
          }
        }
      } catch (err) {
        console.warn(`[AwarenessDaemon] Failed to save skill '${skill.name}':`, err.message);
      }
    }
  }

  // F-034 crystallization hint
  let crystallizationHint = null;
  if (crystallizationCandidates.length > 0 && submittedSkills.length === 0) {
    const first = crystallizationCandidates[0];
    crystallizationHint = _checkCrystallizationLocal(daemon.indexer.db, first);
  }

  // F-059 · realtime lifecycle scan on the submitted content. Auto-close
  // open tasks whose BM25 + real-vector cosine hybrid matches the new
  // content AND content contains a completion keyword. Also mitigates
  // risks. Fire-and-forget — failures don't block the submit response.
  // Runs even when insights.completed_tasks is empty so the LLM doesn't
  // have to explicitly close tasks — "I fixed X" is enough.
  let autoClosedByHybrid = [];
  let autoMitigatedRisks = [];
  try {
    const lifecycleOpts = {};
    if (daemon._embedder) {
      lifecycleOpts.embedFn = (text, type) => daemon._embedder.embed(text, type);
      lifecycleOpts.cosineFn = daemon._embedder.cosineSimilarity;
    }
    const lifecycleContent = params.content || submittedSkills.map((s) => s.summary).filter(Boolean).join('\n\n');
    const lifecycleTitle = submittedSkills[0]?.name || (Array.isArray(insights.knowledge_cards) && insights.knowledge_cards[0]?.title) || '';
    if (lifecycleContent) {
      const lifecycle = await runLifecycleChecks(
        daemon.indexer, lifecycleContent, lifecycleTitle, insights, lifecycleOpts,
      );
      autoClosedByHybrid = lifecycle.resolved_tasks || [];
      autoMitigatedRisks = lifecycle.mitigated_risks || [];
      tasksAutoCompleted += autoClosedByHybrid.length;
    }
  } catch (err) {
    if (process.env.DEBUG) console.warn('[submit-insights] lifecycle check failed:', err.message);
  }

  const result = {
    status: 'ok',
    cards_created: cardsCreated,
    tasks_created: tasksCreated,
    tasks_auto_completed: tasksAutoCompleted,
    tasks_auto_closed_by_hybrid: autoClosedByHybrid,
    risks_auto_mitigated: autoMitigatedRisks,
    skills_created: skillsCreated,
    skills_updated: skillsUpdated,
    mode: 'local',
  };
  if (cardsSkipped.length > 0) {
    result.cards_skipped = cardsSkipped;
  }
  if (skillsSkipped.length > 0) {
    result.skills_skipped = skillsSkipped;
  }
  if (crystallizationHint) {
    result._skill_crystallization_hint = crystallizationHint;
  }
  return result;
}
