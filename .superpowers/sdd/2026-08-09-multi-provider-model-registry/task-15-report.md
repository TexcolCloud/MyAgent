# Task 15 Report: Interactive Setup and Automation CLI

## Status

DONE_WITH_CONCERNS

Task 15 is implemented and committed. All focused Task 15 tests, the exact integration command, lint, typecheck, build, diff checks, HTTP-only audits, and Secret-containment checks pass. The authoritative post-review serial full suite encountered the documented Windows `EBUSY` cleanup transient in two pre-existing fault-boundary cases; it was not retried and no runner settings were changed.

## Files and Scope

Implementation:

- `src/interfaces/cli/main.ts`
- `src/interfaces/cli/client.ts`
- `src/interfaces/cli/formatters.ts`
- `src/interfaces/cli/commands/agents.ts`
- `src/interfaces/cli/commands/model-setup.ts`
- `src/interfaces/cli/commands/providers.ts`
- `src/interfaces/cli/commands/models.ts`
- `src/interfaces/cli/commands/verifications.ts`
- `src/interfaces/cli/commands/secrets.ts`

Tests:

- `test/integration/model-cli.test.ts`
- `test/integration/cli.test.ts`

No Task 16 CI/e2e/docs, persistence, RAG, memory, channels, scheduler, native provider, Web UI, or failover implementation was added. This report is the only required non-CLI artifact.

## RED/GREEN Slices

1. CLI boundary and automation surface
   - RED: exact integration command failed all 24 new Model CLI cases on absent boolean flags, commands, Admin authority, polling, and prompt injection.
   - GREEN: all approved provider/model/assignment/verification/Secret commands mapped to `/v1/admin` with Admin Token selection; M1 commands retained Run Token behavior.
2. Error, auth, Secret, and polling semantics
   - RED: missing Admin credential, Problem trace, stdin-only credential, exit-code, and terminal-state cases failed.
   - GREEN: missing Admin Token fails before prompt/fetch; JSON errors are `{code,detail,traceId}`; exits are validation 2, auth/authz 3, conflict 4, provider/verification 5, transport/service 6, success/cancel 0; async Verification polls only its operation URL.
3. Nine-step setup and review
   - RED: cancellation, warning review, resolved context confirmation, preset delegation, successful Promotion/default/assignment ordering, and no-implicit-mutation cases failed incrementally.
   - GREEN: setup follows provider -> connection/credential -> draft -> discovery/manual eligibility -> model/context -> Verification poll -> review -> explicit Promotion -> optional default/Agent assignment. Review includes destination, auth, model, fixed protocol, capabilities, Usage, context source, affected Agents, and warnings.
4. Final self-review and independent review fixes
   - RED: four focused failures proved interactive Verification cancellation returned 5, optimistic snapshots occurred after confirmation, and extra positionals/flags were accepted.
   - GREEN: setup cancellation returns 0 without mutation; profile/default/assignment revisions are captured before review/final confirmation; exact command/flag grammar rejects unapproved input before fetch.

## Commands and Results

- `npx vitest run test/integration/model-cli.test.ts`
  - PASS, 1 file / 34 tests.
- `npm run test:integration -- test/integration/model-cli.test.ts test/integration/cli.test.ts`
  - PASS, 24 files / 184 tests.
- `npm run lint`
  - PASS, exit 0.
- `npm run typecheck`
  - PASS, exit 0.
- `npm run build`
  - PASS, TypeScript build and migration-copy postbuild exit 0.
- `git diff --check` and `git diff --cached --check`
  - PASS, no output.
- `npm test -- --maxWorkers=1` (pre-independent-review tree)
  - PASS, 74 files passed / 1 skipped; 722 tests passed / 5 skipped.
- `npm test -- --maxWorkers=1` (authoritative post-review final implementation tree)
  - KNOWN TRANSIENT: 73 files passed / 1 failed / 1 skipped; 723 tests passed / 2 failed / 5 skipped.
  - Both failures were `EBUSY: resource busy or locked, unlink ...kernel.db` in the pre-existing `test/e2e/fault-boundaries.test.ts` `before_sse_write` and `after_sse_write` cleanup cases.
  - Per task instruction, the run was recorded without retry and runner settings/timeouts were not changed.

## Secret Containment

- `--api-key` is rejected immediately without copying its following value into parsed flags.
- Automation accepts only `--api-key-env` (environment Secret reference) or `--api-key-stdin` (managed plaintext request).
- Admin credentials come only from `MYAGENT_ADMIN_TOKEN` or `--admin-token` and are used only in the Authorization header.
- Prompted Secrets use a muted terminal output stream; normal prompt text goes to stderr so JSON stdout remains undecorated.
- Stdin API-key test confirms plaintext is submitted only in the write-only HTTP request and is absent from CLI output.
- `rg -n 'console\.(log|error)|JSON\.stringify\((apiKey|adminToken|token)|process\.argv.*(token|api-key)' src/interfaces/cli`
  - Expected exit 1 with no matches.

## HTTP-Only Import Audit

- `rg -n '^import .*from .*?(application|domain|repository|sqlite|secret-decryptor)|node:sqlite|writeFile|appendFile|createWriteStream' src/interfaces/cli`
  - Expected exit 1 with no matches.
- Explicit import listing for the new Model/Admin CLI files contains only `node:readline/promises`, `node:stream`, and CLI-local client/formatter/command modules.
- Model/Admin command modules call only `/v1/admin/...` through `CliClient`; they do not import SQLite, repositories, Secret decryptors, YAML writers, domain/application services, or persistence adapters.

## Self-Review

- Verified every approved command is present and no purge/destroy command or alias was added.
- Verified every stable mutation has `--expected-revision`; stable provider/model creation is the only exception.
- Verified Admin Token selection cannot fall back to Run Token and missing Admin auth stops before prompt/fetch.
- Verified setup mutations cannot occur before the exact final confirmation and cancellation leaves only allowed drafts/Verification history.
- Verified optimistic revisions reviewed by the operator are used for Promotion/default/assignment, allowing concurrent changes to surface as 409 conflicts.
- Verified terminal discovery/Verification safe results preserve trace IDs and map to exits 5 or 0 for cancellation.
- Independent read-only review reported three Important findings (interactive cancellation, post-confirmation snapshots, permissive grammar); all were reproduced with RED tests and fixed before the final gates.

## Commits

- `0aa9a5a` - `feat: manage providers and models through CLI`
- The report is committed separately; its containing commit SHA is reported in the Task 15 completion response.

## Concerns

- The authoritative final full suite had only the known Windows `EBUSY` database cleanup transient described above. Task 15 focused tests and the exact integration command are green, and an earlier serial full-suite run on the same Task 15 behavior was fully green.
