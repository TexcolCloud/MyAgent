# Final Local Integrated Mode Fix Report

## Finding

`inspectProjectState` ignored the resolved SQLite database path and its `-wal`
and `-shm` companions. With config and roots absent, any of those orphan
artifacts was classified as `absent`, allowing initialization to proceed over
historical database state.

## RED

Added deterministic table-driven unit coverage for each orphan artifact:

- `state.sqlite`
- `state.sqlite-wal`
- `state.sqlite-shm`

Each artifact has a classification case and an initialization case that asserts
rejection and exact byte preservation. Before the production change:

```text
npm run test:unit -- --run test/unit/local-project-state.test.ts
Test Files  1 failed (1)
Tests       6 failed | 9 passed (15)
```

The classification cases received `absent` instead of `partial`; the
initialization cases resolved instead of rejecting.

## GREEN

`inspectProjectState` now checks `databasePath`, `databasePath-wal`, and
`databasePath-shm` for any filesystem entry before returning `absent`. The
existing complete config/agents/skills state still returns `ready` first.

```text
npm run test:unit -- --run test/unit/local-project-state.test.ts
Test Files  1 passed (1)
Tests       15 passed (15)

npm run test:integration -- --run test/integration/cli.test.ts
Test Files  2 passed (2)
Tests       73 passed (73)

npm run test:e2e -- --run test/e2e/local-integrated-mode.test.ts
Test Files  1 passed (1)
Tests       1 passed (1)

npm run lint
exit 0

npm run typecheck
exit 0
```
