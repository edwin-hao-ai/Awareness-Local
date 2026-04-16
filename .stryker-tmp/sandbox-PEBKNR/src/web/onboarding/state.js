/* Awareness Onboarding — state machine + localStorage persistence
 * Three keys only: onboarding_completed_at, onboarding_step, onboarding_skipped_steps
 */
// @ts-nocheck

(function () {
  const KEY_COMPLETED = 'awareness_onboarding_completed_at';
  const KEY_STEP = 'awareness_onboarding_step';
  const KEY_SKIPPED = 'awareness_onboarding_skipped_steps';

  const read = (k) => {
    try { return localStorage.getItem(k); } catch { return null; }
  };
  const write = (k, v) => {
    try { localStorage.setItem(k, v); } catch {}
  };
  const del = (k) => {
    try { localStorage.removeItem(k); } catch {}
  };

  const State = {
    isCompleted() {
      return !!read(KEY_COMPLETED);
    },
    completedAt() {
      return read(KEY_COMPLETED);
    },
    markCompleted() {
      write(KEY_COMPLETED, new Date().toISOString());
      del(KEY_STEP);
    },
    reset() {
      del(KEY_COMPLETED);
      del(KEY_STEP);
      del(KEY_SKIPPED);
    },
    currentStep() {
      const n = parseInt(read(KEY_STEP) || '1', 10);
      return Number.isFinite(n) && n >= 1 && n <= 6 ? n : 1;
    },
    setStep(n) {
      write(KEY_STEP, String(n));
    },
    skipStep(n) {
      const arr = State.skippedSteps();
      if (!arr.includes(n)) arr.push(n);
      write(KEY_SKIPPED, JSON.stringify(arr));
    },
    skippedSteps() {
      try {
        const raw = read(KEY_SKIPPED);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch { return []; }
    },
    /** Should we auto-launch onboarding on page load? */
    shouldAutoLaunch() {
      return !State.isCompleted();
    },
  };

  window.AwarenessOnboardingState = State;
})();
