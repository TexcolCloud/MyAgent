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

## Formal Fix Round 1

### Scope and Files

Formal review reopened the earlier Task 16 completion at base `d3bcee399e24bbe203264152c28ffe90f4aeb0d0` with one Critical containment gap and four Important gaps. This fix round changes:

- `test/e2e/multi-provider-models.test.ts` for fully composed containment and distinct real Chat/Responses Tool flows.
- `test/e2e/responses-approval-restart.test.ts` for exact normalized SSE replay comparison against read-only `run_events` rows.
- `test/helpers/fake-openai-provider.ts` for emitted raw-response capture and credential-match booleans without Authorization capture.
- `test/helpers/start-test-app.ts` for an idempotent LIFO asynchronous cleanup stack.
- `test/contract/managed-secret-store.test.ts` for mixed old/current-key behavior before and during rotation.
- `src/adapters/sqlite/encrypted-secret-store.ts` for the production two-key rotation semantics required by design section 12.4.
- `docs/operations/model-registry.md` and `docs/superpowers/specs/2026-08-09-multi-provider-model-registry-design.md` for consistent two-key procedures.
- `docs/superpowers/plans/2026-08-09-multi-provider-model-registry.md` to supersede the obsolete transition-write lock rule with the approved section 12.4 contract.
- This report and `progress.md` for the formal closeout record.

### Critical and Important Resolutions

1. Critical containment proof: a composed HTTP/SSE/SQLite/worker E2E now seeds managed plaintext, distinct Chat and Responses raw reasoning, a raw provider-body field, actual ciphertext in hex and Base64, and the actual Key ID. It scans every setup HTTP response plus later HTTP JSON, raw SSE for both protocols, CLI stdout/stderr, thrown errors, logs, Run events, snapshots, Verification, health, audit, raw SQLite/WAL/SHM bytes, the backup database, and the backup manifest. The fake provider proves the raw fields were emitted and records only a derived credential-match boolean.
2. Important Agent-specific Tool isolation: Chat uses `write_file` with its own call ID, arguments, execution result, and result hash; Responses uses `run_command` with a distinct call ID, encoded argument, stdout, and result. Both use the same Session key through real Approval/execution flows, with positive-own and negative-other protocol-history assertions.
3. Important committed replay exactness: after restart, Responses SSE replay is normalized to `{ sequence, type, payload }` and compared exactly with read-only `run_events` rows after the cursor.
4. Important two-key rotation semantics: new writes use the configured current key while old rows remain under the configured previous key. Both generations resolve before rotation; rotation validates current-key rows, re-encrypts only old-key rows, advances the Keyring, and rejects replayed old envelopes afterward. The Operator guide and design now state the same behavior.
5. Important startup-failure cleanup: each provider/service acquisition registers cleanup immediately. An occupied loopback port induces `EADDRINUSE` after SQLite, the HTTP app, and all three workers are acquired. The test proves bootstrap closes those service resources, the temporary root/database can be removed, environment variables are restored, and the independent provider remains reachable until its separate outer LIFO cleanup.

### RED/GREEN and Mutation Evidence

- Containment RED: the composed test failed because the fake provider exposed no emitted raw body and could not prove `RAW_REASONING_COMPOSED_MARKER_16` entered the boundary. GREEN: the focused containment run passed after raw-response capture and complete surface scans were added.
- Tool isolation RED: injecting a foreign Chat `function_call_output` into the Responses continuation made the negative assertion fail on `chat-isolation-call-16`. GREEN: the real dual-Tool Approval/execution flow passed with distinct protocol histories.
- Replay RED: appending a unique, increasing `run.synthetic` event allowed the earlier surrogate assertions to pass but failed the exact database comparison. GREEN: the restart E2E passed after exact normalized row comparison.
- Cleanup RED: the invalid-configuration case failed before service acquisition and proved only the outer provider disposer. GREEN: an occupied-port failure now occurs after SQLite/app/worker acquisition; bootstrap cleanup removes the root/database and restores the environment while the independent provider continues returning HTTP 200 until its outer LIFO disposer runs.
- Two-key RED: creating a new Secret Version during the two-key phase threw `secret_locked`. GREEN: the focused mixed-generation contract and the complete 28-test managed-secret contract passed; old-envelope replay remains rejected after rotation.
- Documentation audit RED: the Operator guide stated that new writes remain Locked. GREEN: the guide and section 12.4 now state that new writes use the configured current key.

### Verification Evidence

- `npm run test:e2e -- test/e2e/multi-provider-models.test.ts test/e2e/responses-approval-restart.test.ts`
  - Initial Formal Fix pass: 2 files, 6 tests, 18.27 seconds.
  - Post-review pass: 2 files, 6 tests, Vitest 15.51 seconds, command wall time 19.1 seconds.
- Focused composed-containment/startup-cleanup run
  - PASS: 2 files, 4 tests.
- Serialized runner unit run
  - PASS: 1 file, 4 tests.
- Managed-secret contract run
  - PASS: 1 file, 28 tests.
- `npm run lint`
  - PASS, exit 0.
- `npm run typecheck`
  - PASS, exit 0.
- `npm run build`
  - PASS, exit 0.
- `npm run check`
  - FINAL PASS: lint and strict typecheck; 77 files passed / 1 skipped; 743 tests passed / 5 skipped; build/postbuild passed; exit 0; Vitest 155.90 seconds, command wall time 174.5 seconds.
- `npm run test:e2e`
  - FINAL PASS: 5 files passed / 1 skipped; 27 tests passed / 1 opt-in live smoke skipped; exit 0; Vitest 80.67 seconds, command wall time 84.2 seconds.
- `git diff --check`
  - PASS, no output.
- Deferred-surface audit
  - PASS: exactly three matches, all negative `previous_response_id` assertions; every other deferred term has zero matches.

The live provider smoke skipped without credentials as required. Linux remains CI-only.

### Self-Review

- The production change is authorized by a failing contract against approved design section 12.4, not by deferred feature work.
- Mixed-generation resolution is limited to the explicit two-key phase where the stored Keyring matches the configured previous key; after rotation, the old generation is no longer authoritative.
- Rotation decrypts current-key rows only to validate them, clears those plaintext buffers immediately, re-encrypts only old-key rows, and reports the exact number re-encrypted.
- Provider request capture contains no Authorization value, key fragment, or submitted plaintext; only `credentialMatched: boolean` is observable.
- Every credential-bearing setup response is cloned before consumption and included in the composed public-surface scan; streaming SSE is intentionally captured separately to avoid an unbounded global response clone.
- Direct SQLite access in E2E remains assertion-only. Setup, Run, Approval, CLI, backup, and lifecycle actions use public boundaries.
- Cleanup is immediate, idempotent, reverse-order, and covers partial acquisition failures.
- No deferred provider, RAG/Memory, channel, scheduling, multimodal, Web UI, OAuth/Azure, runtime fallback, or failover surface was added.

### Independent Re-review

The post-fix read-only review found no Critical or Important issues after verifying setup-response containment, the distinct Responses reasoning path, post-acquisition bootstrap cleanup, locked-plan consistency, and current-key-only reopen of a mixed-generation rotation. Its one Minor closeout-wording mismatch was corrected above. Static verdict after that correction: ready to commit.

The SHA containing Formal Fix Round 1 is reported externally after commit because a commit cannot contain its own hash.
