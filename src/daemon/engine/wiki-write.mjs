/**
 * wiki-write.mjs — Single entry point used by submit-insights to perform
 * all markdown-tree side effects of one card insertion.
 *
 * F-082 stitches together: card file write → topic aggregation → journal append
 * → INDEX refresh. ALL synchronous on the awareness_record call (no cron).
 *
 * Failure isolation: if any individual side-effect throws, the others still
 * run and we return a list of warnings. The caller (submit-insights) treats
 * markdown writes as best-effort additive — the canonical SQLite write must
 * never be blocked by markdown failures.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveCardPath } from '../../core/markdown-tree.mjs';
import {
  writeMarkdownFile,
  appendBacklink,
  relativeLink,
} from '../../core/wiki-link.mjs';
import { appendCardToTopics } from './topic-aggregate.mjs';
import { appendCardToJournal } from './journal-append.mjs';
import { refreshIndex } from './index-update.mjs';

/**
 * Card object produced by the host-LLM extraction pipeline.
 *
 * @typedef {object} CardLike
 * @property {string} id
 * @property {string} category
 * @property {string} title
 * @property {string} [summary]
 * @property {string[]} [topic]      — F-082 Phase 1 (optional)
 * @property {string[]} [entities]   — list of entity names (optional)
 * @property {string[]} [related]    — list of card slugs / ids to bidi-link (optional)
 * @property {number}   [confidence]
 * @property {string}   [status]
 * @property {string}   [created_at]
 * @property {string[]} [tags]
 */

/**
 * Write a single card to the wiki tree, plus all derived side-effects.
 *
 * @param {object} opts
 * @param {string} opts.awarenessDir
 * @param {CardLike} opts.card
 * @returns {{ cardAbsPath: string, slug: string, warnings: string[] }}
 */
export function writeCardToWiki({ awarenessDir, card }) {
  const warnings = [];

  // 1. Resolve canonical path
  const { absPath, slug } = resolveCardPath(awarenessDir, card);

  // 2. Build frontmatter + body
  const fm = {
    id: card.id || slug,
    type: 'knowledge_card',
    category: card.category || 'insight',
    title: card.title || '',
    topic: Array.isArray(card.topic) ? card.topic : [],
    entities: Array.isArray(card.entities) ? card.entities : [],
    related: Array.isArray(card.related) ? card.related : [],
    tags: Array.isArray(card.tags) ? card.tags : [],
    confidence: card.confidence ?? 0.8,
    status: card.status || 'live',
    created: card.created_at || new Date().toISOString(),
  };
  const body = renderCardBody(card);

  // 3. Atomic file write
  try {
    writeMarkdownFile(absPath, fm, body);
  } catch (e) {
    warnings.push(`card write failed: ${e.message}`);
    // Fatal for this side-effect — return early so we don't try to backlink
    // into a non-existent file.
    return { cardAbsPath: absPath, slug, warnings };
  }

  // 4. Topic aggregation (Phase 1)
  try {
    appendCardToTopics({ awarenessDir, cardAbsPath: absPath, card });
  } catch (e) {
    warnings.push(`topic aggregate failed: ${e.message}`);
  }

  // 5. Journal live-append (Phase 2)
  try {
    appendCardToJournal({ awarenessDir, cardAbsPath: absPath, card });
  } catch (e) {
    warnings.push(`journal append failed: ${e.message}`);
  }

  // 6. Bidirectional related-card links
  if (Array.isArray(card.related) && card.related.length > 0) {
    for (const otherSlug of card.related) {
      try {
        const otherPath = resolveCardPathFromSlug(awarenessDir, otherSlug);
        if (otherPath) {
          const href = relativeLink(otherPath, absPath);
          appendBacklink({
            targetAbsPath: otherPath,
            entry: `- [${card.title || slug}](${href})`,
            skeletonFrontmatter: { id: otherSlug, type: 'knowledge_card', placeholder: true },
            skeletonBody: `# ${otherSlug}\n\n_Placeholder — created as a backlink target. Will be filled in when the real card is recorded._\n`,
          });
        }
      } catch (e) {
        warnings.push(`related backlink failed for ${otherSlug}: ${e.message}`);
      }
    }
  }

  // 7. INDEX.md refresh (Phase 3)
  try {
    refreshIndex({ awarenessDir });
  } catch (e) {
    warnings.push(`index refresh failed: ${e.message}`);
  }

  return { cardAbsPath: absPath, slug, warnings };
}

function renderCardBody(card) {
  const lines = [];
  lines.push(`# ${card.title || '(untitled)'}`);
  lines.push('');
  if (card.summary) {
    // Body MUST start with a self-contained 1-2 sentence summary (§3.16 #2)
    lines.push(card.summary);
    lines.push('');
  }
  if (Array.isArray(card.topic) && card.topic.length) {
    lines.push(`**Topics**: ${card.topic.map((t) => `[${t}](../../../topics/${t}.md)`).join(' · ')}`);
    lines.push('');
  }
  if (Array.isArray(card.entities) && card.entities.length) {
    lines.push(`**Entities**: ${card.entities.map((e) => `[${e}](../../../entities/${e}.md)`).join(' · ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Resolve a card's path from its slug. Searches under cards/ recursively.
 * Returns null if not found (caller can choose to create skeleton).
 */
function resolveCardPathFromSlug(awarenessDir, slug) {
  if (!slug || typeof slug !== 'string') return null;
  const cardsRoot = path.join(awarenessDir, 'cards');
  if (!fs.existsSync(cardsRoot)) return null;
  // Walk year/month dirs
  for (const year of fs.readdirSync(cardsRoot)) {
    const yDir = path.join(cardsRoot, year);
    if (!fs.statSync(yDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yDir)) {
      const mDir = path.join(yDir, month);
      if (!fs.statSync(mDir).isDirectory()) continue;
      const candidate = path.join(mDir, `${slug}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // Not found. Return a synthetic path so a skeleton can be created.
  // Place under cards/<current-year>/<current-month>/<slug>.md
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(cardsRoot, y, m, `${slug}.md`);
}
