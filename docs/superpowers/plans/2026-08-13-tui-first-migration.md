# TUI-first Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every ordinary Operator workflow in the TUI, formalize `/v1` automation, and phase resource-management CLI commands out without weakening safety or automation.

**Architecture:** Extend the existing authenticated `TuiClient` and Pi-TUI workbench over versioned HTTP/SSE resources. Add only the missing server query and controlled-mutation endpoints, then deprecate CLI commands after the TUI completion gate is proven.

**Tech Stack:** Node.js 24, TypeScript 5.9 ESM, Fastify 5, SQLite, Pi-TUI 0.73.1, Vitest 3, existing `/v1` HTTP/SSE contract.

## Global Constraints

- Complete `2026-08-13-local-integrated-mode.md` before this plan.
- TUI never opens SQLite, reads Secret plaintext, executes Tools, or calls provider adapters/Pi-AI directly.
- Every mutation carries an expected revision and treats conflict as reload-required; no silent retry or last-writer-wins.
- Approval authority remains one exact pending Tool Call.
- Secret plaintext, authorization headers, raw provider payloads, and unredacted logs never render.
- Keep deprecated resource CLI commands executable and tested through the next minor release.
- Remove deprecated commands only in a separately approved next-major change after the completion gate passes.
- `/v1` is the sole supported automation contract; do not add `myagent api`.

---

## File Structure

- Expand `src/interfaces/tui/tui-client.ts` into typed resource operations.
- Add focused screens for Providers, Profiles/Verifications, Agents/Assignments, Sessions/Runs, and Diagnostics under `src/interfaces/tui/screens/`.
- Extend HTTP routes/repositories only where list/detail or controlled Agent creation is missing.
- Create `src/application/create-managed-agent.ts` and `src/interfaces/http/routes/managed-agents.ts` for project-confined Agent creation.
- Create `src/interfaces/cli/commands/doctor.ts` and diagnostic services/adapters.
- Add `/v1` automation documentation and CLI deprecation metadata/tests.

### Task 1: Establish Typed TUI Resource Contracts

**Files:**
- Modify: `src/interfaces/tui/tui-client.ts`, `src/interfaces/http/model-control-schemas.ts`, `src/interfaces/http/schemas.ts`
- Test: `test/integration/tui-client.test.ts`, `test/unit/model-control-schemas.test.ts`

**Interfaces:**
- Produces typed list/detail/create/revise/promote/retire/discover/verify/assign methods with `expectedRevision` on every mutation.

- [ ] **Step 1: Write failing authority and shape tests**

```ts
await client.promoteProvider("deepseek", {
  connectionRevisionId: "pcr_2",
  expectedRevision: 3,
});
expect(lastRequest).toMatchObject({
  path: "/v1/admin/provider-connections/deepseek/promotions",
  authority: "admin",
  body: { connectionRevisionId: "pcr_2", expectedRevision: 3 },
});
```

Cover all Operator resources, Run/Admin token separation, safe error projection, and absence of any Secret-value response field.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:integration -- test/integration/tui-client.test.ts`

Run: `npm run test:unit -- test/unit/model-control-schemas.test.ts`

Expected: FAIL for methods and response projections not yet exposed by the client.

- [ ] **Step 3: Implement explicit typed methods**

Use named methods rather than screen-level `adminRequest()` calls. Reuse server schemas as the source of response shapes without importing Fastify handlers. Normalize `409 revision_conflict` to the existing reload-required state.

- [ ] **Step 4: Verify contracts**

Run: `npm run test:integration -- test/integration/tui-client.test.ts test/integration/http-model-control.test.ts`

Expected: PASS with exact authority selection.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/tui/tui-client.ts src/interfaces/http/model-control-schemas.ts src/interfaces/http/schemas.ts test/integration/tui-client.test.ts test/unit/model-control-schemas.test.ts
git commit -m "refactor: type tui resource contracts"
```

### Task 2: Complete Provider Workflows

**Files:**
- Create: `src/interfaces/tui/screens/providers.ts`
- Modify: `src/interfaces/tui/workbench.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/screens/model-setup.ts`
- Test: `test/integration/tui-providers.test.ts`, `test/integration/model-secret-leak.test.ts`

**Interfaces:**
- Consumes: Task 1 Provider methods.
- Produces: list/detail/create/revise/discover/promote/retire and health/Secret-reference status workflows.

- [ ] **Step 1: Write failing controlled-workflow tests**

Test masked managed-Secret entry, environment-reference entry by name, separate Catalog Candidate versus remote discovery labels, revision impact review, explicit confirmation, conflict reload, retirement impact, and locked/degraded states.

- [ ] **Step 2: Run Provider TUI tests**

Run: `npm run test:integration -- test/integration/tui-providers.test.ts test/integration/model-secret-leak.test.ts`

Expected: FAIL because Provider navigation is summary-only.

- [ ] **Step 3: Implement Provider screens**

Render stable selectable rows and a detail inspector. Build mutations as review objects containing resource ID, current revision, proposed revision, affected Profiles, and confirmation state. Clear secret input buffers after request construction and never retain them in screen models.

- [ ] **Step 4: Verify Provider lifecycle**

Run: `npm run test:integration -- test/integration/tui-providers.test.ts test/integration/http-model-control.test.ts test/integration/model-secret-leak.test.ts`

Expected: PASS; failed discovery or conflict cannot promote state.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/tui/screens/providers.ts src/interfaces/tui/workbench.ts src/interfaces/tui/screens/inspector.ts src/interfaces/tui/screens/model-setup.ts test/integration/tui-providers.test.ts test/integration/model-secret-leak.test.ts
git commit -m "feat: complete tui provider workflows"
```

### Task 3: Complete Profiles, Verification, and Assignment

**Files:**
- Create: `src/interfaces/tui/screens/profiles.ts`, `src/interfaces/tui/screens/verifications.ts`, `src/interfaces/tui/screens/assignments.ts`
- Modify: `src/interfaces/tui/workbench.ts`, `src/interfaces/tui/screens/inspector.ts`
- Test: `test/integration/tui-model-control.test.ts`, `test/integration/model-assignments.test.ts`, `test/integration/model-verification-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 Model methods.
- Produces: Profile revision/create, Verification queue/status/cancel, Promotion/retirement, default, and Agent Assignment workflows.

- [ ] **Step 1: Write failing lifecycle tests**

Test that unverified revisions cannot be promoted/assigned, Verification cancellation is explicit, promotion shows exact revision/capabilities, default changes do not rewrite existing assignments, and retirement preserves historical Runs.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:integration -- test/integration/tui-model-control.test.ts test/integration/model-assignments.test.ts`

Expected: FAIL because Profiles and Verifications lack interactive detail/actions.

- [ ] **Step 3: Implement controlled model workflows**

Use immutable revision IDs throughout selection and review. Poll only the returned Verification operation URL, allow cancellation with an AbortSignal, and require a separate confirmation for Promotion and Assignment.

- [ ] **Step 4: Verify model invariants**

Run: `npm run test:integration -- test/integration/tui-model-control.test.ts test/integration/model-assignments.test.ts test/integration/model-verification-worker.test.ts`

Expected: PASS with no automatic fallback, promotion, or assignment.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/tui/screens/profiles.ts src/interfaces/tui/screens/verifications.ts src/interfaces/tui/screens/assignments.ts src/interfaces/tui/workbench.ts src/interfaces/tui/screens/inspector.ts test/integration/tui-model-control.test.ts test/integration/model-assignments.test.ts test/integration/model-verification-worker.test.ts
git commit -m "feat: complete tui model control workflows"
```

### Task 4: Add Controlled Managed Agent Creation

**Files:**
- Create: `src/application/create-managed-agent.ts`, `src/interfaces/http/routes/managed-agents.ts`, `src/interfaces/tui/screens/agents.ts`
- Modify: `src/interfaces/http/app.ts`, `src/config/catalog-service.ts`, `src/interfaces/tui/tui-client.ts`, `src/interfaces/tui/workbench.ts`
- Test: `test/unit/create-managed-agent.test.ts`, `test/integration/http-managed-agents.test.ts`, `test/integration/tui-agents.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CreateManagedAgentInput {
  readonly id: string;
  readonly displayName: string;
  readonly prompt: string;
  readonly workspace: string;
  readonly policy: { readonly rules: readonly PolicyRule[] };
  readonly expectedCatalogRevision: string;
}
```

- [ ] **Step 1: Write failing confinement and atomicity tests**

Cover valid creation under `.myagent/agents/<id>`, path escape, duplicate ID, unmanaged Agent root, invalid policy, write failure before rename, reload conflict, and no implicit Model Assignment.

- [ ] **Step 2: Run Agent tests**

Run: `npm run test:unit -- test/unit/create-managed-agent.test.ts`

Run: `npm run test:integration -- test/integration/http-managed-agents.test.ts test/integration/tui-agents.test.ts`

Expected: FAIL because managed Agent creation is absent.

- [ ] **Step 3: Implement server-owned creation**

Write `agent.yaml`, `AGENT.md`, and `policy.yaml` into a new sibling temporary directory under the canonical managed root; validate using existing loaders; atomically rename; reload through `CatalogService`; remove only the known temporary directory on failure. Register the endpoint under `/v1/admin/agents` and expose a reviewed TUI flow.

- [ ] **Step 4: Verify Agent and assignment boundaries**

Run: `npm run test:unit -- test/unit/create-managed-agent.test.ts test/unit/catalog-service.test.ts`

Run: `npm run test:integration -- test/integration/http-managed-agents.test.ts test/integration/tui-agents.test.ts test/integration/model-assignments.test.ts`

Expected: PASS; creation grants no Tool authority and makes no default/assignment choice.

- [ ] **Step 5: Commit**

```powershell
git add src/application/create-managed-agent.ts src/interfaces/http/routes/managed-agents.ts src/interfaces/tui/screens/agents.ts src/interfaces/http/app.ts src/config/catalog-service.ts src/interfaces/tui/tui-client.ts src/interfaces/tui/workbench.ts test/unit/create-managed-agent.test.ts test/integration/http-managed-agents.test.ts test/integration/tui-agents.test.ts
git commit -m "feat: add controlled agent creation"
```

### Task 5: Complete Session and Run Operations

**Files:**
- Create: `src/interfaces/tui/screens/sessions.ts`, `src/interfaces/tui/screens/runs.ts`
- Modify: `src/ports/run-store.ts`, `src/ports/session-store.ts`, `src/adapters/sqlite/run-repository.ts`, `src/adapters/sqlite/session-repository.ts`, `src/interfaces/http/routes/runs.ts`, `src/interfaces/http/routes/sessions.ts`, `src/interfaces/tui/tui-client.ts`, `src/interfaces/tui/workbench.ts`, `src/interfaces/tui/screens/chat.ts`
- Test: `test/integration/http-runs.test.ts`, `test/integration/tui-runs.test.ts`, `test/integration/sse.test.ts`, `test/e2e/restart-recovery.test.ts`

**Interfaces:**
- Produces paginated/filterable Run and Session lists, detail, cancel/delete impact, and SSE resume by committed cursor.

- [ ] **Step 1: Write failing history tests**

Test Agent/Session filters, stable newest-first ordering with ID tie-break, bounded page size/cursor, terminal/nonterminal Run detail, cancel confirmation, Session deletion impact, and reconnect from the last committed event ID.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:integration -- test/integration/http-runs.test.ts test/integration/tui-runs.test.ts test/integration/sse.test.ts`

Expected: FAIL because ordinary history enumeration and screens are incomplete.

- [ ] **Step 3: Implement queries and screens**

Add repository query objects with maximum page size 100 and opaque cursor encoding. Keep Run Event order canonical. The TUI stores only resource IDs and committed SSE cursors, and refreshes detail after reconnect or cancellation.

- [ ] **Step 4: Verify restart behavior**

Run: `npm run test:integration -- test/integration/http-runs.test.ts test/integration/tui-runs.test.ts test/integration/sse.test.ts`

Run: `npm run test:e2e -- test/e2e/restart-recovery.test.ts`

Expected: PASS with Sessions isolated by `(agentId, sessionKey)` and durable Runs unchanged.

- [ ] **Step 5: Commit**

```powershell
git add src/interfaces/tui/screens/sessions.ts src/interfaces/tui/screens/runs.ts src/ports/run-store.ts src/ports/session-store.ts src/adapters/sqlite/run-repository.ts src/adapters/sqlite/session-repository.ts src/interfaces/http/routes/runs.ts src/interfaces/http/routes/sessions.ts src/interfaces/tui/tui-client.ts src/interfaces/tui/workbench.ts src/interfaces/tui/screens/chat.ts test/integration/http-runs.test.ts test/integration/tui-runs.test.ts test/integration/sse.test.ts test/e2e/restart-recovery.test.ts
git commit -m "feat: add tui session and run history"
```

### Task 6: Add Exact Approval and Read-only Diagnostic Workflows

**Files:**
- Create: `src/application/collect-diagnostics.ts`, `src/interfaces/cli/commands/doctor.ts`, `src/interfaces/tui/screens/diagnostics.ts`
- Modify: `src/interfaces/cli/main.ts`, `src/interfaces/http/routes/health.ts`, `src/interfaces/http/app.ts`, `src/interfaces/tui/screens/approvals.ts`, `src/interfaces/tui/screens/inspector.ts`, `src/interfaces/tui/workbench.ts`
- Test: `test/unit/collect-diagnostics.test.ts`, `test/integration/doctor.test.ts`, `test/integration/tui-diagnostics.test.ts`, `test/integration/approval-resume.test.ts`

**Interfaces:**
- Produces a redacted diagnostic report with check `id`, `status`, and safe `detail`, available as human/JSON CLI and Admin HTTP/TUI projection.

- [ ] **Step 1: Write failing diagnostic safety tests**

Test config readability, `.myagent` permissions, SQLite/migrations, Secret-reference resolvability without values, worker/readiness, provider gateway, TTY, and binding. Snapshot human/JSON output and assert no mutation calls or sentinel secrets.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:unit -- test/unit/collect-diagnostics.test.ts`

Run: `npm run test:integration -- test/integration/doctor.test.ts test/integration/tui-diagnostics.test.ts test/integration/approval-resume.test.ts`

Expected: FAIL because `doctor` and full diagnostics are absent.

- [ ] **Step 3: Implement read-only diagnostics and Approval detail**

Each check catches its own failure and emits a stable safe code. Human output derives from the same report as JSON. Approval detail continues to show only exact Tool name, safe arguments, Run ID, expiry, and decision; it never creates a session-wide grant.

- [ ] **Step 4: Verify diagnostics and Approval safety**

Run: `npm run test:integration -- test/integration/doctor.test.ts test/integration/tui-diagnostics.test.ts test/integration/approval-resume.test.ts test/integration/secret-leak.test.ts`

Expected: PASS with no implicit repair.

- [ ] **Step 5: Commit**

```powershell
git add src/application/collect-diagnostics.ts src/interfaces/cli/commands/doctor.ts src/interfaces/tui/screens/diagnostics.ts src/interfaces/cli/main.ts src/interfaces/http/routes/health.ts src/interfaces/http/app.ts src/interfaces/tui/screens/approvals.ts src/interfaces/tui/screens/inspector.ts src/interfaces/tui/workbench.ts test/unit/collect-diagnostics.test.ts test/integration/doctor.test.ts test/integration/tui-diagnostics.test.ts test/integration/approval-resume.test.ts
git commit -m "feat: add secret-safe operator diagnostics"
```

### Task 7: Deprecate CLI Resources and Publish `/v1` Automation

**Files:**
- Create: `docs/operations/http-automation-v1.md`, `docs/operations/tui-first-workflows.md`
- Modify: `src/interfaces/cli/main.ts`, `docs/operations/model-registry.md`, `package.json`
- Test: `test/integration/cli.test.ts`, `test/integration/model-cli.test.ts`, `test/contract/http-automation-v1.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 and the existing `/v1` routes.
- Produces: one-minor deprecation behavior and a machine-verifiable Automation Surface inventory.

- [ ] **Step 1: Write failing migration-contract tests**

Assert the public help inventory contains only `myagent`, `tui`, `serve`, `config validate`, `doctor`, and `backup`; deprecated commands still execute and emit one stderr notice; JSON stdout remains parseable; Recovery Commands require explicit internal spelling; every documented route exists in the Fastify route inventory.

- [ ] **Step 2: Run CLI and contract tests**

Run: `npm run test:integration -- test/integration/cli.test.ts test/integration/model-cli.test.ts`

Run: `npm run test:contract -- test/contract/http-automation-v1.test.ts`

Expected: FAIL because deprecation metadata and the Automation Surface document are absent.

- [ ] **Step 3: Implement the minor-release boundary**

Centralize command visibility and lifecycle as `public`, `deprecated`, or `internal`. Emit deprecation notices to stderr only, preserve existing exit codes and JSON stdout, and keep all current command handlers until the next-major removal. Do not introduce an API wrapper command.

- [ ] **Step 4: Document exact automation and TUI workflows**

Document authentication authority, idempotency, revisions/conflicts, pagination, SSE resume, error shapes, Secret handling, backups, and each supported `/v1` route. Document the CLI removal version boundary and equivalent TUI/HTTP path.

- [ ] **Step 5: Run the complete release gate**

Run: `npm run check`

Expected: lint, typecheck, deterministic unit/contract/integration/e2e tests, and build PASS; live provider smoke remains opt-in.

- [ ] **Step 6: Commit**

```powershell
git add docs/operations/http-automation-v1.md docs/operations/tui-first-workflows.md docs/operations/model-registry.md src/interfaces/cli/main.ts package.json test/integration/cli.test.ts test/integration/model-cli.test.ts test/contract/http-automation-v1.test.ts
git commit -m "docs: establish tui-first automation boundary"
```
