/**
 * Local write-noise filter (B-004 hardened).
 *
 * Mirrors backend narrative_filter.py logic for the Local Daemon path:
 * - Block structurally low-value events (empty, short, terse)
 * - Block system metadata (XML tags, OpenClaw context, subagent headers)
 * - Block short LLM refusal/hallucination phrases
 * - Clean XML tag blocks before length checks
 * - Preserve titled records and structured insights
 * - Language-agnostic: avoids language-specific keyword lists
 */

const MIN_CONTENT_CHARS = 20;
const MIN_MEANINGFUL_CHARS = 8;
const MAX_TERSE_TOKEN_COUNT = 2;
const MAX_TERSE_CHAR_COUNT = 12;
const REFUSAL_MAX_CHARS = 150;

// ---- B-004 Layer 1: System metadata prefixes (hard block) ------------------

// 0.7.3: every prefix is tested against BOTH the raw content and a copy
// with leading `Request:` / `Result:` / `Send:` / `Received:` wrappers
// stripped. OpenClaw plugin shoves framework metadata inside a
// `Request: <metadata>` envelope, which pre-0.7.3 slipped past every
// startsWith check. See classifyNoiseEvent() below for the match order.
const SYSTEM_METADATA_PREFIXES = [
  'Sender (untrusted metadata)',
  '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
  '[Operational context metadata',
  '[Subagent Context]',
  '[Inter-session message]',
  'A new session was started via /new or /reset',
  '[Current project directory:',
  'turn_brief',
  '[turn_brief',
  '<turn_brief',
];

// Envelope prefixes the agent framework uses to wrap one side of a turn
// around content that is otherwise system-metadata. Stripping these
// before matching SYSTEM_METADATA_PREFIXES is the single source of
// truth for the "Request: Sender (untrusted metadata)..." bug.
const ENVELOPE_PREFIX_RE = /^\s*(?:Request|Result|Send|Received|User|Assistant|Tool)\s*:\s*/i;

// ---- B-004 Layer 1: Short refusal / hallucination phrases ------------------

const REFUSAL_PHRASES = [
  'i cannot',
  "i'm unable to",
  'i am unable to',
  '无法访问',
  '系统策略不允许',
  '系统策略',
  'tool is broken',
  'runtime not ready',
  'pi-tools',
  'fundamental problem with the tooling',
  'issue with the write tool',
  'allowlist does not permit',
  'let me try a different approach',
];

// ---- B-004: XML tag block patterns (strip before content checks) -----------

const TAG_BLOCK_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi,
  /<awareness-memory>[\s\S]*?<\/awareness-memory>/gi,
  /<function_calls>[\s\S]*?<\/function_calls>/gi,
  /<invoke[^>]*>[\s\S]*?<\/invoke>/gi,
  /<parameter[^>]*>[\s\S]*?<\/parameter>/gi,
];

// Line-level drop patterns
const DROP_LINE_PATTERNS = [
  /^\s*Conversation info\s*:.*$/i,
  /^\s*Sender\s*\(untrusted metadata\)\s*:.*$/i,
  /^\s*Tool call:\s*(Read|Grep|Glob|LS|Bash)\b.*$/i,
];

// Greeting-only (single-line)
const GREETING_PATTERN = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure)[\s!.?]*$/i;

// ---- Helpers ---------------------------------------------------------------

function stripMarkdownPrefix(content) {
  return String(content || '')
    .replace(/^\*\*[^*]+\*\*\s*\n*/u, '')
    .trim();
}

function countMeaningfulChars(content) {
  const matches = String(content || '').match(/[\p{L}\p{N}]/gu);
  return matches ? matches.length : 0;
}

function countTokens(content) {
  return String(content || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .length;
}

/**
 * Strip XML tag blocks and noise lines from raw content.
 * Mirrors backend narrative_filter.clean_transcript_content().
 */
export function cleanContent(raw) {
  if (!raw) return '';
  let text = String(raw);

  // Strip XML tag blocks
  for (const pattern of TAG_BLOCK_PATTERNS) {
    text = text.replace(pattern, '');
  }

  // Line-level filtering
  const lines = text.split('\n');
  const cleaned = [];
  for (const line of lines) {
    let dropped = false;
    for (const pat of DROP_LINE_PATTERNS) {
      if (pat.test(line)) {
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      // Strip Request:/Result:/Send:/Received: prefixes
      cleaned.push(line.replace(/^\s*(?:Request|Result|Send|Received)\s*:\s*/i, ''));
    }
  }

  // Collapse 3+ blank lines into 1
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Public API ------------------------------------------------------------

export function classifyNoiseEvent(params = {}) {
  const eventType = String(params.event_type || '').trim();
  const title = String(params.title || '').trim();
  const rawContent = String(params.content || '');
  const insights = params.insights || null;
  const hasStructuredInsights = Boolean(
    insights?.knowledge_cards?.length ||
    insights?.action_items?.length ||
    insights?.risks?.length ||
    insights?.completed_tasks?.length
  );

  // --- Hard filter: session_checkpoint ---
  if (eventType === 'session_checkpoint') {
    return 'session_checkpoint filtered';
  }

  const trimmedRaw = rawContent.trim();

  if (!trimmedRaw) {
    return 'empty_content filtered';
  }

  // --- B-004 / 0.7.3: System metadata prefix — hard block ---
  // Match both the raw content and a copy with `Request:` / `Result:` /
  // similar envelope prefixes stripped, so that
  //   "Request: Sender (untrusted metadata): ..."
  // is caught even though Sender(...) is not the first non-whitespace token.
  const metaCandidates = [trimmedRaw];
  const deEnveloped = trimmedRaw.replace(ENVELOPE_PREFIX_RE, '');
  if (deEnveloped !== trimmedRaw) metaCandidates.push(deEnveloped);
  for (const candidate of metaCandidates) {
    for (const prefix of SYSTEM_METADATA_PREFIXES) {
      if (candidate.startsWith(prefix)) {
        return 'system_metadata filtered';
      }
    }
  }

  // --- B-004: Short refusal/hallucination — heuristic block ---
  if (trimmedRaw.length < REFUSAL_MAX_CHARS) {
    const lowerRaw = trimmedRaw.toLowerCase();
    for (const phrase of REFUSAL_PHRASES) {
      if (lowerRaw.includes(phrase)) {
        return 'refusal_hallucination filtered';
      }
    }
  }

  // --- Clean XML tags before structural checks ---
  const cleaned = cleanContent(rawContent);
  const strippedMd = stripMarkdownPrefix(cleaned);

  if (!strippedMd) {
    return 'empty_after_cleanup filtered';
  }

  // --- Greeting-only check ---
  const nonEmptyLines = strippedMd.split('\n').filter(l => l.trim());
  if (nonEmptyLines.length === 1 && GREETING_PATTERN.test(nonEmptyLines[0])) {
    return 'only_greeting filtered';
  }

  // --- Only tool-activity placeholders ---
  if (nonEmptyLines.every(l => l.trim().startsWith('[tool activity:'))) {
    return 'only_tool_activity filtered';
  }

  // --- Structural low-signal checks (only when no title/insights) ---
  if (!title && !hasStructuredInsights) {
    const meaningfulChars = countMeaningfulChars(strippedMd);
    const tokenCount = countTokens(strippedMd);

    if (meaningfulChars < MIN_MEANINGFUL_CHARS) {
      return 'low_signal_noise filtered';
    }

    if (tokenCount <= MAX_TERSE_TOKEN_COUNT && strippedMd.length <= MAX_TERSE_CHAR_COUNT) {
      return 'terse_noise filtered';
    }

    if (strippedMd.length < MIN_CONTENT_CHARS) {
      return 'short_noise filtered';
    }
  }

  return null;
}

export function shouldStoreMemoryEvent(params = {}) {
  return classifyNoiseEvent(params) === null;
}
