// @ts-nocheck
export function estimateTokenCount(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function applyContextBudget(items, options = {}) {
  const tokenBudget = Number(options.tokenBudget) || 0;
  const minItems = Math.max(1, Number(options.minItems) || 1);
  const maxItems = Math.max(minItems, Number(options.maxItems) || items.length || 1);

  if (!Array.isArray(items) || items.length === 0 || tokenBudget <= 0) {
    return {
      items: Array.isArray(items) ? items.slice(0, maxItems) : [],
      totalTokens: 0,
      truncated: false,
    };
  }

  const selected = [];
  let totalTokens = 0;
  let truncated = false;

  for (const item of items) {
    if (selected.length >= maxItems) {
      truncated = true;
      break;
    }

    const itemTokens = getItemTokens(item);
    const fitsBudget = totalTokens + itemTokens <= tokenBudget;
    if (!fitsBudget && selected.length >= minItems) {
      truncated = true;
      break;
    }

    selected.push(item);
    totalTokens += itemTokens;
  }

  return {
    items: selected,
    totalTokens,
    truncated,
  };
}

function getItemTokens(item) {
  if (Number.isFinite(item?.tokens_est) && item.tokens_est > 0) {
    return item.tokens_est;
  }
  return estimateTokenCount(`${item?.title || ''}\n${item?.summary || item?.content || ''}`);
}
