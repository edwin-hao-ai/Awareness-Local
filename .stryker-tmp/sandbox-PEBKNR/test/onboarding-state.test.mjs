// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, makeLocalStorage, loadModules } from './helpers/onboarding-env.mjs';

function load(ls) {
  const ctx = makeSandbox({ localStorage: ls });
  loadModules(ctx, ['state.js']);
  return ctx.AwarenessOnboardingState;
}
const eq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

test('State: fresh install → shouldAutoLaunch=true, currentStep=1', () => {
  const S = load();
  assert.equal(S.isCompleted(), false);
  assert.equal(S.shouldAutoLaunch(), true);
  assert.equal(S.currentStep(), 1);
  eq(S.skippedSteps(), []);
});

test('State: markCompleted → shouldAutoLaunch=false, step key cleared', () => {
  const ls = makeLocalStorage();
  const S = load(ls);
  S.setStep(3);
  S.markCompleted();
  assert.equal(S.isCompleted(), true);
  assert.equal(S.shouldAutoLaunch(), false);
  assert.equal(ls._dump().awareness_onboarding_step, undefined);
  assert.ok(ls._dump().awareness_onboarding_completed_at);
});

test('State: reset wipes all three keys', () => {
  const ls = makeLocalStorage();
  const S = load(ls);
  S.setStep(4);
  S.skipStep(2);
  S.markCompleted();
  S.reset();
  eq(ls._dump(), {});
  assert.equal(S.shouldAutoLaunch(), true);
});

test('State: setStep persists, currentStep reads back', () => {
  const S = load();
  S.setStep(5);
  assert.equal(S.currentStep(), 5);
});

test('State: currentStep clamps out-of-range values to 1', () => {
  for (const raw of ['99', '0', '-3', 'NaN']) {
    const ls = makeLocalStorage();
    ls.setItem('awareness_onboarding_step', raw);
    const S = load(ls);
    assert.equal(S.currentStep(), 1, `raw=${raw}`);
  }
});

test('State: skipStep accumulates unique values', () => {
  const S = load();
  S.skipStep(2);
  S.skipStep(4);
  S.skipStep(2);
  eq(S.skippedSteps(), [2, 4]);
});

test('State: corrupted skippedSteps JSON is tolerated', () => {
  const ls = makeLocalStorage();
  ls.setItem('awareness_onboarding_skipped_steps', '{not valid json');
  const S = load(ls);
  eq(S.skippedSteps(), []);
});

test('State: disabled localStorage does not crash', () => {
  const ls = makeLocalStorage({ enabled: false });
  const S = load(ls);
  assert.doesNotThrow(() => S.markCompleted());
  assert.doesNotThrow(() => S.setStep(3));
  assert.doesNotThrow(() => S.skipStep(2));
  assert.doesNotThrow(() => S.reset());
  assert.equal(S.isCompleted(), false);
  assert.equal(S.currentStep(), 1);
  eq(S.skippedSteps(), []);
  assert.equal(S.shouldAutoLaunch(), true);
});
