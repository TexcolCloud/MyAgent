# Pi-TUI Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TTY-only `myagent tui` workbench that manages the existing HTTP Model Control Plane and observes or approves durable Runs without direct access to SQLite, Secrets, tools, or Pi-AI.

**Architecture:** The workbench is an authenticated local client, not another service layer. It uses `CliClient` with distinct Run and Admin credentials, consumes committed Run SSE with an event cursor, reuses the existing model setup lifecycle through a `CliPrompt` implementation, and renders a three-region Pi-TUI application with safe control-plane data only.

**Tech Stack:** Node.js 24, TypeScript 5.9 ESM, Commander 14, existing HTTP/SSE API, `@mariozechner/pi-tui@0.73.1`, Vitest 3.

## Global Constraints

- Complete `2026-08-11-pi-ai-provider-runtime.md` before this plan; the TUI consumes its Driver/Candidate control-plane API rather than importing Pi-AI.
- Pin `@mariozechner/pi-tui` to exact `0.73.1` alongside `@mariozechner/pi-ai`.
- Start only with an interactive TTY; non-TTY, redirected, and CI invocations return a stable error.
- Keep distinct Run Token and Admin Token only in process memory. Do not write either token, provider Secret, authorization header, raw provider payload, or unredacted log to terminal history or disk.
- Use Run Token for Run ingress, state, SSE, and Approvals; use Admin Token only for Model Control Plane calls.
- All Provider/Model mutations carry the server's expected record revision. A `revision_conflict` requires reload and a fresh Operator choice.
- Every Approval screen decides one exact pending Tool Call through the existing API. Do not implement session-wide permissions or local Tool execution.
- Preserve existing command grammar, `--json`, and non-interactive CLI behavior.
- Verify on Windows and Linux without real provider credentials.

---

## File Structure

- Create: `src/interfaces/tui/tty.ts` - terminal capability validation and safe process lifecycle.
- Create: `src/interfaces/tui/credentials.ts` - hidden Run/Admin credential acquisition without persistence.
- Create: `src/interfaces/tui/tui-client.ts` - typed HTTP/SSE facade over `CliClient`.
- Create: `src/interfaces/tui/run-event-stream.ts` - SSE parser and cursor-preserving Run view state.
- Create: `src/interfaces/tui/pi-tui-prompt.ts` - `CliPrompt` adapter for model setup dialogs.
- Create: `src/interfaces/tui/workbench.ts` - Pi-TUI startup, region composition, focus routing, and shutdown.
- Create: `src/interfaces/tui/screens/navigation.ts`, `src/interfaces/tui/screens/chat.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/screens/model-setup.ts`, `src/interfaces/tui/screens/approvals.ts`.
- Create: `test/unit/tui-tty.test.ts`, `test/unit/tui-credentials.test.ts`, `test/unit/run-event-stream.test.ts`, `test/unit/pi-tui-prompt.test.ts`, `test/integration/tui-client.test.ts`, `test/integration/tui-workbench.test.ts`.
- Modify: `src/interfaces/cli/main.ts`, `src/interfaces/cli/client.ts`, `src/interfaces/cli/commands/model-setup.ts`, `src/interfaces/cli/commands/runs.ts`, `src/interfaces/cli/formatters.ts`, `package.json`, `package-lock.json`, `docs/operations/model-registry.md`, `README.md` if it exists.

## Target Interfaces

```ts
// src/interfaces/tui/credentials.ts
export interface TuiCredentials {
  readonly runToken: string;
  readonly adminToken: string;
}

export async function readTuiCredentials(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly promptSecret: (label: string) => Promise<string>;
}): Promise<TuiCredentials>;
```

```ts
// src/interfaces/tui/run-event-stream.ts
export interface RunEventCursor {
  readonly runId: string;
  readonly lastEventId?: string;
}

export async function consumeRunEvents(input: {
  readonly client: CliClient;
  readonly cursor: RunEventCursor;
  readonly onEvent: (event: SafeRunEvent) => void;
  readonly signal: AbortSignal;
}): Promise<RunEventCursor>;
```

```ts
// src/interfaces/tui/workbench.ts
export interface TuiWorkbenchOptions {
  readonly client: TuiClient;
  readonly terminal: TuiTerminal;
  readonly prompt: CliPrompt;
}

export async function runWorkbench(options: TuiWorkbenchOptions): Promise<number>;
```

`SafeRunEvent` is built only from committed SSE fields already returned by `/v1/runs/:runId/events`; it does not have a raw provider-payload property.

### Task 1: Add a TTY-Only TUI Entry Point and Dual Credential Handling

**Files:**
- Create: `src/interfaces/tui/tty.ts`, `src/interfaces/tui/credentials.ts`
- Modify: `src/interfaces/cli/main.ts`, `package.json`, `package-lock.json`
- Test: `test/unit/tui-tty.test.ts`, `test/unit/tui-credentials.test.ts`, `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: existing CLI error conventions and `createConsolePrompt().secret()` behavior.
- Produces: `assertInteractiveTty()`, `readTuiCredentials()`, and the `myagent tui` grammar entry for Tasks 2-6.

- [ ] **Step 1: Write failing terminal and credential tests**

```ts
it("rejects TUI startup when stdin or stdout is not a TTY", () => {
  expect(() => assertInteractiveTty({ stdinIsTTY: false, stdoutIsTTY: true }))
    .toThrow(expect.objectContaining({ code: "interactive_tty_required" }));
});

it("uses separate hidden inputs when Run and Admin tokens are absent", async () => {
  const labels: string[] = [];
  await expect(readTuiCredentials({
    environment: {},
    promptSecret: async (label) => { labels.push(label); return `${labels.length}`; },
  })).resolves.toEqual({ runToken: "1", adminToken: "2" });
  expect(labels).toEqual(["Run token", "Admin token"]);
});
```

Add a CLI integration test that `executeCli(["tui"], { stdinIsTTY: false, stdoutIsTTY: false })` returns the normal single Problem representation and never creates a TUI instance.

- [ ] **Step 2: Run the focused tests to verify TUI support is absent**

Run: `npm run test:unit -- test/unit/tui-tty.test.ts test/unit/tui-credentials.test.ts`

Run: `npm run test:integration -- test/integration/cli.test.ts`

Expected: FAIL because `tui` is not in command grammar and the TUI modules do not exist.

- [ ] **Step 3: Implement strict terminal and credential helpers**

`assertInteractiveTty()` checks both readable stdin and writable stdout TTY capability before importing or constructing `ProcessTerminal`. `readTuiCredentials()` uses `MYAGENT_RUN_TOKEN` and `MYAGENT_ADMIN_TOKEN` when present; otherwise it invokes hidden input once for each missing token, rejects blank values, and returns a frozen object. It must not mutate `process.env`, emit token values, or retain prompt buffers after resolution.

Add `tui` as a zero-positional command with explicit `--api-url`, `--token`, and `--admin-token` overrides. Parse CLI flags before terminal acquisition so malformed arguments return the existing usage error. Use the injected test seams in `ExecuteCliOptions` rather than reading global process streams in unit tests.

- [ ] **Step 4: Run focused TTY and command grammar tests**

Run: `npm run test:unit -- test/unit/tui-tty.test.ts test/unit/tui-credentials.test.ts`

Run: `npm run test:integration -- test/integration/cli.test.ts`

Expected: PASS; non-TTY processes get `interactive_tty_required`, and no token appears in captured output.

- [ ] **Step 5: Commit the safe TUI bootstrap**

```powershell
git add src/interfaces/tui/tty.ts src/interfaces/tui/credentials.ts src/interfaces/cli/main.ts package.json package-lock.json test/unit/tui-tty.test.ts test/unit/tui-credentials.test.ts test/integration/cli.test.ts
git commit -m "feat: add tty-only tui entrypoint"
```

### Task 2: Build a Typed Control-Plane and SSE Client

**Files:**
- Create: `src/interfaces/tui/tui-client.ts`, `src/interfaces/tui/run-event-stream.ts`
- Modify: `src/interfaces/cli/client.ts`, `src/interfaces/cli/commands/runs.ts`
- Test: `test/unit/run-event-stream.test.ts`, `test/integration/tui-client.test.ts`

**Interfaces:**
- Consumes: Task 1 `TuiCredentials`, existing `CliClient.request()` and `CliClient.stream()`.
- Produces: typed Run/Admin operations and cursor-preserving committed event consumption for Tasks 3-6.

- [ ] **Step 1: Write failing token-authority and reconnect tests**

```ts
it("uses the Run token for run creation and the Admin token for Driver listing", async () => {
  const client = new TuiClient({ runToken: "run", adminToken: "admin", fetcher });
  await client.createRun({ agentId: "primary", sessionKey: "terminal", text: "hello" });
  await client.listProviderDrivers();
  expect(capturedAuthorizations).toEqual(["Bearer run", "Bearer admin"]);
});

it("reconnects using the last committed SSE event ID", async () => {
  const cursor = await consumeRunEvents({ client, cursor: { runId: "run_1" }, onEvent, signal });
  expect(cursor).toEqual({ runId: "run_1", lastEventId: "12" });
  await consumeRunEvents({ client, cursor, onEvent, signal });
  expect(lastEventIdHeaders).toContain("12");
});
```

Add parser tests for comments, split chunks, terminal events, invalid event data, and abort. Treat invalid SSE payloads as a safe client error without rendering arbitrary raw text.

- [ ] **Step 2: Run focused client tests to verify the facade is missing**

Run: `npm run test:unit -- test/unit/run-event-stream.test.ts`

Run: `npm run test:integration -- test/integration/tui-client.test.ts`

Expected: FAIL because `TuiClient` and `consumeRunEvents()` do not exist.

- [ ] **Step 3: Implement authority-separated methods and safe event parsing**

`TuiClient` composes two `CliClient` instances with the same API URL: one configured with `bearerToken` and one with `adminToken`. Its methods use the appropriate instance:

```ts
createRun(input)              // Run client, POST /v1/runs
getRun(runId)                 // Run client, GET /v1/runs/:runId
decideApproval(id, decision)  // Run client, POST /v1/approvals/:id/decision
listPendingApprovals()        // Run client, GET /v1/approvals?status=pending
listProviderDrivers()         // Admin client, GET /v1/admin/provider-drivers
```

Implement an SSE line parser that stores the greatest numeric event ID only after decoding a complete safe event. On network interruption, return the cursor to the caller; the workbench chooses bounded reconnect timing and never creates a second Run.

- [ ] **Step 4: Run client and cursor regressions**

Run: `npm run test:unit -- test/unit/run-event-stream.test.ts`

Run: `npm run test:integration -- test/integration/tui-client.test.ts`

Expected: PASS; each endpoint receives only its intended token and reconnecting sends `Last-Event-ID`.

- [ ] **Step 5: Commit the TUI transport facade**

```powershell
git add src/interfaces/tui/tui-client.ts src/interfaces/tui/run-event-stream.ts src/interfaces/cli/client.ts src/interfaces/cli/commands/runs.ts test/unit/run-event-stream.test.ts test/integration/tui-client.test.ts
git commit -m "feat: add tui control-plane client"
```

### Task 3: Adapt the Existing Model Setup Lifecycle to Pi-TUI Dialogs

**Files:**
- Create: `src/interfaces/tui/pi-tui-prompt.ts`, `src/interfaces/tui/screens/model-setup.ts`
- Modify: `src/interfaces/cli/commands/model-setup.ts`, `src/interfaces/cli/commands/providers.ts`, `src/interfaces/cli/commands/models.ts`
- Test: `test/unit/pi-tui-prompt.test.ts`, `test/integration/model-cli.test.ts`, `test/integration/tui-workbench.test.ts`

**Interfaces:**
- Consumes: existing `CliPrompt`, `setupModel()`, and Task 2 `TuiClient` Admin methods.
- Produces: `PiTuiPrompt implements CliPrompt` and a wizard screen that performs the exact existing draft/discover/select/verify/promote/assign lifecycle for Task 5.

- [ ] **Step 1: Write failing prompt and wizard lifecycle tests**

```ts
it("never renders a secret answer in Pi-TUI output", async () => {
  const prompt = new PiTuiPrompt(fakeDialogs(["provider-key"]));
  await expect(prompt.secret("API key")).resolves.toBe("provider-key");
  expect(fakeDialogs.renderedText()).not.toContain("provider-key");
});

it("requires explicit promotion after a successful verification", async () => {
  const outcome = await runModelSetupScreen({ prompt: declinePromotionPrompt, client, write });
  expect(outcome).toEqual({ status: "cancelled" });
  expect(requests.some((request) => request.path.endsWith("/promotions"))).toBe(false);
});
```

Add a native candidate test: the screen labels a Pi catalog model separately from remote discovery, sends only its selected Driver/Candidate identifier to Admin API, and shows an unsupported credential candidate as disabled.

- [ ] **Step 2: Run focused wizard tests to verify no Pi-TUI prompt exists**

Run: `npm run test:unit -- test/unit/pi-tui-prompt.test.ts`

Run: `npm run test:integration -- test/integration/model-cli.test.ts test/integration/tui-workbench.test.ts`

Expected: FAIL because no Pi-TUI `CliPrompt` implementation or wizard screen exists.

- [ ] **Step 3: Implement modal prompt composition without duplicating control-plane logic**

Build `PiTuiPrompt` around Pi-TUI `SelectList`, `Editor`, confirmation overlay, and a masked editor for `secret()`. Resolve exactly one pending prompt promise at a time; Escape returns a cancellation result that `setupModel()` maps to its existing safe cancellation path. Clear the secret component value before removing the overlay.

Refactor only the presentation seams in `model-setup.ts`: keep its HTTP request order and mutation checks unchanged, but export a typed progress callback that screens can render as safe lifecycle labels. The screen invokes the existing setup service with `PiTuiPrompt`, an Admin-authenticated `CliClient`, and a captured safe write sink. It must not duplicate discovery, verification polling, Promotion, or Assignment requests.

- [ ] **Step 4: Run model setup and TUI wizard regressions**

Run: `npm run test:unit -- test/unit/pi-tui-prompt.test.ts`

Run: `npm run test:integration -- test/integration/model-cli.test.ts test/integration/tui-workbench.test.ts`

Expected: PASS; normal interactive CLI remains unchanged, secret values never render, and Promotion stays explicit.

- [ ] **Step 5: Commit the reusable setup wizard**

```powershell
git add src/interfaces/tui/pi-tui-prompt.ts src/interfaces/tui/screens/model-setup.ts src/interfaces/cli/commands/model-setup.ts src/interfaces/cli/commands/providers.ts src/interfaces/cli/commands/models.ts test/unit/pi-tui-prompt.test.ts test/integration/model-cli.test.ts test/integration/tui-workbench.test.ts
git commit -m "feat: add pi tui model setup wizard"
```

### Task 4: Implement the Three-Region Workbench Shell and Safe Navigation

**Files:**
- Create: `src/interfaces/tui/workbench.ts`, `src/interfaces/tui/screens/navigation.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/screens/chat.ts`
- Modify: `src/interfaces/cli/main.ts`
- Test: `test/integration/tui-workbench.test.ts`, `test/unit/tui-tty.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 TTY, credentials, `TuiClient`, event stream, and setup screen.
- Produces: `runWorkbench()` with stable navigation/main/inspection regions for Tasks 5-6.

- [ ] **Step 1: Write failing rendering and shutdown tests**

```ts
it("renders three bounded regions and restores the terminal on exit", async () => {
  const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
  await runWorkbench({ client, terminal, prompt });
  expect(terminal.frames.at(-1)).toContain("Runs");
  expect(terminal.frames.at(-1)).toContain("Inspect");
  expect(terminal.stopCalls).toBe(1);
});

it("does not render a raw provider response or token in inspector text", async () => {
  const screen = new InspectorScreen();
  screen.showProblem({ code: "provider_unavailable", detail: "safe detail", traceId: "t_1" });
  expect(screen.render(40).join("\n")).not.toContain("Authorization");
});
```

Add narrow-width tests that assert every line is no wider than the supplied Pi-TUI render width and does not overlap its region.

- [ ] **Step 2: Run workbench tests to prove the shell is absent**

Run: `npm run test:integration -- test/integration/tui-workbench.test.ts`

Expected: FAIL because `runWorkbench()` and screen components do not exist.

- [ ] **Step 3: Compose Pi-TUI regions with deterministic focus and cleanup**

Use `new TUI(new ProcessTerminal())` only after Task 1 validates TTY. Mount a fixed navigation region, focusable main region, and inspector region inside a root container. Give each custom component `render(width): string[]` logic that truncates or wraps safe text before returning it. Bind navigation keys through `matchesKey`; Ctrl+C aborts active streams, closes overlays, calls `tui.stop()`, and returns a normal exit code.

Navigation loads Agents, Runs, providers, profiles, and verifications only through `TuiClient`; inspector receives a typed safe view model, not arbitrary `unknown` JSON. Do not retain a secret or token in screen state after its request has completed.

- [ ] **Step 4: Run shell rendering and cleanup tests**

Run: `npm run test:unit -- test/unit/tui-tty.test.ts`

Run: `npm run test:integration -- test/integration/tui-workbench.test.ts`

Expected: PASS; shell startup is TTY-only, regions remain bounded, and stop is called exactly once on normal or Ctrl+C exit.

- [ ] **Step 5: Commit the workbench shell**

```powershell
git add src/interfaces/tui/workbench.ts src/interfaces/tui/screens/navigation.ts src/interfaces/tui/screens/inspector.ts src/interfaces/tui/screens/chat.ts src/interfaces/cli/main.ts test/unit/tui-tty.test.ts test/integration/tui-workbench.test.ts
git commit -m "feat: add pi tui workbench shell"
```

### Task 5: Add Durable Chat, Run Observation, and Exact Approvals

**Files:**
- Create: `src/interfaces/tui/screens/approvals.ts`
- Modify: `src/interfaces/tui/screens/chat.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/workbench.ts`
- Test: `test/unit/run-event-stream.test.ts`, `test/integration/tui-workbench.test.ts`, `test/integration/approval-resume.test.ts`, `test/integration/sse.test.ts`

**Interfaces:**
- Consumes: Task 2 `TuiClient.createRun()`, `consumeRunEvents()`, and `decideApproval()`.
- Produces: chat submission bound to one Agent/Session Key, cursor-recoverable Run display, and one-Approval decision actions.

- [ ] **Step 1: Write failing Run and Approval interaction tests**

```ts
it("creates one Run and resumes its committed stream after reconnect", async () => {
  await chat.submit({ agentId: "primary", sessionKey: "tui:main", text: "read status" });
  expect(createRunCalls).toHaveLength(1);
  await disconnectAndReconnect();
  expect(lastEventIdHeaders.at(-1)).toBe("4");
});

it("approves one exact pending Tool Call through the Run authority", async () => {
  await approvals.select("apr_1");
  await approvals.decide("approved");
  expect(decisionBodies).toEqual([{ approvalId: "apr_1", decision: "approved" }]);
  expect(decisionAuthorizations).toEqual(["Bearer run-token"]);
});
```

Add a `run_command` risk-notice assertion and a failure assertion that a second decision is rendered from the server's terminal state rather than locally guessed.

- [ ] **Step 2: Run focused durable-event and Approval tests to verify interaction is absent**

Run: `npm run test:unit -- test/unit/run-event-stream.test.ts`

Run: `npm run test:integration -- test/integration/tui-workbench.test.ts test/integration/approval-resume.test.ts test/integration/sse.test.ts`

Expected: FAIL because chat and Approval screens do not invoke the authenticated Run API.

- [ ] **Step 3: Implement Run-owned screen actions**

Chat requires explicit Agent ID and Session Key before enabling submit. On submit, call `TuiClient.createRun()` once with an idempotency key, retain the returned Run ID, and display only committed events emitted by `consumeRunEvents()`. On disconnect, retain the last safe cursor and offer reconnect; do not replay user input or create a duplicate Run.

ApprovalScreen loads `/v1/approvals?status=pending`, displays tool name, safe arguments, expiration, and the existing `run_command` risk notice. Its approve/deny controls call the existing decision endpoint once and refresh from the server response. Disable local controls after dispatch until the response returns.

- [ ] **Step 4: Run durable interaction regressions**

Run: `npm run test:integration -- test/integration/tui-workbench.test.ts test/integration/approval-resume.test.ts test/integration/sse.test.ts`

Expected: PASS; chat uses one persisted Run, SSE resumes by cursor, and Approvals remain exact and server-authoritative.

- [ ] **Step 5: Commit Run and Approval flows**

```powershell
git add src/interfaces/tui/screens/chat.ts src/interfaces/tui/screens/approvals.ts src/interfaces/tui/screens/inspector.ts src/interfaces/tui/workbench.ts test/unit/run-event-stream.test.ts test/integration/tui-workbench.test.ts test/integration/approval-resume.test.ts test/integration/sse.test.ts
git commit -m "feat: add tui run and approval workflows"
```

### Task 6: Surface Optimistic Conflicts and Complete Cross-Platform Release Proof

**Files:**
- Modify: `src/interfaces/tui/tui-client.ts`, `src/interfaces/tui/screens/model-setup.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/workbench.ts`, `docs/operations/model-registry.md`
- Test: `test/integration/tui-workbench.test.ts`, `test/integration/http-model-control.test.ts`, `test/e2e/multi-provider-models.test.ts`, full `npm run check`

**Interfaces:**
- Consumes: Tasks 1-5 workbench and the existing `CliHttpError` representation of `revision_conflict`.
- Produces: visible reload-required conflict state, accurate operations guidance, and final Windows/Linux-safe release evidence.

- [ ] **Step 1: Write failing conflict and redaction tests**

```ts
it("requires reload after a revision conflict instead of replaying Promotion", async () => {
  const result = await screen.promote({ profileRevisionId: "mpr_1", expectedRevision: 2 });
  expect(result).toEqual({ state: "conflict", reloadRequired: true });
  expect(promotionRequests).toHaveLength(1);
  expect(screen.render(80).join("\n")).toContain("Reload required");
});

it("never includes an API key in a rendered conflict or setup review", () => {
  expect(screen.render(80).join("\n")).not.toContain("provider-secret");
});
```

- [ ] **Step 2: Run focused conflict tests to verify the UI does not yet handle them**

Run: `npm run test:integration -- test/integration/tui-workbench.test.ts test/integration/http-model-control.test.ts`

Expected: FAIL because the workbench has no explicit `revision_conflict` state.

- [ ] **Step 3: Implement explicit conflict recovery and documentation**

Catch only `CliHttpError` with `code === "revision_conflict"` in mutation screens. Clear the stale review, preserve no pending Secret or confirmation, show a safe reload-required message, and require the Operator to fetch current state before re-entering the wizard or Promotion action. Re-throw all other errors into the safe inspector path.

Document `myagent tui` prerequisites, both token sources, TTY-only behavior, catalog-versus-discovery labels, cursor reconnection, explicit Approval semantics, and conflict reload behavior. Do not document a persistent token file or direct database access.

- [ ] **Step 4: Run the full release gate**

Run: `npm run check`

Expected: PASS with lint, typecheck, all tests, build, and postbuild. On both operating systems, the opt-in live-provider test remains skipped without credentials.

- [ ] **Step 5: Commit TUI release proof and operations documentation**

```powershell
git add src/interfaces/tui/tui-client.ts src/interfaces/tui/screens/model-setup.ts src/interfaces/tui/screens/inspector.ts src/interfaces/tui/workbench.ts docs/operations/model-registry.md test/integration/tui-workbench.test.ts test/integration/http-model-control.test.ts test/e2e/multi-provider-models.test.ts
git commit -m "test: prove pi tui workbench release gate"
```

## Plan Self-Review

- Spec coverage: Task 1 covers TTY-only and dual credentials; Task 2 covers separated HTTP/SSE authority; Task 3 covers the explicit Provider-to-Assignment wizard and hidden Secrets; Task 4 covers the three-region Pi-TUI shell; Task 5 covers durable chat, cursor recovery, and exact Approvals; Task 6 covers optimistic conflicts, redaction, documentation, and full release proof.
- Placeholder scan: every task includes exact files, typed interfaces, a failing test, a failing command, an implementation shape, a passing command, and a commit boundary.
- Type consistency: `TuiCredentials` feeds `TuiClient`; `TuiClient` and `RunEventCursor` feed the workbench; `PiTuiPrompt` implements the existing `CliPrompt`; all mutating screens consume the existing expected-revision API contract rather than inventing local write types.
