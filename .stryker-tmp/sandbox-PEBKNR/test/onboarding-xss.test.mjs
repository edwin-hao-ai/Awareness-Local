/* Verify that every render* function in steps.js HTML-escapes user-controlled input. */
// @ts-nocheck

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, loadModules, installBaseI18n } from './helpers/onboarding-env.mjs';

function makeRoot() {
  const noopEl = {
    onclick: null,
    style: {},
    dataset: {},
    addEventListener() {},
    querySelector() { return noopEl; },
    querySelectorAll() { return []; },
    set innerHTML(_) {},
    get innerHTML() { return ''; },
  };
  return {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector() { return noopEl; },
    querySelectorAll() { return []; },
  };
}

function loadSteps() {
  const ctx = makeSandbox();
  installBaseI18n(ctx, {
    en: {
      'onb.step_of': 'Step {n} of {total}', 'onb.optional': 'OPTIONAL',
      'onb.skip_step': 'Skip', 'onb.skip_finish': 'Skip finish',
      'onb.welcome.title': 'Welcome', 'onb.welcome.subtitle': 'sub',
      'onb.welcome.bullet_index': 'i', 'onb.welcome.bullet_recall': 'r',
      'onb.welcome.bullet_connect': 'c', 'onb.welcome.bullet_cloud': 'c',
      'onb.welcome.cta': 'Start', 'onb.welcome.skip_all': 'Skip all',
      'onb.scan.title': 'Scan', 'onb.scan.current_dir': 'dir',
      'onb.scan.intro': 'intro', 'onb.scan.privacy': 'priv',
      'onb.scan.cta': 'Scan now', 'onb.scan.progress': '{pct}%',
      'onb.scan.summary': '{files}/{symbols}/{wiki}',
      'onb.recall.title': 'Recall', 'onb.recall.hint': 'hint',
      'onb.recall.input_ph': 'ask', 'onb.recall.results': 'Results',
      'onb.recall.no_results': 'none', 'onb.recall.next': 'next',
      'onb.wiki.title': 'Wiki', 'onb.wiki.description': 'desc',
      'onb.wiki.view_all': '{n} pages', 'onb.wiki.next': 'next',
      'onb.wiki.empty': 'empty',
      'onb.cloud.title': 'Cloud', 'onb.cloud.intro': 'intro',
      'onb.cloud.feat_sync.title': 's', 'onb.cloud.feat_sync.desc': 's',
      'onb.cloud.feat_team.title': 't', 'onb.cloud.feat_team.desc': 't',
      'onb.cloud.feat_growth.title': 'g', 'onb.cloud.feat_growth.desc': 'g',
      'onb.cloud.feat_market.title': 'm', 'onb.cloud.feat_market.desc': 'm',
      'onb.cloud.free_tier': 'free', 'onb.cloud.cta_connect': 'Connect',
      'onb.cloud.cta_later': 'Later', 'onb.cloud.hint_settings': 'hint',
      'onb.auth.title': 'Auth', 'onb.auth.body': 'body',
      'onb.auth.code_label': 'code', 'onb.auth.pending': 'pending',
      'onb.auth.cancel': 'cancel', 'onb.auth.reopen': 'reopen',
      'onb.auth.select_title': 'select', 'onb.auth.confirm': 'confirm',
      'onb.auth.failed': 'fail',
      'onb.done.title': 'Done', 'onb.done.checked_index': 'i',
      'onb.done.checked_wiki': 'w', 'onb.done.checked_mcp': 'm',
      'onb.done.checked_cloud': 'c', 'onb.done.next_title': 'next',
      'onb.done.next_connect': 'c', 'onb.done.next_quickstart': 'q',
      'onb.done.next_community': 'c', 'onb.done.cta': 'open',
    },
  });
  loadModules(ctx, ['steps.js']);
  return ctx.AwarenessOnboardingSteps;
}

const XSS = '<script>alert(1)</script>';
const JS_URL = 'javascript:alert(1)';
// An XSS vector only fires if <tag> is UNESCAPED. Check only inside actual open tags.
function assertSafe(html, label) {
  // 1. Literal payload containing < should not survive (esc must have converted it).
  assert.ok(!html.includes('<script>alert'), `${label}: raw <script>alert executed`);
  assert.ok(!html.includes('<iframe'), `${label}: raw <iframe injected`);
  assert.ok(!html.includes('<img src=x'), `${label}: raw <img onerror injected`);
  // 2. on*= event handlers inside legitimate tags from user strings.
  //    Strip attribute values first so on*= text *inside* a value (already escaped via &quot;)
  //    is not misread as a handler on the tag itself. Our templates emit no on* attributes,
  //    so any surviving <tag ... on...= would be an injection.
  const stripped = html.replace(/="[^"]*"/g, '=""').replace(/='[^']*'/g, "=''");
  assert.ok(!/<\w+[^>]*\son\w+\s*=/i.test(stripped), `${label}: on*= handler inside a tag`);
  // 3. javascript: URL as an attribute value (not just text).
  assert.ok(!/\b(?:href|src)\s*=\s*["']?javascript:/i.test(html), `${label}: javascript: in href/src`);
}

test('XSS: renderAuthPending escapes user_code and verification_uri', () => {
  const S = loadSteps();
  const root = makeRoot();
  S.renderAuthPending(root, {
    user_code: XSS,
    verification_uri: JS_URL,
    onCancel() {}, onReopen() {},
  });
  assertSafe(root.innerHTML, 'renderAuthPending');
  // verification_uri is used as href — ensure javascript: is either escaped or present only as text
  assert.ok(!/href\s*=\s*"javascript:/i.test(root.innerHTML), 'javascript: URL ended up as href');
});

test('XSS: renderMemorySelect escapes memory name and id', () => {
  const S = loadSteps();
  const root = makeRoot();
  S.renderMemorySelect(root, {
    memories: [{ id: '"/><img src=x onerror=alert(1)>', name: XSS }],
    onCancel() {}, onConfirm() {},
  });
  assertSafe(root.innerHTML, 'renderMemorySelect');
});

test('XSS: renderRecall escapes suggestion strings', async () => {
  const S = loadSteps();
  const root = makeRoot();
  await S.renderRecall(root, {
    onNext() {}, onSkipStep() {},
    getSuggestions: async () => [XSS, '"><b>b</b>'],
    runRecall: async () => [],
  });
  assertSafe(root.innerHTML, 'renderRecall');
});

test('XSS: renderWiki escapes page titles and descriptions', async () => {
  const S = loadSteps();
  const root = makeRoot();
  await S.renderWiki(root, {
    onNext() {}, onSkipStep() {},
    getWikiSummary: async () => ({
      total: 1,
      samples: [{ title: XSS, description: '<iframe src=x>' }],
    }),
  });
  assertSafe(root.innerHTML, 'renderWiki');
});

test('XSS: renderScan escapes project dir', async () => {
  const S = loadSteps();
  const root = makeRoot();
  await S.renderScan(root, {
    onNext() {}, onSkipStep() {},
    getProjectDir: async () => XSS,
    triggerScan: async () => ({ files: 1, symbols: 1, wiki: 1 }),
  });
  assertSafe(root.innerHTML, 'renderScan');
});
