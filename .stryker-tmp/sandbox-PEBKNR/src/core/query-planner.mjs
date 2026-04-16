// @ts-nocheck
const EN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'our', 'should', 'that', 'the', 'this', 'to', 'use', 'we', 'what', 'when',
  'why', 'with', 'you', 'your',
]);

const ZH_FILLERS = ['我们', '你们', '现在', '这个', '那个', '一下', '还是', '以及'];
const ZH_GENERIC_PHRASES = [
  '这件事', '卡在哪一步了', '还缺什么', '才能继续', '不要写散文', '最推荐的', '是什么',
  '如果一个', '看起来不错', '我通常', '先用什么', '筛掉它', '的话', '优先级怎么排',
];
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
const QUERY_CONCEPT_RULES = [
  {
    patterns: [/报销|报帐|发票|收据|议程|reimburse|reimbursement|receipt|invoice|expense|agenda/i],
    anchors: ['报销', 'reimbursement', 'receipt', 'invoice', 'next step'],
  },
  {
    patterns: [/周报|客户周报|状态更新|status update|weekly report|client report/i],
    anchors: ['weekly report', 'status update', 'executive summary', 'risks', 'next steps'],
  },
  {
    patterns: [/官方|原始来源|事实类|official|primary source|factual|community/i],
    anchors: ['official docs', 'primary source', 'community references'],
  },
  {
    patterns: [/工具|采购|购买|buy tool|purchase|vendor|procurement|roi|成本/i],
    anchors: ['tool evaluation', 'total cost', 'workflow fit', 'roi'],
  },
  {
    patterns: [/酒店|出差|商务酒店|hotel|travel|meeting location|breakfast|quiet/i],
    anchors: ['business hotel', 'meeting location', 'quiet', 'breakfast'],
  },
];
const INTENT_ANCHORS = {
  continuation: ['next step', 'blocker', 'current status'],
  decision: ['decision criteria', 'decision pattern'],
  risk: ['risk', 'constraint', 'guard'],
  workflow: ['workflow', 'steps', 'procedure'],
};

export function planRecallQuery(params = {}) {
  const semanticQuery = normalizeText(params.semantic_query);
  const keywordQuery = normalizeText(params.keyword_query);
  const intent = detectIntent(semanticQuery || keywordQuery);
  const keywordHints = extractKeywordHints(semanticQuery || keywordQuery);
  const anchorTerms = buildAnchorTerms(semanticQuery || keywordQuery, intent, keywordHints);
  const alternateQueries = buildAlternateQueries(semanticQuery, keywordHints, anchorTerms);

  return {
    ...params,
    semantic_query: semanticQuery,
    keyword_query: keywordQuery,
    query_plan: {
      intent,
      keywordHints,
      anchorTerms,
      alternateQueries,
    },
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function detectIntent(query) {
  if (!query) return 'general';
  const text = query.toLowerCase();
  if (/为什么|why|原因|decision|决定/.test(text)) return 'decision';
  if (/做到哪|next step|接下来|todo|进展|continue|继续/.test(text)) return 'continuation';
  if (/风险|block|guard|问题|pitfall|错误|报错|故障/.test(text)) return 'risk';
  if (/如何|how|流程|步骤|workflow|runbook/.test(text)) return 'workflow';
  return 'general';
}

function extractKeywordHints(query) {
  if (!query) return [];

  if (CJK_RE.test(query)) {
    const segments = query
      .split(/[，。；、,.:：!?？\s]+/)
      .map((token) => normalizeCjkSegment(token))
      .flatMap((token) => expandCjkToken(token))
      .filter((token) => token.length >= 2 && !ZH_FILLERS.includes(token));

    return [...new Set(segments)].slice(0, 8);
  }

  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !EN_STOPWORDS.has(token))
    .slice(0, 6);
}

function normalizeCjkSegment(token) {
  let cleaned = token.trim();
  for (const phrase of ZH_GENERIC_PHRASES) {
    cleaned = cleaned.replaceAll(phrase, ' ');
  }

  cleaned = cleaned
    .replace(/[的了呢吗呀吧啊嘛]/g, ' ')
    .replace(/[^\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AFa-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

function expandCjkToken(token) {
  if (!token) return [];

  const parts = token.split(/\s+/).filter(Boolean);
  const expanded = [];

  for (const part of parts) {
    if (part.length >= 2) expanded.push(part);
    if (part.length >= 4) {
      for (let index = 0; index <= part.length - 2; index++) {
        const bigram = part.slice(index, index + 2);
        if (bigram.length === 2 && !ZH_FILLERS.includes(bigram)) expanded.push(bigram);
      }
    }
  }

  return expanded;
}

function buildAnchorTerms(query, intent, keywordHints) {
  const anchors = [];
  const text = String(query || '');

  for (const rule of QUERY_CONCEPT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      anchors.push(...rule.anchors);
    }
  }

  anchors.push(...(INTENT_ANCHORS[intent] || []));

  anchors.push(...keywordHints.slice(0, 4));

  return [...new Set(anchors.filter(Boolean))].slice(0, 8);
}

function buildAlternateQueries(semanticQuery, keywordHints, anchorTerms = []) {
  const alternates = [];
  if (semanticQuery) {
    alternates.push(semanticQuery.replace(/["'“”‘’]/g, '').trim());
  }
  if (keywordHints.length >= 2) {
    alternates.push(keywordHints.slice(0, 4).join(' '));
  }
  if (anchorTerms.length >= 2) {
    alternates.push(anchorTerms.slice(0, 4).join(' '));
  }
  if (anchorTerms.length >= 1) {
    alternates.push(anchorTerms[0]);
  }

  return [...new Set(alternates.filter(Boolean))].slice(0, 3);
}
