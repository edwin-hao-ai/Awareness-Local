/**
 * topic-aggregate.mjs — Append cards to topic pages on every awareness_record.
 *
 * F-082 Phase 1. Each topic the card declares in its frontmatter triggers:
 *   - topics/<slug>.md created if absent (with skeleton)
 *   - card link appended under "## Cards"
 *   - frontmatter counter bumped
 *
 * Topics are first-class wiki nodes (§3.15.1 cross-link strategy).
 */

import {
  readMarkdownFile,
  writeMarkdownFile,
  appendToSection,
  relativeLink,
} from '../../core/wiki-link.mjs';
import { resolveTopicPath } from '../../core/markdown-tree.mjs';

/**
 * For each topic the card declares, ensure a topic page exists and the
 * card link is appended.
 *
 * @param {object} opts
 * @param {string} opts.awarenessDir
 * @param {string} opts.cardAbsPath
 * @param {{ title: string, topic?: string[], category?: string }} opts.card
 * @returns {Array<{topicSlug: string, created: boolean, changed: boolean}>}
 */
export function appendCardToTopics({ awarenessDir, cardAbsPath, card }) {
  const topics = Array.isArray(card.topic) ? card.topic.filter(Boolean) : [];
  if (topics.length === 0) return [];

  const out = [];
  for (const topicName of topics) {
    const t = resolveTopicPath(awarenessDir, topicName);
    const { frontmatter, body, existed } = readMarkdownFile(t.absPath);

    const href = relativeLink(t.absPath, cardAbsPath);
    const title = (card.title || '').trim() || '(untitled card)';
    const cat = card.category ? ` _${card.category}_` : '';
    const entry = `- [${title}](${href})${cat}`;

    const initialBody = existed
      ? body
      : buildTopicSkeleton(topicName, t.slug);

    const newBody = appendToSection(initialBody, '## Cards', entry);
    if (existed && newBody === body) {
      out.push({ topicSlug: t.slug, created: false, changed: false });
      continue;
    }

    const fm = { ...frontmatter };
    fm.id = fm.id || t.slug;
    fm.type = fm.type || 'topic';
    fm.card_count = Number(fm.card_count || 0) + (newBody === body ? 0 : 1);
    fm.last_updated = new Date().toISOString();

    writeMarkdownFile(t.absPath, fm, newBody);
    out.push({ topicSlug: t.slug, created: !existed, changed: true });
  }
  return out;
}

function buildTopicSkeleton(topicName, slug) {
  return [
    `# ${topicName}`,
    '',
    `Topic page · auto-aggregates cards tagged with \`${slug}\`. Cards arrive in the order they were recorded.`,
    '',
    '## Cards',
    '',
  ].join('\n');
}
