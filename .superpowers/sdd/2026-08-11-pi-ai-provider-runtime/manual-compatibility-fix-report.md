# Manual Pi Compatibility Fix Report

Date: 2026-08-12

## Scope

New manual `pi/openai-compatible` Model Profiles now persist an explicit,
conservative Pi 0.73.1 compatibility contract. Pi no longer infers modern
OpenAI request fields from the loopback gateway URL. Legacy snapshots still
use the legacy router only when their Profile revision has no `piRuntime`;
native catalog contracts, gateway/Secret policy, and fallback behavior are
unchanged.

## TDD Evidence

The regression test runs the composed app through persisted Profile selection,
`PiAiSdkClient`, the loopback provider gateway, and the fake upstream HTTP
provider. It asserts normal model, message, streaming, and Tool fields and the
absence of `store` and Tool `strict` fields in the exact upstream JSON body for
both Chat Completions and Responses.

RED command:

```powershell
node node_modules/vitest/vitest.mjs run test/e2e/multi-provider-models.test.ts --config vitest.worktree.config.ts --maxWorkers=1 --fileParallelism=false -t "runs a manually selected OpenAI-compatible Profile through the Pi gateway"
```

RED output: exit 1, 1 failed; `expected ... to not have property "store"`,
received `false`.

GREEN command: the same command after the production change.

GREEN output: exit 0, 1 passed, 10 skipped.

Responses RED used the same command with test filter `keeps a manual Responses
payload compatible through the Pi gateway`.

Responses RED output: exit 1, 1 failed; `expected ... to not have property
"store"`, received `false`.

Responses GREEN output: exit 0, 1 passed, 11 skipped.

`vitest.worktree.config.ts` was a temporary untracked runner config needed
because the repository config excludes absolute paths containing `.worktrees`;
it was removed before commit.

## Files

- `src/interfaces/http/routes/model-profiles.ts`: persist complete conservative
  Pi 0.73.1 primitive compatibility values for manual OpenAI-compatible
  Profiles.
- `src/adapters/model/pi-ai-client.ts`: remove Pi's hardcoded Responses
  `store` and Tool `strict` fields only for manual `pi/openai-compatible`
  contracts; native catalog payload behavior remains unchanged.
- `src/adapters/sqlite/model-registry-repository.ts`: admit the documented
  primitive Chat/Responses compatibility keys while retaining the allowlist
  and rejecting transport, credential, and object-valued routing data.
- `test/integration/http-model-control.test.ts`: assert both manual protocol
  selections persist the explicit contract.
- `test/e2e/multi-provider-models.test.ts`: assert real Chat Completions and
  Responses Pi SDK/gateway payloads omit unsupported `store` and Tool `strict`
  fields.

## Verification

- Focused contracts/integration/E2E, including legacy and native isolation: 9
  files, 160 tests passed.
- `npm run check`: lint passed; typecheck passed; 83 test files passed and 1
  live-provider file skipped; 851 tests passed and 5 skipped; build passed.
- A preceding full-suite attempt exposed an unrelated nondeterministic
  `run_command` retained-output count failure. Its isolated rerun passed, and
  the fresh complete `npm run check` also passed it. No command-execution code
  was changed.

## Self-Review

- The manual compatibility contract is explicit and does not depend on the
  gateway or upstream base URL.
- The exact payload test exercises the real Pi SDK and gateway route, not a
  constructed model object.
- Native catalog Responses behavior is preserved by the manual Driver check at
  the Pi payload boundary.
- Required request fields and Tool definitions remain present.
- No gateway authorization, Secret handling, runtime fallback, legacy
  discriminator, or native catalog behavior changed.
- The compatibility persistence allowlist remains closed to unknown,
  transport, credential, and nested vendor-routing values.
