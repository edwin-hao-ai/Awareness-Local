export const DEFAULT_PORT = 37800;
export const BIND_HOST = '127.0.0.1';
export const AWARENESS_DIR = '.awareness';
export const PID_FILENAME = 'daemon.pid';
export const LOG_FILENAME = 'daemon.log';

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_USER_PREFERENCES = 15;

export const PREFERENCE_FIRST_CATEGORIES = new Set([
  'personal_preference',
  'activity_preference',
  'important_detail',
  'career_info',
]);

// F-055: single source of truth for *all* personal-style card categories.
// Matches the `categories` enum in backend/awareness-spec.json. Used by:
// - helpers.filterPersonaByRelevance (persona gate)
// - lifecycle-manager.validateCardQuality (relaxed length threshold)
// - mcp-handlers.buildInitResult (pulling persona candidates)
// Avoid inlining this list elsewhere — grow this one constant instead.
export const PERSONAL_CARD_CATEGORIES = new Set([
  'personal_preference',
  'activity_preference',
  'important_detail',
  'plan_intention',
  'health_info',
  'career_info',
  'custom_misc',
]);

export const CATEGORY_TO_RULE_TYPE = {
  decision: 'architecture',
  workflow: 'workflow',
  pitfall: 'pitfall',
  problem_solution: 'solution',
  key_point: 'knowledge',
  insight: 'knowledge',
  personal_preference: 'preference',
  activity_preference: 'preference',
  important_detail: 'context',
  plan_intention: 'context',
  health_info: 'context',
  career_info: 'context',
  custom_misc: 'context',
};
