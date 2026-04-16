/**
 * doc-converter.mjs — Convert documents (PDF/DOCX/Excel/CSV/TXT) to Markdown.
 *
 * Zero-LLM: all conversion is rule-based using battle-tested npm libraries.
 * Each converter returns a markdown string; the unified entry writes to outputDir.
 */
// @ts-nocheck


import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Lazy-loaded heavy deps (avoid startup cost when conversion is not needed)
// ---------------------------------------------------------------------------

let _pdfParse = null;
let _mammoth = null;
let _xlsx = null;

async function getPdfParse() {
  if (!_pdfParse) _pdfParse = (await import('pdf-parse')).default;
  return _pdfParse;
}

async function getMammoth() {
  if (!_mammoth) _mammoth = await import('mammoth');
  return _mammoth;
}

async function getXlsx() {
  if (!_xlsx) _xlsx = (await import('xlsx')).default ?? await import('xlsx');
  return _xlsx;
}

// ---------------------------------------------------------------------------
// Supported extensions
// ---------------------------------------------------------------------------

const CONVERTIBLE_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.text', '.log',
]);

/** @returns {string[]} Lowercase extensions including the dot. */
export function getSupportedConvertibleExts() {
  return [...CONVERTIBLE_EXTS];
}

/** @returns {boolean} Whether the filename has a convertible extension. */
export function isConvertible(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONVERTIBLE_EXTS.has(ext);
}

// ---------------------------------------------------------------------------
// Individual converters
// ---------------------------------------------------------------------------

/**
 * Convert PDF to markdown (one section per page).
 * @param {string} sourcePath Absolute path to PDF file
 * @returns {Promise<string>} Markdown content
 */
export async function convertPdf(sourcePath) {
  const pdfParse = await getPdfParse();
  const buf = fs.readFileSync(sourcePath);
  const data = await pdfParse(buf);
  const basename = path.basename(sourcePath);

  const lines = [
    '---',
    `source: ${basename}`,
    `type: pdf`,
    `pages: ${data.numpages}`,
    '---',
    '',
    `# ${basename}`,
    '',
  ];

  // pdf-parse returns all text concatenated; split by form-feed if present
  const pages = data.text.split('\f').filter(Boolean);
  if (pages.length > 1) {
    for (let i = 0; i < pages.length; i++) {
      lines.push(`## Page ${i + 1}`, '', pages[i].trim(), '');
    }
  } else {
    lines.push(data.text.trim());
  }

  return lines.join('\n');
}

/**
 * Convert DOCX to markdown via mammoth.
 * @param {string} sourcePath Absolute path to DOCX file
 * @returns {Promise<string>} Markdown content
 */
export async function convertDocx(sourcePath) {
  const mammoth = await getMammoth();
  const buf = fs.readFileSync(sourcePath);
  const result = await mammoth.convertToMarkdown({ buffer: buf });
  const basename = path.basename(sourcePath);

  const lines = [
    '---',
    `source: ${basename}`,
    `type: docx`,
    '---',
    '',
    `# ${basename}`,
    '',
    result.value.trim(),
  ];

  return lines.join('\n');
}

/**
 * Convert Excel (XLSX/XLS) to markdown tables (one section per sheet).
 * @param {string} sourcePath Absolute path to Excel file
 * @returns {Promise<string>} Markdown content
 */
export async function convertExcel(sourcePath) {
  const XLSX = await getXlsx();
  const wb = XLSX.readFile(sourcePath);
  const basename = path.basename(sourcePath);

  const lines = [
    '---',
    `source: ${basename}`,
    `type: excel`,
    `sheets: ${wb.SheetNames.length}`,
    '---',
    '',
    `# ${basename}`,
    '',
  ];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (rows.length === 0) continue;

    lines.push(`## ${name}`, '');
    lines.push(rowsToMarkdownTable(rows));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Convert CSV to a markdown table.
 * @param {string} sourcePath Absolute path to CSV file
 * @returns {string} Markdown content
 */
export function convertCsv(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8').trim();
  const basename = path.basename(sourcePath);
  if (!raw) {
    return `---\nsource: ${basename}\ntype: csv\n---\n\n# ${basename}\n\n*Empty file*\n`;
  }

  const rows = raw.split('\n').map(line => line.split(',').map(c => c.trim()));

  const lines = [
    '---',
    `source: ${basename}`,
    `type: csv`,
    '---',
    '',
    `# ${basename}`,
    '',
    rowsToMarkdownTable(rows),
    '',
  ];

  return lines.join('\n');
}

/**
 * Wrap plain text with frontmatter.
 * @param {string} sourcePath Absolute path to text file
 * @returns {string} Markdown content
 */
export function convertPlainText(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const basename = path.basename(sourcePath);

  return [
    '---',
    `source: ${basename}`,
    `type: text`,
    '---',
    '',
    `# ${basename}`,
    '',
    raw,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Unified entry
// ---------------------------------------------------------------------------

/**
 * Convert any supported document to markdown and write to outputDir.
 *
 * @param {string} sourcePath   Absolute path to source document
 * @param {string} outputDir    Directory to write the .md file into
 * @param {object} [options]
 * @param {string} [options.knownHash]  Skip conversion if source hash matches
 * @returns {Promise<ConvertResult>}
 *
 * @typedef {object} ConvertResult
 * @property {boolean} success
 * @property {string}  [outputPath]   Written file path
 * @property {string}  [contentHash]  SHA-256 of source file
 * @property {boolean} [skipped]      True if hash matched → no work done
 * @property {string}  [error]        Error message on failure
 */
export async function convertToMarkdown(sourcePath, outputDir, options = {}) {
  // Validate source exists
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Source file not found: ${sourcePath}` };
  }

  const ext = path.extname(sourcePath).toLowerCase();
  if (!CONVERTIBLE_EXTS.has(ext)) {
    return { success: false, error: `Unsupported extension: ${ext}` };
  }

  // Content hash for dedup
  const buf = fs.readFileSync(sourcePath);
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

  if (options.knownHash && options.knownHash === contentHash) {
    return { success: true, skipped: true, contentHash };
  }

  // Ensure outputDir exists
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    let markdown;

    switch (ext) {
      case '.pdf':
        markdown = await convertPdf(sourcePath);
        break;
      case '.docx':
        markdown = await convertDocx(sourcePath);
        break;
      case '.xlsx':
      case '.xls':
        markdown = await convertExcel(sourcePath);
        break;
      case '.csv':
        markdown = convertCsv(sourcePath);
        break;
      case '.txt':
      case '.text':
      case '.log':
        markdown = convertPlainText(sourcePath);
        break;
      default:
        return { success: false, error: `Unsupported extension: ${ext}` };
    }

    const outName = path.basename(sourcePath) + '.md';
    const outputPath = path.join(outputDir, outName);
    fs.writeFileSync(outputPath, markdown, 'utf8');

    return { success: true, outputPath, contentHash };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Batch conversion (for scanner pipeline)
// ---------------------------------------------------------------------------

/**
 * Convert multiple documents in one call. Used by workspace-scanner indexing.
 *
 * @param {Array<{absolutePath:string, relativePath:string, category:string}>} files
 * @param {string} outputDir  Directory to write .md files into
 * @param {object} [options]
 * @param {Record<string, string>} [options.hashMap]  relPath → known content hash
 * @returns {Promise<ConvertResult[]>}
 */
export async function convertDocumentsInBatch(files, outputDir, options = {}) {
  const convertible = files.filter(f => f.category === 'convertible');
  if (!convertible.length) return [];

  const results = [];
  for (const file of convertible) {
    const knownHash = options.hashMap?.[file.relativePath];
    const result = await convertToMarkdown(file.absolutePath, outputDir, { knownHash });
    results.push({ ...result, relativePath: file.relativePath });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 2D array to a markdown table string.
 * First row is treated as header.
 */
function rowsToMarkdownTable(rows) {
  if (rows.length === 0) return '';

  const header = rows[0].map(c => String(c ?? ''));
  const sep = header.map(() => '---');
  const body = rows.slice(1).map(row =>
    row.map(c => String(c ?? ''))
  );

  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...body.map(r => '| ' + r.join(' | ') + ' |'),
  ];

  return lines.join('\n');
}
