# Task 2 Report: Complete Provider Workflows

## Status

Complete. The three-region workbench now opens a focused Provider workspace through the typed HTTP-only `TuiClient` capability. The screen supports list/select/detail, create, revise, remote discovery, promotion, and retirement. Purge is not exposed.

Provider mutations render a review containing the Provider ID, current revision, proposed revision, affected Profiles, Secret-reference status, and confirmation state before dispatch. Revision conflicts lock mutation controls until an explicit reload; no mutation is retried silently. Failed or stale remote discovery locks Promotion until discovery succeeds or the workspace reloads.

## TDD Evidence

RED:

- The first focused run failed because `src/interfaces/tui/screens/providers.ts` did not exist, proving the new workflow tests did not pass against the summary-only Provider navigation.
- The failed-discovery test initially observed one Promotion request after a failed discovery. Production state was then changed to lock Promotion for `failed` and `stale` discovery outcomes.

GREEN:

- `test/integration/tui-providers.test.ts`: 7 tests passed, including behaviorful terminal navigation, selection/detail, managed-Secret and environment-reference creation, revise/discover/promote/retire reviews, conflict reload, health/locked/degraded display, terminology separation, and failed-discovery promotion locking.
- Final focused regression: 4 files, 75 tests passed.

## Secret Handling

- Managed-Secret input uses the masked Pi-TUI prompt.
- Plaintext is copied directly into the outbound create/revise request object and the local plaintext variable is cleared immediately after request construction.
- Provider screen models retain only safe labels such as `managed Secret configured`, `managed Secret input (masked)`, or `environment reference configured`.
- The Provider behavior test serializes the live screen and renders both center and inspector regions while confirmation is pending; the plaintext sentinel is absent before and after dispatch.
- Existing HTTP/database/log/event Secret-containment tests remain green.
- Environment reference names are submitted by name but cannot be redisplayed later because the safe HTTP response intentionally returns only `credentialConfigured`, not the environment variable name.

## Verification

```text
npm run test:integration -- test/integration/tui-providers.test.ts test/integration/http-model-control.test.ts test/integration/model-secret-leak.test.ts test/integration/tui-workbench.test.ts
PASS: 4 files, 75 tests

npm run lint
PASS

npm run typecheck
PASS

git diff --check
PASS
```

The full suite was not run, per task coordination instructions.

## Files

- `src/interfaces/tui/screens/providers.ts`
- `src/interfaces/tui/screens/inspector.ts`
- `src/interfaces/tui/workbench.ts`
- `test/integration/tui-providers.test.ts`

`src/interfaces/tui/screens/model-setup.ts` and `test/integration/model-secret-leak.test.ts` required no production/test changes; their existing behavior was exercised by the focused regression.

## Concerns

- Computing affected Profiles uses the existing list/detail HTTP endpoints and therefore performs one detail request per Profile. This is correct for the current API but may need a server-side impact endpoint if registry sizes become large.
- The workbench keeps compatibility with summary-only test clients through capability detection. A real `TuiClient` provides the complete capability and always opens the focused Provider screen.
