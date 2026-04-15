import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, loadModules } from './helpers/onboarding-env.mjs';

function load() {
  const ctx = makeSandbox();
  // Seed an existing LOCALES object mirroring index.html's runtime structure.
  ctx.LOCALES = {
    en: { 'existing.key': 'existing-en' },
    zh: { 'existing.key': 'existing-zh' },
  };
  loadModules(ctx, ['i18n.js']);
  return ctx.LOCALES;
}

test('i18n: every onboarding key exists in BOTH en and zh', () => {
  const L = load();
  const en = Object.keys(L.en).filter((k) => k.startsWith('onb.'));
  const zh = Object.keys(L.zh).filter((k) => k.startsWith('onb.'));
  const missingInZh = en.filter((k) => !(k in L.zh));
  const missingInEn = zh.filter((k) => !(k in L.en));
  assert.deepEqual(missingInZh, [], `keys in en missing in zh: ${missingInZh.join(', ')}`);
  assert.deepEqual(missingInEn, [], `keys in zh missing in en: ${missingInEn.join(', ')}`);
  assert.ok(en.length >= 40, `expected ≥40 onboarding keys, got ${en.length}`);
});

test('i18n: merge does not overwrite existing non-onboarding keys', () => {
  const L = load();
  assert.equal(L.en['existing.key'], 'existing-en');
  assert.equal(L.zh['existing.key'], 'existing-zh');
});

test('i18n: interpolation placeholders are consistent between en and zh', () => {
  const L = load();
  const extractVars = (s) => (s.match(/\{\w+\}/g) || []).sort();
  const mismatches = [];
  for (const key of Object.keys(L.en).filter((k) => k.startsWith('onb.'))) {
    const enVars = extractVars(L.en[key]);
    const zhVars = extractVars(L.zh[key] || '');
    if (enVars.join(',') !== zhVars.join(',')) {
      mismatches.push(`${key}: en=${enVars.join(',')} zh=${zhVars.join(',')}`);
    }
  }
  assert.deepEqual(mismatches, [], `interpolation var mismatch:\n${mismatches.join('\n')}`);
});

test('i18n: no empty string values (missing translation indicator)', () => {
  const L = load();
  for (const [key, val] of Object.entries(L.en)) {
    if (key.startsWith('onb.')) assert.ok(val, `empty en value for ${key}`);
  }
  for (const [key, val] of Object.entries(L.zh)) {
    if (key.startsWith('onb.')) assert.ok(val, `empty zh value for ${key}`);
  }
});

test('i18n: zh translations are actually translated (not copied from en)', () => {
  const L = load();
  // Reject if any zh value is identical to en AND contains any ASCII letter (catches lazy copies).
  // Allow identity for symbol-only strings like "→" or "🎉".
  const copies = [];
  for (const key of Object.keys(L.en).filter((k) => k.startsWith('onb.'))) {
    const enStr = L.en[key];
    const zhStr = L.zh[key];
    if (enStr === zhStr && /[a-z]{3,}/i.test(enStr)) {
      copies.push(`${key}: "${enStr}"`);
    }
  }
  assert.deepEqual(copies, [], `zh values copied verbatim from en:\n${copies.join('\n')}`);
});
