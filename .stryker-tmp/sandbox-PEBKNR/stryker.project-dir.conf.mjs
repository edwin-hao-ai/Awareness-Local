/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
// @ts-nocheck

export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'command',
  commandRunner: {
    command: 'node --test test/e2e/user-journeys/project-isolation.test.mjs',
  },
  mutate: [
    'src/daemon.mjs',
  ],
  // Focus on the project validation logic
  mutator: {
    plugins: [],
    excludedMutations: [],
  },
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  tempDirName: '.stryker-tmp',
  concurrency: 2,
};
