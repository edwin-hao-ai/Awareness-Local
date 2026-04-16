/**
 * wiki-generator.mjs — Generate wiki pages from graph data (zero LLM).
 *
 * Two page types:
 *   - Module pages: directory-level aggregation of files + exported symbols
 *   - Concept pages: tag-frequency aggregation of knowledge cards
 *
 * All summaries are rule-based string templates, not LLM-generated.
 */
// @ts-nocheck


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONCEPT_MIN_TAG_COUNT = 2; // minimum tag frequency to create a concept page

// ---------------------------------------------------------------------------
// Directory tree builder
// ---------------------------------------------------------------------------

/**
 * Group file nodes by their parent directory.
 *
 * @param {Array<{id: string, node_type: string, metadata: {relativePath: string}}>} fileNodes
 * @returns {Map<string, Array>}  dirPath → file nodes in that directory
 */
export function buildDirectoryTree(fileNodes) {
  const tree = new Map();

  for (const node of fileNodes) {
    const relPath = node.metadata?.relativePath;
    if (!relPath) continue;

    const dir = relPath.includes('/')
      ? relPath.substring(0, relPath.lastIndexOf('/'))
      : '.';

    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir).push(node);
  }

  return tree;
}

// ---------------------------------------------------------------------------
// Module page generator
// ---------------------------------------------------------------------------

/**
 * Generate a wiki page for a single directory module.
 *
 * @param {string} dirPath        Directory path (e.g., "src/core")
 * @param {Array}  files          File nodes in this directory
 * @param {Array}  symbols        Symbol nodes across all files
 * @param {Array}  edges          All graph edges
 * @returns {string}  Markdown content for the module page
 */
export function generateModulePage(dirPath, files, symbols, edges) {
  const lines = [`# ${dirPath}`, ''];

  if (!files.length) {
    lines.push('*No files in this module.*');
    return lines.join('\n');
  }

  // Summary line
  lines.push(`> **${files.length}** files in this module.`, '');

  // File listing with symbols
  lines.push('## Files', '');

  for (const file of files.sort((a, b) => a.title.localeCompare(b.title))) {
    const relPath = file.metadata?.relativePath || file.title;
    lines.push(`### ${file.title}`, '');

    // First line of content as description
    const desc = (file.content || '').split('\n')[0].trim();
    if (desc) lines.push(desc, '');

    // Exported symbols for this file
    const fileSymbols = symbols.filter(s =>
      s.metadata?.file === relPath && s.metadata?.exported
    );

    if (fileSymbols.length) {
      lines.push('**Exports:**', '');
      for (const sym of fileSymbols) {
        const type = sym.metadata?.symbol_type || 'unknown';
        lines.push(`- \`${sym.title}\` (${type})`);
      }
      lines.push('');
    }

    // Import edges from this file
    const imports = edges.filter(e =>
      e.from_node_id === file.id && e.edge_type === 'import'
    );

    if (imports.length) {
      lines.push('**Dependencies (import):**', '');
      for (const imp of imports) {
        const target = imp.to_node_id.replace('file:', '');
        lines.push(`- \`${target}\``);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Concept page generator
// ---------------------------------------------------------------------------

/**
 * Generate a wiki page for a concept (high-frequency tag).
 *
 * @param {string} tag            The concept tag
 * @param {Array}  taggedNodes    Nodes that have this tag
 * @returns {string}  Markdown content for the concept page
 */
export function generateConceptPage(tag, taggedNodes) {
  const lines = [`# ${tag}`, ''];

  if (!taggedNodes.length) {
    lines.push('*No related knowledge cards found.*');
    return lines.join('\n');
  }

  lines.push(`> **${taggedNodes.length}** knowledge cards related to "${tag}".`, '');

  lines.push('## Related Knowledge', '');

  for (const node of taggedNodes) {
    const tags = (node.tags || []).filter(t => t !== tag).join(', ');
    lines.push(`- **${node.title}**${tags ? ` — tags: ${tags}` : ''}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// End-to-end wiki generation
// ---------------------------------------------------------------------------

/**
 * Generate all wiki pages from graph data + knowledge cards.
 *
 * @param {Array} graphNodes    All graph_nodes
 * @param {Array} graphEdges    All graph_edges
 * @param {Array} knowledgeCards  Knowledge cards with tags
 * @returns {Array<WikiPage>}
 *
 * @typedef {object} WikiPage
 * @property {string} slug       e.g., "modules/src/core" or "concepts/graph"
 * @property {string} title
 * @property {string} content    Markdown
 * @property {'module'|'concept'} pageType
 */
export function generateWikiPages(graphNodes, graphEdges, knowledgeCards) {
  const pages = [];

  // --- Module pages (from file nodes) ---
  const fileNodes = graphNodes.filter(n => n.node_type === 'file');
  const symbolNodes = graphNodes.filter(n => n.node_type === 'symbol');
  const dirTree = buildDirectoryTree(fileNodes);

  for (const [dir, files] of dirTree) {
    const content = generateModulePage(dir, files, symbolNodes, graphEdges);
    pages.push({
      slug: `modules/${dir}`,
      title: dir,
      content,
      pageType: 'module',
    });
  }

  // --- Concept pages (from knowledge card tags) ---
  const tagCounts = new Map();
  const tagNodes = new Map();

  for (const card of knowledgeCards) {
    const tags = Array.isArray(card.tags) ? card.tags : [];
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      if (!tagNodes.has(tag)) tagNodes.set(tag, []);
      tagNodes.get(tag).push(card);
    }
  }

  for (const [tag, count] of tagCounts) {
    if (count >= CONCEPT_MIN_TAG_COUNT) {
      const nodes = tagNodes.get(tag);
      const content = generateConceptPage(tag, nodes);
      pages.push({
        slug: `concepts/${tag}`,
        title: tag,
        content,
        pageType: 'concept',
      });
    }
  }

  return pages;
}
