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

## Formal Fix Round 1/5

### Status and Commits

Both Important findings from the formal Task 14 review are resolved without
deferral.

- Implementation commit: `0eb5005c1f7963083c998a2e3972ccaf0de5f06d`.
- Report commit: this report's final commit SHA is recorded in the Task 14 status
  contract because a Git commit cannot contain its own final SHA.

### Important 1: Atomic Managed Secret Destruction

Finding: Managed Secret reference inspection occurred before the Secret Store's
destructive transaction. A concurrent Connection reference could be created
between inspection and ciphertext destruction, and a stale referenced request
returned `resource_in_use` before validating `expectedRevision`.

Resolution:

- Added a store-level active-version/CAS assertion and made destruction reuse it.
- Moved expected-revision validation, exact reference inspection, safe category
  derivation, and ciphertext destruction into one outer `BEGIN IMMEDIATE`
  transaction, with CAS validation first.
- Removed the non-atomic HTTP route preflight.
- Required managed-Secret Connection creation/revision to assert the Secret is
  active inside the existing outer Connection transaction. Nested SQLite
  transaction helpers execute inline, so Secret validation and reference insertion
  share the same writer lock.
- Preserved exact, deduplicated `provider_connection_revision` category evidence
  without exposing Secret or owner IDs.

RED evidence:

- The stale referenced destruction regression expected `revision_conflict` but
  received `resource_in_use` before the fix.
- The Connection regression allowed a Connection to reference an already-destroyed
  Secret before active-version validation was added.

GREEN evidence and covering tests:

- `test/unit/managed-secret-service.test.ts` verifies transaction entry, CAS-first
  ordering, reference inspection, and exact safe category details.
- `test/contract/managed-secret-store.test.ts` uses two SQLite connections: an open
  reference writer blocks the destructive contender with SQLite busy; after the
  reference commits, destruction returns `resource_in_use` with exactly
  `provider_connection_revision` and leaves the Secret active.
- `test/integration/model-secret-leak.test.ts` verifies stale-revision precedence and
  safe referenced-destruction containment.
- `test/integration/model-assignments.test.ts` verifies a destroyed Secret cannot win
  before a new Connection reference.
- Command:
  `npx vitest run test/unit/managed-secret-service.test.ts test/contract/managed-secret-store.test.ts test/integration/model-secret-leak.test.ts test/integration/model-assignments.test.ts --maxWorkers=1`
  passed 4 files and 48 tests.

### Important 2: Closed Verification and Problem Codes

Finding: the Verification response schema reused a provider-runtime vocabulary that
also contained lifecycle codes, while the HTTP error handler published arbitrary
`DomainError.code` and `ApplicationError.code` strings.

Resolution:

- Removed lifecycle/resource codes from `PROVIDER_RUNTIME_ERROR_CODES`.
- Added the exact nine-code `VERIFICATION_RESULT_CODES` /
  `VerificationResultCode` contract and applied it to the Verification domain,
  persistence port, orchestration normalization, and HTTP response schema.
- Added closed `DomainErrorCode`, `ApplicationErrorCode`,
  `ControlPlaneProblemCode`, and `PublicProblemCode` vocabularies. Existing error
  construction is now compile-time checked.
- HTTP projection now checks the closed public allowlist. An unknown or unapproved
  Domain/Application error is logged as `internal_error` and returns only the
  generic `500 internal_error` Problem, without echoing its code, message, or
  details.
- Persisted invalid Verification result codes fail response parsing and are handled
  as generic internal errors rather than serialized as successful operations.

RED evidence:

- Command:
  `npx vitest run test/unit/model-control-schemas.test.ts test/integration/http-model-control.test.ts --maxWorkers=1`
  failed 6 tests and passed 30: all four lifecycle codes were accepted as
  Verification results, the unknown Domain code was echoed as a 422 Problem, and a
  persisted `revision_conflict` Verification result was serialized with 200.
- `npm run typecheck` failed because `ControlPlaneProblemCode` and
  `VerificationResultCode` did not exist and the negative type assertion was
  unused.

GREEN evidence and covering tests:

- The same focused command passed 2 files and 36 tests.
- `test/unit/model-control-schemas.test.ts` rejects lifecycle results, accepts only
  the nine approved results, accepts `revision_conflict` as a control-plane Problem
  at compile time, and uses `@ts-expect-error` to prove it is not a Verification
  result.
- `test/integration/http-model-control.test.ts` proves unknown Domain diagnostics and
  invalid persisted Verification result codes become generic 500 Problems without
  echo.

### Verification

- Exact Task 14 command:
  `npm run test:integration -- test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts`
  passed 23 files and 149 tests.
- Repository/Secret command:
  `npx vitest run test/contract/model-registry-repository.test.ts test/contract/managed-secret-store.test.ts test/unit/managed-secret-service.test.ts --maxWorkers=1`
  passed 3 files and 72 tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, including migration-copy postbuild.
- `git diff --check`: passed.
- Serialized full-suite command, run exactly once:
  `npm test -- --maxWorkers=1`.
  It reached 72 passing files, 689 passing tests, and 5 skipped tests. The sole
  failure was the known unchanged Windows cleanup issue in
  `test/e2e/fault-boundaries.test.ts`, case `after_sse_write`:
  `EBUSY: resource busy or locked, unlink ...\kernel.db`. Per the fix-round
  instruction, the suite was not retried and no runner settings or timeouts were
  changed.

### Self-Review

- Destruction checks the Secret CAS before revealing reference categories.
- Both destructive and reference-creating paths serialize on the same SQLite writer
  lock; the losing side observes either SQLite busy, the committed reference, or the
  destroyed Secret.
- Verification result codes cannot contain lifecycle/resource Problems at either
  compile time or response serialization.
- Unknown error codes, messages, details, Secret IDs, and reference-owner IDs are not
  published by the new failure paths.
- No migrations, worker lifecycle, test runner settings, timeouts, or unrelated
  routes changed.

## Formal Fix Round 2/5

### Status and Commits

The remaining Important finding from the Round 1 review is resolved without
changing the already-addressed Managed Secret transaction work.

- Implementation commit: `ce11bee08e357c86f684aed4e10ab17ae4d4dbdd`.
- Report commit: this report's final commit SHA is recorded in the Task 14 status
  contract because a Git commit cannot contain its own final SHA.

### Important: HTTP-Public Problem Authority Was Too Broad

Finding: `CONTROL_PLANE_PROBLEM_CODES` existed but was not used as HTTP authority.
`PUBLIC_PROBLEM_CODES` instead spread every `DomainErrorCode` and
`ApplicationErrorCode`, so known internal diagnostics such as `file_changed` were
still serialized as public 422 Problems.

Resolution:

- Added the explicit `M1_HTTP_PROBLEM_CODES` vocabulary for the established Run,
  Approval, backup, reconciliation, config-reload, and Session boundary errors.
- Defined `PublicProblemCode` from only `M1_HTTP_PROBLEM_CODES` plus the existing
  `CONTROL_PLANE_PROBLEM_CODES`. The control-plane vocabulary is now the authority
  for Task 13/14 lifecycle/resource Problems rather than dead metadata.
- Kept `DomainErrorCode` and `ApplicationErrorCode` closed for internal construction,
  while removing their broad spread into HTTP authority.
- Kept provider runtime and the narrower Verification result vocabulary unchanged.
- Internal known and unknown Domain errors now both reach the existing generic
  `500 internal_error` projection without echoing their code, message, or details.

The reviewed M1 public set preserves `agent_unavailable`, Approval resolution and
lookup conflicts, backup conflicts/path validation, idempotency conflicts,
reconciliation validation/conflicts, `restart_required`, Run lookup, Session
lifecycle errors, and Tool Call reconciliation lookup/conflicts. The Task 13/14 set
continues to preserve provider/profile/Verification lookup, URL validation,
revision/resource conflicts, ownership/lifecycle validation, Secret locking, and
Verification/assignment readiness codes.

### RED/GREEN Evidence

RED:

- Command:
  `npx vitest run test/unit/model-control-schemas.test.ts test/integration/http-model-control.test.ts test/integration/http-runs.test.ts --maxWorkers=1`
  produced 1 failure and 42 passes. The known internal `file_changed` error returned
  422 instead of the required generic 500; the unknown diagnostic case and allowed
  Run behavior already passed.
- `npm run typecheck` failed with an unused `@ts-expect-error`, proving
  `file_changed` was still assignable to `PublicProblemCode`.

GREEN:

- The same focused command passed 3 files and 43 tests.
- `test/integration/http-model-control.test.ts` proves both `file_changed` and an
  unknown Domain code become generic 500 Problems with no code/message/details
  echo. It also asserts the exact allowed `resource_in_use` status, title, detail,
  trace ID, and safe owner categories.
- `test/integration/http-runs.test.ts` asserts the exact existing
  `422 agent_unavailable` Problem including its public detail.
- `test/unit/model-control-schemas.test.ts` proves at compile time that
  `file_changed` remains a valid internal `DomainErrorCode` but is not a
  `PublicProblemCode`; provider, Verification, control-plane, and public types remain
  distinct.
- Compatibility command:
  `npx vitest run test/integration/http-decisions.test.ts test/integration/backup.test.ts test/integration/http-auth.test.ts --maxWorkers=1`
  passed 3 files and 22 tests, covering existing Approval, reconciliation, Session,
  backup, authentication, malformed-request, and internal-error HTTP behavior.

### Verification

- Exact Task 14 command:
  `npm run test:integration -- test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts`
  passed 23 files and 150 tests.
- `npm run lint`: passed after the final test assertions.
- `npm run typecheck`: passed after the final test assertions.
- `npm run build`: passed, including migration-copy postbuild.
- `git diff --check`: passed.
- Serialized full-suite command, run exactly once:
  `npm test -- --maxWorkers=1`.
  It reached 72 passing files, 690 passing tests, and 5 skipped tests. The sole
  failure was an unrelated timing failure in the unchanged
  `test/integration/model-verification-worker.test.ts` case `aborts on shutdown and
  reclaims the expired lease after restart`: `timed_out_waiting_for_condition` at
  its existing 2-second polling deadline. That same file passed in the exact Task 14
  command immediately before the full suite, and all 17 unchanged fault-boundary
  E2E tests passed in the full run. Per instruction, the full suite was not retried
  and no runner settings or timeouts were changed.

### Self-Review

- `PUBLIC_PROBLEM_CODES` contains no spread of `DOMAIN_ERROR_CODES` or
  `APPLICATION_ERROR_CODES`.
- Every current `ApplicationErrorCode` intentionally exposed by Run/Admin routes is
  present through either the reviewed M1 or control-plane vocabulary.
- Repository/worker/tool invariants such as file changes, lease loss, invalid state
  transitions, provider protocol failures, and canonicalization failures are not
  HTTP-authoritative.
- Unknown and known-internal error codes, messages, and details are absent from the
  Problem body.
- Existing M1 and Task 13/14 public status/code/detail behavior is covered by focused
  route tests and the complete integration suite.
