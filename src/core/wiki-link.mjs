/**
 * wiki-link.mjs — bidirectional cross-link helpers for the markdown wiki.
 *
 * F-082 §3.15 strong cross-link strategy. Whenever a card asserts a forward
 * reference (topic, related card, entity), this module ensures the backlink
 * also lands on the target file. All operations are synchronous side-effects
 * of `awareness_record`; no cron, no eventual-consistency.
 *
 * The primary public function `appendBacklink` takes a target file path and
 * a label/href, then appends to a "## Related" section (creates section if
 * missing). It is idempotent — re-running with the same source is a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, serializeFrontmatter } from './markdown-frontmatter.mjs';

/**
 * Resolve a markdown link from `fromAbsPath` to `toAbsPath`. Returns the
 * relative href that would work in any markdown renderer.
 *
 * Both paths must be absolute. Returns POSIX-style separators (markdown
 * convention even on Windows).
 */
export function relativeLink(fromAbsPath, toAbsPath) {
  const fromDir = path.dirname(fromAbsPath);
  const rel = path.relative(fromDir, toAbsPath);
  return rel.split(path.sep).join('/');
}

/**
 * Read a markdown file (returning empty if missing) and return parsed result.
 */
export function readMarkdownFile(absPath) {
  if (!fs.existsSync(absPath)) {
    return { frontmatter: {}, body: '', existed: false };
  }
  const raw = fs.readFileSync(absPath, 'utf-8');
  return { ...parseDocument(raw), existed: true };
}

/**
 * Atomically write a markdown file (frontmatter + body). Creates parent dirs.
 * Atomic means: write to .tmp then rename, so a crash mid-write doesn't leave
 * a corrupt file.
 */
export function writeMarkdownFile(absPath, frontmatter, body) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const fm = serializeFrontmatter(frontmatter);
  const bodyStr = body.endsWith('\n') ? body : body + '\n';
  const content = fm + '\n' + bodyStr;
  const tmp = absPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, absPath);
}

/**
 * Ensure a section heading exists in the body and return updated body with
 * the new entry appended. Idempotent: if the entry text is already present
 * verbatim, body is returned unchanged.
 *
 * @param {string} body            current body (no frontmatter)
 * @param {string} sectionHeading  e.g. "## Related"
 * @param {string} entry           full markdown line to add (e.g. "- [foo](../cards/foo.md)")
 */
export function appendToSection(body, sectionHeading, entry) {
  const trimmed = entry.trim();
  if (!trimmed) return body;
  // Idempotent guard
  if (body.includes(trimmed)) return body;

  const lines = body.split('\n');
  const headingIdx = lines.findIndex((line) => line.trim() === sectionHeading);
  if (headingIdx === -1) {
    // No section yet — append section at end
    const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
    return body + sep + '\n' + sectionHeading + '\n\n' + entry + '\n';
  }
  // Find next heading (or EOF) to know where the section ends
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Insert entry on the line immediately before endIdx (skip trailing blanks)
  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, entry);
  return lines.join('\n');
}

/**
 * Append a backlink line to a target file's "## Related" section.
 *
 * If the target file doesn't exist yet, creates a skeleton with the given
 * frontmatter defaults and the section + backlink populated.
 *
 * @param {object} opts
 * @param {string} opts.targetAbsPath  the .md to receive the backlink
 * @param {string} opts.sectionHeading defaults to "## Related"
 * @param {string} opts.entry          markdown bullet line, e.g. "- [Card title](../cards/...)"
 * @param {Record<string, unknown>} [opts.skeletonFrontmatter] used when target doesn't exist
 * @param {string} [opts.skeletonBody] used when target doesn't exist
 */
export function appendBacklink({
  targetAbsPath,
  sectionHeading = '## Related',
  entry,
  skeletonFrontmatter,
  skeletonBody,
}) {
  const { frontmatter, body, existed } = readMarkdownFile(targetAbsPath);
  if (!existed) {
    const fm = skeletonFrontmatter || {};
    const initialBody = skeletonBody || '';
    const newBody = appendToSection(initialBody, sectionHeading, entry);
    writeMarkdownFile(targetAbsPath, fm, newBody);
    return { created: true, changed: true };
  }
  const newBody = appendToSection(body, sectionHeading, entry);
  if (newBody === body) {
    return { created: false, changed: false };
  }
  writeMarkdownFile(targetAbsPath, frontmatter, newBody);
  return { created: false, changed: true };
}
