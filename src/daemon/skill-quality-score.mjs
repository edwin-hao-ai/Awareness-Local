#!/usr/bin/env node
/**
 * skill-quality-score.mjs
 *
 * 8-dimension rubric scorer inspired by Hermes agent SKILL.md structure
 * (When-to-Use / Quick-Reference / Procedure / Pitfalls / Verification)
 * + WebXSkill's "grounded execution + step-level guidance" principle.
 *
 * Each dimension is 0-5; total is /40. A "pass" skill needs 28+/40.
 *
 * Usage:
 *   node scripts/skill-quality-score.mjs           # score all skills in daemon
 *   node scripts/skill-quality-score.mjs --fixtures # score fixture file
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUBRIC = [
  {
    key: 'whenToUse',
    title: 'When-to-Use clarity (trigger_conditions)',
    score: (s) => {
      const tc = s.trigger_conditions || [];
      if (!Array.isArray(tc) || tc.length === 0) return 0;
      const distinct = new Set(tc.map((t) => (t.pattern || '').toLowerCase().trim())).size;
      const avgLen = tc.reduce((a, t) => a + (t.pattern || '').length, 0) / tc.length;
      if (tc.length >= 3 && distinct === tc.length && avgLen >= 15) return 5;
      if (tc.length >= 2 && avgLen >= 10) return 3;
      if (tc.length >= 1 && avgLen >= 5) return 2;
      return 1;
    },
  },
  {
    key: 'summaryQuality',
    title: 'Summary / Quick Reference (length, "why", markdown)',
    score: (s) => {
      const sum = s.summary || '';
      if (sum.length < 30) return 0;
      const hasWhy = /\bwhy\b|because|\*\*Why\*\*|pitfall/i.test(sum);
      const hasMarkdown = /`[^`]+`|\*\*[^*]+\*\*/.test(sum);
      if (sum.length >= 150 && hasWhy && hasMarkdown) return 5;
      if (sum.length >= 100 && (hasWhy || hasMarkdown)) return 4;
      if (sum.length >= 80) return 3;
      if (sum.length >= 50) return 2;
      return 1;
    },
  },
  {
    key: 'stepCount',
    title: 'Procedure — step count ≥ 3',
    score: (s) => {
      const m = s.methods || [];
      if (m.length === 0) return 0;
      if (m.length >= 4) return 5;
      if (m.length === 3) return 4;
      if (m.length === 2) return 2;
      return 1;
    },
  },
  {
    key: 'stepExecutability',
    title: 'Each step is executable (named command / file / check)',
    score: (s) => {
      const m = s.methods || [];
      if (m.length === 0) return 0;
      const executable = m.filter((step) => {
        const d = String(step.description || '');
        if (d.length < 30) return false;
        const hasCommand = /`[^`]+`|npm |npx |git |curl |ssh |docker /.test(d);
        const hasFile = /\.mjs|\.ts|\.tsx|\.py|\.json|\.md|\.sql|\.sh|\.html|\/|@[\w-]+\/[\w-]+/.test(d);
        const hasCheck = /verify|assert|confirm|expect|must |should /i.test(d);
        return (hasCommand || hasFile) && d.length >= 50;
      });
      const ratio = executable.length / m.length;
      if (ratio >= 1 && m.length >= 3) return 5;
      if (ratio >= 0.75) return 4;
      if (ratio >= 0.5) return 3;
      if (ratio > 0) return 2;
      return 0;
    },
  },
  {
    key: 'pitfalls',
    title: 'Pitfalls / gotchas mentioned',
    score: (s) => {
      // Dedicated pitfalls[] array (emitted by the updated SSOT prompt) is
      // the primary signal — text-search over summary/methods is a fallback
      // for older skills that predate the array field.
      const dedicatedPitfalls = Array.isArray(s.pitfalls) ? s.pitfalls.filter(Boolean) : [];
      if (dedicatedPitfalls.length >= 2 && dedicatedPitfalls.every((p) => String(p).length >= 20)) return 5;
      if (dedicatedPitfalls.length >= 1 && String(dedicatedPitfalls[0]).length >= 20) return 4;

      const text = [s.summary, ...(s.methods || []).map((m) => m.description)].join(' ');
      const pitfalls = /pitfall|gotcha|warning|must not|do not|never |careful|watch out|avoid|bypass|reject|prevent|fail\b/i;
      const reason = /because|why|\bif\b.*\bthen\b|otherwise/i;
      if (pitfalls.test(text) && reason.test(text)) return 3;
      if (pitfalls.test(text)) return 2;
      if (reason.test(text)) return 1;
      return 0;
    },
  },
  {
    key: 'verification',
    title: 'Verification step present',
    score: (s) => {
      // Dedicated verification[] array (from updated SSOT prompt) is primary.
      const dedicatedVerify = Array.isArray(s.verification) ? s.verification.filter(Boolean) : [];
      if (dedicatedVerify.length >= 1 && String(dedicatedVerify[0]).length >= 20) return 5;

      const lastSteps = (s.methods || []).slice(-2).map((m) => String(m.description || ''));
      const verifPat = /verify|assert|confirm|expect|must print|should return|healthy|status 200|exit 0/i;
      if (lastSteps.some((d) => verifPat.test(d))) return 5;
      const anyStep = (s.methods || []).some((m) => verifPat.test(String(m.description || '')));
      if (anyStep) return 3;
      return 0;
    },
  },
  {
    key: 'grepTitle',
    title: 'Grep-friendly title (R6 — specific verbs/numbers/files)',
    score: (s) => {
      const t = String(s.name || '');
      if (t.length < 8) return 0;
      const hasSpecific = /[·@\-$\/]|\d|\bto\b|\bfrom\b|[A-Z]{2,}|@\w/.test(t);
      const vague = /^(handle|do|process|work|manage|check) /i.test(t);
      if (vague) return 1;
      if (hasSpecific && t.length >= 20) return 5;
      if (hasSpecific) return 4;
      if (t.length >= 25) return 3;
      return 2;
    },
  },
  {
    key: 'topicTags',
    title: 'Topic-specific tags (R7 — no "general"/"misc"/"note")',
    score: (s) => {
      const tags = Array.isArray(s.tags) ? s.tags : [];
      if (tags.length === 0) return 0;
      const generic = new Set(['general', 'misc', 'note', 'other', 'stuff', 'thing', 'test', 'debug', 'data']);
      const goodTags = tags.filter((t) => {
        const tag = String(t).toLowerCase();
        return !generic.has(tag) && tag.length >= 3;
      });
      if (goodTags.length >= 5) return 5;
      if (goodTags.length >= 3) return 4;
      if (goodTags.length >= 2) return 3;
      if (goodTags.length >= 1) return 2;
      return 0;
    },
  },
];

export function scoreSkill(skill) {
  const scores = {};
  let total = 0;
  for (const dim of RUBRIC) {
    const s = dim.score(skill);
    scores[dim.key] = s;
    total += s;
  }
  return { total, scores, passed: total >= 28 };
}

export function formatReport(named) {
  const lines = [];
  lines.push('skill,total_40,when_to_use,summary,steps,executable,pitfalls,verify,grep_title,topic_tags,pass');
  for (const { name, score } of named) {
    const s = score.scores;
    lines.push([
      JSON.stringify(name).slice(0, 60),
      score.total,
      s.whenToUse, s.summaryQuality, s.stepCount, s.stepExecutability,
      s.pitfalls, s.verification, s.grepTitle, s.topicTags,
      score.passed ? 'YES' : 'no',
    ].join(','));
  }
  return lines.join('\n');
}

// NOTE — the CLI entry below is retained ONLY in scripts/skill-quality-score.mjs
// (the dev-facing copy). This src/daemon/ copy is library-only so the npm
// package doesn't need scripts/ files at runtime.
// CLI entry guarded by always-false so it cannot accidentally run from here.
if (false && import.meta.url === `file://${process.argv[1]}`) {
  const useFixtures = process.argv.includes('--fixtures');
  const scored = [];

  if (useFixtures) {
    const { SKILL_FIXTURES } = await import('../test/fixtures/skill-quality-fixtures.mjs');
    for (const fx of SKILL_FIXTURES) {
      scored.push({ name: fx.name, score: scoreSkill(fx) });
    }
  } else {
    // Read from live daemon via MCP
    const res = await fetch('http://localhost:37800/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'awareness_lookup', arguments: { type: 'skills', limit: 100 } },
      }),
    });
    const body = await res.json();
    const txt = body?.result?.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(txt);
    const skills = (parsed.skills || []).map((row) => ({
      name: row.name,
      summary: row.summary || '',
      methods: tryParse(row.methods) || [],
      trigger_conditions: tryParse(row.trigger_conditions) || [],
      tags: tryParse(row.tags) || [],
    }));
    for (const s of skills) scored.push({ name: s.name, score: scoreSkill(s) });
  }

  console.log(formatReport(scored));
  const passes = scored.filter((s) => s.score.passed).length;
  console.log(`\n# summary: ${passes}/${scored.length} pass (≥28/40)`);
  console.log(`# avg total: ${(scored.reduce((a, s) => a + s.score.total, 0) / (scored.length || 1)).toFixed(1)}/40`);

  function tryParse(v) {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return null; }
  }
}
