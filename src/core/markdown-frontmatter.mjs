/**
 * markdown-frontmatter.mjs — Minimal YAML frontmatter parser/serializer.
 *
 * We keep this dependency-free (no js-yaml in this SDK; package.json keeps
 * the npm tarball small). Supports the subset we need:
 *   - scalar strings, numbers, booleans, null
 *   - flow arrays: `topic: [a, b, c]`
 *   - quoted strings with escape: `title: "Foo \"bar\""`
 *   - block scalar lines (1-level): `key: value`
 *
 * This is intentionally NOT general YAML. If a card needs richer structure,
 * embed it in the markdown body, not frontmatter.
 *
 * Round-trip rule: frontmatter we write must round-trip through our parser.
 * No fancy features.
 */

const FRONTMATTER_FENCE = /^---\s*$/;

/**
 * Serialize a JS object to a frontmatter block (with surrounding `---`).
 * Keys appear in insertion order. Values:
 *   - string -> quoted if contains : or starts with - or has leading space, else bare
 *   - number, boolean, null -> bare
 *   - array of scalars -> flow `[a, b]`
 *   - nested object -> JSON.stringify (1-line)
 *   - undefined keys -> omitted
 *
 * @param {Record<string, unknown>} obj
 * @returns {string} frontmatter block including leading and trailing fence + trailing \n
 */
export function serializeFrontmatter(obj) {
  if (!obj || typeof obj !== 'object') return '---\n---\n';
  const lines = ['---'];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    lines.push(`${key}: ${formatValue(val)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function formatValue(val) {
  if (val === null) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return '[' + val.map((v) => formatScalar(v)).join(', ') + ']';
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return formatScalar(val);
}

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'string') return String(v);
  // Quote if it contains :, #, leading -, leading/trailing space, or quotes
  const needsQuote =
    /[:#\n]/.test(v) ||
    /^-/.test(v) ||
    /^\s|\s$/.test(v) ||
    v.includes('"') ||
    v.length === 0;
  if (!needsQuote) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Parse a markdown document into { frontmatter, body }.
 * If no frontmatter fence pair is found at the top, returns { frontmatter: {}, body: source }.
 *
 * @param {string} source
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function parseDocument(source) {
  const text = String(source ?? '');
  const lines = text.split('\n');
  if (lines.length < 2 || !FRONTMATTER_FENCE.test(lines[0])) {
    return { frontmatter: {}, body: text };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: {}, body: text };
  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n');
  const frontmatter = parseFrontmatterLines(fmLines);
  // Trim a single leading blank line on body for nicer round-trip
  return { frontmatter, body: body.replace(/^\n/, '') };
}

function parseFrontmatterLines(lines) {
  const out = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    const raw = line.slice(colonIdx + 1).trim();
    out[key] = parseValue(raw);
  }
  return out;
}

function parseValue(raw) {
  if (!raw) return '';
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Flow array
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner).map((item) => parseValue(item.trim()));
  }
  // Quoted string
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  // JSON object
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// Splits flow-array contents at top-level commas, respecting quotes and brackets.
function splitFlowItems(s) {
  const out = [];
  let depth = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      buf += ch;
      if (ch === '"' && s[i - 1] !== '\\') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
