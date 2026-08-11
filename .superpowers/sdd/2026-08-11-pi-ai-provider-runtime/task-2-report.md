# Task 2 Report: Persist Drivers and Immutable Pi Contracts

## Status

Complete. SQLite migration 0003, repository mappings, application propagation,
runtime snapshot boundaries, legacy compatibility, and regression coverage are
implemented.

## RED Evidence

### Missing migration and repository storage

Command:

```powershell
npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts
```

Result before production changes: exit 1; 2 test files failed, 7 tests failed,
50 passed. The failures were the intended missing behavior:

- schema history contained versions 1 and 2, not version 3;
- a real version-2 registry had no `provider_driver` column to backfill;
- final schema had no `provider_driver` or `runtime_contract_json`;
- inserting/updating `runtime_contract_json` failed because the column did not
  exist;
- repository-created `pi/anthropic` connection returned no Driver;
- malformed runtime JSON could not reach the typed mapper because the column
  did not exist.

An earlier first run had 6 failures and 50 passes, but one repository fixture
failed first on the legacy `invocation_protocol` CHECK because it used
`pi_ai`. The fixture was corrected to `responses`: `piRuntime` is the new
execution selector while `invocation_protocol` remains the compatibility
projection.

### Native Driver compatibility projection

Command:

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts
```

Result before the projection fix: exit 1; 1 failed, 38 passed. The
`pi/anthropic` row returned legacy kind `openai` instead of the required
`openai_compatible` projection.

### Runtime snapshot mutation checks

After the integration test had been authored, each production snapshot field
was temporarily omitted to prove the regression test detects both boundaries.

Command for each mutation:

```powershell
npm run test:integration -- test/integration/pi-runtime-registry.test.ts
```

Results:

- with `VerifyModelService.resolveRuntime()` omitting `piRuntime`: exit 1; 1
  failed, expected the Anthropic contract and received `undefined` at line 163;
- with `AgentResolver` omitting `piRuntime`: exit 1; 1 failed, expected the
  Anthropic contract and received `undefined` at line 192.

Both production fields were restored before GREEN verification.

## GREEN Evidence

Required contract command:

```powershell
npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts
```

Result: exit 0; 2 files passed, 57 tests passed.

Required integration command:

```powershell
npm run test:integration -- test/integration/legacy-model-migration.test.ts test/integration/pi-runtime-registry.test.ts
```

Result: exit 0; 2 files passed, 6 tests passed.

Restored runtime snapshot mutation check:

```powershell
npm run test:integration -- test/integration/pi-runtime-registry.test.ts
```

Result: exit 0; 1 file passed, 1 test passed.

Full repository tests:

```powershell
npm test
```

Result: exit 0; 80 files passed, 1 skipped; 774 tests passed, 5 skipped.
The credentialed live-provider test and platform-specific cases remained
skipped as expected.

Static verification and build:

```powershell
npm run lint
npm run typecheck
npm run build
git diff --check
```

Results: all exit 0. Build completed TypeScript compilation and copied SQLite
migrations.

`npm run check` was also attempted. Lint and typecheck passed, and the all-test
phase showed no failures before the command wrapper reached its 120-second
timeout. The same `npm test` phase was then rerun with a 300-second allowance
and passed in 154 seconds, followed by a successful standalone build.

## Implementation

- Added additive migration `0003-pi-runtime.sql`:
  - nullable `provider_driver`, followed by deterministic legacy backfill;
  - nullable `runtime_contract_json`, preserving all historical Profile rows;
  - exact drop/recreation of `model_profile_revisions_content_immutable` with
    `runtime_contract_json` in both the `BEFORE UPDATE OF` list and `IS NOT`
    condition.
- Repository writes a Driver for every new Connection, including legacy
  imports, and projects non-OpenAI/DeepSeek Drivers to `openai_compatible`.
- Repository canonically serializes new Pi contracts and maps SQL null to an
  absent optional property whose observable value is `undefined`.
- Non-null runtime JSON is parsed and structurally validated. Invalid JSON,
  unknown fields (including URL/Secret-shaped additions), wrong Pi version,
  invalid numbers, or non-primitive compatibility values use
  `DomainError("invalid_model_profile")`.
- Provider/profile management carries the Driver and a detached frozen Pi
  contract into new records.
- Agent resolution and model verification clone and deeply freeze the exact
  stored contract. Neither imports or queries `pi-runtime-catalog.ts`.
- A fixed pre-0003 Agent snapshot is decoded through the real SQLite catalog
  repository, and its stored `content_json` is asserted byte-identical.

## Files

- `src/adapters/sqlite/migrations/0003-pi-runtime.sql`
- `src/ports/model-registry-store.ts`
- `src/adapters/sqlite/model-registry-repository.ts`
- `src/application/manage-provider-connections.ts`
- `src/application/manage-model-profiles.ts`
- `src/application/agent-resolver.ts`
- `src/application/verify-model.ts`
- `test/contract/sqlite-migrations.test.ts`
- `test/contract/model-registry-repository.test.ts`
- `test/integration/legacy-model-migration.test.ts`
- `test/integration/pi-runtime-registry.test.ts`
- `.superpowers/sdd/2026-08-11-pi-ai-provider-runtime/task-2-report.md`

## Self-Review

- Migration is forward-only and does not update historical Agent snapshot JSON
  or existing Profile revision content; only the new Connection projection
  column is backfilled.
- The Pi contract allowlist excludes provider URL and credential material.
- Existing ModelPort streaming, one-tool-call verification, cancellation,
  retry, and fallback behavior was not changed.
- Remote discovery remains unchanged and separate from catalog contracts and
  verification.
- No OAuth/Azure/AWS creation/assignment path or runtime fallback was added.
- Tests are credential-free and use filesystem URLs/SQLite APIs that work on
  Windows and Unix-like systems.
- `git diff --check` is clean.

## Concerns

- The all-in-one `npm run check` command exceeds the 120-second tool allowance
  on this Windows environment. Its phases pass when run with an adequate test
  timeout, as recorded above.
- No implementation concerns remain for Task 2.

## Round 1 Review Fixes

### RED Evidence

Compatibility validation and direct SQLite immutability:

```powershell
npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts
```

Result before production changes: exit 1; 4 failed and 55 passed. Three
failures demonstrated the reviewed defects: `apiKey` and `baseUrl` were
accepted inside persisted compatibility metadata, and direct
`provider_driver` updates succeeded. The fourth failure was an expected JSON
fixture that still named the removed fabricated `supportsReasoning` field; the
literal was corrected to match the safe fixture before GREEN verification.

The first Pi fallback run stopped on a duplicate fixture database path and was
not counted as RED. After giving each integration case its own fixture name,
the command reached the reviewed behavior:

```powershell
npm run test:integration -- test/integration/pi-runtime-registry.test.ts
```

Result before production changes: exit 1; 1 failed and 1 passed. A failed Pi
verification received `fallbackVerificationId: "ver_forbidden_fallback"`
instead of `null`, proving that it created the forbidden fallback revision and
Verification.

Legacy fallback baseline before production changes:

```powershell
npm run test:unit -- test/unit/model-verification.test.ts
```

Result: exit 0; 29 passed.

### GREEN Evidence

Focused contract verification:

```powershell
npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts
```

Result: exit 0; 2 files passed, 59 tests passed.

Focused Pi and legacy fallback verification:

```powershell
npm run test:integration -- test/integration/pi-runtime-registry.test.ts
npm run test:unit -- test/unit/model-verification.test.ts
```

Results: both exit 0; 2 Pi integration tests and 29 legacy unit tests passed.

Legacy migration and Pi runtime integration verification:

```powershell
npm run test:integration -- test/integration/legacy-model-migration.test.ts test/integration/pi-runtime-registry.test.ts
```

Result: exit 0; 2 files passed, 7 tests passed.

Full repository tests:

```powershell
npm test
```

Result: exit 0; 80 files passed, 1 skipped; 777 tests passed, 5 skipped.

Static verification and build:

```powershell
npm run typecheck
npm run lint
npm run build
git diff --check
```

Results: all exit 0. Build completed TypeScript compilation and copied SQLite
migrations. An initial escalated parallel `git diff --check` invocation lost
its working directory and was discarded; the direct worktree rerun exited 0.

### Implementation

- Pi-backed Profile revisions now return no protocol fallback candidate.
  Profiles without `piRuntime` retain the existing Responses/Chat fallback.
- Migration 0003 adds a database trigger that aborts any direct
  `provider_driver` mutation with `immutable_provider_driver`.
- Persisted Pi compatibility metadata is pinned to the ten fields supported by
  `@mariozechner/pi-ai@0.73.1`: eight boolean fields and two string fields.
  Unknown fields, wrong types, numeric entries, credentials, and transport URLs
  map to `DomainError("invalid_model_profile")`.

### Self-Review

- The Pi guard is placed after target resolution and before any fallback IDs or
  revision objects are created, so failure completion remains unchanged and no
  extra IDs are consumed.
- The SQLite trigger uses `IS NOT`, matching the existing null-safe immutability
  style and protecting both null/non-null transitions and Driver replacement.
- The compatibility validator accepts empty metadata and all known 0.73.1
  boolean/string fields while excluding arbitrary primitive extension points.
- Existing legacy fallback coverage remained green before and after the fix.
- No unrelated production behavior or schema history was changed.

### Round 1 Concerns

- No implementation concerns remain for the Round 1 findings.

## Round 2 Review Fixes

### Finding

The Round 1 compatibility allowlist constrained `maxTokensField` and
`thinkingFormat` to strings but did not constrain their values. That allowed
URL- and Secret-shaped strings to enter immutable runtime contract JSON.

### RED Evidence

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts
```

Result before the Round 2 production change: exit 1; 2 failed and 48 passed.
The repository accepted `maxTokensField: "secret"` and
`thinkingFormat: "https://provider.example/v1"` instead of throwing
`DomainError("invalid_model_profile")`. The same run confirmed all seven
initially enumerated Pi 0.73.1 values still round-tripped before hardening.

### GREEN Evidence

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts
npm run typecheck
git diff --check
```

Results: all exit 0. The focused contract file passed all 50 tests, including
rejection of the URL/Secret-shaped values and persistence of each allowed
enum value. TypeScript compilation and whitespace validation both passed.

### Implementation

- `maxTokensField` is now restricted to Pi's 0.73.1
  `max_completion_tokens | max_tokens` enum.
- `thinkingFormat` is now restricted to Pi's 0.73.1
  `openai | deepseek | zai | qwen | qwen-chat-template` enum.
- The contract tests exercise every accepted enum value at the real repository
  boundary and ensure rejected values leave no persisted runtime JSON.

### Self-Review

- The exact domains are derived from the installed `@mariozechner/pi-ai@0.73.1`
  compatibility types, not URL or Secret heuristics.
- The existing boolean allowlist and rejection of unknown compatibility keys
  remain unchanged.
- No migration, historical revision, or runtime resolution behavior changed.

### Round 2 Concerns

- No implementation concerns remain for the Round 2 finding.

## Round 3 Review Fixes

### Finding

Pi's installed 0.73.1 compatibility type also permits
`thinkingFormat: "openrouter"`. The Round 2 exact allowlist and acceptance
matrix omitted that literal, incorrectly rejecting a valid stored contract.

### RED Evidence

This was test-first coverage. The valid `thinkingFormat: "openrouter"`
round-trip case was added before the production allowlist changed:

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts
```

Result before the Round 3 production change: exit 1; 1 failed and 50 passed.
The new case failed with `DomainError("invalid_model_profile")`, while both
existing URL/Secret-shaped rejection cases remained green.

### GREEN Evidence

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts
npm run typecheck
git diff --check
```

Results: all exit 0. The focused contract file passed all 51 tests, including
the `openrouter` round trip and the retained rejection cases. TypeScript
compilation and whitespace validation both passed.

### Implementation

- Added `openrouter` to the exact Pi 0.73.1 `thinkingFormat` allowlist.
- Extended exhaustive accepted-enum coverage to include all six documented
  `thinkingFormat` values and both `maxTokensField` values.

### Self-Review

- The literal was taken from the installed Pi type declaration, which describes
  its OpenRouter reasoning payload semantics.
- No permissive pattern or URL/Secret heuristic was introduced; arbitrary
  strings remain invalid.
- The change is limited to one allowed literal, its round-trip regression
  test, and this report correction.

### Round 3 Concerns

- No implementation concerns remain for the Round 3 finding.
