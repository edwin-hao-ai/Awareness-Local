/**
 * Workspace Scanner — file discovery, git incremental detection,
 * and index pipeline for workspace scanning (F-038 Phase 1).
 *
 * Core capabilities:
 *   - Recursive file traversal with three-layer filtering
 *   - Git-driven incremental change detection
 *   - Batch indexing pipeline writing to graph_nodes + graph_edges
 *   - AbortController support for cancellation
 *
 * Zero LLM dependency — all processing is rule-based.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { loadGitignoreRules } from './gitignore-parser.mjs';
import { isExcludedDir, isExcludedFile, isSensitiveFile, classifyFile } from './scan-defaults.mjs';
import { loadScanConfig } from './scan-config.mjs';
import { detectLanguage } from './lang-detect.mjs';
import { extractFile } from './parsers/index.mjs';
import { convertToMarkdown, isConvertible } from './doc-converter.mjs';
import { discoverLinks } from './link-discovery.mjs';
import { generateWikiPages } from './wiki-generator.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB
const LARGE_FILE_HEAD_LINES = 50;

// ---------------------------------------------------------------------------
// Git helpers (T-007)
// ---------------------------------------------------------------------------

/**
 * Check if a directory is a git repository.
 * @param {string} projectDir
 * @returns {boolean}
 */
export function isGitRepo(projectDir) {
  return fs.existsSync(path.join(projectDir, '.git'));
}

/**
 * Get the current HEAD commit hash.
 * @param {string} projectDir
 * @returns {string|null} SHA hash or null if not a git repo / error
 */
export function getCurrentCommit(projectDir) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --name-status` output into structured changes.
 * @param {string} output - Raw git diff output
 * @returns {GitChanges}
 */
export function parseGitDiffOutput(output) {
  const changes = { added: [], modified: [], deleted: [], renamed: [] };
  if (!output || !output.trim()) return changes;

  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [status, ...paths] = line.split('\t');
    if (!status || paths.length === 0) continue;

    if (status === 'A') changes.added.push(paths[0]);
    else if (status === 'M') changes.modified.push(paths[0]);
    else if (status === 'D') changes.deleted.push(paths[0]);
    else if (status.startsWith('R')) {
      changes.renamed.push({ from: paths[0], to: paths[1] });
    }
  }
  return changes;
}

/**
 * Get file changes between two commits using git diff.
 * Returns null if git is unavailable or lastCommit is null (triggers full scan).
 *
 * @param {string} projectDir
 * @param {string|null} lastCommit
 * @returns {GitChanges|null} null means "do a full scan"
 */
export function getGitChanges(projectDir, lastCommit) {
  if (!lastCommit) return null;

  try {
    const output = execSync(
      `git diff --name-status -M ${lastCommit}..HEAD`,
      { cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return parseGitDiffOutput(output);
  } catch {
    return null; // git failure → fallback full scan
  }
}

// ---------------------------------------------------------------------------
// File traversal (T-006)
// ---------------------------------------------------------------------------

/**
 * Recursively discover scannable files in a project directory.
 *
 * Applies the full filter pipeline:
 *   1. Excluded directory blacklist
 *   2. Excluded file blacklist + patterns
 *   3. Sensitive file detection
 *   4. Gitignore rules
 *   5. User scan-config exclude patterns
 *   6. File type whitelist (category classification)
 *   7. File size limit (large files get metadata-only treatment)
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {Object} [options]
 * @param {import('./scan-config.mjs').ScanConfig} [options.config] - Scan config (loaded if not provided)
 * @param {ReturnType<import('./gitignore-parser.mjs').loadGitignoreRules>} [options.gitignore] - Gitignore filter
 * @param {AbortSignal} [options.signal] - AbortController signal for cancellation
 * @param {(count: number) => void} [options.onProgress] - Called with discovered file count
 * @returns {ScanFile[]} Array of discovered files
 */
export function scanWorkspace(projectDir, options = {}) {
  const config = options.config || loadScanConfig(projectDir);
  if (!config.enabled) return [];

  const gitignore = options.gitignore || loadGitignoreRules(projectDir, {
    extraPatterns: config.exclude,
  });

  const maxDepth = config.max_depth || 15;
  const maxFiles = config.max_total_files || 10000;
  const maxSizeBytes = (config.max_file_size_kb || 500) * 1024;

  const results = [];

  function walk(dir, depth) {
    // Check cancellation
    if (options.signal?.aborted) return;
    if (depth > maxDepth) return;
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or broken symlink
    }

    for (const entry of entries) {
      if (options.signal?.aborted) return;
      if (results.length >= maxFiles) return;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectDir, fullPath);

      if (entry.isDirectory()) {
        // Layer 1: Directory blacklist
        if (isExcludedDir(entry.name)) continue;
        // Layer 5: Gitignore
        if (gitignore.isIgnored(relativePath + '/')) continue;
        walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      // Layer 2: File blacklist
      if (isExcludedFile(entry.name)) continue;

      // Layer 3: Sensitive file detection
      if (isSensitiveFile(relativePath)) continue;

      // Layer 4: Gitignore
      if (gitignore.isIgnored(relativePath)) continue;

      // Layer 5: File type whitelist + category enable check
      const classification = classifyFile(relativePath, {
        scan_code: config.scan_code,
        scan_docs: config.scan_docs,
        scan_config: config.scan_config,
        scan_convertible: config.scan_convertible,
      });
      if (classification.excluded) continue;

      // Get file stats
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const oversized = stat.size > maxSizeBytes;

      results.push({
        absolutePath: fullPath,
        relativePath,
        category: classification.category,
        size: stat.size,
        mtime: stat.mtimeMs,
        oversized,
      });

      if (options.onProgress) {
        options.onProgress(results.length);
      }
    }
  }

  walk(projectDir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Index pipeline (T-010)
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 content hash for a file.
 * @param {string} content
 * @returns {string}
 */
function contentHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generate a deterministic node ID for a workspace file.
 * @param {string} relativePath
 * @returns {string}
 */
function fileNodeId(relativePath) {
  return 'file:' + relativePath.split(path.sep).join('/');
}

/**
 * Read file content, respecting oversized limits.
 * @param {string} absolutePath
 * @param {boolean} oversized
 * @returns {string}
 */
function readFileContent(absolutePath, oversized) {
  try {
    const raw = fs.readFileSync(absolutePath, 'utf8');
    if (oversized) {
      return raw.split('\n').slice(0, LARGE_FILE_HEAD_LINES).join('\n');
    }
    return raw;
  } catch {
    return '';
  }
}

/**
 * Extract import/require paths from file content (simple regex).
 * Works for JS/TS/Python — returns relative or package paths.
 *
 * @param {string} content
 * @param {string} category
 * @returns {string[]}
 */
function extractImports(content, category) {
  if (category !== 'code') return [];

  const imports = new Set();

  // ES modules: import ... from '...'
  const esRe = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = esRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // Dynamic import: import('...')
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // CommonJS: require('...')
  const cjsRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // Python: from X import Y / import X
  const pyFromRe = /^from\s+([\w.]+)\s+import/gm;
  while ((m = pyFromRe.exec(content)) !== null) {
    imports.add(m[1]);
  }
  const pyRe = /^import\s+([\w.]+)/gm;
  while ((m = pyRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  return [...imports];
}

/**
 * Resolve an import path to a file node ID if it's a relative import.
 * Returns null for package imports (node_modules, pip packages).
 *
 * @param {string} importPath
 * @param {string} fromRelativePath - The file doing the import
 * @param {Set<string>} knownPaths - Set of all known relativePaths
 * @returns {string|null}
 */
function resolveImportToNodeId(importPath, fromRelativePath, knownPaths) {
  // Only resolve relative imports
  if (!importPath.startsWith('.')) return null;

  const fromDir = path.dirname(fromRelativePath);
  let resolved = path.join(fromDir, importPath);
  // Normalize separators
  resolved = resolved.split(path.sep).join('/');

  // Try exact match first, then common extensions
  const extensions = ['', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.cjs', '/index.js', '/index.ts', '/index.mjs'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownPaths.has(candidate)) {
      return fileNodeId(candidate);
    }
  }
  return null;
}

/**
 * Index workspace files into graph_nodes and graph_edges.
 *
 * Processing:
 *   - Batch of BATCH_SIZE files at a time
 *   - Each file → graph_node (node_type='file')
 *   - Import statements → graph_edge (edge_type='import')
 *   - content_hash skip for unchanged files
 *   - setImmediate between batches to avoid blocking event loop
 *
 * @param {ScanFile[]} files - Files to index
 * @param {import('./indexer.mjs').Indexer} indexer - Indexer instance
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @param {(progress: {phase: string, done: number, total: number, skipped: number}) => void} [options.onProgress]
 * @returns {Promise<IndexResult>}
 */
export async function indexWorkspaceFiles(files, indexer, options = {}) {
  const result = { indexed: 0, skipped: 0, errors: 0, edges: 0 };
  if (!files.length || !indexer) return result;

  const total = files.length;

  // Build a set of known paths for import resolution
  const knownPaths = new Set(files.map(f => f.relativePath.split(path.sep).join('/')));

  // Collect import edges for second pass
  const pendingEdges = [];

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (options.signal?.aborted) break;

    const batch = files.slice(i, i + BATCH_SIZE);

    for (const file of batch) {
      if (options.signal?.aborted) break;

      try {
        const nodeId = fileNodeId(file.relativePath);
        const content = readFileContent(file.absolutePath, file.oversized);
        const hash = content ? contentHash(content) : '';

        // content_hash fast path — skip if unchanged
        const existing = indexer.getGraphNode?.(nodeId);
        if (existing && existing.content_hash === hash) {
          result.skipped++;
          continue;
        }

        // For convertible files (PDF/DOCX/Excel/CSV/TXT), auto-convert to markdown
        let nodeContent = content.slice(0, 8000); // default cap
        if (file.category === 'convertible' && isConvertible(file.relativePath)) {
          try {
            const docsDir = options.documentsDir || path.join(options.projectDir || '.', '.awareness', 'documents');
            const convResult = await convertToMarkdown(file.absolutePath, docsDir);
            if (convResult.success && !convResult.skipped && convResult.outputPath) {
              const converted = fs.readFileSync(convResult.outputPath, 'utf8');
              nodeContent = converted.slice(0, 8000);
              result.converted = (result.converted || 0) + 1;
            }
          } catch (convErr) {
            console.warn(`[workspace-scanner] convert error for ${file.relativePath}:`, convErr.message);
          }
        }

        // Insert/update graph node
        indexer.graphInsertNode({
          id: nodeId,
          node_type: file.category === 'convertible' ? 'doc' : 'file',
          title: path.basename(file.relativePath),
          content: nodeContent,
          content_hash: hash,
          metadata: {
            relativePath: file.relativePath,
            category: file.category,
            size: file.size,
            oversized: file.oversized,
          },
        });

        result.indexed++;

        // Detect language and extract symbols + imports via parser
        const firstLine = content.split('\n')[0] || '';
        const langInfo = detectLanguage(file.relativePath, firstLine);
        const language = langInfo?.language || null;

        if (language && file.category === 'code') {
          const { symbols, imports: parsedImports } = extractFile(content, language);

          // Write symbols as graph_nodes (node_type='symbol')
          for (const sym of symbols) {
            if (sym.symbol_type === 'annotation') continue; // skip TODO/FIXME for graph
            const symId = `sym:${file.relativePath}:${sym.name}:${sym.line_start}`;
            indexer.graphInsertNode({
              id: symId,
              node_type: 'symbol',
              title: sym.name,
              content: sym.signature + (sym.doc_comment ? '\n' + sym.doc_comment : ''),
              metadata: {
                symbol_type: sym.symbol_type,
                signature: sym.signature,
                line_start: sym.line_start,
                exported: sym.exported,
                language,
                file: file.relativePath,
              },
            });
            // 'contains' edge: file → symbol
            pendingEdges.push({
              from: nodeId,
              to: symId,
              edgeType: 'contains',
              importPath: null,
            });
            result.symbols = (result.symbols || 0) + 1;
          }

          // Use parser imports (more precise than old extractImports)
          for (const imp of parsedImports) {
            const targetId = resolveImportToNodeId(imp.path, file.relativePath, knownPaths);
            if (targetId) {
              pendingEdges.push({ from: nodeId, to: targetId, edgeType: 'import', importPath: imp.path });
            }
          }
        } else {
          // Fallback: old extractImports for non-code or unknown language
          const imports = extractImports(content, file.category);
          for (const imp of imports) {
            const targetId = resolveImportToNodeId(imp, file.relativePath, knownPaths);
            if (targetId) {
              pendingEdges.push({ from: nodeId, to: targetId, edgeType: 'import', importPath: imp });
            }
          }
        }
      } catch (err) {
        result.errors++;
        console.warn(`[workspace-scanner] index error for ${file.relativePath}:`, err.message);
      }
    }

    // Report progress
    if (options.onProgress) {
      options.onProgress({
        phase: 'indexing',
        done: Math.min(i + BATCH_SIZE, total),
        total,
        skipped: result.skipped,
      });
    }

    // Yield to event loop between batches
    if (i + BATCH_SIZE < total) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // Second pass: create edges (import + contains)
  for (const edge of pendingEdges) {
    if (options.signal?.aborted) break;
    try {
      const metadata = edge.importPath ? { importPath: edge.importPath } : {};
      indexer.graphInsertEdge({
        from_node_id: edge.from,
        to_node_id: edge.to,
        edge_type: edge.edgeType || 'import',
        metadata,
      });
      result.edges++;
    } catch {
      // Edge insert failures are non-critical
    }
  }

  // Third pass: doc→code link discovery for markdown/doc files
  if (!options.signal?.aborted) {
    try {
      const allNodes = indexer.db
        .prepare("SELECT id, node_type, title FROM graph_nodes WHERE status = 'active'")
        .all();
      const docFiles = files.filter(f =>
        f.category === 'docs' || f.category === 'convertible'
      );
      for (const file of docFiles) {
        const nodeId = fileNodeId(file.relativePath);
        const node = indexer.getGraphNode?.(nodeId);
        if (!node || !node.content) continue;
        const links = discoverLinks(node.content, allNodes);
        for (const link of links) {
          try {
            indexer.graphInsertEdge({
              from_node_id: nodeId,
              to_node_id: link.targetId,
              edge_type: 'doc_reference',
              weight: link.confidence,
              metadata: { refName: link.refName, refType: link.refType, line: link.line },
            });
            result.edges++;
            result.docLinks = (result.docLinks || 0) + 1;
          } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      console.warn('[workspace-scanner] link discovery error:', err.message);
    }
  }

  // Fourth pass: generate wiki pages and write to graph_nodes
  if (!options.signal?.aborted) {
    try {
      const allNodes = indexer.db
        .prepare("SELECT id, node_type, title, content, metadata FROM graph_nodes WHERE status = 'active'")
        .all()
        .map(n => ({ ...n, metadata: safeJsonParse(n.metadata) }));
      const allEdges = indexer.db
        .prepare('SELECT * FROM graph_edges')
        .all();
      // Knowledge cards from indexer (if available)
      const cards = indexer.db.prepare?.('SELECT id, title, tags FROM knowledge_cards WHERE status != ?')
        ?.all('superseded')
        ?.map(c => ({ ...c, tags: safeJsonParse(c.tags) || [] })) || [];

      const pages = generateWikiPages(allNodes, allEdges, cards);
      for (const page of pages) {
        indexer.graphInsertNode({
          id: `wiki:${page.slug}`,
          node_type: 'wiki',
          title: page.title,
          content: page.content.slice(0, 8000),
          metadata: { slug: page.slug, pageType: page.pageType },
        });
        result.wikiPages = (result.wikiPages || 0) + 1;
      }
    } catch (err) {
      console.warn('[workspace-scanner] wiki generation error:', err.message);
    }
  }

  return result;
}

/**
 * Handle deleted files: mark graph_nodes as deleted.
 *
 * @param {string[]} deletedPaths - Relative paths of deleted files
 * @param {import('./indexer.mjs').Indexer} indexer
 * @returns {number} Count of nodes marked deleted
 */
export function markDeletedFiles(deletedPaths, indexer) {
  let count = 0;
  for (const relPath of deletedPaths) {
    const nodeId = fileNodeId(relPath);
    try {
      indexer.db.prepare(`
        UPDATE graph_nodes SET status = 'deleted', updated_at = ?
        WHERE id = ? AND status != 'deleted'
      `).run(new Date().toISOString(), nodeId);
      count++;
    } catch {
      // Ignore if node doesn't exist
    }
  }
  return count;
}

/**
 * Handle renamed files: update the node ID and metadata.
 *
 * @param {Array<{from: string, to: string}>} renames
 * @param {import('./indexer.mjs').Indexer} indexer
 * @returns {number}
 */
export function handleRenamedFiles(renames, indexer) {
  let count = 0;
  for (const { from, to } of renames) {
    const oldId = fileNodeId(from);
    const newId = fileNodeId(to);
    const now = new Date().toISOString();
    try {
      // Mark old as deleted
      indexer.db.prepare(`
        UPDATE graph_nodes SET status = 'deleted', updated_at = ?
        WHERE id = ?
      `).run(now, oldId);
      count++;
    } catch {
      // Old node might not exist
    }
    // New path will be picked up as an added file
  }
  return count;
}

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ScanFile
 * @property {string} absolutePath
 * @property {string} relativePath
 * @property {'code'|'docs'|'convertible'|'config'} category
 * @property {number} size - File size in bytes
 * @property {number} mtime - Last modified timestamp (ms)
 * @property {boolean} oversized - Whether the file exceeds max size
 */

/**
 * @typedef {Object} GitChanges
 * @property {string[]} added
 * @property {string[]} modified
 * @property {string[]} deleted
 * @property {Array<{from: string, to: string}>} renamed
 */

/**
 * @typedef {Object} IndexResult
 * @property {number} indexed
 * @property {number} skipped
 * @property {number} errors
 * @property {number} edges
 * @property {number} [docLinks]
 * @property {number} [wikiPages]
 * @property {number} [converted]
 * @property {number} [symbols]
 */

/** Safe JSON parse — returns null on failure. */
function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}
