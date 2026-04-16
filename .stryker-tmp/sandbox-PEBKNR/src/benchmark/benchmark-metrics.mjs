// @ts-nocheck
export function computeRecallAtK(resultIds, goldIds, k = 5) {
  const expected = new Set(goldIds || []);
  if (expected.size === 0) return 0;
  const topK = (resultIds || []).slice(0, k);
  let hits = 0;
  for (const id of topK) {
    if (expected.has(id)) hits++;
  }
  return hits / expected.size;
}

export function computeMRR(resultIds, goldIds) {
  const expected = new Set(goldIds || []);
  if (expected.size === 0) return 0;
  for (let index = 0; index < (resultIds || []).length; index++) {
    if (expected.has(resultIds[index])) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

export function computeNdcgAtK(resultIds, goldIds, k = 5) {
  const expected = new Set(goldIds || []);
  const topK = (resultIds || []).slice(0, k);
  let dcg = 0;
  for (let index = 0; index < topK.length; index++) {
    if (expected.has(topK[index])) {
      dcg += 1 / Math.log2(index + 2);
    }
  }
  let ideal = 0;
  const idealHits = Math.min(expected.size, k);
  for (let index = 0; index < idealHits; index++) {
    ideal += 1 / Math.log2(index + 2);
  }
  if (ideal === 0) return 0;
  return dcg / ideal;
}

export function computeAnswerHitRate(answerText, expectedPoints) {
  if (!Array.isArray(expectedPoints) || expectedPoints.length === 0) return 0;
  const text = String(answerText || '').toLowerCase();
  let hits = 0;
  for (const point of expectedPoints) {
    if (text.includes(String(point || '').toLowerCase())) hits++;
  }
  return hits / expectedPoints.length;
}

export function summarizeBenchmarkResults(caseResults) {
  const rows = Array.isArray(caseResults) ? caseResults : [];
  if (rows.length === 0) {
    return {
      totalCases: 0,
      recallAt3: 0,
      recallAt5: 0,
      mrr: 0,
      ndcgAt5: 0,
      injectedTokensAvg: 0,
      answerHitRate: 0,
    };
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.recallAt3 += row.recallAt3 || 0;
      acc.recallAt5 += row.recallAt5 || 0;
      acc.mrr += row.mrr || 0;
      acc.ndcgAt5 += row.ndcgAt5 || 0;
      acc.injectedTokens += row.injectedTokens || 0;
      acc.answerHitRate += row.answerHitRate || 0;
      return acc;
    },
    { recallAt3: 0, recallAt5: 0, mrr: 0, ndcgAt5: 0, injectedTokens: 0, answerHitRate: 0 },
  );

  return {
    totalCases: rows.length,
    recallAt3: totals.recallAt3 / rows.length,
    recallAt5: totals.recallAt5 / rows.length,
    mrr: totals.mrr / rows.length,
    ndcgAt5: totals.ndcgAt5 / rows.length,
    injectedTokensAvg: totals.injectedTokens / rows.length,
    answerHitRate: totals.answerHitRate / rows.length,
  };
}
