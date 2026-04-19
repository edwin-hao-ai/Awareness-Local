import { mcpResult } from './mcp-contract.mjs';
import {
  buildAgentPromptResult,
  buildInitResult,
  buildRecallResult,
} from './mcp-handlers.mjs';
import { track } from '../core/telemetry.mjs';

const KNOWN_TOOLS = new Set([
  'awareness_init',
  'awareness_recall',
  'awareness_record',
  'awareness_lookup',
  'awareness_get_agent_prompt',
  'awareness_apply_skill',
  'awareness_mark_skill_used',
  'awareness_workspace_search',
]);

// F-053 post-0.8.0 defensive normalize: some MCP clients (incl. older
// versions of Claude Code's stdio bridge) serialize nested object/array
// arguments to JSON strings on the wire. Rather than reject the call with
// an opaque "expected object, received string" validation error, normalize
// stringified values back to their native form before the handler sees
// them. This makes the daemon Postel-liberal: accept common client bugs,
// emit structured output.
const STRUCTURED_ARG_FIELDS = ['insights', 'items', 'tags', 'ids', 'source_exclude'];

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return value;
  try { return JSON.parse(trimmed); }
  catch { return value; }
}

/**
 * F-058 action auto-inference. Callers used to have to pass action=remember /
 * submit_insights / remember_batch / update_task explicitly. Now the server
 * figures out what to do from the presence of content / insights / items /
 * task_id — so the LLM can just describe WHAT it wants in one shape and
 * never see an action enum.
 *
 * Priority (first match wins, so an explicit `action` still overrides):
 *   1. items: array      → remember_batch
 *   2. task_id + status  → update_task
 *   3. content present   → remember (default)
 *   4. insights only     → submit_insights
 */
function inferRecordAction(args) {
  if (Array.isArray(args.items) && args.items.length > 0) return 'remember_batch';
  if (args.task_id && args.status) return 'update_task';
  const hasContent = typeof args.content === 'string'
    ? args.content.length > 0
    : Array.isArray(args.content) && args.content.length > 0;
  if (hasContent) return 'remember';
  if (args.insights && typeof args.insights === 'object') return 'submit_insights';
  return undefined;
}

function normalizeStructuredArgs(args) {
  if (!args || typeof args !== 'object') return args || {};
  let mutated = false;
  const out = { ...args };
  for (const field of STRUCTURED_ARG_FIELDS) {
    if (!(field in out)) continue;
    const original = out[field];
    const parsed = tryParseJson(original);
    if (parsed !== original) {
      out[field] = parsed;
      mutated = true;
    }
  }
  if (mutated) {
    // eslint-disable-next-line no-console
    console.warn('[awareness_record] normalized stringified structured args — client wire layer may be serializing nested objects');
  }
  return out;
}

function trackToolCall(name, success) {
  track('mcp_tool_called', { tool_name: name, success });
}

function isMcpErrorResult(result) {
  if (!result || typeof result !== 'object') return false;
  if ('isError' in result && result.isError) return true;
  const firstText = result.content?.[0]?.text;
  if (typeof firstText !== 'string') return false;
  try {
    const parsed = JSON.parse(firstText);
    return !!parsed?.error;
  } catch {
    return false;
  }
}

export async function callMcpTool(daemon, name, args) {
  try {
    let result;

    switch (name) {
      case 'awareness_init': {
        // F-053 post-0.8.0: `max_sessions` defaults to 0 for new sessions so
        // the init payload carries only focus-relevant cards + tasks + perception
        // + user prefs, not the noisy "what were we doing yesterday" summary.
        // Callers who actively want continuity can opt in with max_sessions:3+.
        // Rationale: on a fresh session the prior-session summaries eat 500-1000
        // prompt tokens without helping the user's new task.
        const initResult = buildInitResult({
          createSession: (source) => daemon._createSession(source),
          indexer: daemon.indexer,
          loadSpec: () => daemon._loadSpec(),
          source: args.source,
          days: args.days ?? 7,
          maxCards: args.max_cards ?? 5,
          maxTasks: args.max_tasks ?? 0,
          maxSessions: args.max_sessions ?? 0,
          renderContextOptions: {
            localUrl: `http://localhost:${daemon.port}`,
            currentFocus: args.query,
          },
        });

        result = mcpResult(initResult);
        break;
      }

      case 'awareness_recall': {
        result = await buildRecallResult({
          search: daemon.search,
          args,
          indexer: daemon.indexer,
          getArchetypeIndex: () => daemon._ensureArchetypeIndex(),
        });
        break;
      }

      case 'awareness_record': {
        // F-058 · auto-infer the action from params shape so the LLM only
        // has to describe what it wants (content, insights, task_id…) —
        // no action enum to remember. Legacy callers that still pass
        // `action` win over inference (backward compatibility).
        const recordArgs = normalizeStructuredArgs(args);
        const action = recordArgs.action || inferRecordAction(recordArgs);
        let recordResult;
        switch (action) {
          case 'write':       // legacy alias
          case 'remember':
            recordResult = await daemon._remember(recordArgs);
            break;
          case 'remember_batch':
            recordResult = await daemon._rememberBatch(recordArgs);
            break;
          case 'update_task':
            recordResult = await daemon._updateTask(recordArgs);
            break;
          case 'submit_insights':
            recordResult = await daemon._submitInsights(recordArgs);
            break;
          default:
            recordResult = { error: 'awareness_record requires at least one of: content, insights, or task_id+status' };
        }
        result = mcpResult(recordResult);
        break;
      }

      case 'awareness_lookup': {
        result = mcpResult(await daemon._lookup(args));
        break;
      }

      case 'awareness_get_agent_prompt': {
        result = mcpResult(buildAgentPromptResult({
          loadSpec: () => daemon._loadSpec(),
          role: args.role,
        }));
        break;
      }

      case 'awareness_apply_skill': {
        const { skill_id, context } = args;
        if (!skill_id) {
          result = mcpResult({ error: 'skill_id is required' });
          break;
        }
        try {
          const skill = daemon.indexer.db
            .prepare("SELECT * FROM skills WHERE id = ? AND status = 'active'")
            .get(skill_id);
          if (!skill) {
            result = mcpResult({ error: `Skill not found: ${skill_id}` });
            break;
          }

          const now = new Date().toISOString();
          daemon.indexer.db
            .prepare("UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?")
            .run(now, now, skill_id);

          const methods = JSON.parse(skill.methods || '[]');
          const triggerConditions = JSON.parse(skill.trigger_conditions || '[]');
          const sourceCardIds = JSON.parse(skill.source_card_ids || '[]');
          let pitfalls = [];
          try { pitfalls = JSON.parse(skill.pitfalls || '[]'); } catch {}
          let verification = [];
          try { verification = JSON.parse(skill.verification || '[]'); } catch {}

          // Hydrate top-3 source cards so the skill is self-contained —
          // LLM sees the linked context, not just IDs. "skill = head of its
          // card cluster" (user ask 2026-04-19). Keep bounded to avoid
          // token blow-up on widely-linked skills.
          let linkedCards = [];
          if (sourceCardIds.length > 0) {
            try {
              const placeholders = sourceCardIds.slice(0, 3).map(() => '?').join(',');
              const rows = daemon.indexer.db
                .prepare(`SELECT id, category, title, summary FROM knowledge_cards WHERE id IN (${placeholders}) AND status = 'active' LIMIT 3`)
                .all(...sourceCardIds.slice(0, 3));
              linkedCards = rows.map((r) => ({
                id: r.id,
                category: r.category,
                title: r.title,
                summary: r.summary,
              }));
            } catch { /* cards may have been superseded — skip hydration */ }
          }

          // F-059 · apply_skill is a usage signal — re-evaluate growth
          // stage (usage_count just incremented, may push budding →
          // evergreen). Best-effort; no failure path.
          try {
            const { evaluateSkillGrowth } = await import('./skill-growth.mjs');
            const { scoreSkill } = await import('./skill-quality-score.mjs');
            const rubric = scoreSkill({
              name: skill.name,
              summary: skill.summary || '',
              methods,
              trigger_conditions: triggerConditions,
              tags: JSON.parse(skill.tags || '[]'),
              pitfalls,
              verification,
            }).total;
            evaluateSkillGrowth(daemon.indexer, skill_id, rubric);
          } catch { /* growth eval best-effort */ }

          result = mcpResult({
            skill_name: skill.name,
            summary: skill.summary,
            methods,
            pitfalls,
            verification,
            trigger_conditions: triggerConditions,
            source_card_count: sourceCardIds.length,
            linked_cards: linkedCards,
            growth_stage: skill.growth_stage || 'seedling',
            usage_count: (skill.usage_count || 0) + 1,
            guidance: `Execute this ${methods.length}-step skill "${skill.name}" for the current task${context ? `: "${context}"` : ''}. Follow each step in order. Adapt descriptions to the specific context. Report completion status after finishing.${linkedCards.length > 0 ? ` Linked knowledge cards (${linkedCards.length}) provide supporting context.` : ''}`,
          });
        } catch (err) {
          result = mcpResult({ error: `Failed to apply skill: ${err.message}` });
        }
        break;
      }

      case 'awareness_mark_skill_used': {
        const { skill_id, outcome = 'success' } = args;
        if (!skill_id) {
          result = mcpResult({ error: 'skill_id is required' });
          break;
        }
        const validOutcomes = ['success', 'partial', 'failed'];
        if (!validOutcomes.includes(outcome)) {
          result = mcpResult({ error: `Invalid outcome: "${outcome}". Must be success/partial/failed.` });
          break;
        }
        const now = new Date().toISOString();
        try {
          // Fetch current state for outcome-based adjustments
          const current = daemon.indexer.db.prepare(
            `SELECT decay_score, confidence, consecutive_failures FROM skills WHERE id = ?`
          ).get(skill_id);
          if (!current) {
            result = mcpResult({ error: `Skill ${skill_id} not found` });
            break;
          }

          const curDecay = current.decay_score ?? 1.0;
          const curConfidence = current.confidence ?? 1.0;
          const curFailures = current.consecutive_failures ?? 0;

          let newDecay, newConfidence, newFailures;
          if (outcome === 'success') {
            newDecay = 1.0;
            newConfidence = Math.min(1.0, curConfidence + 0.05);
            newFailures = 0;
          } else if (outcome === 'partial') {
            newDecay = 0.7;
            newConfidence = curConfidence;
            newFailures = 0;
          } else {
            // failed
            newDecay = Math.max(0.1, curDecay - 0.2);
            newConfidence = Math.max(0.1, curConfidence - 0.1);
            newFailures = curFailures + 1;
          }

          const newStatus = newFailures >= 3 ? 'needs_review' : undefined;
          const statusClause = newStatus ? `, status = '${newStatus}'` : '';

          daemon.indexer.db.prepare(
            `UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?,
             decay_score = ?, confidence = ?, consecutive_failures = ?,
             updated_at = ?${statusClause} WHERE id = ?`
          ).run(now, newDecay, newConfidence, newFailures, now, skill_id);

          const res = { success: true, skill_id, outcome, decay_score: newDecay, confidence: newConfidence };
          if (newFailures >= 3) {
            res._notice = `Skill has failed ${newFailures} consecutive times and is now marked 'needs_review'.`;
          }
          result = mcpResult(res);
        } catch (err) {
          result = mcpResult({ error: `Failed to mark skill used: ${err.message}` });
        }
        break;
      }

      case 'awareness_workspace_search': {
        const query = args.query;
        if (!query) {
          result = mcpResult({ error: 'query is required' });
          break;
        }

        const nodeTypes = args.node_types || null;
        const limit = Math.min(args.limit || 10, 30);
        const includeNeighbors = args.include_neighbors ?? false;
        const results = daemon.indexer.searchGraphNodes(query, { nodeTypes, limit });

        let expanded = [];
        if (includeNeighbors && results.length > 0) {
          const seen = new Set(results.map((r) => r.id));
          for (const node of results.slice(0, 3)) {
            const neighbors = daemon.indexer.graphTraverse(node.id, {
              edgeTypes: ['similarity', 'doc_reference'],
              maxDepth: 1,
              limit: 3,
            });
            for (const n of neighbors) {
              if (!seen.has(n.id)) {
                seen.add(n.id);
                expanded.push(n);
              }
            }
          }
        }

        const formatted = [...results, ...expanded].slice(0, limit).map((node) => {
          let metadata = {};
          try { metadata = JSON.parse(node.metadata || '{}'); } catch { /* ignore */ }
          return {
            id: node.id,
            type: node.node_type,
            title: node.title || '',
            summary: (node.content || '').slice(0, 500),
            file_path: metadata.file_path || metadata.relative_path || '',
            language: metadata.language || '',
            score: Math.abs(node.rank || 0),
            is_neighbor: expanded.includes(node),
          };
        });

        result = mcpResult({
          results: formatted,
          total: formatted.length,
          query,
        });
        break;
      }

      default:
        track('feature_blocked', { feature_name: name });
        trackToolCall(name, false);
        throw new Error(`Unknown tool: ${name}`);
    }

    const success = !isMcpErrorResult(result);
    trackToolCall(name, success);
    return result;
  } catch (error) {
    if (KNOWN_TOOLS.has(name)) {
      trackToolCall(name, false);
    }
    throw error;
  }
}
