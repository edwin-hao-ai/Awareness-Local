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
        const initResult = buildInitResult({
          createSession: (source) => daemon._createSession(source),
          indexer: daemon.indexer,
          loadSpec: () => daemon._loadSpec(),
          source: args.source,
          days: args.days ?? 7,
          maxCards: args.max_cards ?? 5,
          maxTasks: args.max_tasks ?? 0,
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
        });
        break;
      }

      case 'awareness_record': {
        let recordResult;
        switch (args.action) {
          case 'remember':
            recordResult = await daemon._remember(args);
            break;
          case 'remember_batch':
            recordResult = await daemon._rememberBatch(args);
            break;
          case 'update_task':
            recordResult = await daemon._updateTask(args);
            break;
          case 'submit_insights':
            recordResult = await daemon._submitInsights(args);
            break;
          default:
            recordResult = { error: `Unknown action: ${args.action}` };
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

          result = mcpResult({
            skill_name: skill.name,
            summary: skill.summary,
            methods,
            trigger_conditions: triggerConditions,
            source_card_count: JSON.parse(skill.source_card_ids || '[]').length,
            usage_count: (skill.usage_count || 0) + 1,
            guidance: `Execute this ${methods.length}-step skill "${skill.name}" for the current task${context ? `: "${context}"` : ''}. Follow each step in order. Adapt descriptions to the specific context. Report completion status after finishing.`,
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
