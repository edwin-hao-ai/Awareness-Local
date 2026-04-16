/**
 * link-discovery.mjs — Discover references between documents and code.
 *
 * Scans markdown / doc content for code identifiers (backtick names,
 * file paths, PascalCase class names) and matches them against known
 * graph_nodes to create doc_reference edges.
 *
 * Zero LLM — all matching is regex + exact/fuzzy string comparison.
 */
// @ts-nocheck


// ---------------------------------------------------------------------------
// Common words to ignore (not code references)
// ---------------------------------------------------------------------------

const IGNORE_PASCAL = new Set([
  'README', 'TODO', 'FIXME', 'NOTE', 'WARNING', 'HACK', 'XXX',
  'API', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JSON', 'XML',
  'SQL', 'CLI', 'SDK', 'CDN', 'DNS', 'SSH', 'TLS', 'SSL',
  'EOF', 'NULL', 'TRUE', 'FALSE', 'OK', 'PR', 'CI', 'CD',
  'UI', 'UX', 'ID', 'IP', 'OS', 'DB', 'AWS', 'GCP', 'PDF',
  'DOCX', 'XLSX', 'CSV', 'UTF', 'ASCII', 'NPM', 'YAML',
  'Docker', 'GitHub', 'GitLab', 'MongoDB', 'PostgreSQL', 'Redis',
  'Python', 'JavaScript', 'TypeScript', 'Markdown', 'Rust', 'Golang',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Phase', 'Table', 'Section', 'Chapter', 'Figure', 'Summary',
  'Added', 'Changed', 'Fixed', 'Removed', 'Updated', 'Created',
]);

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Backtick code: `identifier` or `obj.method()` — extract last segment
const RE_BACKTICK = /`([^`]+?)`/g;

// File paths: foo/bar.ext or ./foo/bar.ext (must have extension)
const RE_FILE_PATH = /(?:\.?\.?\/?)?(?:[\w@-]+\/)+[\w.-]+\.\w{1,10}/g;

// PascalCase identifiers: at least 2 words (e.g., WorkspaceScanner)
const RE_PASCAL = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

// ---------------------------------------------------------------------------
// Extract code references from markdown text
// ---------------------------------------------------------------------------

/**
 * Extract potential code references from markdown content.
 *
 * @param {string} markdown
 * @returns {Array<{name: string, type: 'backtick'|'path'|'pascal', line: number}>}
 */
export function extractCodeReferences(markdown) {
  if (!markdown) return [];

  const seen = new Set();
  const refs = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip code blocks (``` ... ```)
    if (line.trimStart().startsWith('```')) continue;

    // Backtick references
    for (const m of line.matchAll(RE_BACKTICK)) {
      const raw = m[1].trim();
      // Extract meaningful identifier from backtick content
      const names = extractIdentifiers(raw);
      for (const name of names) {
        if (!seen.has(name)) {
          seen.add(name);
          // Determine if it looks like a path or an identifier
          if (raw.includes('/') && raw.includes('.')) {
            refs.push({ name: raw, type: 'path', line: lineNum });
          } else {
            refs.push({ name, type: 'backtick', line: lineNum });
          }
        }
      }
    }

    // File paths (outside backticks)
    for (const m of line.matchAll(RE_FILE_PATH)) {
      const p = m[0];
      if (!seen.has(p)) {
        seen.add(p);
        refs.push({ name: p, type: 'path', line: lineNum });
      }
    }

    // PascalCase names
    for (const m of line.matchAll(RE_PASCAL)) {
      const name = m[1];
      if (!seen.has(name) && !IGNORE_PASCAL.has(name)) {
        seen.add(name);
        refs.push({ name, type: 'pascal', line: lineNum });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Match references against known graph nodes
// ---------------------------------------------------------------------------

/**
 * Match extracted references against a list of known graph_nodes.
 *
 * @param {Array<{name: string, type: string, line: number}>} refs
 * @param {Array<{id: string, node_type: string, title: string}>} knownNodes
 * @returns {Array<{targetId: string, refName: string, refType: string, confidence: number, line: number}>}
 */
export function matchReferencesToNodes(refs, knownNodes) {
  if (!refs.length || !knownNodes.length) return [];

  // Build lookup indexes
  const byTitle = new Map();     // title → node[]
  const byPathEnd = new Map();   // last path segment → node[]

  for (const node of knownNodes) {
    const title = node.title;
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(node);

    // For file nodes, also index by full path in id
    if (node.node_type === 'file') {
      const pathInId = node.id.replace('file:', '');
      if (!byPathEnd.has(pathInId)) byPathEnd.set(pathInId, []);
      byPathEnd.get(pathInId).push(node);
    }
  }

  const links = [];
  const seen = new Set(); // avoid duplicate links

  for (const ref of refs) {
    let matches = [];

    if (ref.type === 'path') {
      // Try exact path match first
      const normalized = ref.name.replace(/^\.\//, '');
      if (byPathEnd.has(normalized)) {
        for (const node of byPathEnd.get(normalized)) {
          matches.push({ node, confidence: 1.0 });
        }
      }
      // Try matching the basename
      if (!matches.length) {
        const basename = ref.name.split('/').pop();
        if (byTitle.has(basename)) {
          for (const node of byTitle.get(basename)) {
            matches.push({ node, confidence: 0.6 });
          }
        }
      }
    } else {
      // backtick or pascal: match by title
      if (byTitle.has(ref.name)) {
        for (const node of byTitle.get(ref.name)) {
          const confidence = ref.type === 'backtick' ? 0.8 : 0.7;
          matches.push({ node, confidence });
        }
      }
    }

    for (const { node, confidence } of matches) {
      const key = `${ref.name}→${node.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({
          targetId: node.id,
          refName: ref.name,
          refType: ref.type,
          confidence,
          line: ref.line,
        });
      }
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// End-to-end: markdown → links
// ---------------------------------------------------------------------------

/**
 * Discover doc→code links from markdown content.
 *
 * @param {string} markdown       Document content
 * @param {Array}  knownNodes     Known graph_nodes to match against
 * @returns {Array<{targetId, refName, refType, confidence, line}>}
 */
export function discoverLinks(markdown, knownNodes) {
  const refs = extractCodeReferences(markdown);
  return matchReferencesToNodes(refs, knownNodes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Common code file extensions — if backtick content ends with one, treat as filename. */
const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'rb', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'md', 'json', 'yaml', 'yml',
  'toml', 'sql', 'sh', 'bash', 'css', 'scss', 'html', 'vue', 'svelte',
]);

/** Noise patterns to skip in backtick extraction. */
const BACKTICK_NOISE = /^\[.*\]$|^[A-Z]{1,5}$|^\.?\.?\/?\s*$|^\d+$|^[<>!=]+$|^(true|false|null|undefined|none|nil)$/i;

/** Common non-code words that appear in backticks in docs. */
const BACKTICK_STOPWORDS = new Set([
  'env', 'Memory', 'REFERENCES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'DROP', 'ALTER', 'CREATE', 'TABLE', 'FROM', 'WHERE', 'SET', 'INTO',
  'VALUES', 'INDEX', 'COLUMN', 'PRIMARY', 'KEY', 'NOT', 'NULL',
  'DEFAULT', 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'VARCHAR', 'BOOLEAN',
  'enabled', 'disabled', 'active', 'pending', 'deleted', 'open', 'closed',
  'latest', 'default', 'public', 'private', 'main', 'master', 'origin',
]);

/**
 * Extract meaningful identifiers from a backtick string.
 * E.g., "indexer.graphInsertNode()" → ["graphInsertNode"]
 *       "convertToMarkdown" → ["convertToMarkdown"]
 *       "cloud-sync.mjs" → ["cloud-sync.mjs"]  (kept as filename)
 */
function extractIdentifiers(raw) {
  // Filter noise
  if (BACKTICK_NOISE.test(raw)) return [];
  if (raw.length < 2 || raw.length > 200) return [];
  if (BACKTICK_STOPWORDS.has(raw)) return [];
  // Skip shell commands and sentences
  if (raw.includes(' ') && raw.split(' ').length > 3) return [];
  // Skip bare extensions like ".md", ".json"
  if (/^\.\w{1,6}$/.test(raw)) return [];

  // Strip trailing ()
  const cleaned = raw.replace(/\(\)$/, '').replace(/\(.*\)$/, '');

  // If it looks like a path with /, return empty (handled by path regex)
  if (cleaned.includes('/')) return [];

  // If it has a dot, check if it's a filename (e.g., "cloud-sync.mjs")
  if (cleaned.includes('.')) {
    const ext = cleaned.split('.').pop();
    if (CODE_EXTS.has(ext)) {
      // It's a filename like "indexer.mjs" — keep whole
      return [cleaned];
    }
    // It's an object method like "indexer.graphInsertNode" — take last segment
    const parts = cleaned.split('.');
    const last = parts[parts.length - 1];
    return last && last.length >= 2 ? [last] : [];
  }

  return cleaned && cleaned.length >= 2 ? [cleaned] : [];
}
