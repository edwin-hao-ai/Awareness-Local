// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { planRecallQuery } from '../src/core/query-planner.mjs';

test('planRecallQuery keeps inputs normalized and infers intent', () => {
  const result = planRecallQuery({
    semantic_query: '  我们为什么不用 prisma db push？  ',
    keyword_query: ' prisma   db push ',
  });

  assert.equal(result.semantic_query, '我们为什么不用 prisma db push？');
  assert.equal(result.keyword_query, 'prisma db push');
  assert.equal(result.query_plan.intent, 'decision');
  assert.ok(result.query_plan.alternateQueries.length >= 1);
});

test('planRecallQuery extracts keyword hints for english queries', () => {
  const result = planRecallQuery({
    semantic_query: 'How should we benchmark retrieval latency and answer quality for QMD hybrid recall?',
  });

  assert.ok(result.query_plan.keywordHints.includes('benchmark'));
  assert.ok(result.query_plan.keywordHints.includes('retrieval'));
});

test('planRecallQuery derives anchor terms for chinese paraphrase continuation queries', () => {
  const result = planRecallQuery({
    semantic_query: '报销这件事卡在哪一步了，还缺什么材料才能继续？',
  });

  assert.ok(result.query_plan.anchorTerms.includes('reimbursement'));
  assert.ok(result.query_plan.anchorTerms.includes('next step'));
  assert.match(result.query_plan.alternateQueries.join(' | '), /报销|reimbursement/);
});

test('planRecallQuery derives structure and decision anchors for chinese paraphrase queries', () => {
  const reportQuery = planRecallQuery({
    semantic_query: '客户周报不要写散文的话，最推荐的段落顺序是什么？',
  });
  const decisionQuery = planRecallQuery({
    semantic_query: '如果一个新工具看起来不错，我通常先用什么标准筛掉它？',
  });

  assert.ok(reportQuery.query_plan.anchorTerms.includes('weekly report'));
  assert.ok(reportQuery.query_plan.anchorTerms.includes('executive summary'));
  assert.ok(decisionQuery.query_plan.anchorTerms.includes('tool evaluation'));
  assert.ok(decisionQuery.query_plan.anchorTerms.includes('total cost'));
});
