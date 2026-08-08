# Task 14 Report

## Implementation summary

- Added a composed `bootstrap(configPath)` service that validates Node 24, loads the catalog and secrets before SQLite/listening, migrates SQLite, composes repositories, use cases, tools, worker, approval expirer, HTTP API, and graceful shutdown.
- Added authenticated `POST /v1/backups`, online SQLite backup, atomic sibling partial directories, source snapshot copying, SHA-256 manifest generation, and collision-only 409 handling.
- Captured immutable global, Agent, policy, prompt, and active Skill source contents in catalog snapshots for backup consistency; restored stable `invalid_global_config` wrapping for unreadable global config files.
- Added an HTTP-only CLI with every required operational command, native fetch/client error handling, SSE reconnection support, local pure config validation, and JSON formatting.
- Added runnable example global config, Agents, policies, Skills, and explicit workspaces.

## Files changed

- `src/bootstrap.ts`
- `src/application/create-backup.ts`
- `src/adapters/sqlite/backup.ts`
- `src/config/catalog-loader.ts`, `src/config/skill-loader.ts`
- `src/interfaces/http/app.ts`, `src/interfaces/http/schemas.ts`, `src/interfaces/http/routes/backups.ts`
- `src/interfaces/cli/**`
- `examples/**`
- `test/helpers/start-test-app.ts`, `test/unit/catalog-loader.test.ts`
- `test/integration/backup.test.ts`, `test/integration/cli.test.ts`, `test/integration/bootstrap.test.ts`

## TDD evidence

- Inherited backup RED/GREEN: the task handoff reported both backup integration cases initially failed with `POST /v1/backups` returning 404, then became green after the inherited implementation. I did not observe that original RED run and do not claim fresh output for it.
- Observed RED: `npx vitest run test/unit/catalog-loader.test.ts` failed `wraps an unreadable global config in the stable global error`: expected `invalid_global_config`, received raw `ENOENT`. GREEN: the same test passed after wrapping the global read.
- Observed RED: `npx vitest run test/integration/cli.test.ts test/integration/bootstrap.test.ts` failed because `src/interfaces/cli/main.js` and `src/bootstrap.js` did not exist. GREEN: both suites passed after adding the modules and composition root.
- Observed RED: the bootstrap secret-startup test initially allowed startup and cleanup failed with SQLite `EBUSY`; GREEN: it passed after eager model-secret resolution before SQLite open/listen.

## Test commands and results

- `npx vitest run test/unit/catalog-loader.test.ts` - pass, 9 tests.
- `npx vitest run test/integration/backup.test.ts` - pass, 2 tests.
- `npx vitest run test/integration/cli.test.ts test/integration/bootstrap.test.ts` - pass during initial GREEN verification.
- `npx vitest run test/integration/backup.test.ts test/integration/cli.test.ts test/integration/bootstrap.test.ts test/unit/catalog-loader.test.ts test/unit/skill-loader.test.ts` - pass, 5 files / 18 tests.
- `npm run lint` - pass.
- `npm run typecheck` - pass.
- `npm run build` - pass.
- `npm run check` - lint and typecheck passed; Task 14 backup/CLI/bootstrap tests passed. It failed on the documented Windows baseline failures: `test/contract/process-tree.test.ts`, two cases in `test/contract/run-command.test.ts`, and the concurrent child-process case in `test/integration/run-queue.test.ts`.

## Self-review

- CLI modules do not import SQLite or open database connections; operational commands go through authenticated HTTP, while `config validate` only calls the pure catalog loader.
- Backup writes only to a validated sibling partial directory, publishes through rename, and maps only `EEXIST`/`ENOTEMPTY` rename collisions to `backup_destination_exists`.
- Catalog backup inputs retain loaded source strings rather than reading changed files later.
- Bootstrap stops the HTTP listener before worker/scanner teardown, uses the shared execution registry for cancellation, and closes SQLite last.
- Public HTTP errors remain redacted through the existing problem handler; CLI error parsing uses server Problem Details without printing internal error objects.

## Concerns

- `npm run check` is not fully green on this Windows host because of the pre-existing process-tree and run-queue failures listed above.
- CLI command output is JSON to preserve exact HTTP response values; no human table formatter was introduced because the API responses are the operator-facing boundary.
