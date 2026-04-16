// @ts-nocheck
import http from 'node:http';

import {
  CATEGORY_TO_RULE_TYPE,
  MAX_BODY_BYTES,
  MAX_USER_PREFERENCES,
  PREFERENCE_FIRST_CATEGORIES,
} from './constants.mjs';

/**
 * Create a noop indexer fallback when better-sqlite3 is not available.
 * Provides stubs for every method/property accessed on the real Indexer,
 * including `db.prepare(sql).get/all/run()` and `db.transaction()`.
 */
export function createNoopIndexer() {
  const noopStmt = { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
  const noopDb = {
    prepare: () => noopStmt,
    transaction: (fn) => fn,
    exec: () => {},
    pragma: () => {},
  };
  return {
    db: noopDb,
    incrementalIndex: async () => ({ indexed: 0, skipped: 0 }),
    indexMemory: () => ({ indexed: false }),
    indexKnowledgeCard: () => {},
    indexTask: () => {},
    search: () => [],
    searchKnowledge: () => [],
    getRecentKnowledge: () => [],
    getRecentMemories: () => [],
    getOpenTasks: () => [],
    getRecentSessions: () => [],
    getStats: () => ({ totalMemories: 0, totalKnowledge: 0, totalTasks: 0, totalSessions: 0 }),
    createSession: (source, agentRole = 'builder_agent') => ({
      id: `ses_${Date.now()}_noop`,
      source: source || null,
      agent_role: agentRole,
      started_at: new Date().toISOString(),
    }),
    updateSession: () => {},
    supersedeCard: () => false,
    getEvolutionChain: () => [],
    storeEmbedding: () => {},
    getEmbedding: () => null,
    getAllEmbeddings: () => [],
    close: () => {},
  };
}

export function nowISO() {
  return new Date().toISOString();
}

export function splitPreferences(cards) {
  const prefs = [];
  const other = [];
  for (const card of cards) {
    if (PREFERENCE_FIRST_CATEGORIES.has(card.category) && prefs.length < MAX_USER_PREFERENCES) {
      prefs.push(card);
    } else {
      other.push(card);
    }
  }
  return { user_preferences: prefs, knowledge_cards: other };
}

export function synthesizeRules(cards, maxRules = 30) {
  const buckets = {};
  for (const card of cards) {
    const ruleType = CATEGORY_TO_RULE_TYPE[card.category] || 'knowledge';
    if (!buckets[ruleType]) buckets[ruleType] = [];

    const ruleText = (card.actionable_rule || '').trim() || card.summary || '';
    if (!ruleText) continue;

    buckets[ruleType].push({
      id: `rule_${(card.id || '').slice(0, 8)}`,
      rule_type: ruleType,
      title: card.title || '',
      rule: ruleText,
      confidence: card.confidence || 0.8,
      tags: card.tags ? (typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags) : [],
    });
  }

  const priority = ['preference', 'architecture', 'pitfall', 'workflow', 'solution', 'knowledge', 'context'];
  const rules = [];
  for (const type of priority) {
    const bucket = (buckets[type] || []).slice(0, 8);
    for (const rule of bucket) {
      if (rules.length >= maxRules) break;
      rules.push(rule);
    }
    if (rules.length >= maxRules) break;
  }
  return { rules, rule_count: rules.length };
}

export function extractActiveSkills(cards, indexer) {
  // F-032: Prefer dedicated skills table
  if (indexer) {
    try {
      const skills = indexer.db.prepare(
        "SELECT * FROM skills WHERE status = 'active' AND decay_score > 0.3 ORDER BY decay_score DESC LIMIT 10"
      ).all();
      if (skills.length > 0) {
        return skills.map((s) => {
          let methods = [];
          if (s.methods) {
            try { methods = JSON.parse(s.methods); } catch { methods = []; }
          }
          if (!Array.isArray(methods)) methods = [];
          return {
            id: s.id,
            title: s.name || '',
            summary: s.summary || '',
            methods,
            decay_score: s.decay_score,
            usage_count: s.usage_count,
          };
        });
      }
    } catch { /* skills table may not exist yet — fall through to legacy */ }
  }
  // Legacy fallback: read from knowledge_cards
  return cards
    .filter((card) => card.category === 'skill')
    .map((card) => {
      let methods = [];
      if (card.methods) {
        methods = typeof card.methods === 'string' ? JSON.parse(card.methods) : card.methods;
      }
      if (!Array.isArray(methods)) methods = [];
      return {
        title: card.title || '',
        summary: card.summary || '',
        methods,
      };
    });
}

export function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  const origin = 'http://localhost:37800';
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': origin,
  });
  res.end(body);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large (max 10MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function httpHealthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}
