/**
 * index-update.mjs — Refresh INDEX.md and (one-shot) README.md on every record.
 *
 * F-082 Phase 3. Event-driven (NO cron). After the card + topics + journal
 * have been written, this rewrites:
 *   - INDEX.md  (always; cheap directory enumeration)
 *   - README.md (only if absent; permanent user orientation)
 *
 * INDEX content:
 *   - Top: 1-line "this folder is your memory" pointer
 *   - Topics list (sorted by card_count desc, top 30)
 *   - Recent journal entries (last 7 days)
 *   - Active skills (top 10)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  readMarkdownFile,
  writeMarkdownFile,
} from '../../core/wiki-link.mjs';
import { MARKDOWN_TREE_SUBDIRS } from '../../core/markdown-tree.mjs';

const README_FILENAME = 'README.md';
const INDEX_FILENAME = 'INDEX.md';

/**
 * @param {object} opts
 * @param {string} opts.awarenessDir
 */
export function refreshIndex({ awarenessDir }) {
  ensureReadme(awarenessDir);
  writeIndex(awarenessDir);
}

function ensureReadme(awarenessDir) {
  const p = path.join(awarenessDir, README_FILENAME);
  if (fs.existsSync(p)) return;
  const body = [
    '# Awareness Memory · Your Wiki',
    '',
    'This folder is **your memory** — a wiki of cards, topics, daily journal, ',
    'entities and facts that an AI agent has been building with you.',
    '',
    'It is **plain markdown**. You can:',
    '',
    '- Open any file in a text editor or markdown reader',
    '- Zip the whole folder to back it up or hand it to another person',
    '- `git init` here and push to a private repo for sync',
    '- Read it without our software — that is by design',
    '',
    '## Where things live',
    '',
    '| Folder | What it holds |',
    '|--------|---------------|',
    '| `INDEX.md` | This wiki\'s home page (auto-refreshed) |',
    '| `cards/YYYY/MM/` | One markdown file per knowledge card |',
    '| `topics/` | One page per topic, aggregating its cards |',
    '| `journal/` | One file per day, live-appended as the agent works |',
    '| `entities/` | Named entities (people, services, files) |',
    '| `facts/` | Bi-temporal facts (F-074) |',
    '| `skills/` | Reusable procedures the agent has learned |',
    '| `rules/` | Editorial / extraction rules the agent follows |',
    '| `action-items/` | Open and completed tasks |',
    '| `.index/` | Vector + full-text search indices (regenerable) |',
    '',
    '## Updating',
    '',
    'You can edit any markdown file by hand. The daemon will pick up your',
    'changes on its next read and re-index them.',
    '',
    '## License',
    '',
    'These files are yours. Awareness does not own them.',
    '',
  ].join('\n');
  writeMarkdownFile(p, {}, body);
}

function writeIndex(awarenessDir) {
  const p = path.join(awarenessDir, INDEX_FILENAME);
  const { frontmatter } = readMarkdownFile(p);
  const fm = {
    type: 'index',
    last_updated: new Date().toISOString(),
    ...frontmatter,
  };

  const topics = listTopics(awarenessDir).slice(0, 30);
  const journals = listRecentJournal(awarenessDir, 7);
  const skills = listSkills(awarenessDir).slice(0, 10);

  const lines = [
    '# Your Memory · Wiki Home',
    '',
    `_Auto-updated on every \`awareness_record\` call._ Last refresh: ${new Date().toISOString()}.`,
    '',
    '## Topics',
    '',
  ];

  if (topics.length === 0) {
    lines.push('_No topics yet. Topics appear here as your agent records cards with `topic: [...]` tags._');
  } else {
    for (const t of topics) {
      lines.push(`- [${t.slug}](topics/${t.slug}.md)${t.cardCount ? ` _(${t.cardCount} cards)_` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Recent journal');
  lines.push('');
  if (journals.length === 0) {
    lines.push('_No journal entries yet. The journal is auto-appended as the agent records during the day._');
  } else {
    for (const j of journals) {
      lines.push(`- [${j.date}](journal/${j.date}.md)${j.cardCount ? ` _(${j.cardCount} cards)_` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Skills');
  lines.push('');
  if (skills.length === 0) {
    lines.push('_No skills recorded yet._');
  } else {
    for (const s of skills) {
      lines.push(`- [${s.slug}](skills/${s.slug}.md)`);
    }
  }
  lines.push('');

  fm.last_updated = new Date().toISOString();
  fm.topic_count = topics.length;
  fm.journal_days = journals.length;
  fm.skill_count = skills.length;

  writeMarkdownFile(p, fm, lines.join('\n'));
}

function listTopics(awarenessDir) {
  const dir = path.join(awarenessDir, MARKDOWN_TREE_SUBDIRS.topics);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    const slug = f.replace(/\.md$/, '');
    const { frontmatter } = readMarkdownFile(full);
    out.push({ slug, cardCount: Number(frontmatter.card_count || 0) });
  }
  out.sort((a, b) => b.cardCount - a.cardCount || a.slug.localeCompare(b.slug));
  return out;
}

function listRecentJournal(awarenessDir, days) {
  const dir = path.join(awarenessDir, MARKDOWN_TREE_SUBDIRS.journal);
  if (!fs.existsSync(dir)) return [];
  const all = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, days);
  return all.map((f) => {
    const full = path.join(dir, f);
    const date = f.replace(/\.md$/, '');
    const { frontmatter } = readMarkdownFile(full);
    return { date, cardCount: Number(frontmatter.card_count || 0) };
  });
}

function listSkills(awarenessDir) {
  const dir = path.join(awarenessDir, MARKDOWN_TREE_SUBDIRS.skills);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ slug: f.replace(/\.md$/, '') }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
