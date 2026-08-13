# Local Integrated Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `myagent`, `myagent tui`, and `myagent tui --local` safely own a random-port loopback service and TUI for one foreground session.

**Architecture:** Add an in-process Bootstrap authentication override, a project-state initializer, and a Local Integrated Host that composes Bootstrap with the existing HTTP/SSE TUI client. Preserve `serve` as an independent mode and keep all durable state under `.myagent/`.

**Tech Stack:** Node.js 24, TypeScript 5.9 ESM, Fastify 5, Commander-compatible existing parser, SQLite, YAML 2, Pi-TUI 0.73.1, Vitest 3.

## Global Constraints

- Do not pass Run/Admin tokens through argv, environment, logs, configuration, SQLite, shell history, or persisted diagnostics.
- Bind Local Integrated Mode to `127.0.0.1` and port `0`; random ports are not authorization.
- Keep HTTP/SSE as the only TUI control-plane boundary.
- Preserve durable Runs, Approvals, Model Registry, Secret Registry, and Project Agent State across local sessions.
- `serve` and `config validate` retain root `myagent.yaml` defaults; local mode defaults to `.myagent/myagent.yaml`.
- Noninteractive first use fails without filesystem mutation.
- Do not remove or deprecate resource CLI commands in this plan.

---

## File Structure

- Modify `src/bootstrap.ts` for explicit in-process HTTP auth injection.
- Create `src/interfaces/local/project-state.ts` for path resolution, inspection, consent-safe initialization, and minimum v2 YAML generation.
- Create `src/interfaces/local/local-host.ts` for token generation, service/TUI composition, and cleanup ownership.
- Create `src/interfaces/local/exit-impact.ts` for active Run/pending Approval exit summaries.
- Modify `src/interfaces/cli/main.ts`, `src/interfaces/tui/workbench.ts`, `src/interfaces/tui/credentials.ts`, `src/interfaces/tui/tui-client.ts`, and Run HTTP/store adapters.
- Create focused unit/integration tests under `test/unit/local-*.test.ts` and `test/integration/local-*.test.ts`; extend existing bootstrap, CLI, TUI, restart, and secret-leak suites.

### Task 1: Add a Bootstrap Authentication Override

**Files:**
- Modify: `src/bootstrap.ts`
- Test: `test/integration/bootstrap.test.ts`, `test/integration/secret-leak.test.ts`

**Interfaces:**
- Consumes: existing `BootstrapOptions`, `EnvironmentSecretResolver`, and `createHttpApp()`.
- Produces: `BootstrapOptions.auth?: { readonly bearerToken: string; readonly adminToken: string }`.

- [ ] **Step 1: Write failing override tests**

```ts
const service = await bootstrap(configPath, {
  auth: { bearerToken: "local-run", adminToken: "local-admin" },
  listen: { host: "127.0.0.1", port: 0 },
  signals: false,
});
expect(await fetch(`${service.url}/v1/agents`, {
  headers: { authorization: "Bearer local-run" },
})).toMatchObject({ status: 200 });
expect(environmentResolveCalls).toBe(0);
```

Also capture structured log lines and assert neither injected value occurs on startup, auth failure, or shutdown.

- [ ] **Step 2: Run tests and observe the missing option**

Run: `npm run test:integration -- test/integration/bootstrap.test.ts test/integration/secret-leak.test.ts`

Expected: FAIL because `BootstrapOptions.auth` does not exist and configured token references are still resolved.

- [ ] **Step 3: Implement the minimal auth selection**

```ts
const auth = options.auth ?? {
  bearerToken: environmentSecrets.resolve(bootConfig.server.bearerToken),
  adminToken: environmentSecrets.resolve(bootConfig.server.adminToken),
};
const { bearerToken, adminToken } = auth;
```

Freeze the supplied auth object at its creator, register both values with dynamic redaction before any log write, require nonempty distinct values, and do not mutate `process.env`.

- [ ] **Step 4: Run focused and auth regressions**

Run: `npm run test:integration -- test/integration/bootstrap.test.ts test/integration/http-auth.test.ts test/integration/secret-leak.test.ts`

Expected: PASS with configured Secret references unchanged in Explicit Service Mode.

- [ ] **Step 5: Commit**

```powershell
git add src/bootstrap.ts test/integration/bootstrap.test.ts test/integration/secret-leak.test.ts
git commit -m "feat: support in-process bootstrap auth"
```

### Task 2: Create Consent-safe Project Agent State

**Files:**
- Create: `src/interfaces/local/project-state.ts`
- Test: `test/unit/local-project-state.test.ts`, `test/fixtures/config/local-minimal/myagent.yaml`
- Modify: `src/config/schemas.ts`

**Interfaces:**
- Produces:

```ts
export interface LocalProjectPaths {
  readonly workspace: string;
  readonly root: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly agentsRoot: string;
  readonly skillsRoot: string;
}
export function resolveLocalProjectPaths(workspace: string, configPath?: string): LocalProjectPaths;
export async function inspectProjectState(paths: LocalProjectPaths): Promise<"ready" | "absent" | "partial">;
export async function initializeProjectState(paths: LocalProjectPaths): Promise<void>;
```

- [ ] **Step 1: Write failing path and initialization tests**

```ts
expect(resolveLocalProjectPaths("C:\\repo").configPath)
  .toBe(path.resolve("C:\\repo", ".myagent", "myagent.yaml"));
await initializeProjectState(paths);
expect(await loadBootConfig(paths.configPath)).toMatchObject({ version: 2 });
expect(await readdir(paths.agentsRoot)).toEqual([]);
```

Cover explicit `--config`, absent state, partial-state rejection, repeated initialization rejection, and no Provider/Model/Agent/default fields.

- [ ] **Step 2: Run the unit test**

Run: `npm run test:unit -- test/unit/local-project-state.test.ts test/unit/config-schemas.test.ts`

Expected: FAIL because the local project module and minimum configuration contract are absent.

- [ ] **Step 3: Implement atomic minimum initialization**

Generate version 2 YAML with database path `state.sqlite`, empty `.myagent/agents` and `.myagent/skills` roots, loopback service defaults, and environment references `MYAGENT_BEARER_TOKEN`/`MYAGENT_ADMIN_TOKEN`. Write to a sibling temporary file with exclusive creation, rename only after validation, and remove only that known temporary file on failure. Do not create an Agent.

- [ ] **Step 4: Verify initialization and legacy compatibility**

Run: `npm run test:unit -- test/unit/local-project-state.test.ts test/unit/boot-config.test.ts test/unit/config-schemas.test.ts`

Expected: PASS; root `myagent.yaml` is not selected unless explicitly supplied.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/local/project-state.ts src/config/schemas.ts test/unit/local-project-state.test.ts test/fixtures/config/local-minimal/myagent.yaml
git commit -m "feat: initialize project-local agent state"
```

### Task 3: Compose the Local Integrated Host

**Files:**
- Create: `src/interfaces/local/local-host.ts`
- Test: `test/integration/local-host.test.ts`
- Modify: `src/interfaces/tui/tui-client.ts`

**Interfaces:**
- Consumes: Tasks 1-2, `bootstrap()`, `TuiClient`, and `runWorkbench()`.
- Produces:

```ts
export interface LocalHostDependencies {
  readonly bootstrapService: typeof bootstrap;
  readonly generateToken: () => string;
  readonly runTui: (options: RunWorkbenchOptions) => Promise<number>;
}
export async function runLocalHost(input: {
  readonly configPath: string;
  readonly dependencies?: Partial<LocalHostDependencies>;
}): Promise<number>;
```

- [ ] **Step 1: Write failing ownership tests**

Test distinct 32-byte base64url CSPRNG tokens, `listen: { host: "127.0.0.1", port: 0 }`, `signals: false`, returned URL use, and exactly-once shutdown after normal TUI exit, TUI throw, and startup failure.

- [ ] **Step 2: Run the host test**

Run: `npm run test:integration -- test/integration/local-host.test.ts`

Expected: FAIL because no Local Integrated Host exists.

- [ ] **Step 3: Implement try/finally ownership**

```ts
const service = await bootstrapService(input.configPath, {
  auth: Object.freeze({ bearerToken: runToken, adminToken }),
  listen: { host: "127.0.0.1", port: 0 },
  signals: false,
});
try {
  return await runTui({ client: new TuiClient({ apiUrl: service.url, runToken, adminToken }) });
} finally {
  await service.shutdown();
}
```

Zero token buffers owned by helpers after construction where practical; no value is included in thrown error text.

- [ ] **Step 4: Run lifecycle and recovery regressions**

Run: `npm run test:integration -- test/integration/local-host.test.ts test/integration/bootstrap.test.ts test/e2e/restart-recovery.test.ts`

Expected: PASS with SQLite reopenable after shutdown.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/local/local-host.ts src/interfaces/tui/tui-client.ts test/integration/local-host.test.ts
git commit -m "feat: compose local integrated host"
```

### Task 4: Route Local and Attached CLI Invocations Safely

**Files:**
- Modify: `src/interfaces/cli/main.ts`, `src/interfaces/tui/credentials.ts`
- Test: `test/integration/cli.test.ts`, `test/unit/tui-credentials.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3.
- Produces: unambiguous local/attached command routing and remote-origin consent.

- [ ] **Step 1: Write failing command matrix tests**

```ts
for (const args of [[], ["tui"], ["tui", "--local"]]) {
  expect(await executeCli(args, localOptions)).toBe(0);
}
expect(await executeCli(["tui", "--local", "--api-url", "http://127.0.0.1:1"], options)).toBe(2);
```

Cover no TTY/no writes, explicit first-run confirmation, legacy `serve`/`config validate` defaults, attached loopback credentials, non-loopback rejection, `--allow-remote` plus exact normalized-origin confirmation, and token flag rejection.

- [ ] **Step 2: Run CLI tests**

Run: `npm run test:integration -- test/integration/cli.test.ts`

Expected: FAIL because empty invocation and `--local` are not registered.

- [ ] **Step 3: Implement the command routing**

Add `local`, `config`, and `allow-remote` grammar where applicable. Resolve mode from syntax only. Perform Project Initialization consent before any write; Attached TUI credentials come only from named environment, credential helper seam, or masked prompt. Display normalized origin, TLS state, and source category without values before remote confirmation.

- [ ] **Step 4: Run CLI and credential tests**

Run: `npm run test:unit -- test/unit/tui-credentials.test.ts test/unit/tui-tty.test.ts`

Run: `npm run test:integration -- test/integration/cli.test.ts`

Expected: PASS with deterministic exit codes and no argv secret option.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/cli/main.ts src/interfaces/tui/credentials.ts test/integration/cli.test.ts test/unit/tui-credentials.test.ts
git commit -m "feat: make local tui the default entry"
```

### Task 5: Guard Exit with Durable Impact State

**Files:**
- Create: `src/interfaces/local/exit-impact.ts`
- Modify: `src/ports/run-store.ts`, `src/adapters/sqlite/run-repository.ts`, `src/interfaces/http/routes/runs.ts`, `src/interfaces/http/schemas.ts`, `src/interfaces/tui/tui-client.ts`, `src/interfaces/tui/workbench.ts`
- Test: `test/integration/http-runs.test.ts`, `test/integration/tui-workbench.test.ts`, `test/integration/local-host.test.ts`

**Interfaces:**
- Produces `GET /v1/runs?state=active`, `TuiClient.listActiveRuns()`, and:

```ts
export interface ExitImpact {
  readonly activeRuns: readonly { readonly runId: string; readonly status: RunStatus }[];
  readonly pendingApprovalCount: number;
}
```

- [ ] **Step 1: Write failing exit tests**

Assert clean exit needs no prompt; active Runs or pending Approvals render IDs/counts; decline resumes TUI; confirm permits shutdown; database state remains unchanged by impact inspection.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:integration -- test/integration/http-runs.test.ts test/integration/tui-workbench.test.ts test/integration/local-host.test.ts`

Expected: FAIL because active Run enumeration and exit guarding are absent.

- [ ] **Step 3: Add read-only enumeration and guarded exit**

Define active as `queued`, `running`, `waiting_approval`, or `cancelling`. Query through repositories and HTTP, not SQLite from the TUI. Workbench attempts to exit through an async `beforeExit` callback; only a confirmed result resolves the workbench.

- [ ] **Step 4: Verify durable semantics**

Run: `npm run test:integration -- test/integration/http-runs.test.ts test/integration/tui-workbench.test.ts test/integration/approval-resume.test.ts`

Run: `npm run test:e2e -- test/e2e/restart-recovery.test.ts test/e2e/responses-approval-restart.test.ts`

Expected: PASS; inspection and shutdown do not mark ambiguous work successful.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/local/exit-impact.ts src/ports/run-store.ts src/adapters/sqlite/run-repository.ts src/interfaces/http/routes/runs.ts src/interfaces/http/schemas.ts src/interfaces/tui/tui-client.ts src/interfaces/tui/workbench.ts test/integration/http-runs.test.ts test/integration/tui-workbench.test.ts test/integration/local-host.test.ts
git commit -m "feat: guard local exit with run impact"
```

### Task 6: Prove and Document the Local Product Boundary

**Files:**
- Modify: `docs/operations/model-registry.md`
- Create: `docs/operations/local-integrated-mode.md`
- Test: `test/integration/local-mode-secret-leak.test.ts`, `test/e2e/local-integrated-mode.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release evidence and operating guidance.

- [ ] **Step 1: Add end-to-end and leakage tests**

Spawn the built CLI in a controlled TTY fixture, approve initialization, observe a random loopback URL through an injected diagnostic seam, exit, and assert the listener closes and SQLite reopens. Seed sentinel tokens and recursively scan captured stdout/stderr, logs, `.myagent/`, and database text projections for their absence.

- [ ] **Step 2: Run the release slice**

Run: `npm run test:integration -- test/integration/local-mode-secret-leak.test.ts`

Run: `npm run test:e2e -- test/e2e/local-integrated-mode.test.ts test/e2e/restart-recovery.test.ts`

Expected: PASS on Windows and Linux without provider credentials.

- [ ] **Step 3: Write operations documentation**

Document the command matrix, first-run consent, `.myagent/` ownership, local versus attached credentials, foreground-only lifetime, exit impact, Explicit Service Mode, and recovery after interruption. Do not publish token transport shortcuts.

- [ ] **Step 4: Run the complete gate**

Run: `npm run check`

Expected: lint, typecheck, all deterministic tests, and build PASS.

- [ ] **Step 5: Commit**

```powershell
git add docs/operations/local-integrated-mode.md docs/operations/model-registry.md test/integration/local-mode-secret-leak.test.ts test/e2e/local-integrated-mode.test.ts
git commit -m "test: prove local integrated mode boundary"
```
