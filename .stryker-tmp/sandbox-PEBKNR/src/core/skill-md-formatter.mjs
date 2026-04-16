/**
 * SKILL.md formatter — emits OpenClaw / Claude Code compatible markdown.
 *
 * Based on the real anthropic/claude-code plugin-dev SKILL.md spec
 * (fetched 2026-04). Rules:
 *   - Frontmatter MUST contain `name` (≤64 chars, [a-z0-9-]) and
 *     `description` (≤1024 chars, "pushy": say WHAT + WHEN). Optional
 *     fields like `version` are allowed.
 *   - Body is imperative-voice markdown; section headings are chosen
 *     per skill domain (no prescribed names). We use "When to use this
 *     skill" + "How to apply" because that matches our data shape
 *     (trigger_conditions + methods) and keeps the output ≪500 lines.
 *
 * Exports pure functions so REST + tests + future CLI reuse them.
 */
// @ts-nocheck


const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const SLUG_FALLBACK = 'skill';

/**
 * Kebab-case a skill name into a frontmatter-safe slug.
 * - lowercase
 * - [a-z0-9-]+
 * - truncated to 60 chars (under the 64 hard cap, leaves room)
 * - never empty (falls back to 'skill')
 */
export function slugify(name) {
  const raw = String(name == null ? '' : name).toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const capped = cleaned.slice(0, 60);
  return capped || SLUG_FALLBACK;
}

/**
 * Produce a pushy one-line description: starts with the summary's first
 * sentence, then appends "Use when <triggers...>." if triggers exist.
 * Caps at 1024 chars. Newlines collapsed to spaces (single-line parser).
 */
export function buildDescription(skill) {
  const summary = String(skill?.summary || '').trim();
  const triggers = Array.isArray(skill?.trigger_conditions)
    ? skill.trigger_conditions
        .map((t) => String(t?.pattern || '').trim())
        .filter(Boolean)
    : [];

  // First sentence of summary, as the primary "what it does" clause.
  const firstSentenceMatch = summary.match(/^[^.。!?！？]+[.。!?！？]?/);
  const head = (firstSentenceMatch ? firstSentenceMatch[0] : summary).trim();

  let out = head || 'No summary provided.';
  if (triggers.length > 0) {
    const joined = triggers.slice(0, 3).join('; ');
    // Avoid double-period runs.
    out = out.replace(/[.。]+$/, '') + '. Use when ' + joined + '.';
  }

  // Collapse any newlines (frontmatter parser expects single-line values).
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_DESCRIPTION_LEN) {
    out = out.slice(0, MAX_DESCRIPTION_LEN - 1).trimEnd() + '…';
  }
  return out;
}

/**
 * Build the SKILL.md body in imperative voice.
 * No "## Methods" / "## Tags" / "## Trigger Conditions" sections that
 * merely mirror the DB — those go against the official spec. Instead:
 *   - summary paragraph
 *   - "## When to use this skill" bullet list (if triggers)
 *   - "## How to apply" numbered imperative list (if methods)
 */
export function buildBody(skill) {
  const parts = [];
  const summary = String(skill?.summary || '').trim();
  const title = String(skill?.name || 'Skill').trim();
  parts.push(`# ${title}\n`);
  if (summary) parts.push(summary + '\n');

  const triggers = Array.isArray(skill?.trigger_conditions)
    ? skill.trigger_conditions
        .map((t) => String(t?.pattern || '').trim())
        .filter(Boolean)
    : [];
  if (triggers.length > 0) {
    parts.push('## When to use this skill\n');
    for (const t of triggers) parts.push(`- ${t}`);
    parts.push('');
  }

  const methods = Array.isArray(skill?.methods) ? skill.methods : [];
  if (methods.length > 0) {
    parts.push('## How to apply\n');
    methods.forEach((m, i) => {
      const step = m?.step || i + 1;
      const desc = String(m?.description || '').trim();
      const tool = m?.tool_hint ? ` (use ${m.tool_hint})` : '';
      if (desc) parts.push(`${step}. ${desc}${tool}`);
    });
    parts.push('');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Assemble the full SKILL.md document.
 */
export function buildSkillMd(skill) {
  const slug = slugify(skill?.name);
  // The `name` frontmatter value uses the slug (rules require kebab-case).
  const nameField = slug.slice(0, MAX_NAME_LEN);
  const description = buildDescription(skill);
  const frontmatter = `---\nname: ${nameField}\ndescription: ${description}\n---\n\n`;
  return { slug, content: frontmatter + buildBody(skill) };
}
