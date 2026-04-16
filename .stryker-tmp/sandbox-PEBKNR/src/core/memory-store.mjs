/**
 * MemoryStore — Markdown file management for Awareness Local
 *
 * Responsibilities:
 *   - Write memories as Markdown with YAML front matter (atomic writes)
 *   - Read / parse Markdown files back to structured objects
 *   - List, filter, and update memory files
 *   - Detect unindexed files for incremental indexing
 *
 * Pure Node.js — no external dependencies.
 */
// @ts-nocheck


import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  /**
   * @param {string} rootDir - Absolute path to the project root
   */
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.memoriesDir = path.join(rootDir, '.awareness', 'memories');
    this.knowledgeDir = path.join(rootDir, '.awareness', 'knowledge');
    this.tasksDir = path.join(rootDir, '.awareness', 'tasks');
  }

  // -----------------------------------------------------------------------
  // ID generation
  // -----------------------------------------------------------------------

  /**
   * Generate a unique memory ID.
   * Format: "mem_{YYYYMMDDHHmmss}_{4-char-hex}"
   *
   * @returns {string} e.g. "mem_20260321_143022_a3f2"
   */
  generateId() {
    const now = new Date();
    const ts = formatTimestamp(now);
    const rand = crypto.randomBytes(2).toString('hex'); // 4 hex chars
    return `mem_${ts}_${rand}`;
  }

  // -----------------------------------------------------------------------
  // Filename
  // -----------------------------------------------------------------------

  /**
   * Build a human-readable filename from a memory object.
   * Format: "{YYYY-MM-DD}_{slugified-title-max-50}.md"
   *
   * Falls back to the generated id when title is missing.
   *
   * @param {object} memory - must have at least { title? | content }
   * @returns {string}
   */
  buildFilename(memory) {
    const now = new Date();
    const dateStr = formatDate(now);

    // Derive a title from explicit field, first heading, or first line
    const rawTitle =
      memory.title ||
      extractFirstHeading(memory.content) ||
      (memory.content || '').split('\n')[0] ||
      'untitled';

    const slug = slugifyTitle(rawTitle, 50);
    return `${dateStr}_${slug}.md`;
  }

  // -----------------------------------------------------------------------
  // Markdown serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize a memory into Markdown with YAML front matter.
   *
   * @param {string} id
   * @param {object} memory
   * @returns {string} Complete Markdown string
   */
  toMarkdown(id, memory) {
    const now = new Date().toISOString();

    const frontMatter = {
      id,
      type: memory.type || 'turn_summary',
      session_id: memory.session_id || null,
      agent_role: memory.agent_role || 'builder_agent',
      tags: Array.isArray(memory.tags) ? memory.tags : [],
      created_at: memory.created_at || now,
      updated_at: memory.updated_at || now,
      source: memory.source || 'manual',
      status: memory.status || 'active',
      related: Array.isArray(memory.related) ? memory.related : [],
    };

    // Sync state fields (only emit when present)
    if (memory.cloud_id) frontMatter.cloud_id = memory.cloud_id;
    if (memory.last_pushed_at) frontMatter.last_pushed_at = memory.last_pushed_at;
    if (memory.last_pulled_at) frontMatter.last_pulled_at = memory.last_pulled_at;
    if (memory.version != null) frontMatter.version = memory.version;
    if (memory.schema_version != null) frontMatter.schema_version = memory.schema_version;
    if (memory.sync_status) frontMatter.sync_status = memory.sync_status;

    const yamlLines = serializeYaml(frontMatter);
    const body = (memory.content || '').trim();

    return `---\n${yamlLines}---\n\n${body}\n`;
  }

  /**
   * Parse a Markdown string that starts with YAML front matter.
   * Returns { metadata: {...}, content: "..." }.
   *
   * @param {string} raw - Full file content
   * @returns {{ metadata: object, content: string }}
   */
  parseMarkdown(raw) {
    if (!raw || typeof raw !== 'string') {
      return { metadata: {}, content: '' };
    }

    const trimmed = raw.replace(/^\uFEFF/, ''); // strip BOM
    const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    if (!match) {
      // No front matter — treat entire content as body
      return { metadata: {}, content: trimmed.trim() };
    }

    const yamlBlock = match[1];
    const body = (match[2] || '').trim();
    const metadata = parseYaml(yamlBlock);

    // Apply sync field defaults for backward compatibility
    metadata.cloud_id = metadata.cloud_id || null;
    metadata.version = metadata.version != null ? metadata.version : 1;
    metadata.schema_version = metadata.schema_version != null ? metadata.schema_version : 1;
    metadata.sync_status = metadata.sync_status || 'pending_push';
    metadata.last_pushed_at = metadata.last_pushed_at || null;
    metadata.last_pulled_at = metadata.last_pulled_at || null;

    return { metadata, content: body };
  }

  // -----------------------------------------------------------------------
  // File I/O
  // -----------------------------------------------------------------------

  /**
   * Atomic write: write to a temporary file then rename.
   * Prevents partial writes from corrupting the target file.
   *
   * @param {string} filepath - Absolute target path
   * @param {string} content
   */
  async atomicWrite(filepath, content) {
    const dir = path.dirname(filepath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${filepath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filepath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Write a memory to disk.
   *
   * @param {object} memory - { type, content, title?, tags?, agent_role?, session_id?, source?, related? }
   * @returns {{ id: string, filepath: string }}
   */
  async write(memory) {
    const id = this.generateId();
    const filename = this.buildFilename(memory);
    const filepath = path.join(this.memoriesDir, filename);

    // Handle filename collision (unlikely but possible)
    const finalPath = await this._resolveCollision(filepath);
    const markdown = this.toMarkdown(id, memory);
    await this.atomicWrite(finalPath, markdown);

    return { id, filepath: finalPath };
  }

  /**
   * Read and parse a memory file by its id.
   * Searches the memories directory for a file whose front matter id matches.
   *
   * @param {string} id
   * @returns {{ metadata: object, content: string, filepath: string } | null}
   */
  async read(id) {
    // Fast path: scan directory for files and check front matter
    const files = this._listMdFiles(this.memoriesDir);

    for (const filepath of files) {
      try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        // Quick check before full parse — look for the id in front matter
        if (!raw.includes(id)) continue;

        const parsed = this.parseMarkdown(raw);
        if (parsed.metadata.id === id) {
          return { ...parsed, filepath };
        }
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    return null;
  }

  /**
   * Read raw file content by filepath.
   *
   * @param {string} filepath - Absolute path
   * @returns {string}
   */
  readContent(filepath) {
    return fs.readFileSync(filepath, 'utf-8');
  }

  /**
   * List memory files with optional filtering.
   *
   * @param {object} filter
   * @param {string}   [filter.type]   - Memory type to match
   * @param {string[]} [filter.tags]   - At least one tag must match
   * @param {string}   [filter.status] - Status to match
   * @returns {Array<{ metadata: object, content: string, filepath: string }>}
   */
  async list(filter = {}) {
    const files = this._listMdFiles(this.memoriesDir);
    const results = [];

    for (const filepath of files) {
      try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        const parsed = this.parseMarkdown(raw);
        const meta = parsed.metadata;

        // Apply filters
        if (filter.type && meta.type !== filter.type) continue;
        if (filter.status && meta.status !== filter.status) continue;
        if (filter.tags && Array.isArray(filter.tags) && filter.tags.length > 0) {
          const memTags = Array.isArray(meta.tags) ? meta.tags : [];
          const hasOverlap = filter.tags.some((t) => memTags.includes(t));
          if (!hasOverlap) continue;
        }

        results.push({ ...parsed, filepath });
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    // Sort by created_at descending (newest first)
    results.sort((a, b) => {
      const aDate = a.metadata.created_at || '';
      const bDate = b.metadata.created_at || '';
      return bDate.localeCompare(aDate);
    });

    return results;
  }

  /**
   * Update the status field in a memory's front matter.
   * Rewrites the file atomically.
   *
   * @param {string} id
   * @param {string} newStatus - e.g. "active", "superseded", "archived"
   * @returns {boolean} true if updated, false if not found
   */
  async updateStatus(id, newStatus) {
    const entry = await this.read(id);
    if (!entry) return false;

    const now = new Date().toISOString();
    entry.metadata.status = newStatus;
    entry.metadata.updated_at = now;

    const yamlLines = serializeYaml(entry.metadata);
    const newContent = `---\n${yamlLines}---\n\n${entry.content}\n`;
    await this.atomicWrite(entry.filepath, newContent);

    return true;
  }

  /**
   * Compare files on disk against an indexer to find unindexed files.
   *
   * @param {{ isIndexed: (filepath: string) => boolean }} indexer
   *   An object with an `isIndexed(filepath)` method.
   * @returns {Array<{ filepath: string, raw: string }>}
   */
  async getUnindexedFiles(indexer) {
    const files = this._listMdFiles(this.memoriesDir);
    const unindexed = [];

    for (const filepath of files) {
      try {
        const indexed = typeof indexer.isIndexed === 'function'
          ? indexer.isIndexed(filepath)
          : false;

        if (!indexed) {
          const raw = fs.readFileSync(filepath, 'utf-8');
          unindexed.push({ filepath, raw });
        }
      } catch {
        continue;
      }
    }

    return unindexed;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Recursively list all .md files under a directory.
   * @param {string} dir
   * @returns {string[]} Sorted array of absolute paths
   */
  _listMdFiles(dir) {
    if (!fs.existsSync(dir)) return [];

    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._listMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results.sort();
  }

  /**
   * If filepath already exists, append a numeric suffix before .md
   * @param {string} filepath
   * @returns {string}
   */
  async _resolveCollision(filepath) {
    if (!fs.existsSync(filepath)) return filepath;

    const ext = path.extname(filepath);
    const base = filepath.slice(0, -ext.length);
    let counter = 1;

    while (fs.existsSync(`${base}-${counter}${ext}`)) {
      counter++;
      if (counter > 999) {
        // Safety valve — use random suffix
        const rand = crypto.randomBytes(3).toString('hex');
        return `${base}-${rand}${ext}`;
      }
    }

    return `${base}-${counter}${ext}`;
  }
}

// ---------------------------------------------------------------------------
// Pure-function helpers (no dependencies)
// ---------------------------------------------------------------------------

/**
 * Format a Date as "YYYYMMDD_HHmmss" for IDs.
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}_${h}${mi}${s}`;
}

/**
 * Format a Date as "YYYY-MM-DD" for filenames.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Turn an arbitrary string into a filesystem-safe slug.
 * Handles CJK characters by transliterating to pinyin-like dashes.
 * Non-alphanumeric chars become hyphens; consecutive hyphens are collapsed.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function slugifyTitle(text, maxLen = 50) {
  let slug = text
    .toLowerCase()
    // Replace CJK and other non-Latin chars with hyphens
    // Keep basic Latin letters, digits, hyphens, and spaces
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    // Replace whitespace and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Replace any non-ASCII-letter/digit/hyphen with hyphen
    .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF-]/g, '-')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-|-$/g, '');

  // Truncate to maxLen, but don't cut in the middle of a multi-byte char
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen);
    // Remove trailing hyphen from truncation
    slug = slug.replace(/-$/, '');
  }

  return slug || 'untitled';
}

/**
 * Extract the first Markdown heading from content.
 * @param {string} content
 * @returns {string|null}
 */
function extractFirstHeading(content) {
  if (!content) return null;
  const match = content.match(/^#+\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Minimal YAML serializer (front matter only, no dependency)
// ---------------------------------------------------------------------------

/**
 * Serialize a flat/simple object to YAML-like lines for front matter.
 * Supports: string, number, boolean, null, arrays of scalars, Date.
 *
 * @param {object} obj
 * @returns {string} Multi-line YAML (without --- delimiters)
 */
function serializeYaml(obj) {
  const lines = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        const items = value.map((v) => yamlScalar(v)).join(', ');
        lines.push(`${key}: [${items}]`);
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Format a scalar value for inline YAML.
 * Strings that contain special chars are quoted.
 *
 * @param {*} val
 * @returns {string}
 */
function yamlScalar(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);

  const str = String(val);
  // Quote if the string contains YAML-special characters
  if (
    str === '' ||
    str.includes(':') ||
    str.includes('#') ||
    str.includes('{') ||
    str.includes('}') ||
    str.includes('[') ||
    str.includes(']') ||
    str.includes(',') ||
    str.includes('&') ||
    str.includes('*') ||
    str.includes('?') ||
    str.includes('|') ||
    str.includes('-') ||
    str.includes('<') ||
    str.includes('>') ||
    str.includes('=') ||
    str.includes('!') ||
    str.includes('%') ||
    str.includes('@') ||
    str.includes('`') ||
    str.includes('"') ||
    str.includes("'") ||
    str.includes('\n') ||
    str.startsWith(' ') ||
    str.endsWith(' ') ||
    str === 'true' ||
    str === 'false' ||
    str === 'null' ||
    str === 'yes' ||
    str === 'no'
  ) {
    // Use double quotes, escape inner double quotes and backslashes
    const escaped = str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `"${escaped}"`;
  }

  return str;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (front matter only, no dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a simple YAML block into a plain object.
 * Handles: scalars, inline arrays [a, b], quoted strings, booleans, numbers, null.
 * Does NOT handle nested objects, multi-line strings, anchors, or aliases.
 *
 * @param {string} yaml
 * @returns {object}
 */
function parseYaml(yaml) {
  const result = {};
  const lines = yaml.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Split on first colon
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let rawValue = trimmed.slice(colonIdx + 1).trim();

    // Strip inline comments (but not inside quoted strings)
    if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      const commentIdx = rawValue.indexOf(' #');
      if (commentIdx !== -1) {
        rawValue = rawValue.slice(0, commentIdx).trim();
      }
    }

    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

/**
 * Parse a single YAML value string.
 *
 * @param {string} raw
 * @returns {*}
 */
function parseYamlValue(raw) {
  if (raw === '' || raw === 'null' || raw === '~') return null;
  if (raw === 'true' || raw === 'yes') return true;
  if (raw === 'false' || raw === 'no') return false;

  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return splitYamlArray(inner).map((item) => parseYamlValue(item.trim()));
  }

  // Quoted string (double)
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  // Quoted string (single)
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  // Plain string
  return raw;
}

/**
 * Split a YAML inline array body respecting quoted strings.
 * e.g. 'jwt, "a, b", auth' → ['jwt', '"a, b"', 'auth']
 *
 * @param {string} inner
 * @returns {string[]}
 */
function splitYamlArray(inner) {
  const items = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inQuote) {
      current += ch;
      if (ch === quoteChar && inner[i - 1] !== '\\') {
        inQuote = false;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}
