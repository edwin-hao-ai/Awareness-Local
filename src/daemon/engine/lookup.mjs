/**
 * awareness_lookup engine · F-057 Phase 2 extraction from daemon.mjs.
 *
 * Pure function that takes a daemon instance + MCP `params`, switches on
 * `params.type`, and returns the domain object (context / tasks / knowledge /
 * risks / session_history / timeline / skills / perception). No behaviour
 * change — body is byte-equivalent to the pre-extraction class method,
 * with `this` → `daemon` and `splitPreferences` imported from helpers.
 */

import { splitPreferences } from '../helpers.mjs';

/**
 * @param {object} daemon - AwarenessLocalDaemon instance
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function lookup(daemon, params) {
  const { type, limit = 10, status, category, priority, session_id, agent_role, query } = params;

  switch (type) {
    case 'context': {
      // Full context dump with preference separation
      const stats = daemon.indexer.getStats();
      const knowledge = daemon.indexer.getRecentKnowledge(limit);
      const tasks = daemon.indexer.getOpenTasks(0);
      const rawSessions = daemon.indexer.getRecentSessions(7);
      // De-noise: only sessions with content; fallback to 3 most recent
      let sessions = rawSessions.filter(s => s.memory_count > 0 || s.summary);
      if (sessions.length === 0) sessions = rawSessions.slice(0, 3);
      sessions = sessions.slice(0, 5);
      const { user_preferences, knowledge_cards: otherCards } = splitPreferences(knowledge);
      return { stats, user_preferences, knowledge_cards: otherCards, open_tasks: tasks, recent_sessions: sessions, mode: 'local' };
    }

    case 'tasks': {
      let sql = 'SELECT * FROM tasks';
      const conditions = [];
      const sqlParams = [];

      if (status) {
        conditions.push('status = ?');
        sqlParams.push(status);
      } else {
        conditions.push("status = 'open'");
      }
      if (priority) {
        conditions.push('priority = ?');
        sqlParams.push(priority);
      }
      if (agent_role) {
        conditions.push('agent_role = ?');
        sqlParams.push(agent_role);
      }

      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      if (limit > 0) {
        sql += ' LIMIT ?';
        sqlParams.push(limit);
      }

      const tasks = daemon.indexer.db.prepare(sql).all(...sqlParams);
      return { tasks, total: tasks.length, mode: 'local' };
    }

    case 'knowledge': {
      let sql = 'SELECT * FROM knowledge_cards';
      const conditions = [];
      const sqlParams = [];

      if (status) {
        conditions.push('status = ?');
        sqlParams.push(status);
      } else {
        conditions.push("status = 'active'");
      }
      if (category) {
        conditions.push('category = ?');
        sqlParams.push(category);
      }

      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC LIMIT ?';
      sqlParams.push(limit);

      const cards = daemon.indexer.db.prepare(sql).all(...sqlParams);
      return { knowledge_cards: cards, total: cards.length, mode: 'local' };
    }

    case 'risks': {
      // Risks are stored as knowledge_cards with category containing 'risk' or 'pitfall'
      let sql = "SELECT * FROM knowledge_cards WHERE (category = 'pitfall' OR category = 'risk')";
      const sqlParams = [];

      if (status) {
        sql += ' AND status = ?';
        sqlParams.push(status);
      } else {
        sql += " AND status = 'active'";
      }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      sqlParams.push(limit);

      const risks = daemon.indexer.db.prepare(sql).all(...sqlParams);
      return { risks, total: risks.length, mode: 'local' };
    }

    case 'session_history': {
      let sql = 'SELECT * FROM sessions';
      const conditions = [];
      const sqlParams = [];

      if (session_id) {
        conditions.push('id = ?');
        sqlParams.push(session_id);
      }

      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY started_at DESC LIMIT ?';
      sqlParams.push(limit);

      const sessions = daemon.indexer.db.prepare(sql).all(...sqlParams);
      return { sessions, total: sessions.length, mode: 'local' };
    }

    case 'timeline': {
      // Timeline = recent memories ordered by time
      const memories = daemon.indexer.db
        .prepare(
          "SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?"
        )
        .all(limit);
      return { events: memories, total: memories.length, mode: 'local' };
    }

    case 'skills': {
      // F-032: Query dedicated skills table (not deprecated knowledge_cards category)
      let skillSql = 'SELECT * FROM skills';
      const skillParams = [];

      if (status) {
        skillSql += ' WHERE status = ?';
        skillParams.push(status);
      } else {
        skillSql += " WHERE status = 'active'";
      }

      skillSql += ' ORDER BY decay_score DESC, created_at DESC LIMIT ?';
      skillParams.push(limit);

      let skills;
      try {
        skills = daemon.indexer.db.prepare(skillSql).all(...skillParams);
      } catch {
        // Fallback to legacy knowledge_cards if skills table doesn't exist yet
        skills = daemon.indexer.db.prepare(
          "SELECT * FROM knowledge_cards WHERE category = 'skill' AND status = 'active' ORDER BY created_at DESC LIMIT ?"
        ).all(limit);
      }
      return { skills, total: skills.length, mode: 'local' };
    }

    case 'perception': {
      // Read perception signals from cache file + derive from recent knowledge
      const signals = [];
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');

      // 1. Read cached perception signals (written by awareness plugin hooks)
      try {
        const cachePath = path.join(daemon.awarenessDir, 'perception-cache.json');
        if (fs.existsSync(cachePath)) {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (Array.isArray(cached)) {
            signals.push(...cached);
          } else if (cached.signals) {
            signals.push(...cached.signals);
          }
        }
      } catch { /* no cache file */ }

      // 2. Derive staleness signals from old knowledge cards (30-day threshold, unified)
      try {
        const staleCards = daemon.indexer.db
          .prepare(
            `SELECT title, category, COALESCE(updated_at, created_at) AS last_touch
             FROM knowledge_cards
             WHERE status = 'active'
               AND COALESCE(updated_at, created_at) < datetime('now', '-30 days')
             ORDER BY last_touch ASC LIMIT 3`
          )
          .all();
        for (const card of staleCards) {
          const daysOld = card.last_touch
            ? Math.floor((Date.now() - new Date(card.last_touch).getTime()) / 86400000)
            : 30;
          signals.push({
            type: 'staleness',
            message: `⏳ Knowledge card "${card.title}" hasn't been updated in ${daysOld} days — may be outdated`,
            card_title: card.title,
            category: card.category,
            days_since_update: daysOld,
          });
        }
      } catch { /* db might not have the table */ }

      // 3. Derive pattern signals from tag co-occurrence (not just category count)
      try {
        const recentCards = daemon.indexer.db
          .prepare(
            `SELECT tags FROM knowledge_cards
             WHERE status = 'active' AND created_at > datetime('now', '-7 days')`
          )
          .all();
        const tagCounts = new Map();
        for (const row of recentCards) {
          let tags = [];
          try { tags = JSON.parse(row.tags || '[]'); } catch { /* skip */ }
          for (const t of tags) {
            if (typeof t === 'string' && t.length >= 2) {
              const k = t.toLowerCase();
              tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
            }
          }
        }
        const themes = [...tagCounts.entries()]
          .filter(([, count]) => count >= 3)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        for (const [tag, count] of themes) {
          signals.push({
            type: 'pattern',
            message: `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`,
            tag,
            count,
          });
        }
      } catch { /* db issue */ }

      return { signals, total: signals.length, mode: 'local' };
    }

    default:
      return { error: `Unknown lookup type: ${type}`, mode: 'local' };
  }
}
