import { mcpResult } from './mcp-contract.mjs';
import {
  buildAgentPromptResult,
  buildInitResult,
  buildRecallResult,
} from './mcp-handlers.mjs';

export async function callMcpTool(daemon, name, args) {
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

      return mcpResult(initResult);
    }

    case 'awareness_recall': {
      return buildRecallResult({
        search: daemon.search,
        args,
        indexer: daemon.indexer,
      });
    }

    case 'awareness_record': {
      let result;
      switch (args.action) {
        case 'remember':
          result = await daemon._remember(args);
          break;
        case 'remember_batch':
          result = await daemon._rememberBatch(args);
          break;
        case 'update_task':
          result = await daemon._updateTask(args);
          break;
        case 'submit_insights':
          result = await daemon._submitInsights(args);
          break;
        default:
          result = { error: `Unknown action: ${args.action}` };
      }
      return mcpResult(result);
    }

    case 'awareness_lookup': {
      const result = await daemon._lookup(args);
      return mcpResult(result);
    }

    case 'awareness_get_agent_prompt': {
      return mcpResult(buildAgentPromptResult({
        loadSpec: () => daemon._loadSpec(),
        role: args.role,
      }));
    }

    case 'awareness_apply_skill': {
      const { skill_id, context } = args;
      if (!skill_id) {
        return mcpResult({ error: 'skill_id is required' });
      }
      try {
        const skill = daemon.indexer.db
          .prepare("SELECT * FROM skills WHERE id = ? AND status = 'active'")
          .get(skill_id);
        if (!skill) {
          return mcpResult({ error: `Skill not found: ${skill_id}` });
        }

        // Mark as used (reset decay)
        const now = new Date().toISOString();
        daemon.indexer.db
          .prepare("UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?")
          .run(now, now, skill_id);

        const methods = JSON.parse(skill.methods || '[]');
        const triggerConditions = JSON.parse(skill.trigger_conditions || '[]');

        return mcpResult({
          skill_name: skill.name,
          summary: skill.summary,
          methods,
          trigger_conditions: triggerConditions,
          source_card_count: JSON.parse(skill.source_card_ids || '[]').length,
          usage_count: (skill.usage_count || 0) + 1,
          guidance: `Execute this ${methods.length}-step skill "${skill.name}" for the current task${context ? `: "${context}"` : ''}. Follow each step in order. Adapt descriptions to the specific context. Report completion status after finishing.`,
        });
      } catch (err) {
        return mcpResult({ error: `Failed to apply skill: ${err.message}` });
      }
    }

    case 'awareness_mark_skill_used': {
      const { skill_id } = args;
      if (!skill_id) {
        return mcpResult({ error: 'skill_id is required' });
      }
      const now = new Date().toISOString();
      try {
        daemon.indexer.db.prepare(
          `UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?`
        ).run(now, now, skill_id);
        return mcpResult({ success: true, skill_id });
      } catch (err) {
        return mcpResult({ error: `Failed to mark skill used: ${err.message}` });
      }
    }

    case 'awareness_workspace_search': {
      const query = args.query;
      if (!query) return mcpResult({ error: 'query is required' });

      const nodeTypes = args.node_types || null;
      const limit = Math.min(args.limit || 10, 30);
      const includeNeighbors = args.include_neighbors ?? false;

      // FTS5 search on graph_nodes
      const results = daemon.indexer.searchGraphNodes(query, { nodeTypes, limit });

      // Optional: expand with 1-hop similarity neighbors
      let expanded = [];
      if (includeNeighbors && results.length > 0) {
        const seen = new Set(results.map(r => r.id));
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

      // Format results
      const formatted = [...results, ...expanded].slice(0, limit).map(node => {
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

      return mcpResult({
        results: formatted,
        total: formatted.length,
        query,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
