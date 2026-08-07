# Task 13 Report: Authenticated HTTP API and Replayable SSE

## Implementation Summary

Implemented a Fastify HTTP boundary with a static Bearer-token guard, RFC 7807-style Problem Details, strict Zod request validation, durable Run endpoints, catalog reload/listing, approval and reconciliation routes, session lifecycle routes, and persisted SSE replay/tailing. The API maps only safe identifier and lifecycle fields into responses. SSE reads only committed `run_events`, replays strictly after `Last-Event-ID`, emits standard `id`, `event`, and `data` fields, sends 15-second heartbeats, observes socket close, and waits for drain after backpressure.

The Session repository now supplies a metadata-only identity lookup. The HTTP-only `DeleteSessionService` blocks deletion of Sessions with a `running` Run while retaining the existing repository cascade-delete behavior used by delegation tests.

## Files Changed

- `src/interfaces/http/app.ts`, `auth.ts`, `problem.ts`, `schemas.ts`, `sse.ts`
- `src/interfaces/http/routes/{health,agents,config,runs,approvals,tool-calls,sessions}.ts`
- `src/application/delete-session.ts`
- `src/adapters/sqlite/{approval-repository,session-repository}.ts`
- `src/ports/{approval-store,session-store}.ts`
- `test/helpers/start-test-app.ts`
- `test/integration/{http-auth,http-runs,http-decisions,sse}.test.ts`

## TDD Evidence

1. RED: `npm run test:integration -- test/integration/http-auth.test.ts` failed because `src/interfaces/http/app.ts` did not exist.
2. GREEN: `npx vitest run test/integration/http-auth.test.ts` passed after bootstrap/auth/Problem Details implementation.
3. RED: `npx vitest run test/integration/http-runs.test.ts` failed with `expected 404 to be 202` before Run route registration.
4. GREEN: `npx vitest run test/integration/http-runs.test.ts test/integration/http-auth.test.ts` passed after strict Run routes and migrated test harness were added.
5. RED/GREEN follow-up: the full check revealed a compatibility regression from moving the running-Run guard into `SqliteSessionRepository.delete`; the guard was moved to `DeleteSessionService`, and `npx vitest run test/integration/delegation.test.ts test/integration/http-auth.test.ts test/integration/http-runs.test.ts test/integration/http-decisions.test.ts test/integration/sse.test.ts` passed (15 tests).

## Verification

- `npx vitest run test/integration/http-auth.test.ts test/integration/http-runs.test.ts test/integration/http-decisions.test.ts test/integration/sse.test.ts` - PASS, 4 files / 5 tests.
- `npm run lint` - PASS.
- `npm run typecheck` - PASS.
- `npm run build` - PASS.
- `npm run check` - exit 1. Lint and typecheck passed; full Vitest had the known Windows `process_tree_termination_failed` / `EBUSY` failures in `process-tree.test.ts` and `run-command.test.ts`, plus a run-queue worker timeout under concurrent full-suite load. The run also exposed the Session delete regression noted above; it was fixed and the affected delegation suite was rerun successfully. Build did not run because `npm test` exited nonzero.

## Self-Review

- Authentication parses a single Bearer token and uses equal-length `Buffer` comparison with `timingSafeEqual`; `/healthz` and `/readyz` remain unprotected.
- Route payloads use strict object schemas and reject unknown Run/reconciliation/decision fields.
- HTTP handlers delegate mutations to established application services and repositories; no provider or Tool I/O occurs in a SQLite transaction here.
- SSE queries persisted events only, validates the cursor before hijacking the response, uses strict `sequence > cursor`, and stops on terminal state or socket close.
- Generic errors never include error messages, stacks, database details, paths, provider bodies, or token values; logging records only a generic code and trace ID.
- Approval projections include the required `run_command` host-risk notice.

## Concerns

- The full check remains nonzero on this Windows host because of the pre-existing process-tree/run-command contract instability, with an additional concurrent run-queue timeout in that full-run invocation. The Task 13 focused suite and the affected delegation suite pass after the final fix.
- The Task 13 integration tests cover durable replay on a terminal Run. They do not exercise a real network client disconnect or the 15-second heartbeat interval; those mechanics are implemented in the streaming loop but would benefit from a dedicated socket-level test.
