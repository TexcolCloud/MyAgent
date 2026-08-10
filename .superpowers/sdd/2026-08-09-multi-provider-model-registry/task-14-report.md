# Task 14 Report: Complete Model Registry Lifecycle API

## Status

Implemented and independently reviewed from base `16ffc450c7cd00ccb89c7de2644d409eb3e62a0c`.

Implementation commit: `328bbbd38fa1df68d0f091bb39a6d8f5cc0b96dc`.

## Implementation Summary

- Added Verification enqueue, polling, and cancellation routes. Enqueue returns `202` plus a stable operation URL; polling exposes only safe result evidence and omits worker lease ownership/expiry.
- Added explicit ordered Connection and Profile promotion routes. Profile promotion preflights the referenced Connection revision while preserving stale-revision precedence, and neither promotion mutates existing Agent assignments.
- Added exact Agent assignment and default Profile GET/PUT routes with explicit `assigned`/`unassigned` and `configured`/`unset` response states.
- Added optimistic retirement plus separately confirmed Profile and Connection purge routes.
- Added confirmed Managed Secret destruction and singleton master-key rotation. Rotation accepts no key material and returns only `{ reencrypted, currentKeyId, recordRevision }`.
- Added allowlisted `resource_in_use.ownerCategories`. Profile and Connection categories are derived atomically from actual references, deduplicated with `EXISTS`, and contain no owner IDs. Managed Secret categories are derived from typed Secret references and contain no Secret or owner IDs.
- Added strict request/response schemas, resource-specific safe `404` Problems, closed Verification result-code serialization, and lifecycle/containment coverage.

## Files Changed

- `src/adapters/sqlite/model-registry-repository.ts`
- `src/interfaces/http/app.ts`
- `src/interfaces/http/model-control-schemas.ts`
- `src/interfaces/http/problem.ts`
- `src/interfaces/http/routes/managed-secrets.ts` (new)
- `src/interfaces/http/routes/model-assignments.ts` (new)
- `src/interfaces/http/routes/model-profiles.ts`
- `src/interfaces/http/routes/model-verifications.ts` (new)
- `src/interfaces/http/routes/provider-connections.ts`
- `test/contract/model-registry-repository.test.ts`
- `test/integration/http-model-control.test.ts`
- `test/integration/model-assignments.test.ts`
- `test/integration/model-secret-leak.test.ts`

No migrations, runner settings, timeouts, worker lifecycle, or unrelated Run routes changed.

## Incremental RED/GREEN Evidence

1. Verification lifecycle RED: enqueue/poll/cancel routes were absent. GREEN: `202` operation creation, safe polling, cancellation history, and optimistic conflicts.
2. Ordered promotion RED: Profile promotion could not report the required Connection-first lifecycle result through HTTP. GREEN: exact Connection then Profile promotion with no implicit Agent rebinding.
3. Assignment/default RED: lifecycle routes were absent. GREEN: discriminated read states and exact optimistic PUT semantics for future Runs only.
4. Retirement/purge RED: lifecycle routes were absent. GREEN: optimistic non-destructive retirement plus separate confirmed `204` purge.
5. Secret operations RED: destruction and keyring rotation routes were absent. GREEN: confirmed reference-checked destruction and write-only transactional key rotation.
6. Missing-resource RED: lifecycle mutations surfaced generic failures. GREEN: resource-specific safe `404` Problems without requested identifiers.
7. Review round 1 RED: `resource_in_use` omitted safe owner categories. GREEN: allowlisted Problem projection and ID-leak assertions for Profile, Connection, and Managed Secret blockers.
8. Review round 2 RED: Profile/Connection routes reported hardcoded possible categories, including nonexistent blockers. GREEN: transaction-local exact category queries with isolated, combined, retained, and repeated-owner deduplication coverage.

## Final Verification

- Task 14 focused integration command:
  - `npm run test:integration -- test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts`
  - PASS: 23 files, 146 tests.
- Exact-category repository/HTTP command:
  - `npx vitest run test/contract/model-registry-repository.test.ts test/integration/http-model-control.test.ts --maxWorkers=1`
  - PASS: 2 files, 58 tests.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS, including migration copy postbuild.
- `git diff --cached --check`: PASS before the implementation commit.
- Independent fix-round 2 review: no Critical or Important findings; reviewer reran 61 focused tests, typecheck, and diff-check successfully.

The final serialized `npm test -- --maxWorkers=1` gate did not produce a clean exit on three post-fix attempts. Each attempt reached 672 passing tests and 5 skipped tests, then one unchanged `test/e2e/fault-boundaries.test.ts` SSE case failed during temporary SQLite cleanup with Windows `EBUSY: resource busy or locked, unlink ...kernel.db`. The failure alternated between `before_sse_write` and `after_sse_write`; each failing case passed immediately when run alone. All Task 14 and repository tests passed in every attempt. A serialized full-suite run before the final category refinement passed 673 tests with 5 skipped.

## Review and Self-Review

- Initial independent review found one Important omission: `resource_in_use` did not expose safe owner categories. Added a closed allowlist plus response containment tests.
- Fix-round 1 found one Important accuracy issue: static possibility lists reported blocker categories that were not present. Moved Profile/Connection category derivation into the repository purge transaction after expected-revision validation.
- Fix-round 2 found no Critical or Important issues.
- Destructive requests require `{ expectedRevision, confirm: true }`; retirement remains a distinct non-destructive operation.
- Verification responses omit `leaseOwner` and lease expiry. Secret responses omit plaintext, ciphertext, key material, Secret IDs in blocked-destruction Problems, and reference-owner IDs.
- Category serialization accepts only the closed safe vocabulary and drops the complete category field if any unrecognized value appears.

## Concerns

The pre-existing Windows E2E cleanup flake prevents a clean final full-suite exit despite isolated reproduction passing and all changed behavior remaining green. The failure is confined to temporary-file unlink after an unchanged fault-boundary SSE case; no Task 14 code path participates in that cleanup.
