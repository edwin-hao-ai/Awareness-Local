/**
 * Periodic maintenance timers · F-057 Phase 6.
 *
 * Moved out of daemon.mjs so the class stays focused on lifecycle +
 * request dispatch. Each class method becomes a 1-line delegation.
 */

/**
 * 24h skill-decay recalculation. Runs once at startup (after 5s defer)
 * and then on a 24h interval. Process is allowed to exit via unref().
 */
export function startSkillDecayTimer(daemon) {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setTimeout(() => runSkillDecay(daemon), 5000);
  daemon._skillDecayTimer = setInterval(
    () => runSkillDecay(daemon),
    TWENTY_FOUR_HOURS,
  );
  if (daemon._skillDecayTimer.unref) daemon._skillDecayTimer.unref();
}

/**
 * 0.7.2 · bound graph_edges growth + reclaim pages daily. Prune first,
 * then VACUUM only if we actually freed >1k rows.
 */
export function startGraphMaintenanceTimer(daemon) {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const MAX_EDGES_PER_NODE = 50;
  const run = () => {
    if (!daemon.indexer || !daemon.indexer.db) return;
    try {
      const pruned = daemon.indexer.pruneGraphEdges({
        maxPerNode: MAX_EDGES_PER_NODE,
        edgeType: 'doc_reference',
      });
      if (pruned.removed > 0) {
        console.log(`[awareness-local] graph maintenance: pruned ${pruned.removed} doc_reference edges`);
      }
      if (pruned.removed > 1000) {
        const compact = daemon.indexer.compactDb();
        if (compact.ok && compact.bytesFreed > 0) {
          const mb = (compact.bytesFreed / (1024 * 1024)).toFixed(1);
          console.log(`[awareness-local] graph maintenance: VACUUM freed ${mb} MB`);
        }
      }
    } catch (err) {
      console.warn('[awareness-local] graph maintenance failed:', err.message);
    }
  };
  setTimeout(run, 60_000);
  daemon._graphMaintenanceTimer = setInterval(run, TWENTY_FOUR_HOURS);
  if (daemon._graphMaintenanceTimer.unref) daemon._graphMaintenanceTimer.unref();
}

/**
 * Recalculate decay_score for every non-pinned skill.
 * Formula (aligned with cloud backend):
 *   baseDecay   = exp(-ln(2) * daysSince / 30)   // 30-day half-life
 *   usageBoost  = ln(usage_count + 1) / ln(20)
 *   decay_score = min(1.0, baseDecay + usageBoost)
 * Pinned skills always keep decay_score = 1.0.
 */
export function runSkillDecay(daemon) {
  if (!daemon.indexer || !daemon.indexer.db) return;
  try {
    const now = Date.now();
    const skills = daemon.indexer.db
      .prepare('SELECT id, last_used_at, usage_count, pinned FROM skills WHERE status = ?')
      .all('active');

    const update = daemon.indexer.db.prepare(
      'UPDATE skills SET decay_score = ?, updated_at = ? WHERE id = ?',
    );

    const nowISOStr = new Date(now).toISOString();
    const LN_20 = Math.log(20);
    const HALF_LIFE_DAYS = 30;
    const LAMBDA = 0.693 / HALF_LIFE_DAYS;

    const batch = daemon.indexer.db.transaction(() => {
      for (const skill of skills) {
        if (skill.pinned) {
          update.run(1.0, nowISOStr, skill.id);
          continue;
        }
        const lastUsed = skill.last_used_at
          ? new Date(skill.last_used_at).getTime()
          : now;
        const daysSince = (now - lastUsed) / (1000 * 60 * 60 * 24);
        const baseDecay = Math.exp(-LAMBDA * daysSince);
        const usageBoost = Math.log((skill.usage_count || 0) + 1) / LN_20;
        const score = Math.min(1.0, baseDecay + usageBoost);
        update.run(Math.round(score * 1000) / 1000, nowISOStr, skill.id);
      }
    });
    batch();

    if (skills.length > 0) {
      console.log(`[awareness-local] skill decay: updated ${skills.length} skills`);
    }
  } catch (err) {
    console.error('[awareness-local] skill decay error:', err.message);
  }
}
