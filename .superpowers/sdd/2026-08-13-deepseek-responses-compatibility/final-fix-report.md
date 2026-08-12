# Final Review Fix Report

## Scope

This fix wave closes all four findings from the final DeepSeek Responses
Compatibility review: historical Run restoration, fail-closed payload shaping,
exact immutable variant identity, and legacy catalog resolution.

## Changes

- Historical `agent_revisions.content_json` snapshots now normalize an omitted
  Provider Compatibility Contract to `none` while loading a Run execution
  context. The stored JSON is not rewritten or mutated.
- `deepseek-responses-v1` is accepted only with the complete immutable
  DeepSeek Responses identity. Corrupt persisted Profiles fail as
  `invalid_model_profile`; corrupt captured Runs fail before route allocation as
  non-transient `model_protocol_error`.
- The DeepSeek payload hook now requires an object payload with a nonempty
  model, array input, `stream: true`, and object-only tool definitions. Invalid
  shapes fail closed before gateway egress, including when Pi reports a hook
  exception as an error event.
- Runtime catalog resolution treats a historically omitted compatibility field
  locally as `none` without modifying its input.

## TDD Evidence

The new regressions were run against the pre-fix behavior before production
changes:

- Unit: 1 failed, 7 passed.
- Contract: 25 failed, 87 passed.
- Integration: 1 failed, 14 passed.

After implementation, the smallest focused groups passed: 5 files and 135
tests. The broader affected matrix then passed: 12 files and 230 tests,
covering adjacent catalog, Profile persistence, gateway, HTTP, provider-driver,
Run worker, Approval restart, and multi-provider behavior.

The first lint run found one test-only unused destructuring binding in the new
historical resolver regression. The test now asserts that the deliberately
removed value is `none`; its focused rerun, lint, and typecheck all passed.

## Final Verification

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS; 89 files passed and 1 live-provider file skipped, with 956
  tests passed and 6 skipped.
- `npm run build`: PASS, including the migration-copy postbuild step.
- `git diff --check`: PASS.
- `examples/data/`: no tracked or untracked files.

The mandated `npm run test:smoke:live` wrapper exited 1 without executing a
test because Vitest's existing `**/.worktrees/**` exclusion hides the linked
worktree. The root/config-explicit equivalent was run after removing
`MYAGENT_DEEPSEEK_BASE_URL`, `MYAGENT_DEEPSEEK_API_KEY`, and
`MYAGENT_DEEPSEEK_MODEL` from the child environment by name. It exited 0 with
the one live-provider file and both tests skipped, confirming the intended
credential-absent, no-network behavior without reading or printing secrets.

## Remaining Concern

The live-smoke npm wrapper still cannot discover its test from a repository
located beneath `.worktrees`. This is pre-existing test-runner infrastructure;
the compatibility behavior and credential-absent smoke path are covered by the
root-explicit run above.

## Scoped Re-review Follow-up

Scoped re-review found that captured DeepSeek Responses runtimes with a null or
missing `compatibility` record reached `Object.entries()` in the immutable
identity guard and escaped as a raw `TypeError`. Two adapter regressions first
reproduced that failure while the matching persisted-Profile cases confirmed
the repository already returned `invalid_model_profile`.

The shared identity guard now validates that `compatibility` is a non-array
object containing only finite primitive values before any contract-specific
branch or record comparison. Captured null, missing, and otherwise malformed
records therefore fail before gateway allocation or Pi invocation as a
non-transient `model_protocol_error`; valid legacy/manual `none` runtimes retain
their existing behavior.

Follow-up verification:

- Focused contract: 2 files and 116 tests passed.
- Run-worker integration: 1 file and 13 tests passed.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
