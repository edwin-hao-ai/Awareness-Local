# Zero-Mock Policy — Enforcement

The hook `scripts/verify-zero-mock.mjs` fails CI if any spec under
`test/e2e/user-journeys/` references:

- `page.route`
- `page.routeFromHAR`
- `setExtraHTTPHeaders` (with auth)

This is equivalent to an ESLint rule but implemented as a repo-level
check so the project's root `.eslintrc` doesn't have to be modified
(which the config-protection hook forbids).

## Bypass
There is no bypass. If you think you need to mock in a user-journey
spec, you're writing the wrong kind of spec. Move it to
`test/e2e/onboarding-*.spec.mjs` instead (the non-journey E2E bucket
which still allows mocks for component isolation).
