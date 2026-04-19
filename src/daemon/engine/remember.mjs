/**
 * awareness_record(action=remember) engine · F-057 Phase 4 extraction.
 *
 * Writes a single memory, indexes it (FTS5 + embedding), fires async
 * knowledge extraction, runs lifecycle checks (auto-resolve + GC),
 * builds the inline perception[] block, and attaches
 * _extraction_instruction when no insights were provided. Mirrors
 * cloud-backend semantics.
 *
 * Extracted verbatim from daemon.mjs::_remember (F-057 Phase 4);
 * `this` → `daemon`, nested method calls reach through the daemon
 * instance so the class surface stays intact.
 */

import { classifyNoiseEvent, cleanContent } from '../../core/noise-filter.mjs';
import { runLifecycleChecks } from '../../core/lifecycle-manager.mjs';
import { shouldRequestExtraction, buildExtractionInstruction } from '../extraction-instruction.mjs';

/**
 * @param {object} daemon - AwarenessLocalDaemon instance
 * @param {object} params - MCP args
 * @returns {Promise<object>}
 */
export async function remember(daemon, params) {
  if (!params.content) {
    return { error: 'content is required for remember action' };
  }

  const noiseReason = classifyNoiseEvent(params);
  if (noiseReason) {
    return { status: 'skipped', reason: noiseReason };
  }

  // SECURITY H1: Reject oversized content to prevent FTS5/embedding freeze
  const maxBytes = daemon.constructor.MAX_CONTENT_BYTES;
  if (typeof params.content === 'string' && params.content.length > maxBytes) {
    return { error: `Content too large (${params.content.length} bytes, max ${maxBytes})` };
  }

  // Strip metadata envelope prefixes before title auto-gen + indexing.
  const sanitizedContent = cleanContent(params.content);
  const contentForPersist = sanitizedContent || params.content;

  // Auto-generate title from SANITIZED content.
  let title = params.title || '';
  if (!title && contentForPersist) {
    const firstLine = contentForPersist.split(/[.\n!?。！？]/)[0].trim();
    title = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
  }

  const memory = {
    type: params.event_type || 'turn_summary',
    content: contentForPersist,
    title,
    tags: params.tags || [],
    agent_role: params.agent_role || 'builder_agent',
    session_id: params.session_id || '',
    source: params.source || 'mcp',
  };

  // Write markdown file
  const { id, filepath } = await daemon.memoryStore.write(memory);

  // Index in SQLite (sanitized content so FTS + embeddings skip the envelope prefix)
  daemon.indexer.indexMemory(id, { ...memory, filepath }, contentForPersist);

  // Fire-and-forget embedding + knowledge extraction
  daemon._embedAndStore(id, contentForPersist).catch(() => {});
  daemon._extractAndIndex(id, contentForPersist, memory, params.insights);

  // Cloud sync (fire-and-forget)
  if (daemon.cloudSync?.isEnabled()) {
    Promise.all([
      daemon.cloudSync.syncToCloud(),
      daemon.cloudSync.syncInsightsToCloud(),
      daemon.cloudSync.syncTasksToCloud(),
    ]).catch((err) => {
      console.warn('[awareness-local] cloud sync after remember failed:', err.message);
    });
  }

  // Lifecycle: auto-resolve tasks/risks, garbage collect
  const lifecycleOpts = {};
  if (daemon._embedder) {
    lifecycleOpts.embedFn = (text, type) => daemon._embedder.embed(text, type);
    lifecycleOpts.cosineFn = daemon._embedder.cosineSimilarity;
  }
  const lifecycle = await runLifecycleChecks(
    daemon.indexer, params.content, title, params.insights, lifecycleOpts,
  );

  // Perception: Eywa Whisper signals
  const perception = await daemon._buildPerception(params.content, title, memory, params.insights);

  // Fire-and-forget: LLM auto-resolve check on existing active perceptions
  daemon._checkPerceptionResolution(id, {
    title, content: params.content, tags: memory.tags, insights: params.insights,
  }).catch((err) => {
    if (process.env.DEBUG) console.warn('[awareness-local] perception resolve failed:', err.message);
  });

  const result = {
    status: 'ok',
    id,
    filepath,
    mode: 'local',
  };

  // Attach _extraction_instruction when no pre-extracted insights were provided.
  if (shouldRequestExtraction(params)) {
    try {
      const existingCards = daemon.indexer.db
        .prepare("SELECT id, title, category, summary FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT 8")
        .all();
      const spec = daemon._loadSpec();
      result._extraction_instruction = buildExtractionInstruction({
        content: params.content,
        memoryId: id,
        existingCards,
        spec,
      });
    } catch (_err) {
      // Non-fatal: extraction instruction is best-effort
    }
  }

  if (perception && perception.length > 0) {
    result.perception = perception;
  }

  // Surface lifecycle actions in response
  if (lifecycle.resolved_tasks.length > 0) {
    result.resolved_tasks = lifecycle.resolved_tasks;
  }
  if (lifecycle.mitigated_risks.length > 0) {
    result.mitigated_risks = lifecycle.mitigated_risks;
  }
  if (lifecycle.archived > 0) {
    result.archived_count = lifecycle.archived;
  }

  return result;
}
