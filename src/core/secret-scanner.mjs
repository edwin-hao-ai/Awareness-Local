/**
 * secret-scanner.mjs — Local pre-publish secret/PII scanner.
 *
 * F-081 Part B. Runs locally inside the daemon BEFORE a vibe-publish draft
 * leaves the user's machine. Implements rules from
 * sdks/_shared/prompts/secret-scanner-rules.md (SSOT).
 *
 * Two tiers:
 *   - HARD hits: must redact; the resulting draft is blocked from publish
 *   - SOFT hits: allowed but flagged for reviewer
 *
 * Redaction: replace full match with `<REDACTED:<category>>`, keep a 4-char
 * prefix when applicable (e.g. `sk-a<REDACTED:anthropic_key>`).
 *
 * No external deps. Pure JS regex.
 */

/** @typedef {{ category: string, severity: 'hard'|'soft', excerpt: string, redacted: string }} ScanHit */

/** Hard-blocker rules. Order matters: first-match wins. */
const HARD_RULES = Object.freeze([
  // Anthropic / OpenAI / common LLM provider keys (most specific FIRST)
  {
    category: 'anthropic_key',
    re: /sk-ant-[A-Za-z0-9_\-]{20,}/g,
  },
  {
    category: 'openai_key',
    re: /sk-proj-[A-Za-z0-9_\-]{20,}/g,
  },
  {
    category: 'generic_sk_key',
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  // Cloud credentials
  {
    category: 'aws_access_key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    category: 'aws_temp_key',
    re: /\bASIA[0-9A-Z]{16}\b/g,
  },
  {
    category: 'google_api_key',
    re: /\bAIza[0-9A-Za-z_\-]{35}\b/g,
  },
  // GitHub tokens
  {
    category: 'github_token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    category: 'github_pat',
    re: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/g,
  },
  // Package registries
  {
    category: 'npm_token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    category: 'pypi_token',
    re: /\bpypi-AgEI[A-Za-z0-9_\-]{20,}/g,
  },
  {
    category: 'clawhub_token',
    re: /\bclh_[A-Za-z0-9_\-]{20,}\b/g,
  },
  // Slack
  {
    category: 'slack_token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // Private keys (multi-line)
  {
    category: 'private_key_block',
    re: /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA) PRIVATE KEY-----[\s\S]*?-----END \1 PRIVATE KEY-----/g,
  },
  // JWT
  {
    category: 'jwt',
    re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  },
  // DB URLs with embedded password
  {
    category: 'db_url_with_password',
    re: /\b(postgres(ql)?|mongodb(\+srv)?|redis|mysql|mariadb):\/\/[^:\s]+:[^@\s]+@[^\s)"']+/g,
  },
  // Generic secret-looking assignment (catches 'password=...', 'api_key: "..."')
  {
    category: 'generic_secret_assignment',
    re: /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi,
  },
]);

/** Soft-warning rules. */
const SOFT_RULES = Object.freeze([
  {
    category: 'email_address',
    re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
    // Skip example.com / localhost-style placeholders
    filter: (match) => !/@(example\.com|test\.com|localhost)/i.test(match),
  },
  {
    category: 'absolute_unix_path',
    re: /\/(?:Users|home)\/[A-Za-z0-9._\-]+(?:\/[^\s]*)?/g,
  },
  {
    category: 'absolute_windows_path',
    re: /[A-Z]:\\Users\\[A-Za-z0-9._\-]+(?:\\[^\s]*)?/g,
  },
  {
    category: 'public_ipv4',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    filter: (match) => {
      const parts = match.split('.').map(Number);
      if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
      const [a, b] = parts;
      // Skip RFC1918 and localhost
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 127) return false;
      if (a === 0 || a === 255) return false;
      return true;
    },
  },
  {
    category: 'internal_hostname',
    re: /\b[a-zA-Z0-9\-]+\.(?:internal|corp|lan|local)\b/g,
  },
]);

const PREFIX_KEEP = 4;

function redactMatch(match, category) {
  if (match.length <= PREFIX_KEEP * 2) {
    return `<REDACTED:${category}>`;
  }
  return `${match.slice(0, PREFIX_KEEP)}<REDACTED:${category}>`;
}

/**
 * Scan a string and return both the redacted version and the list of hits.
 *
 * @param {string} text
 * @returns {{ redacted: string, hits: ScanHit[], blocked: boolean }}
 */
export function scanText(text) {
  if (!text || typeof text !== 'string') {
    return { redacted: text || '', hits: [], blocked: false };
  }
  const hits = [];
  let redacted = text;

  // Hard rules first (in order)
  for (const rule of HARD_RULES) {
    redacted = redacted.replace(rule.re, (match) => {
      hits.push({
        category: rule.category,
        severity: 'hard',
        excerpt: clipExcerpt(match),
        redacted: redactMatch(match, rule.category),
      });
      return redactMatch(match, rule.category);
    });
  }

  // Soft rules — recorded but not redacted (reviewer sees originals)
  for (const rule of SOFT_RULES) {
    let m;
    rule.re.lastIndex = 0;
    while ((m = rule.re.exec(redacted)) !== null) {
      const match = m[0];
      if (rule.filter && !rule.filter(match)) continue;
      hits.push({
        category: rule.category,
        severity: 'soft',
        excerpt: clipExcerpt(match),
        redacted: match, // soft = not auto-redacted
      });
    }
  }

  const blocked = hits.some((h) => h.severity === 'hard');
  return { redacted, hits, blocked };
}

/**
 * Scan a structured publish-draft payload (manifest + skill_md + content).
 * Returns the same shape but with hard-blocker substrings redacted.
 *
 * @param {object} draft
 * @returns {{ draft: object, report: { blocked: boolean, hard_hits: ScanHit[], soft_hits: ScanHit[] } }}
 */
export function scanDraft(draft) {
  const out = { ...draft };
  const allHits = [];
  for (const field of ['skill_md', 'description', 'contents', 'system_prompt']) {
    if (typeof out[field] === 'string') {
      const r = scanText(out[field]);
      out[field] = r.redacted;
      allHits.push(...r.hits);
    }
  }
  // If `contents` is an array of {body} or strings, scan each
  if (Array.isArray(out.contents)) {
    out.contents = out.contents.map((c) => {
      if (typeof c === 'string') {
        const r = scanText(c);
        allHits.push(...r.hits);
        return r.redacted;
      }
      if (c && typeof c === 'object' && typeof c.body === 'string') {
        const r = scanText(c.body);
        allHits.push(...r.hits);
        return { ...c, body: r.redacted };
      }
      return c;
    });
  }
  const hard = allHits.filter((h) => h.severity === 'hard');
  const soft = allHits.filter((h) => h.severity === 'soft');
  return {
    draft: out,
    report: {
      blocked: hard.length > 0,
      hard_hits: hard,
      soft_hits: soft,
    },
  };
}

function clipExcerpt(s) {
  if (s.length <= 80) return s;
  return s.slice(0, 40) + '...' + s.slice(-30);
}
