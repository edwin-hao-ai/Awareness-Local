/**
 * sync-push.mjs — Push (upload) layer for CloudSync.
 *
 * Extracted from cloud-sync.mjs.  Each function receives a context object
 * instead of using `this`, making them testable in isolation.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Errors are caught internally — none of these functions may crash the daemon.
 */

import fs from 'node:fs';
import { createLocalConflict } from './sync-conflict.mjs';

const LOG_PREFIX = '[SyncPush]';

// ---------------------------------------------------------------------------
// Push memories
// ---------------------------------------------------------------------------

/**
 * Push unsynced local memories to the cloud.
 * Finds all memories with synced_to_cloud=0 and POSTs them to /mcp/events.
 *
 * @param {object} ctx — Push context
 * @param {object} ctx.indexer       — Indexer instance (SQLite access)
 * @param {object} ctx.memoryStore   — MemoryStore instance (markdown read/write)
 * @param {string} ctx.apiBase       — Cloud API base URL
 * @param {string} ctx.apiKey        — Cloud API key
 * @param {string} ctx.memoryId      — Cloud memory ID
 * @param {string} ctx.deviceId      — Local device identifier
 * @param {function} ctx.httpPost    — (endpoint, data) => Promise<object|null>
 * @param {function} ctx.getSyncState  — (key) => string|null
 * @param {function} ctx.setSyncState  — (key, value) => void
 * @param {function} ctx.recordSyncEvent — (type, details) => void
 * @param {function} ctx.parseTags   — (tagsStr) => string[]
 * @returns {Promise<{ synced: number, errors: number }>}
 */
export async function pushMemoriesToCloud(ctx) {
  const {
    indexer, memoryStore, apiBase, apiKey, memoryId, deviceId,
    httpPost, getSyncState, setSyncState, recordSyncEvent, parseTags,
  } = ctx;

  let synced = 0;
  let errors = 0;

  try {
    const unsynced = indexer.db
      .prepare('SELECT * FROM memories WHERE synced_to_cloud = 0 ORDER BY created_at')
      .all();

    if (!unsynced.length) return { synced: 0, errors: 0 };

    for (const memory of unsynced) {
      try {
        // Read the markdown content from disk, strip YAML front matter
        let content = '';
        try {
          const raw = fs.readFileSync(memory.filepath, 'utf-8');
          content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
        } catch {
          // File may have been deleted — skip
          console.warn(`${LOG_PREFIX} File not found, skipping: ${memory.filepath}`);
          errors++;
          continue;
        }

        // Gather local vector if available
        const embedding = indexer.db
          .prepare('SELECT vector, model_id FROM embeddings WHERE memory_id = ?')
          .get(memory.id);

        const metadata = {
          local_id: memory.id,
          device_id: deviceId,
          agent_role: memory.agent_role,
          tags: parseTags(memory.tags),
          source: memory.source || 'awareness-local',
        };

        // Attach local vector for cloud to optionally reuse
        if (embedding) {
          try {
            const floats = new Float32Array(
              embedding.vector.buffer,
              embedding.vector.byteOffset,
              embedding.vector.byteLength / 4
            );
            metadata.local_vector = Array.from(floats);
            metadata.local_model = embedding.model_id;
            metadata.local_dim = floats.length;
          } catch {
            // Vector decode failed — send without
          }
        }

        const result = await httpPost('/mcp/events', {
          memory_id: memoryId,
          events: [
            {
              event_type: memory.type,
              content,
              metadata,
            },
          ],
        });

        // Mark as synced
        const cloudId = result?.cloud_id || result?.ids?.[0] || null;
        indexer.db
          .prepare('UPDATE memories SET synced_to_cloud = 1 WHERE id = ?')
          .run(memory.id);

        // Store cloud_id mapping in sync_state for reference
        if (cloudId) {
          setSyncState(`cloud_id:${memory.id}`, cloudId);
        }

        synced++;
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to push memory ${memory.id}:`, err.message);
        errors++;
      }
    }

    if (synced > 0) {
      console.log(
        `${LOG_PREFIX} Pushed ${synced} memories to cloud` +
          (errors ? ` (${errors} errors)` : '')
      );
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} pushMemoriesToCloud failed:`, err.message);
  }

  if (synced > 0) {
    recordSyncEvent('memories', { count: synced, direction: 'push' });
  }

  return { synced, errors };
}

// ---------------------------------------------------------------------------
// Push knowledge cards (insights)
// ---------------------------------------------------------------------------

/**
 * Push unsynced knowledge cards to the cloud.
 * Uses POST /memories/{id}/insights/submit with action:"new".
 *
 * When the cloud responds with HTTP 409 (version conflict), a local conflict
 * record is created via sync-conflict.mjs so the user can resolve it later.
 *
 * @param {object} ctx — Same shape as pushMemoriesToCloud context plus:
 * @param {function} ctx.httpPostRaw — (endpoint, data, extraHeaders?) => Promise<{ status, body }>
 *   Raw variant that exposes status code so we can detect 409s.
 * @returns {Promise<{ synced: number, errors: number }>}
 */
export async function pushInsightsToCloud(ctx) {
  const {
    indexer, memoryId, deviceId,
    httpPost, httpPostRaw,
    getSyncState, setSyncState, recordSyncEvent, parseTags,
  } = ctx;

  let synced = 0;
  let errors = 0;

  try {
    // Push active cards + superseded cards that haven't been synced yet
    const unsynced = indexer.db
      .prepare(
        "SELECT * FROM knowledge_cards WHERE synced_to_cloud = 0 AND status IN ('active', 'superseded') ORDER BY created_at"
      )
      .all();

    if (!unsynced.length) return { synced: 0, errors: 0 };

    // Batch cards in groups of 10 to reduce API calls
    const batchSize = 10;
    for (let i = 0; i < unsynced.length; i += batchSize) {
      const batch = unsynced.slice(i, i + batchSize);
      const cards = batch
        .map((card) => {
          // Determine cloud action based on local evolution type
          let action = 'new';
          if (card.evolution_type === 'update' && card.parent_card_id) {
            // Look up the cloud ID of the parent card
            const cloudParentId = getSyncState(`local_kc_to_cloud:${card.parent_card_id}`);
            if (cloudParentId) {
              action = `update:${cloudParentId}`;
            }
            // If no cloud mapping exists, fall back to 'new' — cloud's own
            // BM25/vector dedup will handle it
          }
          // Skip superseded cards — they were already replaced locally
          if (card.status === 'superseded') {
            return null;
          }

          // Read the card's local version for If-Match optimistic lock
          const localVersion = card.version ?? null;

          return {
            _localId: card.id,
            _localVersion: localVersion,
            title: card.title,
            summary: card.summary || '',
            category: card.category,
            confidence: card.confidence || 0.8,
            tags: parseTags(card.tags),
            action,
          };
        })
        .filter(Boolean);

      try {
        // Build extra headers — attach If-Match when we have a single-card
        // batch with a known version (allows the cloud to 409 on conflict).
        const extraHeaders = {};
        if (cards.length === 1 && cards[0]._localVersion != null) {
          extraHeaders['If-Match'] = String(cards[0]._localVersion);
        }

        // Strip internal fields before sending to cloud
        const cleanCards = cards.map(({ _localId, _localVersion, ...rest }) => rest);

        const payload = {
          session_id: `local-sync-${deviceId}`,
          knowledge_cards: cleanCards,
          metadata: { device_id: deviceId, source: 'awareness-local' },
        };

        // Use raw POST if available so we can inspect the status code
        let result = null;
        let httpStatus = 0;
        let rawBody = '';

        if (httpPostRaw) {
          const resp = await httpPostRaw(
            `/memories/${memoryId}/insights/submit`,
            payload,
            extraHeaders
          );
          httpStatus = resp.status;
          rawBody = resp.body;

          if (httpStatus >= 200 && httpStatus < 300) {
            try {
              result = JSON.parse(rawBody);
            } catch {
              result = {};
            }
          }
        } else {
          result = await httpPost(
            `/memories/${memoryId}/insights/submit`,
            payload
          );
        }

        // Handle 409 Conflict — create local conflict records
        if (httpStatus === 409) {
          let cloudVersion = null;
          try {
            const errPayload = JSON.parse(rawBody);
            cloudVersion = errPayload.cloud_version || errPayload.current_version || null;
          } catch {
            // Could not parse conflict details
          }

          for (const card of cards) {
            try {
              createLocalConflict(indexer, {
                card_id: card._localId,
                local_version: card._localVersion != null ? JSON.stringify({ version: card._localVersion, title: card.title }) : '{}',
                cloud_version: cloudVersion ? JSON.stringify(cloudVersion) : '{}',
                device_id: deviceId,
                conflict_type: 'version_mismatch',
              });
              console.warn(
                `${LOG_PREFIX} Version conflict for card ${card._localId} — recorded locally`
              );
            } catch (conflictErr) {
              console.warn(
                `${LOG_PREFIX} Failed to record conflict for ${card._localId}:`,
                conflictErr.message
              );
            }
          }
          errors += batch.length;
          continue;
        }

        if (result) {
          // Mark entire batch as synced (including superseded ones we filtered out)
          const markStmt = indexer.db.prepare(
            'UPDATE knowledge_cards SET synced_to_cloud = 1 WHERE id = ?'
          );
          for (const card of batch) {
            markStmt.run(card.id);
          }
          synced += cleanCards.length;
        } else {
          errors += batch.length;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to push insight batch:`, err.message);
        errors += batch.length;
      }
    }

    if (synced > 0) {
      console.log(
        `${LOG_PREFIX} Pushed ${synced} knowledge cards to cloud` +
          (errors ? ` (${errors} errors)` : '')
      );
      recordSyncEvent('insights', { count: synced, direction: 'push' });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} pushInsightsToCloud failed:`, err.message);
  }

  return { synced, errors };
}

// ---------------------------------------------------------------------------
// Push tasks (action items)
// ---------------------------------------------------------------------------

/**
 * Push unsynced tasks (action items) to the cloud.
 * Uses POST /memories/{id}/insights/submit with action_items.
 *
 * @param {object} ctx — Same shape as pushMemoriesToCloud context
 * @returns {Promise<{ synced: number, errors: number }>}
 */
export async function pushTasksToCloud(ctx) {
  const {
    indexer, memoryId, deviceId,
    httpPost, getSyncState, setSyncState, recordSyncEvent, parseTags,
  } = ctx;

  let synced = 0;
  let errors = 0;

  try {
    const unsynced = indexer.db
      .prepare('SELECT * FROM tasks WHERE synced_to_cloud = 0 ORDER BY created_at')
      .all();

    if (!unsynced.length) return { synced: 0, errors: 0 };

    const batchSize = 10;
    for (let i = 0; i < unsynced.length; i += batchSize) {
      const batch = unsynced.slice(i, i + batchSize);
      const items = batch.map((task) => ({
        title: task.title,
        detail: task.description || '',
        priority: task.priority || 'medium',
        status: task.status || 'open',
        agent_role: task.agent_role || '',
      }));

      try {
        const result = await httpPost(
          `/memories/${memoryId}/insights/submit`,
          {
            session_id: `local-sync-${deviceId}`,
            action_items: items,
            metadata: { device_id: deviceId, source: 'awareness-local' },
          }
        );

        if (result) {
          const markStmt = indexer.db.prepare(
            'UPDATE tasks SET synced_to_cloud = 1 WHERE id = ?'
          );
          for (const task of batch) {
            markStmt.run(task.id);
          }
          synced += batch.length;
        } else {
          errors += batch.length;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to push task batch:`, err.message);
        errors += batch.length;
      }
    }

    if (synced > 0) {
      console.log(
        `${LOG_PREFIX} Pushed ${synced} tasks to cloud` +
          (errors ? ` (${errors} errors)` : '')
      );
      recordSyncEvent('tasks', { count: synced, direction: 'push' });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} pushTasksToCloud failed:`, err.message);
  }

  return { synced, errors };
}

// ---------------------------------------------------------------------------
// Push documents (workspace_scan)
// ---------------------------------------------------------------------------

const DOC_BATCH_SIZE = 10;

/**
 * Push document nodes (node_type='doc') from graph_nodes to the cloud.
 *
 * Only pushes documents where content_hash ≠ sync_hash (changed since last push).
 * After successful push, updates sync_hash to avoid re-pushing.
 *
 * @param {object} ctx — same context as pushMemoriesToCloud
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
export async function pushDocumentsToCloud(ctx) {
  const { indexer, memoryId, httpPost, recordSyncEvent } = ctx;

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Fetch all doc nodes
    const docNodes = indexer.db
      .prepare("SELECT * FROM graph_nodes WHERE node_type = 'doc' AND (status IS NULL OR status != 'deleted')")
      .all();

    if (!docNodes.length) return { synced: 0, skipped: 0, errors: 0 };

    // Filter to only those that need pushing (content_hash ≠ sync_hash)
    const toPush = [];
    for (const node of docNodes) {
      if (node.sync_hash && node.sync_hash === node.content_hash) {
        skipped++;
        continue;
      }
      toPush.push(node);
    }

    if (!toPush.length) return { synced: 0, skipped, errors: 0 };

    // Push in batches
    const updateStmt = indexer.db.prepare(
      'UPDATE graph_nodes SET sync_hash = ? WHERE id = ?'
    );

    for (let i = 0; i < toPush.length; i += DOC_BATCH_SIZE) {
      const batch = toPush.slice(i, i + DOC_BATCH_SIZE);

      try {
        const documents = batch.map(node => {
          let meta = {};
          try { meta = JSON.parse(node.metadata || '{}'); } catch (_) {}
          return {
            title: node.title,
            content: node.content || '',
            content_hash: node.content_hash,
            source_type: 'workspace_scan',
            relative_path: meta.relativePath || node.title,
            category: meta.category || 'docs',
          };
        });

        const result = await httpPost(
          `/memories/${memoryId}/documents/sync`,
          { documents }
        );

        if (result && !result.error) {
          for (const node of batch) {
            updateStmt.run(node.content_hash, node.id);
          }
          synced += batch.length;
        } else {
          errors += batch.length;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to push document batch:`, err.message);
        errors += batch.length;
      }
    }

    if (synced > 0) {
      console.log(
        `${LOG_PREFIX} Pushed ${synced} documents to cloud` +
          (errors ? ` (${errors} errors)` : '')
      );
      recordSyncEvent('documents', { count: synced, direction: 'push' });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} pushDocumentsToCloud failed:`, err.message);
  }

  return { synced, skipped, errors };
}
