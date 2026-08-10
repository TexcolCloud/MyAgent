# SDD ledger — plan: docs/superpowers/plans/2026-08-09-multi-provider-model-registry.md

Preflight: resolved — Verification enqueue requires the owning Model Profile's expectedRevision.
Preflight: resolved — Provider/runtime error normalization is closed; control-plane resource/lifecycle codes remain separately typed.
Preflight: resolved — master-key rotation uses a singleton Managed Secret Keyring record and requires its expectedRevision.
Task 1: review found Important gaps — exact assignment/revision identity, typed registry/provider error vocabularies, deep readonly ProviderAuth, and conflicting fallback classifier semantics.
Task 1: minor (deferred): the compile-time immutability test mutates at runtime and should be renamed or strengthened.
Task 1: human ruling — Global Constraints govern fallback; require `invocation_protocol_unsupported` with 404/405/501 or validated internal `unsupported_endpoint`.
Task 1: fix round 1/5 (3 addressed, 1 open — `unsupported_endpoint` lacks type-distinguished validated internal evidence; commits ab8891b..97c56fd)
Task 1: fix round 2/5 (1 addressed, 0 open — validated internal endpoint evidence branded; commits 97c56fd..cf97b20)
Task 1: complete (commits da3cbd8..cf97b20, review clean)
Task 2: review found Important gaps — disputed Profile revision append path and internal worker CAS/audit contracts; confirmed Promotion lifecycle-state and expectedRevision ordering defects.
Task 2: minor (deferred): missing repository resources use generic Error instead of typed errors.
Task 2: minor (deferred): retirement assertion and migration-trigger coverage are weaker than the behavior contract.
Task 2: human ruling — add generic createProfileRevision with stable Profile expectedRevision, retirement check, immutable append, and same-transaction audit.
Task 2: human ruling — expectedRevision/audit governs control-plane and stable-resource mutations; internal Verification state/leaseOwner CAS and informational Health retain their canonical signatures.
Task 2: fix round 1/5 (3 addressed, 0 open — Profile revision append, verified Promotion state, and CAS-first ordering; commits 2fa7d0e..5276ae1)
Task 2: complete (commits cf97b20..5276ae1, review clean)
Task 3: review found Important gaps — equal-timestamp discovery generations can select the wrong latest write, and fallback rollback coverage fails before partial completion writes.
Task 3: minor (deferred): cancellation tests do not explicitly cover running leases or passed/failed terminal rejection.
Task 3: fix round 1/5 (2 addressed, 0 open — durable discovery ordering and late-failure fallback rollback proof; commits f9857f5..d735afc)
Task 3: complete (commits 5276ae1..d735afc, review clean)
Task 4: review found Important gaps — Keyring authority is not enforced during resolution or destruction, and environment Secret resolution emits `secret_unavailable` outside the closed runtime error set.
Task 4: minor (deferred): rotation retains all decrypted Secret buffers until the complete transaction finishes, increasing plaintext lifetime and memory use with the Secret set size.
Task 4: review warning resolved — runtime composition, HTTP view sanitization/`credentialConfigured`, Run-time `model_provider_locked` translation, and backup-manifest exclusions are assigned to later Tasks 12, 13, and 16 rather than this adapter/service task.
Task 4: fix round 1/5 (3 addressed, 0 open — Keyring-authoritative resolution, authenticated destruction, and closed environment Secret error mapping; commits 0119f11..9cddeb0)
Task 4: complete (commits 5e39f44..9cddeb0, review clean)
Task 5: minor (deferred): legacy import boundary tests do not cover unknown/duplicate aliases, path confinement, hash determinism under reordered YAML, version-discriminator rejection, or managed-Secret rejection for v2 server tokens.
Task 5: review warning resolved — controller reran the focused unit suite (129 passed/1 skipped) and typecheck at reviewed HEAD with exit 0.
Task 5: complete (commits 9cddeb0..5a89a0c, review clean)
Task 6: review found Important gaps — empty URL components are accepted, encoded responses are not fetch-compatible, `303` changes `HEAD` to `GET`, request-body pumping leaks listeners/work, and the transport module has excessive security-sensitive responsibilities.
Task 6: minor (deferred): focused contracts omit direct slow-DNS, post-header deadline, connect-timeout, URL-object, Host-strip, declared-length, compressed-response, and redirect-method cases beyond the reviewed fixes.
Task 6: review warning resolved — Linux execution is assigned to Task 16's cross-platform CI/release gate; controller reran focused unit (166 passed/1 skipped), contract (176 passed/3 skipped), and typecheck at reviewed HEAD with exit 0 on Windows.
Task 6: fix round 1/5 (5 addressed, 0 open — raw URL delimiters, identity encoding, 303 HEAD, upload cancellation/listener cleanup, and focused internal modules; commits 3a7b845..02361c8)
Task 6: complete (commits 5a89a0c..02361c8, review clean)
Task 7: review found Important gaps — caller-controlled discovery limits bypass the hard 1,000 ceiling, malformed `has_more` can persist incomplete fresh results, invalid Unix dates escape normalization, untrusted errors can forge safe metadata, and repository/ID failures are misclassified as provider failures.
Task 7: minor (deferred): fake provider response timers are not tracked/cleared during teardown, weakening cleanup guarantees for aborted delayed responses.
Task 7: environment finding — default parallel Vitest repeatedly times out existing Windows process/SQLite tests; unchanged `--maxWorkers=1` run passes 470 tests/5 skipped, assigning deterministic cross-platform gate configuration to Task 16.
Task 7: review warning resolved — inherited Task 3 repository and Task 6 transport behavior already passed their task reviews; controller reran focused unit (177 passed/1 skipped), contract (190 passed/3 skipped), and typecheck at reviewed HEAD with exit 0.
Task 7: fix round 1/5 (5 addressed, 0 open — hard item ceiling, strict pagination metadata, finite dates, trusted safe errors, and infrastructure-failure propagation; commits a7c4c11..4d4688c)
Task 7: complete (commits 02361c8..4d4688c, review clean)
Task 8: review found Important gaps — Session summary watermarks can skip queued/current Run input, idempotent Run/delegation replay resolves live assignments too early, legacy Connection eligibility is inverted, null root provider IDs can reach side effects/repeated nondurable failure, malformed Tool call IDs are validated after healthy attempt recording, and Provider Health injection is optional.
Task 8: review warning resolved — controller reran the five directly covering test files (55 passed) and typecheck at reviewed HEAD with exit 0; implementer serialized full suite passed 505 tests/5 skipped.
Task 8: fix round 1/5 (6 addressed, 0 open — contiguous summary watermark, lazy idempotent resolution, legacy Connection eligibility, null-ID preflight, streamed call-ID validation, and mandatory Health sink; commits e3ba1bd..c2b6476)
Task 8: complete (commits 4d4688c..c2b6476, review clean)
Task 9: review found Important gaps — canonical JSON exceptions are misclassified as provider outages, Tool Call assembly accepts invalid initial indexes/restarted metadata, and zero-choice Usage frames lack ordering/uniqueness/token validation.
Task 9: fix round 1/5 (2 addressed, 1 open — repeated Tool Call ID/name remains accepted and consistent continuation type is over-rejected; commits 44fdc85..c0fcfce)
Task 9: fix round 2/5 (2 addressed, 1 open — value-equality duplicate detection rejects valid repeated ID/name fragments; commits c0fcfce..4b55080)
Task 9: fix round 3/5 (1 addressed, 0 open — opaque repeated fragments restored with observable stream invariants preserved; commits 4b55080..4259c41)
Task 9: review warning resolved — controller reran the Chat contract (65 focused; 245 passed/3 skipped overall) and typecheck at reviewed HEAD with exit 0.
Task 9: complete (commits c2b6476..4259c41, review clean)
Task 10: review found Critical/Important gaps — Responses output indexes and function-call item identity/terminal output are not reconciled, malformed declared calls can be ignored, and negative tests mask invariants behind missing-terminal failures while omitting required malformed/mismatch/cancellation coverage.
Task 10: fix round 1/5 (3 addressed, 0 open — strict Responses call state machine, truthful malformed-stream contracts, and mid-stream cancellation; commits de517d6..4ed48c5)
Task 10: review warning resolved — controller reran Responses/router contracts (270 passed/3 skipped) and typecheck at reviewed HEAD with exit 0.
Task 10: complete (commits 4259c41..4ed48c5, review clean)
Task 11: human ruling — reopen the Task 3 repository contract so legacy candidate copy and Verification enqueue are one transaction; failure must leave no draft revision.
Task 11: review found Important gaps — unknown provider codes plus 404/405/501 can gain unauthorized protocol fallback, and broad SQLITE_* fatal classification can stop the worker lane on recoverable per-job constraint failures.
Task 11: minor (deferred): an exception thrown by onUnexpectedVerificationError can terminate the worker lane after the job was safely failed.
Task 11: fix round 1/5 (2 addressed, 0 open — exact provider fallback evidence and explicit fatal SQLite classification; commits 7bc1723..4d298a0)
Task 11: review warning resolved — controller reran unit (226 passed/1 skipped), integration (98 passed), and typecheck at reviewed HEAD with exit 0.
Task 11: complete (commits 4ed48c5..4d298a0, review clean)
Task 12: review found an Important gap — first-seen Agent identity is not persisted when no default exists, so a later default can silently assign an already-seen Agent after reload/restart.
Task 12: minor (deferred): bootstrap preflight and Catalog load parse configuration separately and could observe different file generations.
Task 12: minor (deferred): lifecycle ordering is covered indirectly but lacks one explicit HTTP/Verification/Run/Approval/SQLite order assertion.
Task 12: fix round 1/5 (1 addressed, 0 open — durable first-seen Agent synchronization marker; commits 7f4404e..c324aa3)
Task 12: review warning resolved — controller reran assignment/repository tests (44 passed) and typecheck at reviewed HEAD with exit 0.
Task 12: complete (commits 4d298a0..c324aa3, review clean)
Task 13: review warning resolved — unchanged Task 6/7 provider transport enforces URL credential/query/fragment rejection, post-DNS address classification and pinning, same-origin redirects, and TLS verification; routes delegate without bypass.
Task 13: complete (commits c324aa3..16ffc45, review clean)
Task 14: review found Important gaps — Managed Secret reference inspection is outside the destructive transaction/CAS, and Verification/provider result codes are not type-separated from lifecycle/resource Problem codes.
Task 14: fix round 1/5 (1 addressed, 1 open — Secret destruction transaction/race fixed; HTTP public Problem allowlist remains broader than the control-plane/public contract; commits 44b651b..115b13e)
Task 14: fix round 2/5 (1 addressed, 0 open — explicit M1/control-plane public Problem allowlists; commits 115b13e..2a83c2a)
Task 14: environment finding — serialized Windows full-suite attempts continue to show unrelated intermittent SQLite EBUSY/worker-poll timeout; focused Task 14 and affected-file suites pass, deterministic cross-platform gate remains Task 16 scope.
Task 14: complete (commits 16ffc45..2a83c2a, review clean)
Task 15: review found Critical/Important gaps — setup JSON mode emits multiple objects, interactive validation maps to transport exit 6, and final review shows raw rather than persisted effective Base URL.
Task 15: fix round 1/5 (3 addressed, 0 open — one-object setup JSON, validation exit 2, and persisted effective destination review; commits c152b76..bad462d)
Task 15: environment finding — post-fix serialized suite was externally terminated at 120 seconds after no emitted failures; focused CLI/integration/static gates pass and deterministic full-suite ownership remains Task 16.
Task 15: complete (commits 2a83c2a..bad462d, review clean)
Task 16: resolved Task 7 deferred cleanup — fake-provider response timers and sockets are tracked, cleared, and closed idempotently, including aborted delayed responses and redirect targets.
Task 16: environment resolution — Vitest suites run serially through an explicit `--dir=<suite>` router that preserves focused files, `-t`, reporter values, output files, and excludes without broadening suite scope.
Task 16: environment resolution — Windows child-process cleanup now waits for `close` after stdio teardown rather than treating `exit` as complete lifecycle cleanup.
Task 16: release proof — real HTTP/SSE/SQLite/worker tests cover Chat/Responses isolation, Approval/restart with the original provider call ID and exactly-once Tool execution, assignment stability across the required failure matrix, and containment across HTTP, SSE, CLI, errors, logs, persistence, snapshots, audit, health, Verification, and backups.
Task 16: review found 6 Important issues across runner argument routing, live-smoke Secret safety/time budgets, fake-provider redirect/lifecycle behavior, operator rotation guidance, request evidence, and cleanup guarantees.
Task 16: fix rounds resolved all findings — focused regressions pass, cross-origin redirect proves the source was contacted and target was not, live Verification uses a configurable deadline, and final independent follow-up reports no remaining findings.
Task 16: complete (release gates pass, review clean, no production `src` changes)
Task 16: formal review reopened — Critical whole-system leakage proof is incomplete; Important gaps remain in Agent-specific Tool isolation, exact committed SSE replay, two-key rotation documentation, and startup-failure cleanup.
Task 16: formal fix round 1/5 (5 addressed, 0 open — composed whole-system containment, dual Tool isolation, exact SSE replay, approved two-key semantics, and immediate partial-start cleanup; commits d3bcee3..d5e4bd9)
Task 16: final complete (commits bad462d..d5e4bd9, formal review clean; release gates pass)
Task 16: supersession — the earlier completion line predates formal review and is superseded by Formal Fix Round 1 evidence below.
Task 16: Formal Fix Round 1 Critical resolved — composed containment proves raw provider fields entered the boundary and scans managed plaintext, raw reasoning/body, actual ciphertext encodings, and the actual Key ID across every required public, observable, durable, raw SQLite, and backup surface.
Task 16: Formal Fix Round 1 Important resolved — Chat and Responses use distinct real Tools, call IDs, arguments, results, and Approval/execution histories under the same Session key, with positive-own and negative-other assertions.
Task 16: Formal Fix Round 1 Important resolved — Responses replay compares normalized sequence/type/payload exactly with committed read-only `run_events` rows after the cursor; mutation with a unique increasing event fails the proof.
Task 16: Formal Fix Round 1 Important resolved — two-key documentation now states that new writes use the configured current key; the contract exposed and fixed production behavior so mixed generations resolve before rotation, only old rows are re-encrypted, the Keyring advances, and old-envelope replay remains rejected.
Task 16: Formal Fix Round 1 Important resolved — an occupied-port `EADDRINUSE` failure occurs after SQLite/app/worker acquisition and proves bootstrap cleanup removes the temporary root/database and restores the environment while the independent provider remains reachable until outer LIFO cleanup.
Task 16: Formal Fix Round 1 release gates — focused E2E 6/6, managed-secret contract 28/28, full `npm run check` 743 passed/5 skipped, full E2E 27 passed/1 live smoke skipped, lint/typecheck/build, whitespace, and deferred-surface audits pass; Linux remains CI-only.
Task 16: Formal Fix Round 1 complete — one Critical and four Important formal findings resolved at base d3bcee399e24bbe203264152c28ffe90f4aeb0d0; containing commit SHA is reported externally.
Task 16: Formal Fix Round 1 follow-up review found 3 Important gaps — setup mutation responses and Responses-only reasoning were absent from the containment corpus, startup failure occurred before service acquisition, and the locked plan retained the obsolete transition-write lock rule; 2 Minor gaps covered current-key-only reopen and active-envelope wording.
Task 16: Formal Fix Round 1 follow-up resolved — setup-only response clones plus distinct Responses reasoning are scanned, occupied-port startup exercises bootstrap cleanup after resource acquisition, plan/design/operations agree on section 12.4, mixed generations reopen current-key-only, and destroyed metadata is distinguished from active old-key envelopes.
Task 16: Formal Fix Round 1 final re-review — 0 Critical and 0 Important findings; the sole Minor stale cleanup-evidence wording was corrected before final gates.
Task 16: Formal Fix Round 1 final gates — `npm run check` passed 743/743 with 5 skipped plus lint/typecheck/build/postbuild in 174.5 seconds; explicit E2E passed 27/27 with the opt-in live smoke skipped in 84.2 seconds; ready for the single containing commit.
