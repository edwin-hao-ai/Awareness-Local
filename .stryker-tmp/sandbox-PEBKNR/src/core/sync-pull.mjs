/**
 * sync-pull.mjs — Card-level pull using the dedicated sync endpoint.
 *
 * Pulls knowledge cards that changed on the cloud since the last pull,
 * filtered by device_id to skip items this daemon already pushed.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Errors are caught internally — pull failures must never crash the daemon.
 */
// @ts-nocheck


const LOG_PREFIX = '[SyncPull]';

// ---------------------------------------------------------------------------
// Pull cards
// ---------------------------------------------------------------------------

/**
 * Pull knowledge cards from the cloud that were modified since the last pull.
 *
 * Calls:
 *   GET /memories/{memoryId}/cards/sync?since={last_pulled_at}&device_id={deviceId}
 *
 * For each returned card the function:
 *   1. Checks if the card already exists locally (by cloud-to-local ID mapping).
 *   2. Upserts the card into the local SQLite `knowledge_cards` table.
 *   3. Optionally writes a markdown file via memoryStore.
 *   4. Updates the `last_pulled_at` timestamp in sync_state.
 *
 * @param {object} ctx
 * @param {string}   ctx.apiBase     — Cloud API base URL
 * @param {string}   ctx.apiKey      — Cloud API key
 * @param {string}   ctx.memoryId    — Cloud memory ID
 * @param {string}   ctx.deviceId    — Local device identifier
 * @param {object}   ctx.indexer     — Indexer instance (SQLite access)
 * @param {object}   ctx.memoryStore — MemoryStore instance (markdown read/write)
 * @param {function} ctx.getSyncState  — (key) => string|null
 * @param {function} ctx.setSyncState  — (key, value) => void
 * @param {function} ctx.httpGet     — async (endpoint) => object|null
 * @returns {Promise<{ pulled: number }>}
 */
export async function pullCardsSince(ctx) {
  const {
    apiBase, apiKey, memoryId, deviceId,
    indexer, memoryStore,
    getSyncState, setSyncState, httpGet,
  } = ctx;

  let pulled = 0;

  try {
    const lastPulledAt = getSyncState('cards_last_pulled_at') || '';

    // Build query string
    const qs = new URLSearchParams();
    if (lastPulledAt) qs.set('since', lastPulledAt);
    if (deviceId) qs.set('device_id', deviceId);

    const queryStr = qs.toString();
    const endpoint = `/memories/${memoryId}/cards/sync${queryStr ? '?' + queryStr : ''}`;
    const result = await httpGet(endpoint);

    if (!result) {
      // httpGet returns null on non-2xx or network error
      return { pulled: 0 };
    }

    // API may return { cards: [...] } or an array directly
    const cards = Array.isArray(result) ? result : (result.cards || result.items || []);

    if (!cards.length) return { pulled: 0 };

    for (const card of cards) {
      try {
        // Skip cards pushed by this device (anti-loop)
        const cardDeviceId = card.metadata?.device_id || card.device_id;
        if (cardDeviceId === deviceId) continue;

        // Skip if we already have a local mapping for this cloud card
        const existingLocalId = getSyncState(`cloud_kc:${card.id}`);

        if (existingLocalId) {
          // Card already exists locally — update it if the cloud version is newer
          _updateLocalCard(indexer, existingLocalId, card);
        } else {
          // New card — insert locally
          _insertLocalCard(indexer, card, deviceId, getSyncState, setSyncState);
        }

        pulled++;
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to pull card ${card.id}:`, err.message);
      }
    }

    // Advance the pull cursor to the server-provided timestamp (or now)
    const newCursor = result.sync_timestamp || result.server_time || new Date().toISOString();
    setSyncState('cards_last_pulled_at', newCursor);

    if (pulled > 0) {
      console.log(`${LOG_PREFIX} Pulled ${pulled} knowledge cards from cloud`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} pullCardsSince failed:`, err.message);
  }

  return { pulled };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Update an existing local card with data from the cloud.
 *
 * @param {object} indexer
 * @param {string} localId — Existing local card ID
 * @param {object} cloudCard — Card payload from cloud
 */
function _updateLocalCard(indexer, localId, cloudCard) {
  try {
    indexer.db
      .prepare(
        `UPDATE knowledge_cards
         SET title = ?,
             summary = ?,
             category = ?,
             confidence = ?,
             status = ?,
             tags = ?,
             synced_to_cloud = 1
         WHERE id = ?`
      )
      .run(
        cloudCard.title || '',
        cloudCard.summary || '',
        cloudCard.category || 'key_point',
        cloudCard.confidence || 0.8,
        cloudCard.status || 'active',
        JSON.stringify(cloudCard.tags || []),
        localId
      );
  } catch (err) {
    // Non-critical — log but don't throw
    if (!err.message?.includes('UNIQUE')) {
      console.warn(`${LOG_PREFIX} Failed to update local card ${localId}:`, err.message);
    }
  }
}

/**
 * Insert a new cloud card into the local database.
 *
 * @param {object} indexer
 * @param {object} cloudCard — Card payload from cloud
 * @param {string} deviceId
 * @param {function} getSyncState
 * @param {function} setSyncState
 */
function _insertLocalCard(indexer, cloudCard, deviceId, getSyncState, setSyncState) {
  const kcId = `kc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const tags = Array.isArray(cloudCard.tags) ? cloudCard.tags : [];

  // Resolve parent_card_id: translate cloud parent ID to local ID
  let localParentId = null;
  if (cloudCard.parent_card_id) {
    localParentId = getSyncState(`cloud_kc:${cloudCard.parent_card_id}`) || null;
  }

  // If this card supersedes a local card, mark the local one as superseded
  if (
    localParentId &&
    (cloudCard.evolution_type === 'update' || cloudCard.evolution_type === 'reversal')
  ) {
    try {
      indexer.db
        .prepare("UPDATE knowledge_cards SET status = 'superseded' WHERE id = ? AND status = 'active'")
        .run(localParentId);
    } catch {
      // Non-critical
    }
  }

  try {
    indexer.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_cards
         (id, category, title, summary, source_memories, confidence, status, tags,
          parent_card_id, evolution_type, created_at, filepath, synced_to_cloud)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        kcId,
        cloudCard.category || 'key_point',
        cloudCard.title || '',
        cloudCard.summary || '',
        JSON.stringify(cloudCard.source_memories || []),
        cloudCard.confidence || 0.8,
        cloudCard.status || 'active',
        JSON.stringify(tags),
        localParentId,
        cloudCard.evolution_type || 'initial',
        now,
        `cloud-pull:${cloudCard.id}`
      );

    // Store bidirectional cloud <-> local ID mappings
    setSyncState(`cloud_kc:${cloudCard.id}`, kcId);
    setSyncState(`local_kc_to_cloud:${kcId}`, cloudCard.id);
  } catch (err) {
    // Duplicate or constraint error — safe to ignore
    if (!err.message?.includes('UNIQUE')) {
      throw err;
    }
  }
}
