# User Journeys — Zero-Mock E2E

Specs in this directory **MUST NOT** use any network mocking.
No `page.route`, no `page.routeFromHAR`, no fetch stubs.

## Why

Every bug we've shipped in the F-040 cycle slipped through because we
mocked the network. Mocked tests measure what we *wrote*, not what the
user *experiences*. These journeys must fail when the real daemon is
broken, the real endpoint 502s, or the real UI forgets to wire a button.

## Rules

1. **One file = one user action.** e.g.
   `switch-workspace.spec.mjs`, `connect-cloud.spec.mjs`,
   `first-time-onboarding.spec.mjs`.
2. **Assertions must be user-visible.** Text, URL, color, toast.
   Never assert on internal localStorage keys, React state, or
   hidden DOM attributes users never see.
3. **Daemon is real.** Tests rely on `playwright.config.mjs`'s
   `webServer` directive to launch `node bin/awareness-local.mjs start`.
4. **Upstream cloud can be down.** Journeys that require the cloud
   must check `is_headless`/offline status first and assert a
   graceful error UI, not skip silently.
5. **No shared state.** Each journey sets up its own `/tmp` project
   dir via `freshSession()` + unique install_id.

## Cross-reference

Each journey MUST link to an entry in
`docs/features/<F>/ACCEPTANCE.md` (Given/When/Then). A journey
without a matching acceptance entry is a code smell — either the
feature is undocumented or the journey is drifting.

## Running locally

```bash
cd sdks/local
npx playwright test test/e2e/user-journeys/ --reporter=list
```
