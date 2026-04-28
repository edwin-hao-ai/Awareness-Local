/**
 * journal-append.mjs — Live-append daily journal on every awareness_record.
 *
 * F-082 Phase 2. Event-driven (NO cron). Each call to `appendCardToJournal`:
 *   - opens journal/<YYYY-MM-DD>.md (creates if absent)
 *   - appends a card link under the right category section
 *   - updates frontmatter counters
 *   - writes atomically
 *
 * Sections inside a journal day:
 *   ## Decisions
 *   ## Pitfalls
 *   ## Workflows
 *   ## Other         (catch-all for personal categories etc.)
 */

import {
  readMarkdownFile,
  writeMarkdownFile,
  appendToSection,
  relativeLink,
} from '../../core/wiki-link.mjs';
import { resolveJournalPath } from '../../core/markdown-tree.mjs';

const TECHNICAL_SECTION = {
  decision: '## Decisions',
  problem_solution: '## Pitfalls',
  pitfall: '## Pitfalls',
  workflow: '## Workflows',
  insight: '## Insights',
  key_point: '## Insights',
};

function sectionForCategory(category) {
  return TECHNICAL_SECTION[category] || '## Other';
}

function todayHeadingDate(dateISO) {
  const d = dateISO ? new Date(dateISO) : new Date();
  // Use UTC for stable cross-tz behaviour
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Append one card link to today's journal under the proper category section.
 *
 * @param {object} opts
 * @param {string} opts.awarenessDir   absolute path
 * @param {string} opts.cardAbsPath    where the card .md was written
 * @param {{ category: string, title: string, created_at?: string }} opts.card
 * @returns {{ journalPath: string, created: boolean, changed: boolean }}
 */
export function appendCardToJournal({ awarenessDir, cardAbsPath, card }) {
  const journal = resolveJournalPath(awarenessDir, card.created_at);
  const { frontmatter, body, existed } = readMarkdownFile(journal.absPath);

  const heading = sectionForCategory(card.category);
  const href = relativeLink(journal.absPath, cardAbsPath);
  const title = (card.title || '').trim() || '(untitled card)';
  const entry = `- [${title}](${href})`;

  const initialBody = existed
    ? body
    : buildJournalSkeleton(todayHeadingDate(card.created_at));

  const newBody = appendToSection(initialBody, heading, entry);
  if (existed && newBody === body) {
    return { journalPath: journal.absPath, created: false, changed: false };
  }

  // Update / init frontmatter counters
  const fm = { ...frontmatter };
  fm.id = fm.id || todayHeadingDate(card.created_at);
  fm.type = fm.type || 'journal';
  fm.card_count = Number(fm.card_count || 0) + (newBody === body ? 0 : 1);
  fm.last_updated = new Date().toISOString();

  writeMarkdownFile(journal.absPath, fm, newBody);
  return { journalPath: journal.absPath, created: !existed, changed: true };
}

function buildJournalSkeleton(ymd) {
  return [
    `# ${ymd} · Daily Journal`,
    '',
    'Auto-appended by Awareness on every `awareness_record`. Read top-down for what happened today.',
    '',
    '## Decisions',
    '',
    '## Pitfalls',
    '',
    '## Workflows',
    '',
    '## Insights',
    '',
    '## Other',
    '',
  ].join('\n');
}
