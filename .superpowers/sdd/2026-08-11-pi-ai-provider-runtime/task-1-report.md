# Task 1 Report: Pin Pi and Define Stable Runtime Contracts

## Implementation Summary

- Pinned `@mariozechner/pi-ai` and `@mariozechner/pi-tui` to exact `0.73.1` versions.
- Added pure Pi runtime contract types and a catalog adapter. The adapter is the sole project module importing Pi catalog functions (`getProviders`, `getModels`, and `getModel`).
- Project-owned `pi/<provider>` Driver IDs and catalog candidates are frozen. Candidate projections contain only safe catalog metadata, never Pi Base URLs, headers, API keys, or Secrets.
- Marked AWS, Azure-special-header, and OAuth/ambient-identity catalog families as `credentialSupport: "unsupported"`; bearer candidates remain visible as bearer-only metadata. Unsupported wildcard lookup exists solely to display the unavailable credential state and cannot select a runtime model.
- Extended `InvocationProtocol` with `pi_ai`, added optional `piRuntime` to Profile Revisions and effective snapshots, and added optional `providerDriver` to preserve the next persistence boundary without invalidating old data.
- `AgentResolver` snapshots the exact Profile Revision Pi contract and deep-freezes it. Serialized pre-0003 snapshot content remains representable with no `piRuntime`.
- Added `skipLibCheck` after the exact Pi dependency graph introduced errors in third-party declaration files. Project source remains checked by TypeScript.

## Changed Files

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/domain/pi-runtime.ts`
- `src/config/pi-runtime-catalog.ts`
- `src/domain/model-registry.ts`
- `src/domain/provider-connection.ts`
- `src/domain/model-profile.ts`
- `src/domain/agent-revision.ts`
- `src/application/agent-resolver.ts`
- `test/unit/pi-runtime-catalog.test.ts`
- `test/unit/agent-resolver.test.ts`

## TDD Evidence

### RED

Command:

```powershell
npm run test:unit -- test/unit/pi-runtime-catalog.test.ts test/unit/agent-resolver.test.ts
```

Result: exit 1. Vitest could not load `../../src/config/pi-runtime-catalog.js` because the module did not exist. The pre-existing resolver tests passed; the new catalog suite failed at its missing-contract import, as expected.

### GREEN

Command:

```powershell
npm run test:unit -- test/unit/pi-runtime-catalog.test.ts test/unit/model-registry.test.ts test/unit/agent-resolver.test.ts
```

Result: exit 0, 3 files passed, 24 tests passed.

## Verification

```powershell
npm run lint
# exit 0

npm run typecheck
# exit 0

npm run build
# exit 0
```

Catalog self-check: 969 projected candidates; every contract uses `piVersion: "0.73.1"`; no candidate or invocation object owns a Base URL, headers, API key, or Secret field.

## Self-Review

- Pi remains isolated to the adapter-side catalog module; domain contracts do not import Pi.
- The resolver copies only the stored Profile Revision contract and never derives a runtime from the mutable catalog.
- Optional fields retain representability for legacy revisions and serialized snapshots.
- The task adds no provider transport, discovery, verification, credentials, or runtime fallback behavior.
- The `"any"` unsupported lookup is limited to explanatory catalog metadata. It does not produce a usable candidate and must remain excluded from create/assign paths in Task 5.

## Concerns

- Pi `0.73.1` brings transitive SDK declaration issues under this repository's strict library checking (`undici-types`, optional MCP SDK, and DOM `ErrorEvent`). `skipLibCheck` is necessary for the project compiler to validate source code reliably; it does not suppress project-source errors.
- npm reported upstream deprecation notices for the exact, task-required `@mariozechner` packages. Versions remain pinned as required.
- A repository-wide `npm test` was started but reached the 120-second command cap before Vitest emitted a final summary. All suites reported before the timeout were passing; it is not recorded as a full-suite pass.
