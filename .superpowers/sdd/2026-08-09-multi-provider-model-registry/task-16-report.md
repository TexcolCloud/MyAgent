# Task 16 Report: Multi-Provider Release Gates

## Status

DONE

Task 16 proves the multi-provider model registry through the fully composed HTTP/SSE/SQLite/worker system. The deterministic Windows release gate, focused and complete E2E suites, leakage audits, deferred-surface audit, lint, typecheck, and build all pass. Independent review completed two fix rounds and returned a final clean verdict.

## Files and Scope

Release runner and CI:

- `.github/workflows/ci.yml`
- `package.json`
- `scripts/run-vitest.mjs`
- `scripts/run-vitest-args.mjs`
- `test/unit/run-vitest-args.test.ts`

Composed test harness and E2E coverage:

- `test/helpers/fake-openai-provider.ts`
- `test/helpers/start-test-app.ts`
- `test/helpers/fault-controller.ts`
- `test/e2e/multi-provider-models.test.ts`
- `test/e2e/responses-approval-restart.test.ts`
- `test/e2e/live-provider.smoke.test.ts`

Containment and operational coverage:

- `test/integration/secret-leak.test.ts`
- `test/integration/model-secret-leak.test.ts`
- `test/integration/network-defaults.test.ts`
- `test/integration/readiness.test.ts`
- `examples/myagent.yaml`
- `docs/operations/model-registry.md`

No production file under `src` changed. Deferred providers, RAG/Memory, channels, scheduling, multimodal input, Web UI, OAuth/Azure, runtime protocol fallback, and cross-provider failover remain outside this milestone.

## RED/GREEN Slices

1. Serialized runner routing
   - RED: the focused unit test could not import the missing argument-builder export.
   - GREEN: four unit cases prove explicit suite directories, focused files, `-t`, reporters, JUnit output, and excludes are routed without broadening a suite.
2. Verification deadline
   - RED: the composed helper ignored the caller-provided polling timeout.
   - GREEN: the deadline is plumbed through; the live smoke can allow 120 seconds for Verification while the regression uses a bounded short deadline.
3. Provider timeout normalization
   - RED: the failure-matrix case returned `tool_call_unsupported` for a timed-out probe.
   - GREEN: timeout is normalized as `provider_unavailable` and cannot mutate the active Assignment.
4. Redirect security
   - RED: cross-origin redirect was reported as `provider_unavailable`.
   - GREEN: it is rejected as `model_protocol_error`; the source request is observed and the redirect target receives no request.
5. Leakage containment
   - RED: deliberate Key ID and raw-provider marker mutations caused the new whole-system scans to fail.
   - GREEN: with the mutations removed, all scans pass across every required surface.

## Isolation, Restart, and Failure Matrix

- Separate Chat Completions and Responses Profiles run through real HTTP with the same Session key while preserving Agent, Session, Tool, and provider-request isolation.
- A Responses Tool Call pauses for real Approval, the application stops, reopens the same SQLite database, approves, executes the Tool exactly once, and continues with the original provider call ID.
- SSE reconnect replays committed events only, and continuation requests contain no `previous_response_id`.
- Failed Verification, Provider API Key rotation, wrong master key, provider timeout, cross-origin redirect, provider outage, and cancellation leave the active Assignment byte-for-byte unchanged.
- The harness binds test services to loopback, supports restart over the same database/config/master key, and closes provider timers, sockets, and child stdio deterministically.

## Secret Containment

The tests seed unique plaintext, Key ID, ciphertext, reasoning, and provider-body markers. Assertions scan HTTP JSON, SSE, CLI stdout/stderr, thrown errors, logs, SQLite text/blob renderings, Run events, snapshots, Verification records, Provider Health, audit records, and online backups. No forbidden marker is exposed.

The opt-in live key assertion compares only a derived boolean, so a failed Vitest assertion cannot print the credential. Captured provider requests omit Authorization values.

## Commands and Results

- `npm run test:e2e -- test/e2e/multi-provider-models.test.ts test/e2e/responses-approval-restart.test.ts`
  - PASS: 2 files, 4 tests, exit 0, 16.4 seconds.
- Focused review-fix suite
  - PASS: 5 files, 14 tests.
- `npm run lint`
  - PASS, exit 0.
- `npm run typecheck`
  - PASS, exit 0.
- `npm run check`
  - PASS: lint, strict typecheck, 741 passed / 5 skipped tests, build, exit 0, 170.6 seconds.
- `npm run test:e2e`
  - PASS: 5 files passed / 1 skipped; 25 tests passed / 1 opt-in live smoke skipped; exit 0, 77.81 seconds.
- `git diff --check`
  - PASS, no output.

The live DeepSeek smoke was correctly skipped because the required external environment variables were not present. Normal tests and CI use no real provider credentials.

## Deferred Surface Audit

`rg -n "EmbeddingPort|RerankPort|KnowledgeBase|previous_response_id|Anthropic|GenerateContent|Azure|OAuth|automatic_failover|runtime_fallback" src test examples`

The audit returns exactly three matches, all negative `previous_response_id` assertions:

- `test/e2e/responses-approval-restart.test.ts` contains two.
- `test/contract/openai-responses.test.ts` contains one.

Every other deferred term has zero matches.

## Independent Review and Fix Rounds

The first independent review reported six Important issues. The fixes covered explicit serialized suite routing; safe live-key assertions and coherent polling/test budgets; fake-provider redirect support, retry-script reset, timer/socket cleanup, and idempotent close; the correct two-key master rotation procedure; non-vacuous redirect request evidence; and `finally`-guarded cleanup.

Follow-up review specifically verified `--dir=<suite>` argument routing, the 210-second live smoke budget around 120-second Verification and 60-second Run limits, and source-contact/target-isolation evidence for cross-origin redirects. Final verdict: ready to merge, with no remaining findings.

## Self-Review

- Confirmed all new application coverage goes through public HTTP/CLI boundaries; direct database reads are assertions only.
- Confirmed no provider Authorization value is captured and no credential literal is introduced in examples, docs, tests, or CI.
- Confirmed the runner serializes suites on Windows/Linux and preserves focused Vitest arguments used by local and CI commands.
- Confirmed the operator guide covers loopback/Admin prerequisites, v2 configuration, manual eligibility, Verification/promotion/assignment ordering, Provider API Key rotation, the four-step two-key master rotation, encrypted backup restore, Locked diagnosis, retirement, purge/destruction, and opt-in smoke variables.
- Confirmed only Task 16 release-gate, harness, test, documentation, example, and CI surfaces changed.

## Concerns

The monolithic Windows `npm run check` takes about 171 seconds because it deliberately serializes the complete suite. CI still exposes bounded unit, contract, integration, and E2E commands independently, making failures attributable. Linux execution is delegated to the configured CI matrix and was not run locally. The external DeepSeek smoke remains opt-in and was not executed without credentials.
