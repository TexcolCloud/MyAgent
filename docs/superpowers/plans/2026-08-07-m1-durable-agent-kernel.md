# M1 Durable Agent Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M1 vertical slice in which an authenticated HTTP request creates a durable, Agent-scoped Run that can activate a Skill, call policy-governed Tools, pause for exact human Approval, survive restart, reconcile ambiguous side effects, delegate once, and finish through replayable SSE.

**Architecture:** Implement one ESM TypeScript package and one Node.js 24 LTS service process. Domain rules and application use cases depend on narrow Ports; a SQLite adapter owns transactional state, Fastify exposes the HTTP boundary, a reference CLI uses only that boundary, and a leased worker advances one durable boundary at a time. M2 Memory/RAG, M3 Feishu, and M4 Scheduler are not scaffolded in this plan.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9, npm, Fastify 5, Zod 4, YAML 2, OpenAI Node SDK 5, Node `node:sqlite`, Commander 14, RFC 8785 `canonicalize` 2, UUID 11, Vitest 3, fast-check 4, ESLint 9.

## Global Constraints

- The product has one trusted Operator and listens on `127.0.0.1` by default; binding elsewhere requires explicit configuration and a security warning.
- Every `/v1/*` endpoint requires a static Bearer Token except `/healthz` and `/readyz`; token values come from environment references and are compared in constant time.
- The HTTP API is the behavioral boundary. Operational CLI commands use HTTP and never open SQLite directly; `serve` composes the process and `config validate` may invoke the pure file validator without opening SQLite.
- Session identity is exactly `(agentId, sessionKey)`; one blocking Run per Session is allowed and queued Runs execute FIFO.
- Stable input limits are copied from the specification: `agentId` is a lowercase ASCII slug of 1-63 characters, `sessionKey` is 1-200 characters from `[A-Za-z0-9._:@/-]`, and `Idempotency-Key` is printable ASCII of 8-128 characters.
- Default Run limits are 20 model turns, 12 Tool Calls, four child Runs, delegation depth one, 900 active seconds, 120-second default Tool timeout capped at 600 seconds, 1 MiB output per Tool Call, 8 MiB aggregate Tool output per Run, and one Tool Call per model turn.
- Every Run snapshots its effective Agent prompt, model, Skill catalog bodies, Tool Policy, Workspace, delegate allowlist, and limits; reload affects only later Runs.
- Tool Policy is ordered first-match `allow | ask | deny`; no match is `deny`. Skill metadata never grants Tool authority.
- `run_command` uses structured `program + args[]`, `shell: false`, a Workspace-bound `cwd`, an environment allowlist, process-tree cancellation, timeout, and output caps. It is explicitly not an OS sandbox.
- A side-effecting Tool left in `executing` after lease loss becomes `unknown`; the system never retries it automatically.
- Run state changes and their matching Run Events commit in one SQLite transaction; SSE exposes persisted events only and replays from `Last-Event-ID`.
- Secrets, authorization headers, resolved Tool environment values, raw provider payloads, and configured sensitive keys must be redacted from logs, events, errors, and snapshots.
- Core automated suites run on Windows and Linux without real provider credentials.
- M1 does not create Memory, Knowledge Base, Embedding, Feishu, Channel, or Scheduler Ports, routes, directories, configuration fields, or placeholder adapters.
- The specification clarification approved with this plan adds `POST /v1/backups`, because `myagent backup` must use HTTP rather than open SQLite directly.

---

## Locked File Map

The repository starts with documentation only. Create the following focused files; do not collapse them into a single service or repository file.

**Project and composition**

- `package.json`, `package-lock.json`: runtime dependencies, scripts, engine floor, and CLI bin.
- `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`: strict ESM build and test gates.
- `.node-version`: Node major `24`.
- `src/platform.ts`: Node runtime assertion.
- `src/bootstrap.ts`: composition root for catalog, SQLite, worker, HTTP server, and shutdown.

**Domain and application**

- `src/domain/ids.ts`, `states.ts`, `events.ts`, `limits.ts`, `errors.ts`, `json.ts`: validated identities, transition tables, event names, budgets, typed failures, and JSON value types.
- `src/domain/agent-revision.ts`, `run.ts`, `tool-call.ts`, `approval.ts`, `policy.ts`: immutable domain records.
- `src/application/create-run.ts`, `advance-run.ts`, `policy-engine.ts`, `tool-proposal.ts`, `decide-approval.ts`, `reconcile-tool-call.ts`, `cancel-run.ts`, `delegate-agent.ts`, `delete-session.ts`, `create-backup.ts`: one use case per file.
- `src/application/prompt-assembler.ts`, `session-summarizer.ts`, `delta-buffer.ts`: trust-layer ordering, canonical-history compression, and persisted delta coalescing.

**Ports**

- `src/ports/clock.ts`, `id-generator.ts`, `catalog-store.ts`, `run-store.ts`, `tool-store.ts`, `approval-store.ts`, `session-store.ts`: deterministic infrastructure contracts.
- `src/ports/model.ts`, `tool.ts`, `secret-resolver.ts`: model attempts, Tool schemas/execution, and late Secret resolution.

**Configuration**

- `src/config/schemas.ts`, `skill-loader.ts`, `catalog-loader.ts`, `catalog-service.ts`, `secret-ref.ts`: strict YAML/frontmatter validation, root confinement, unavailable-Agent reporting, and atomic reload.

**Adapters and runtime**

- `src/adapters/system-clock.ts`, `uuid-id-generator.ts`, `environment-secret-resolver.ts`: production Clock, UUIDv7, and environment Secret adapters.
- `src/adapters/sqlite/database.ts`, `migrator.ts`, `catalog-repository.ts`, `run-repository.ts`, `tool-repository.ts`, `approval-repository.ts`, `session-repository.ts`, `backup.ts`: SQLite connection and use-case-specific persistence.
- `src/adapters/sqlite/migrations/0001-m1-kernel.sql`: all M1 relational state and constraints.
- `src/adapters/model/openai-chat-completions.ts`: one OpenAI-compatible Chat Completions attempt.
- `src/adapters/tools/path-guard.ts`, `activate-skill.ts`, `list-files.ts`, `read-file.ts`, `write-file.ts`, `run-command.ts`, `process-tree.ts`, `delegate-agent.ts`, `registry.ts`: built-in Tool implementations.
- `src/runtime/run-worker.ts`, `lease-heartbeat.ts`, `execution-registry.ts`, `approval-expirer.ts`, `fault-injector.ts`: concurrent Session-safe execution, cancellation, and no-op production fault hook.
- `src/observability/logger.ts`, `redactor.ts`: structured JSON logging and centralized redaction.

**Interfaces**

- `src/interfaces/http/app.ts`, `auth.ts`, `problem.ts`, `schemas.ts`, and `routes/*.ts`: Fastify API, authentication, Problem Details, and resource routes.
- `src/interfaces/http/sse.ts`: persisted replay, tail polling, and 15-second heartbeat.
- `src/interfaces/cli/main.ts`, `client.ts`, `formatters.ts`, and `commands/*.ts`: reference CLI that calls HTTP only.

**Configuration examples and tests**

- `examples/myagent.yaml`, `examples/agents/primary/*`, `examples/agents/researcher/*`, `examples/skills/research/SKILL.md`: runnable M1 configuration.
- `test/helpers/temp-dir.ts`, `fake-clock.ts`, `fake-ids.ts`, `scripted-model.ts`, `fake-tool.ts`, `test-config.ts`, `start-test-app.ts`: deterministic fixtures.
- `test/unit/*.test.ts`, `test/contract/*.test.ts`, `test/integration/*.test.ts`, `test/e2e/*.test.ts`: risk-scaled suites named in the tasks below.
- `test/fixtures/config/**`: valid and deliberately invalid Agent, Skill, and Policy catalogs.
- `.github/workflows/ci.yml`: Windows/Linux release-gate matrix.

## Canonical Cross-Task Contracts

Later tasks must use these names and shapes exactly. A change requires updating this section and every consuming task before implementation proceeds.

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RunState =
  | "queued" | "running" | "waiting_approval" | "waiting_reconciliation"
  | "completed" | "failed" | "cancelled";

export type ToolCallState =
  | "proposed" | "allowed" | "waiting_approval" | "denied"
  | "executing" | "succeeded" | "failed" | "unknown";

export type PolicyEffect = "allow" | "ask" | "deny";
export type ApprovalState = "pending" | "approved" | "denied" | "expired";

export interface CreateRunCommand {
  agentId: string;
  sessionKey: string;
  input: { type: "text"; text: string };
  idempotencyKey: string;
  source: { kind: "http"; externalId?: string };
}

export interface ModelPort {
  streamAttempt(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: { name: string; arguments: JsonValue } }
  | { type: "completed"; finishReason: string; usage: ModelUsage };

export interface ToolDefinition<TArgs extends JsonValue = JsonValue> {
  readonly name: string;
  readonly effect: "read_only" | "side_effect" | "internal";
  parseAndNormalize(raw: JsonValue, context: ToolNormalizeContext): Promise<{
    arguments: TArgs;
    policyFacts: ToolPolicyFacts;
  }>;
  execute(args: TArgs, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolPolicyFacts {
  pathWithinWorkspace?: true;
  targetAgentInDelegates?: true;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  content: JsonValue;
  capturedBytes: number;
  truncated: boolean;
}
```

```ts
export interface RunLimits {
  modelTurns: number;
  toolCalls: number;
  childRuns: number;
  delegationDepth: number;
  activeExecutionSeconds: number;
  defaultToolTimeoutMs: number;
  maxToolTimeoutMs: number;
  maxToolOutputBytes: number;
  maxRunToolOutputBytes: number;
}

export interface SkillSnapshot {
  name: string;
  description: string;
  version: number;
  requiredTools: readonly string[];
  body: string;
  contentSha256: string;
}

export type PolicyWhen =
  | { pathWithinWorkspace: true }
  | { targetAgentInDelegates: true };

export interface PolicyRule {
  agent?: AgentId | "*";
  tool: string;
  when?: PolicyWhen;
  effect: PolicyEffect;
}

export interface AgentRevisionSnapshot {
  revisionId: string;
  agentId: AgentId;
  displayName: string;
  prompt: string;
  model: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: SecretRef;
    maxInputTokens: number;
  };
  workspace: string;
  skills: readonly SkillSnapshot[];
  policy: readonly PolicyRule[];
  delegates: readonly AgentId[];
  limits: RunLimits;
  contentSha256: string;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface IdGenerator {
  sessionId(): SessionId;
  runId(): RunId;
  toolCallId(): ToolCallId;
  approvalId(): ApprovalId;
  attemptId(): AttemptId;
}

export interface SecretRef { fromEnvironment: string }
export interface SecretResolver { resolve(reference: SecretRef): string }

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRequest {
  purpose: "run" | "session_summary";
  model: AgentRevisionSnapshot["model"];
  messages: readonly {
    role: "system" | "user" | "assistant" | "tool";
    name: string;
    content: string;
  }[];
  tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonValue;
  }[];
}

export interface NormalizedToolProposal {
  toolName: string;
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  effect: ToolDefinition["effect"];
  policyFacts: ToolPolicyFacts;
}

export interface CreateRunResult {
  runId: RunId;
  sessionId: SessionId;
  state: "queued";
  created: boolean;
}

export type AdvanceOutcome =
  | { type: "advanced"; runId: RunId }
  | { type: "waiting"; runId: RunId; state: "waiting_approval" | "waiting_reconciliation" }
  | { type: "terminal"; runId: RunId; state: "completed" | "failed" | "cancelled" };
```

---

### Task 1: Establish the Node.js Package and Quality Gates

**Files:**
- Create: `package.json`, `package-lock.json`, `.node-version`
- Create: `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`
- Create: `src/platform.ts`
- Test: `test/unit/platform.test.ts`

**Interfaces:**
- Consumes: Node.js 24 and npm.
- Produces: `assertSupportedRuntime(version?: NodeJS.ProcessVersions): void`; scripts `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:contract`, `test:integration`, `test:e2e`, and `check`.

- [ ] **Step 1: Initialize the package and pin supported major versions**

Run:

```bash
npm init -y
npm install canonicalize@2 commander@14 fastify@5 openai@5 uuid@11 yaml@2 zod@4
npm install --save-dev @eslint/js@9 @types/node@24 eslint@9 fast-check@4 tsx@4 typescript@5.9 typescript-eslint@8 vitest@3
```

Edit `package.json` to set `"type": "module"`, `"private": true`, `"engines": { "node": ">=24.0.0 <25" }`, and `"bin": { "myagent": "./dist/interfaces/cli/main.js" }`. Add the scripts named in the Interfaces block, with `check` running lint, typecheck, all tests, then build.

- [ ] **Step 2: Write the failing runtime-floor test**

```ts
import { describe, expect, it } from "vitest";
import { assertSupportedRuntime } from "../../src/platform.js";

describe("assertSupportedRuntime", () => {
  it("accepts Node 24 and rejects other majors", () => {
    expect(() => assertSupportedRuntime({ node: "24.3.0" } as NodeJS.ProcessVersions)).not.toThrow();
    expect(() => assertSupportedRuntime({ node: "23.11.0" } as NodeJS.ProcessVersions))
      .toThrow("MyAgent requires Node.js 24 LTS");
  });
});
```

- [ ] **Step 3: Run the focused test and confirm failure from the missing module**

Run: `npm run test:unit -- test/unit/platform.test.ts`

Expected: FAIL because `src/platform.ts` does not exist.

- [ ] **Step 4: Add strict ESM compiler, lint, and Vitest configuration**

Use `module/moduleResolution: "NodeNext"`, `target/lib: "ES2023"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `useUnknownInCatchVariables: true`, `verbatimModuleSyntax: true`, `rootDir: "."`, and exclude `dist`. The build config includes only `src/**/*.ts` and emits declarations and source maps to `dist`.

- [ ] **Step 5: Implement the runtime assertion**

```ts
export function assertSupportedRuntime(
  version: NodeJS.ProcessVersions = process.versions,
): void {
  const major = Number.parseInt(version.node.split(".")[0] ?? "", 10);
  if (major !== 24) {
    throw new Error(`MyAgent requires Node.js 24 LTS; received ${version.node}`);
  }
}
```

- [ ] **Step 6: Run the full foundation gate**

Run: `npm run check`

Expected: lint, typecheck, one unit test, and build all exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .node-version tsconfig.json tsconfig.build.json eslint.config.js vitest.config.ts src/platform.ts test/unit/platform.test.ts
git commit -m "chore: initialize Node 24 TypeScript service"
```

---

### Task 2: Define Identities, State Machines, Events, and Budgets

**Files:**
- Create: `src/domain/json.ts`, `ids.ts`, `states.ts`, `events.ts`, `limits.ts`, `errors.ts`
- Create: `src/domain/run.ts`, `tool-call.ts`, `approval.ts`
- Create: `src/ports/clock.ts`, `id-generator.ts`
- Create: `src/adapters/system-clock.ts`, `uuid-id-generator.ts`
- Create: `test/helpers/fake-clock.ts`, `fake-ids.ts`
- Test: `test/unit/ids.test.ts`, `states.test.ts`, `limits.test.ts`

**Interfaces:**
- Consumes: `uuid.v7()` and the exact limits in Global Constraints.
- Produces: branded `AgentId`, `SessionId`, `RunId`, `ToolCallId`, `ApprovalId`, `AttemptId`; `parseAgentId`, `parseSessionKey`, `parseIdempotencyKey`; `assertRunTransition`, `assertToolCallTransition`, `assertApprovalTransition`; `consumeBudget`; `Clock`; `IdGenerator`; production `SystemClock` and `UuidIdGenerator`.

- [ ] **Step 1: Write failing validation and property tests**

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAgentId, parseIdempotencyKey, parseSessionKey } from "../../src/domain/ids.js";

describe("stable identifiers", () => {
  it("scopes valid session keys without normalizing case", () => {
    expect(parseSessionKey("Feishu:dm:Open_ID")).toBe("Feishu:dm:Open_ID");
  });

  it("rejects invalid lengths and characters", () => {
    expect(() => parseAgentId("Primary_Agent")).toThrow();
    expect(() => parseSessionKey("contains space")).toThrow();
    expect(() => parseIdempotencyKey("short")).toThrow();
  });

  it("accepts every allowed session-key character", () => {
    fc.assert(fc.property(
      fc.string({ unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@/-"), minLength: 1, maxLength: 200 }),
      (value) => expect(parseSessionKey(value)).toBe(value),
    ));
  });
});
```

- [ ] **Step 2: Run the identifier tests and confirm they fail**

Run: `npm run test:unit -- test/unit/ids.test.ts`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement branded IDs and deterministic fakes**

Use a single private `brand<T, Name>()` helper, prefix UUIDv7 values as `ses_`, `run_`, `call_`, `apr_`, and `att_`, and expose an `IdGenerator` interface with one method per ID. `UuidIdGenerator` uses `uuid.v7()`; `SystemClock` supplies `now()` and abortable `sleep()`; `FakeIds` returns queued values and throws when a test forgot to seed one.

- [ ] **Step 4: Write failing transition-table tests**

```ts
import { describe, expect, it } from "vitest";
import { assertApprovalTransition, assertRunTransition, assertToolCallTransition } from "../../src/domain/states.js";

describe("durable state transitions", () => {
  it("makes terminal Run states immutable", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(() => assertRunTransition(state, "running")).toThrow("invalid_run_transition");
    }
  });

  it("requires reconciliation before an unknown Tool Call can finish", () => {
    expect(() => assertToolCallTransition("executing", "unknown")).not.toThrow();
    expect(() => assertToolCallTransition("unknown", "succeeded")).not.toThrow();
    expect(() => assertToolCallTransition("unknown", "executing")).toThrow();
  });

  it("allows only one terminal Approval decision", () => {
    expect(() => assertApprovalTransition("pending", "expired")).not.toThrow();
    expect(() => assertApprovalTransition("approved", "denied")).toThrow();
  });
});
```

- [ ] **Step 5: Implement explicit transition maps**

```ts
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: ["queued", "waiting_approval", "waiting_reconciliation", "completed", "failed", "cancelled"],
  waiting_approval: ["queued", "cancelled"],
  waiting_reconciliation: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TOOL_TRANSITIONS: Record<ToolCallState, readonly ToolCallState[]> = {
  proposed: ["allowed", "waiting_approval", "denied"],
  allowed: ["executing"],
  waiting_approval: ["allowed", "denied"],
  denied: [],
  executing: ["succeeded", "failed", "unknown"],
  succeeded: [],
  failed: [],
  unknown: ["succeeded", "failed"],
};
```

Use `DomainError` with stable codes rather than generic messages for every rejected transition.

- [ ] **Step 6: Add Run Event names and budget accounting**

Define the complete M1 event union from the specification, including `run.*`, `model.attempt.*`, `message.*`, `skill.activated`, `tool.*`, `approval.*`, and `delegation.*`. Implement `consumeBudget(current, delta, limits)` so active wait time is excluded and crossing any hard limit returns a typed `run_budget_exceeded` failure.

- [ ] **Step 7: Run the domain suite**

Run: `npm run test:unit -- test/unit/ids.test.ts test/unit/states.test.ts test/unit/limits.test.ts`

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain src/ports/clock.ts src/ports/id-generator.ts src/adapters/system-clock.ts src/adapters/uuid-id-generator.ts test/helpers/fake-clock.ts test/helpers/fake-ids.ts test/unit/ids.test.ts test/unit/states.test.ts test/unit/limits.test.ts
git commit -m "feat: define durable kernel domain rules"
```

---

### Task 3: Load Agents, Skills, Policies, and Immutable Revisions

**Files:**
- Create: `src/domain/agent-revision.ts`
- Create: `src/config/schemas.ts`, `secret-ref.ts`, `skill-loader.ts`, `catalog-loader.ts`, `catalog-service.ts`
- Create: `src/ports/catalog-store.ts`, `secret-resolver.ts`
- Create: `src/adapters/environment-secret-resolver.ts`
- Create: `test/fixtures/config/valid/**`, `invalid-agent/**`, `escaped-skill/**`
- Test: `test/unit/config-schemas.test.ts`, `skill-loader.test.ts`, `catalog-loader.test.ts`, `catalog-service.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `RunLimits`, explicit Agent and Skill roots, and environment-variable references.
- Produces: `loadCatalog(configPath): Promise<CatalogSnapshot>`; `CatalogService.current(): CatalogSnapshot`; `CatalogService.validate(): Promise<CatalogSnapshot>`; `CatalogService.reload(): Promise<CatalogSnapshot>`; `CatalogService.resolve(agentId): AvailableAgent`; `CatalogRevisionStore.save/get`; `EnvironmentSecretResolver.resolve(ref)`.

- [ ] **Step 1: Create valid and invalid catalog fixtures**

The valid fixture contains `myagent.yaml`, primary and researcher Agent directories, one research Skill, and first-match policies. The invalid fixture contains one broken Agent beside one valid Agent. The escaped fixture points a Skill symlink/junction outside every configured Skill root.

- [ ] **Step 2: Write failing strict-schema tests**

```ts
it("rejects global listener errors but isolates an invalid Agent", async () => {
  await expect(loadCatalog(fixture("bad-global/myagent.yaml")))
    .rejects.toMatchObject({ code: "invalid_global_config" });

  const result = await loadCatalog(fixture("invalid-agent/myagent.yaml"));
  expect(result.available.map((agent) => agent.id)).toEqual(["primary"]);
  expect(result.unavailable).toEqual([
    expect.objectContaining({ id: "broken", code: "invalid_agent_config" }),
  ]);
});
```

Assert that unknown Tool fields, duplicate Agent IDs, missing prompts, duplicate Skill names, non-positive Skill versions, missing allowlisted Skills, and unsupported M2 fields are rejected in M1.

- [ ] **Step 3: Run the schema tests and confirm failure**

Run: `npm run test:unit -- test/unit/config-schemas.test.ts test/unit/catalog-loader.test.ts`

Expected: FAIL because the loaders do not exist.

- [ ] **Step 4: Implement strict Zod schemas**

Define these M1 configuration shapes:

```ts
const globalConfigSchema = z.strictObject({
  server: z.strictObject({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8787),
    bearerToken: secretRefSchema,
  }),
  database: z.strictObject({
    path: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5_000),
  }),
  agentRoots: z.array(z.string().min(1)).min(1),
  skillRoots: z.array(z.string().min(1)).default([]),
  models: z.record(z.string(), modelConfigSchema),
  toolEnvironmentAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
});
```

The M1 Agent schema includes `id`, `displayName`, `prompt`, `model`, `workspace`, `skills`, `policy`, `delegates`, and `limits`. Do not accept `context` or `knowledgeCollections` before M2.

- [ ] **Step 5: Implement strict `SKILL.md` parsing and root confinement**

Split only an exact leading YAML frontmatter block, parse it with `yaml`, require `name`, `description`, positive integer `version`, and optional `requiredTools`, then retain the complete body and SHA-256. Resolve both configured root and candidate with `realpath`; reject when `path.relative(root, candidate)` is absolute or begins with `..`.

- [ ] **Step 6: Implement resolved revision hashing**

Build `AgentRevisionSnapshot` with resolved absolute Workspace, full prompt text, selected model config without resolved secrets, allowed Skill metadata and bodies, normalized policy rules, delegate allowlist, and limits. Hash the RFC 8785 canonical JSON and use `rev_<sha256>` as the immutable revision ID.

- [ ] **Step 7: Implement atomic in-memory reload**

```ts
export class CatalogService {
  #snapshot: CatalogSnapshot;

  current(): CatalogSnapshot { return this.#snapshot; }

  validate(): Promise<CatalogSnapshot> {
    return loadCatalog(this.#snapshot.configPath);
  }

  async reload(): Promise<CatalogSnapshot> {
    const candidate = await this.validate();
    assertReloadableGlobal(this.#snapshot.global, candidate.global);
    this.#snapshot = Object.freeze(candidate);
    return this.#snapshot;
  }

  resolve(agentId: AgentId): AvailableAgent {
    const agent = this.#snapshot.byId.get(agentId);
    if (!agent) throw new ApplicationError("agent_unavailable", 422);
    return agent;
  }
}
```

Before assignment, compare listener host/port, database path/busy timeout, and their Secret references with the active global settings. A change returns `restart_required` and leaves the active snapshot untouched; Agent, prompt, Skill, Policy, model selection, Workspace, delegate, and limit changes publish atomically for future Runs. `EnvironmentSecretResolver` resolves a named environment variable only at bootstrap or inside an approved Tool adapter and throws `secret_unavailable` without including its value. No filesystem watcher is created.

- [ ] **Step 8: Run configuration tests**

Run: `npm run test:unit -- test/unit/config-schemas.test.ts test/unit/skill-loader.test.ts test/unit/catalog-loader.test.ts test/unit/catalog-service.test.ts`

Expected: all tests PASS, including symlink/junction escape rejection.

- [ ] **Step 9: Commit**

```bash
git add src/domain/agent-revision.ts src/config src/ports/catalog-store.ts src/ports/secret-resolver.ts src/adapters/environment-secret-resolver.ts test/fixtures/config test/unit/config-schemas.test.ts test/unit/skill-loader.test.ts test/unit/catalog-loader.test.ts test/unit/catalog-service.test.ts
git commit -m "feat: load immutable Agent and Skill revisions"
```

---

### Task 4: Create the SQLite Schema, Migration Runner, and Revision Store

**Files:**
- Create: `src/adapters/sqlite/migrations/0001-m1-kernel.sql`
- Create: `src/adapters/sqlite/database.ts`, `migrator.ts`, `catalog-repository.ts`
- Create: `test/helpers/temp-dir.ts`
- Test: `test/contract/sqlite-migrations.test.ts`, `catalog-repository.test.ts`

**Interfaces:**
- Consumes: `AgentRevisionSnapshot`, Node `DatabaseSync`, a database path, and busy timeout.
- Produces: `openDatabase(options): SqliteDatabase`; `migrate(db): void`; `SqliteCatalogRepository.save(snapshot): void`; `get(revisionId): AgentRevisionSnapshot | null`.

- [ ] **Step 1: Write the failing empty-database migration test**

```ts
it("migrates an empty database and reopens it with required pragmas", () => {
  const file = tempPath("kernel.db");
  const first = openDatabase({ path: file, busyTimeoutMs: 5_000 });
  try {
    migrate(first.db);
    expect(first.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(first.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  } finally {
    first.close();
  }

  const reopened = openDatabase({ path: file, busyTimeoutMs: 5_000 });
  try {
    migrate(reopened.db);
    expect(reopened.db.prepare("SELECT version FROM schema_migrations").all())
      .toEqual([{ version: 1 }]);
  } finally {
    reopened.close();
  }
});
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts`

Expected: FAIL because the SQLite adapter and migration are missing.

- [ ] **Step 3: Write the complete M1 relational migration**

Create `schema_migrations`, `agent_revisions`, `sessions`, `messages`, `session_summaries`, `runs`, `run_events`, `run_activated_skills`, `tool_calls`, `approvals`, `reconciliations`, and `idempotency_keys`. Include:

- unique `sessions(agent_id, session_key)`;
- unique `runs(session_id, fifo_sequence)`;
- a partial unique index on `runs(session_id)` for `running | waiting_approval | waiting_reconciliation`;
- unique `run_events(run_id, sequence)`;
- unique `idempotency_keys(agent_id, session_key, key)`;
- immutable canonical argument/digest columns on `tool_calls`;
- unique `approvals(tool_call_id)` and `reconciliations(tool_call_id)`;
- parent/root/delegation depth and `blocked_by_child_run_id`;
- `lease_owner`, `lease_expires_at`, turn/Tool counters, active elapsed time, and output byte totals;
- synthetic Session ownership so deleting a root Session cascades its delegated Sessions.

Use `CHECK` constraints for every state string and `ON DELETE CASCADE` for Session-owned records.

- [ ] **Step 4: Implement connection and forward-only migration handling**

On open, set `journal_mode=WAL`, `foreign_keys=ON`, and `busy_timeout` to the configured non-zero value. Read SQL migration resources in numeric order, execute each inside `BEGIN IMMEDIATE`, record the version, and reject a database version newer than the binary.

- [ ] **Step 5: Write the failing revision round-trip test**

```ts
it("stores complete Skill bodies without resolving model secrets", () => {
  const revision = agentRevisionFixture();
  repository.save(revision);
  expect(repository.get(revision.revisionId)).toEqual(revision);
  expect(JSON.stringify(repository.get(revision.revisionId))).not.toContain("real-api-key");
});
```

- [ ] **Step 6: Implement the catalog repository**

Store the canonical revision JSON and SHA-256 once with `INSERT ... ON CONFLICT DO NOTHING`. On a revision-ID collision with different canonical JSON, throw `revision_hash_collision`; never update an existing revision.

- [ ] **Step 7: Run migration and revision contracts**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/catalog-repository.test.ts`

Expected: all tests PASS on a real temporary SQLite file.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/sqlite test/helpers/temp-dir.ts test/contract/sqlite-migrations.test.ts test/contract/catalog-repository.test.ts
git commit -m "feat: add M1 SQLite schema and revision storage"
```

---

### Task 5: Create Runs Idempotently and Enforce Session FIFO

**Files:**
- Create: `src/ports/run-store.ts`
- Create: `src/application/create-run.ts`
- Create: `src/adapters/sqlite/run-repository.ts`
- Test: `test/unit/create-run.test.ts`
- Test: `test/integration/run-queue.test.ts`

**Interfaces:**
- Consumes: `CreateRunCommand`, `CatalogService.resolve`, `Clock`, `IdGenerator`, `SqliteCatalogRepository`.
- Produces: `CreateRunService.execute(command): CreateRunResult`; `RunStore.create`, `getRun`, `listEventsAfter`, `claimNextEligible`, `renewLease`, `releaseLease`; gap-free `appendEvent`.

- [ ] **Step 1: Write failing idempotency and isolation tests**

```ts
it("returns the original Run only for the same scoped request digest", () => {
  const first = service.execute(command({ agentId: "primary", sessionKey: "cli:main", idempotencyKey: "request-0001" }));
  const retry = service.execute(command({ agentId: "primary", sessionKey: "cli:main", idempotencyKey: "request-0001" }));
  expect(retry).toEqual({ ...first, created: false });

  expect(() => service.execute(command({
    agentId: "primary",
    sessionKey: "cli:main",
    idempotencyKey: "request-0001",
    input: { type: "text", text: "different" },
  }))).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
});

it("allows two Agents to reuse one Session Key without sharing a Session", () => {
  const a = service.execute(command({ agentId: "primary", sessionKey: "shared:key" }));
  const b = service.execute(command({ agentId: "researcher", sessionKey: "shared:key" }));
  expect(a.sessionId).not.toBe(b.sessionId);
});
```

- [ ] **Step 2: Run the unit test and confirm failure**

Run: `npm run test:unit -- test/unit/create-run.test.ts`

Expected: FAIL because `CreateRunService` and `RunStore` are missing.

- [ ] **Step 3: Implement one transactional create operation**

Inside `BEGIN IMMEDIATE`:

1. validate IDs and text input;
2. save the resolved revision;
3. canonicalize the request and hash it;
4. return the original Run for a matching scoped idempotency row;
5. throw `idempotency_conflict` for a different digest;
6. resolve or insert `sessions(agent_id, session_key)`;
7. allocate `MAX(fifo_sequence) + 1` for that Session;
8. insert the Run and its immutable input;
9. insert the canonical Operator message tagged with that Run FIFO sequence;
10. append `run.queued` as event sequence 1;
11. insert the idempotency row.

Do not expose later queued Operator inputs to an earlier Run; conversation queries filter messages by `run_fifo_sequence <= currentRun.fifoSequence`.

- [ ] **Step 4: Write the failing FIFO claim integration test**

```ts
it("claims one Run per Session while allowing another Session", () => {
  const a1 = create("primary", "session:a");
  const a2 = create("primary", "session:a");
  const b1 = create("primary", "session:b");

  const first = store.claimNextEligible("worker-1", now, leaseUntil);
  const second = store.claimNextEligible("worker-2", now, leaseUntil);
  expect(new Set([first?.runId, second?.runId])).toEqual(new Set([a1.runId, b1.runId]));
  expect(store.getRun(a2.runId).state).toBe("queued");
});
```

- [ ] **Step 5: Implement atomic claim, lease, and event sequencing**

Select the oldest queued Run whose Session has no `running`, `waiting_approval`, or `waiting_reconciliation` Run, ordered by creation time and Run ID. In the same transaction update it to `running`, set lease owner/expiry and active-start timestamp, and append `run.started`. Also allow reclaiming an expired `running` Run without appending a second `run.started`.

Allocate event sequence with `SELECT COALESCE(MAX(sequence), 0) + 1` under the same write transaction that changes state.

- [ ] **Step 6: Verify conflict and gap-free behavior under contention**

Run: `npm run test:integration -- test/integration/run-queue.test.ts`

Expected: same-Session claims serialize, different Sessions claim concurrently, duplicate create returns one Run, and committed event sequences are `1..N` without gaps.

- [ ] **Step 7: Run all tests accumulated so far**

Run: `npm run check`

Expected: all unit, contract, integration, type, lint, and build gates exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/ports/run-store.ts src/application/create-run.ts src/adapters/sqlite/run-repository.ts test/unit/create-run.test.ts test/integration/run-queue.test.ts
git commit -m "feat: create durable Agent-scoped Runs"
```

### Task 6: Normalize Tool Calls and Evaluate Default-Deny Policy

**Files:**
- Create: `src/domain/policy.ts`
- Create: `src/ports/tool.ts`
- Create: `src/application/policy-engine.ts`, `tool-proposal.ts`
- Create: `src/adapters/tools/registry.ts`
- Test: `test/unit/tool-proposal.test.ts`, `policy-engine.test.ts`

**Interfaces:**
- Consumes: snapshotted Policy rules, Agent revision, raw model Tool Call, and registered `ToolDefinition`.
- Produces: `ToolRegistry.get(name)`; `normalizeToolProposal(input): Promise<NormalizedToolProposal>`; `PolicyEngine.decide(context): PolicyDecision`.

- [ ] **Step 1: Write failing canonicalization tests**

```ts
it("hashes normalized arguments using RFC 8785 ordering", async () => {
  const first = await normalizeToolProposal(input({ arguments: { path: ".", maxEntries: 20 } }));
  const second = await normalizeToolProposal(input({ arguments: { maxEntries: 20, path: "." } }));
  expect(first.canonicalArguments).toBe(second.canonicalArguments);
  expect(first.argumentsSha256).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects unknown fields before policy evaluation", async () => {
  await expect(normalizeToolProposal(input({
    arguments: { path: ".", maxEntries: 20, grantsAdmin: true },
  }))).rejects.toMatchObject({ code: "invalid_tool_arguments" });
});
```

- [ ] **Step 2: Run Tool proposal tests and confirm failure**

Run: `npm run test:unit -- test/unit/tool-proposal.test.ts`

Expected: FAIL because the Tool Port, registry, and normalizer are absent.

- [ ] **Step 3: Implement the Tool contract and registry**

```ts
export interface ToolNormalizeContext {
  agentId: AgentId;
  revision: AgentRevisionSnapshot;
}

export interface ToolExecutionContext extends ToolNormalizeContext {
  runId: RunId;
  toolCallId: ToolCallId;
  signal: AbortSignal;
  remainingRunOutputBytes: number;
  activateSkill(skillName: string): void;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) throw new Error(`duplicate Tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }
  get(name: string): ToolDefinition | undefined { return this.#tools.get(name); }
}
```

Every built-in Tool uses `z.strictObject`; registration rejects duplicate names.

- [ ] **Step 4: Implement normalization and digesting**

Look up the Tool, reject unknown Tools with `tool_not_found`, call `parseAndNormalize`, pass only its `arguments` to the `canonicalize` package, reject non-finite or non-JSON values, and compute SHA-256 over UTF-8 canonical JSON. Freeze the normalized arguments and their separately returned `policyFacts`; never accept model-supplied policy facts or replacement arguments after persistence.

- [ ] **Step 5: Write failing first-match policy tests**

```ts
it("uses the first match and denies unmatched calls", () => {
  const policy = policyFixture([
    { tool: "read_file", effect: "ask" },
    { tool: "read_file", effect: "allow" },
  ]);
  expect(engine.decide(context({ toolName: "read_file", policy })).effect).toBe("ask");
  expect(engine.decide(context({ toolName: "unlisted", policy })).effect).toBe("deny");
});

it("does not treat requiredTools as permission", () => {
  expect(engine.decide(context({
    toolName: "run_command",
    requiredTools: ["run_command"],
    policy: policyFixture([]),
  })).effect).toBe("deny");
});
```

- [ ] **Step 6: Implement the finite M1 policy matcher**

Support exact Agent ID or `"*"`, exact Tool name or `"*"`, and only these typed predicates:

```ts
export type PolicyWhen =
  | { pathWithinWorkspace: true }
  | { targetAgentInDelegates: true };
```

`pathWithinWorkspace` consumes `NormalizedToolProposal.policyFacts.pathWithinWorkspace`, set only after PathGuard succeeds. `targetAgentInDelegates` consumes the corresponding trusted fact set after comparing the normalized target against the snapshotted delegate allowlist. Return the matching rule index and effect for audit; return `{ effect: "deny", matchedRule: null }` when none matches.

- [ ] **Step 7: Run policy and proposal tests**

Run: `npm run test:unit -- test/unit/tool-proposal.test.ts test/unit/policy-engine.test.ts`

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/policy.ts src/ports/tool.ts src/application/policy-engine.ts src/application/tool-proposal.ts src/adapters/tools/registry.ts test/unit/tool-proposal.test.ts test/unit/policy-engine.test.ts
git commit -m "feat: evaluate normalized Tool Calls with default deny"
```

---

### Task 7: Implement Skill Activation and Workspace File Tools

**Files:**
- Create: `src/adapters/tools/path-guard.ts`, `activate-skill.ts`, `list-files.ts`, `read-file.ts`, `write-file.ts`
- Test: `test/unit/path-guard.test.ts`
- Test: `test/contract/file-tools.test.ts`, `activate-skill.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`, snapshotted Workspace and Skill bodies, `ToolExecutionContext.activateSkill`.
- Produces: `PathGuard.resolveExisting`, `resolveForCreate`; Tool definitions `activate_skill`, `list_files`, `read_file`, and `write_file`.

- [ ] **Step 1: Write failing path-confinement tests**

```ts
it("rejects lexical and symlink escapes from the Workspace", async () => {
  await expect(guard.resolveExisting("../outside.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
  await createFileLink(outsideFile, workspacePath("linked.txt"));
  await expect(guard.resolveExisting("linked.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
});

it("checks the real parent when the target does not exist", async () => {
  await createDirectoryLink(outsideDirectory, workspacePath("linked-dir"));
  await expect(guard.resolveForCreate("linked-dir/new.txt"))
    .rejects.toMatchObject({ code: "path_outside_workspace" });
});
```

- [ ] **Step 2: Run PathGuard tests and confirm failure**

Run: `npm run test:unit -- test/unit/path-guard.test.ts`

Expected: FAIL because PathGuard does not exist.

- [ ] **Step 3: Implement cross-platform real-path confinement**

Resolve the Workspace once with `realpath`. For existing targets, resolve the complete path. For new targets, walk upward to the nearest existing parent, resolve it, then append only validated missing segments. Reject absolute user paths, NUL bytes, an absolute `path.relative` result, or a relative result equal to `..` or beginning with `..` followed by `path.sep`.

- [ ] **Step 4: Write failing Tool contract tests**

Cover these exact cases:

- `list_files` defaults to 200 entries, caps at 1,000, returns Workspace-relative paths in lexical order, and never follows directory symlinks.
- `read_file` supports inclusive 1-based line ranges, defaults to 256 KiB, caps at 1 MiB, and reports truncation.
- `write_file(expectedSha256: null)` is create-only.
- replacement requires the current SHA-256 and fails with `file_changed` on mismatch.
- writes occur through an exclusive sibling temporary file, `fsync`, atomic rename, and guaranteed temporary-file cleanup.

- [ ] **Step 5: Implement `list_files` and `read_file`**

Use Node 24 `fs.promises.glob` with `cwd` fixed to the Workspace, validate every returned entry through PathGuard, and return metadata rather than absolute paths. Read through a bounded file handle, calculate captured bytes before UTF-8 decoding, and return a structured `ToolResult`.

- [ ] **Step 6: Implement atomic `write_file`**

```ts
const schema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
```

Enforce a 1 MiB UTF-8 content limit. Recheck the target hash after opening the sibling temporary file and immediately before rename. Use mode `0o600` for new files and preserve the existing target mode on replacement.

- [ ] **Step 7: Implement `activate_skill`**

Normalize only a Skill name present in the Run revision. On execution invoke `context.activateSkill(name)`; the supplied callback persists `run_activated_skills` and `skill.activated` in one transaction. Repeated activation returns the existing activation without duplicating the event.

- [ ] **Step 8: Run file and Skill contracts**

Run: `npm run test:contract -- test/contract/file-tools.test.ts test/contract/activate-skill.test.ts`

Expected: all contracts PASS on Windows-compatible temporary directories.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/tools/path-guard.ts src/adapters/tools/activate-skill.ts src/adapters/tools/list-files.ts src/adapters/tools/read-file.ts src/adapters/tools/write-file.ts test/unit/path-guard.test.ts test/contract/file-tools.test.ts test/contract/activate-skill.test.ts
git commit -m "feat: add Workspace-bound file and Skill Tools"
```

---

### Task 8: Implement Controlled Host Command Execution

**Files:**
- Create: `src/adapters/tools/process-tree.ts`, `run-command.ts`
- Modify: `src/config/secret-ref.ts` for Tool environment references
- Test: `test/contract/run-command.test.ts`, `process-tree.test.ts`

**Interfaces:**
- Consumes: Workspace, Tool environment allowlist, `SecretResolver`, AbortSignal, per-call and per-Run output budgets.
- Produces: `run_command` Tool; `ProcessTree.start/terminate`; no shell interpretation.

- [ ] **Step 1: Write failing argument and shell-safety tests**

```ts
it("passes metacharacters as literal arguments with shell disabled", async () => {
  const result = await tool.execute({
    program: process.execPath,
    args: ["-e", "console.log(process.argv[1])", "a && echo injected"],
    cwd: ".",
    env: {},
    timeoutMs: 2_000,
  }, context());
  expect(result.content).toMatchObject({ exitCode: 0, stdout: "a && echo injected\n" });
});
```

Also reject a `cwd` outside Workspace, environment names not in the allowlist, timeout above 600,000 ms, and unknown fields such as `shell`.

- [ ] **Step 2: Run the command contract and confirm failure**

Run: `npm run test:contract -- test/contract/run-command.test.ts`

Expected: FAIL because `run_command` is not registered.

- [ ] **Step 3: Define the strict command schema**

```ts
const commandSchema = z.strictObject({
  program: z.string().min(1),
  args: z.array(z.string()).max(256),
  cwd: z.string().default("."),
  env: z.record(z.string(), z.union([
    z.strictObject({ value: z.string() }),
    z.strictObject({ fromEnvironment: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  ])).default({}),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
});
```

The approval digest contains literal values or environment reference names, never resolved Secret values.

- [ ] **Step 4: Implement late environment resolution and spawn**

After the policy/Approval gate, resolve only allowlisted environment names. Call `spawn(program, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32" })`. Never concatenate a command string and never inherit the full parent environment.

- [ ] **Step 5: Implement process-tree timeout and cancellation**

On POSIX terminate the detached process group, first with `SIGTERM`, then `SIGKILL` after a bounded grace period. On Windows call `taskkill.exe /PID <pid> /T /F` with `shell: false`. Treat an already-exited process as success and await child close before returning.

- [ ] **Step 6: Enforce output limits**

Capture stdout and stderr independently but stop retaining bytes when the smaller of 1 MiB per call and the Run's remaining 8 MiB budget is reached. Continue draining pipes to avoid deadlock, set `truncated: true`, and persist byte counts without logging output.

- [ ] **Step 7: Run command and process-tree contracts**

Run: `npm run test:contract -- test/contract/run-command.test.ts test/contract/process-tree.test.ts`

Expected: literal metacharacters are not interpreted, timeout and AbortSignal terminate descendants, Secret values do not appear in the normalized arguments, and caps are enforced.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/tools/process-tree.ts src/adapters/tools/run-command.ts src/config/secret-ref.ts test/contract/run-command.test.ts test/contract/process-tree.test.ts
git commit -m "feat: execute approved commands without a shell"
```

---

### Task 9: Assemble Trusted Prompts and Add the Model Adapter

**Files:**
- Create: `src/ports/model.ts`, `session-store.ts`
- Create: `src/application/prompt-assembler.ts`, `session-summarizer.ts`, `delta-buffer.ts`
- Create: `src/adapters/model/openai-chat-completions.ts`
- Create: `src/adapters/sqlite/session-repository.ts`
- Modify: `src/config/schemas.ts`
- Create: `test/helpers/scripted-model.ts`
- Test: `test/unit/prompt-assembler.test.ts`, `session-summarizer.test.ts`, `delta-buffer.test.ts`
- Test: `test/contract/openai-chat-completions.test.ts`

**Interfaces:**
- Consumes: Agent revision, activated Skills, bounded prior messages, current Run input, Tool results, existing Session Summary.
- Produces: `PromptAssembler.build(input): Promise<ModelRequest>`; `SessionSummarizer.ensureWithinBudget`; `DeltaBuffer.push/flush`; `OpenAiChatCompletionsModel.streamAttempt`.

- [ ] **Step 1: Write the failing trust-layer ordering test**

```ts
it("orders trusted instructions before delimited untrusted data", async () => {
  const request = await assembler.build(promptFixture());
  expect(request.messages.map((message) => message.name)).toEqual([
    "runtime_safety",
    "agent_instructions",
    "skill:research",
    "session_summary",
    "session_history",
    "current_operator_input",
    "tool_results",
  ]);
  expect(request.messages.find((m) => m.name === "tool_results")?.content)
    .toContain("<untrusted-tool-result>");
});
```

Assert that future queued inputs are absent, resolved Secrets are absent, and Skill bodies appear only after activation.

- [ ] **Step 2: Run prompt tests and confirm failure**

Run: `npm run test:unit -- test/unit/prompt-assembler.test.ts`

Expected: FAIL because prompt assembly is missing.

- [ ] **Step 3: Implement canonical-history queries and prompt assembly**

The Session repository returns the latest Summary plus canonical messages whose Run FIFO sequence is not later than the current Run. Prompt assembly uses this exact order: runtime protocol plus eligible Skill names/descriptions, `AGENT.md`, activated Skill bodies, Session Summary/recent messages, current input, then Tool results. Full Skill bodies never appear before activation. Wrap every history, summary, input, and Tool result section in explicit untrusted delimiters.

- [ ] **Step 4: Implement deterministic context estimation and summaries**

Add `maxInputTokens` to each model config and estimate prompt tokens as `ceil(UTF8 byte length / 4)`. When the estimate exceeds 75% of that value, make a no-Tool model request with `purpose: "session_summary"`, summarize the oldest unsummarized canonical messages, and store `source_message_from`, `source_message_to`, model ID, and created time. A summary request consumes one model turn and active execution time, uses the same three-attempt retry ceiling, and fails the Run if context cannot be reduced safely. Never delete or rewrite source messages.

- [ ] **Step 5: Write and implement delta-buffer tests**

```ts
it("flushes at 1 KiB or 100 ms, whichever occurs first", () => {
  const buffer = new DeltaBuffer({ maxBytes: 1_024, maxDelayMs: 100, clock });
  expect(buffer.push("a".repeat(1_023))).toBeNull();
  expect(buffer.push("b")).toEqual("a".repeat(1_023) + "b");
});
```

`flush()` returns remaining text; empty input never creates an event.

- [ ] **Step 6: Define one-attempt Model Port semantics**

The Port performs exactly one provider attempt so the application can persist `model.attempt.started` and `model.attempt.failed` per attempt. Define `ModelProviderError` with `transient`, optional `retryAfterMs`, status, and redacted code. The adapter accumulates streamed Tool argument fragments, emits one parsed `tool_call`, and throws `model_protocol_error` if more than one Tool Call is returned.

- [ ] **Step 7: Contract-test the OpenAI-compatible adapter against a local fake server**

Serve scripted Chat Completions SSE frames from `node:http`: text deltas, one fragmented Tool Call, usage/final reason, HTTP 429 with `Retry-After`, malformed arguments, and two Tool Calls. Do not require network access or credentials.

- [ ] **Step 8: Run prompt, summary, buffer, and model contracts**

Run: `npm run test:unit -- test/unit/prompt-assembler.test.ts test/unit/session-summarizer.test.ts test/unit/delta-buffer.test.ts`

Run: `npm run test:contract -- test/contract/openai-chat-completions.test.ts`

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ports/model.ts src/ports/session-store.ts src/application/prompt-assembler.ts src/application/session-summarizer.ts src/application/delta-buffer.ts src/adapters/model src/adapters/sqlite/session-repository.ts src/config/schemas.ts test/helpers/scripted-model.ts test/unit/prompt-assembler.test.ts test/unit/session-summarizer.test.ts test/unit/delta-buffer.test.ts test/contract/openai-chat-completions.test.ts
git commit -m "feat: assemble trusted prompts and stream model attempts"
```

---

### Task 10: Advance Runs Through Durable Worker Checkpoints

**Files:**
- Create: `src/ports/tool-store.ts`, `approval-store.ts`
- Create: `src/application/advance-run.ts`
- Create: `src/adapters/sqlite/tool-repository.ts`, `approval-repository.ts`
- Create: `src/runtime/run-worker.ts`, `lease-heartbeat.ts`
- Create: `test/helpers/fake-tool.ts`
- Test: `test/unit/advance-run.test.ts`
- Test: `test/integration/run-worker.test.ts`, `lease-recovery.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `ToolStore`, `ApprovalStore`, `ModelPort`, PromptAssembler, ToolRegistry, PolicyEngine, Clock, and Run limits.
- Produces: `AdvanceRunService.advance(runId, leaseOwner, signal): Promise<AdvanceOutcome>`; `RunWorker.start/stop`; lease recovery and pending Approval creation.

- [ ] **Step 1: Write the failing final-response worker test**

```ts
it("commits only a completed attempt as canonical assistant history", async () => {
  model.script(
    transientFailureAfter("discard me"),
    completedText("final answer"),
  );
  await runWorkerUntilTerminal(runId);
  expect(store.listEventsAfter(runId, 0).map((event) => event.type)).toContain("model.attempt.failed");
  expect(sessionStore.listMessages(sessionId).filter((m) => m.role === "assistant"))
    .toEqual([expect.objectContaining({ content: "final answer" })]);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:unit -- test/unit/advance-run.test.ts`

Expected: FAIL because the advancement service does not exist.

- [ ] **Step 3: Implement one durable-boundary advancement algorithm**

`advance` performs exactly one of these actions per call:

1. recover an expired in-flight checkpoint;
2. execute one already-allowed Tool;
3. consume one completed/denied Tool result in the next prompt;
4. run one model turn with at most three transient attempts;
5. persist one proposed Tool and its policy result;
6. commit the final assistant message and `run.completed`.

Each branch validates current state and lease ownership before and after external I/O. Never hold a SQLite transaction open during a model request or Tool execution. A transient SQLite busy/unavailable error leaves the last committed checkpoint untouched and backs the worker off from 50 ms to a 1-second ceiling before trying another claim.

- [ ] **Step 4: Persist Tool proposal and policy outcomes atomically**

For `allow`, insert the immutable proposal, normalized canonical arguments/digest, matched rule, state `allowed`, and `tool.proposed` plus `tool.policy_decided`. For `ask`, also insert one pending Approval with a 24-hour expiry, move the Run to `waiting_approval`, clear the lease, accumulate active time, and append `approval.required` plus `run.waiting`. For `deny`, store a structured denial result and let the next advancement return it to the model.

- [ ] **Step 5: Implement external-I/O checkpoints**

Before Tool execution, transition `allowed -> executing` and append `tool.started` in one transaction. After execution, persist result, byte counts, `succeeded | failed`, and matching event in one transaction. Before each model attempt append `model.attempt.started`; coalesced deltas carry that Attempt ID. A failed attempt appends `model.attempt.failed`; partial text never becomes a Message. Retry transient provider failures with 250 ms, 1 second, then 4 second bounded delays, honoring `Retry-After` when it is longer but no more than 30 seconds.

- [ ] **Step 6: Write failing lease-recovery tests**

```ts
it("marks an abandoned side effect unknown and retries only read-only Tools", async () => {
  seedExecutingTool({ effect: "side_effect", leaseExpired: true });
  await service.advance(runId, "worker-recovery", signal);
  expect(store.getRun(runId).state).toBe("waiting_reconciliation");
  expect(toolStore.get(callId).state).toBe("unknown");

  seedExecutingTool({ effect: "read_only", leaseExpired: true });
  await service.advance(readOnlyRunId, "worker-recovery", signal);
  expect(fakeTool.executions(readOnlyCallId)).toBe(1);
});
```

- [ ] **Step 7: Implement recovery and active-time accounting**

On reclaim, append `model.attempt.failed` for an unmatched started Attempt. Transition abandoned read-only and idempotent internal calls back to `allowed`; linked Delegation calls follow Task 12's child-state recovery; transition abandoned external side effects to `unknown` and the Run to `waiting_reconciliation`. Active time accumulates when leaving `running`; Approval/reconciliation waits do not count.

- [ ] **Step 8: Implement the worker pool and heartbeat**

Start four claim loops by default. Each loop claims an eligible Run, creates an AbortController, renews its lease at one-third of lease duration, calls `advance`, and immediately continues while work is available. `stop()` stops new claims, aborts active model calls/read-only work, waits for loops, and leaves durable checkpoints for restart.

- [ ] **Step 9: Enforce model/Tool/output/time budgets**

Check budget before starting each model turn or Tool. Crossing a limit persists `run.failed` with code `run_budget_exceeded`; never start the external operation. Reject multiple Tool Calls as a model protocol error that consumes the model turn.

- [ ] **Step 10: Run worker and recovery suites**

Run: `npm run test:unit -- test/unit/advance-run.test.ts`

Run: `npm run test:integration -- test/integration/run-worker.test.ts test/integration/lease-recovery.test.ts`

Expected: final text, allow/ask/deny, retry attempts, Skill activation, delta events, budgets, Session concurrency, and recovery all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/ports/tool-store.ts src/ports/approval-store.ts src/application/advance-run.ts src/adapters/sqlite/tool-repository.ts src/adapters/sqlite/approval-repository.ts src/runtime/run-worker.ts src/runtime/lease-heartbeat.ts test/helpers/fake-tool.ts test/unit/advance-run.test.ts test/integration/run-worker.test.ts test/integration/lease-recovery.test.ts
git commit -m "feat: advance Runs through durable worker checkpoints"
```

### Task 11: Resolve Approvals, Reconciliation, Expiry, and Cancellation

**Files:**
- Create: `src/application/decide-approval.ts`, `reconcile-tool-call.ts`, `cancel-run.ts`
- Extend: `src/adapters/sqlite/approval-repository.ts`, `tool-repository.ts`, `run-repository.ts`
- Create: `src/runtime/approval-expirer.ts`, `execution-registry.ts`
- Test: `test/unit/decide-approval.test.ts`, `reconcile-tool-call.test.ts`, `cancel-run.test.ts`
- Test: `test/integration/approval-resume.test.ts`, `cancellation.test.ts`

**Interfaces:**
- Consumes: pending Approval, exact immutable Tool Call digest, unknown Tool Call, active AbortController/process handle, and Clock.
- Produces: `DecideApprovalService.execute`; `ReconcileToolCallService.execute`; `CancelRunService.execute`; `ApprovalExpirer.start/stop`; `ExecutionRegistry.register/abort`.

- [ ] **Step 1: Write failing idempotent Approval tests**

```ts
it("repeats the same decision but rejects the opposite decision", () => {
  const first = service.execute({ approvalId, decision: "approve" });
  expect(service.execute({ approvalId, decision: "approve" })).toEqual(first);
  expect(() => service.execute({ approvalId, decision: "deny" }))
    .toThrowError(expect.objectContaining({ code: "approval_already_resolved", status: 409 }));
});

it("resumes only the immutable approved arguments", () => {
  service.execute({ approvalId, decision: "approve" });
  expect(toolStore.get(callId)).toMatchObject({
    state: "allowed",
    argumentsSha256: originalDigest,
  });
});
```

- [ ] **Step 2: Run Approval tests and confirm failure**

Run: `npm run test:unit -- test/unit/decide-approval.test.ts`

Expected: FAIL because the decision service does not exist.

- [ ] **Step 3: Implement transactional Approval decisions**

For approve, transition `pending -> approved`, `waiting_approval -> allowed`, and Run `waiting_approval -> queued`; append `approval.resolved` and a resumable `run.queued` event. For deny or expiry, transition the Tool Call to `denied`, persist a structured Tool result with reason, queue the Run, and append the same audit events. Never read Policy from the current catalog; use the stored revision and immutable arguments.

- [ ] **Step 4: Implement the expiry scanner**

Every 60 seconds query pending Approvals with `expires_at <= clock.now()` and resolve them through the same transaction as an explicit denial with state `expired`. The scanner runs once immediately at startup and is idempotent across multiple invocations.

- [ ] **Step 5: Write failing reconciliation tests**

```ts
it.each(["succeeded", "failed"] as const)("records an Operator supplied %s result", (outcome) => {
  const result = service.execute({ toolCallId, outcome, note: "checked externally", result: { observed: true } });
  expect(result.toolCall.state).toBe(outcome);
  expect(store.getRun(runId).state).toBe("queued");
});

it("creates one linked retry without rewriting the unknown call", () => {
  const first = service.execute({ toolCallId, outcome: "retry" });
  const again = service.execute({ toolCallId, outcome: "retry" });
  expect(again.retryToolCallId).toBe(first.retryToolCallId);
  expect(toolStore.get(toolCallId).state).toBe("unknown");
  expect(toolStore.get(first.retryToolCallId).retryOfToolCallId).toBe(toolCallId);
});
```

- [ ] **Step 6: Implement reconciliation outcomes**

Validate that the original call is `unknown` and the Run is `waiting_reconciliation`. Limit note plus synthetic result to 64 KiB after canonicalization and pass it to the model as explicitly Operator-supplied untrusted Tool data. Reject `result` for `retry`; require it to be absent or bounded JSON for the two observed outcomes. For `retry`, create one linked immutable Tool Call with the original arguments, re-evaluate the stored Policy, and create a new Approval when the effect is `ask`; the reconciliation request itself does not reuse the consumed Approval.

- [ ] **Step 7: Implement in-process execution cancellation**

`ExecutionRegistry` maps Run IDs to current Attempt/Tool AbortControllers and optional process-tree handles. `CancelRunService` sets a durable cancellation request before aborting in-memory work. Waiting Approvals are denied with reason `run_cancelled`; queued Runs become terminal immediately. The worker decides after an active side effect stops: known non-execution becomes `cancelled`; a known completed result is persisted and the Run then becomes `cancelled`; uncertainty becomes `unknown` plus `waiting_reconciliation`.

- [ ] **Step 8: Run decision, reconciliation, and cancellation suites**

Run: `npm run test:unit -- test/unit/decide-approval.test.ts test/unit/reconcile-tool-call.test.ts test/unit/cancel-run.test.ts`

Run: `npm run test:integration -- test/integration/approval-resume.test.ts test/integration/cancellation.test.ts`

Expected: expiry, idempotency, restart resume, retry linking, model AbortSignal, and process-tree cancellation all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/application/decide-approval.ts src/application/reconcile-tool-call.ts src/application/cancel-run.ts src/adapters/sqlite/approval-repository.ts src/adapters/sqlite/tool-repository.ts src/adapters/sqlite/run-repository.ts src/runtime/approval-expirer.ts src/runtime/execution-registry.ts test/unit/decide-approval.test.ts test/unit/reconcile-tool-call.test.ts test/unit/cancel-run.test.ts test/integration/approval-resume.test.ts test/integration/cancellation.test.ts
git commit -m "feat: resolve human gates and cancellation"
```

---

### Task 12: Add Bounded, Auditable Agent Delegation

**Files:**
- Create: `src/application/delegate-agent.ts`
- Create: `src/adapters/tools/delegate-agent.ts`
- Extend: `src/adapters/sqlite/run-repository.ts`, `tool-repository.ts`, `session-repository.ts`
- Test: `test/unit/delegate-agent.test.ts`
- Test: `test/integration/delegation.test.ts`

**Interfaces:**
- Consumes: parent Run/revision, normalized `delegate_agent({ targetAgentId, task, context })`, target Agent revision, and limits.
- Produces: one persistent child Run in `delegate:<rootRunId>:<toolCallId>`; parent wake-up when the child becomes terminal.

- [ ] **Step 1: Write failing boundary tests**

```ts
it("rejects undeclared, recursive, and excessive delegation", () => {
  expect(() => delegate({ targetAgentId: "not-allowed" }))
    .toThrow(expect.objectContaining({ code: "delegate_not_allowed" }));
  expect(() => delegate({ parentDepth: 1 }))
    .toThrow(expect.objectContaining({ code: "delegation_depth_exceeded" }));
  seedFourChildren(rootRunId);
  expect(() => delegate({ rootRunId }))
    .toThrow(expect.objectContaining({ code: "delegation_count_exceeded" }));
});
```

Also assert that a child prompt receives only `task` and `context`, never parent Session messages.

- [ ] **Step 2: Run delegation tests and confirm failure**

Run: `npm run test:unit -- test/unit/delegate-agent.test.ts`

Expected: FAIL because the Tool and use case are missing.

- [ ] **Step 3: Implement the strict Delegation Tool**

```ts
const delegateSchema = z.strictObject({
  targetAgentId: agentIdSchema,
  task: z.string().min(1).max(32_768),
  context: z.record(z.string(), jsonValueSchema).default({}),
});
```

Normalize the target against the parent's snapshotted delegate allowlist. Classify this Tool as a durable internal side effect: it must pass Policy but never launches an external process.

- [ ] **Step 4: Create parent block and child Run in one transaction**

Generate `sessionKey = delegate:<rootRunId>:<toolCallId>`, insert a synthetic Session owned by the root Session, snapshot the target Agent revision, insert the child Run/input/event, increment the root Run child count, set the parent `blocked_by_child_run_id`, keep the parent Run in `running` with no lease, keep the parent Tool Call `executing`, and append `delegation.started`. If the transaction repeats, return the existing child.

- [ ] **Step 5: Resume the parent transactionally on child completion**

When a child reaches `completed | failed | cancelled`, locate its parent Tool Call. Persist a bounded child result, transition that call to `succeeded | failed`, clear the parent's child block, set parent Run to `queued`, and append `delegation.completed`. Recovery recognizes linked `delegate_agent` calls and never marks them `unknown`.

- [ ] **Step 6: Implement deletion and cancellation propagation**

Deleting a root Session cascades synthetic Sessions and their records. Cancelling a blocked parent requests cancellation of its non-terminal child before resolving the parent. Deleting a synthetic Session directly is forbidden with `synthetic_session_owned`.

- [ ] **Step 7: Run the Delegation integration suite**

Run: `npm run test:integration -- test/integration/delegation.test.ts`

Expected: one-level delegation, four-child cap, context isolation, crash/idempotency recovery, parent resume, and cascade deletion all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/application/delegate-agent.ts src/adapters/tools/delegate-agent.ts src/adapters/sqlite/run-repository.ts src/adapters/sqlite/tool-repository.ts src/adapters/sqlite/session-repository.ts test/unit/delegate-agent.test.ts test/integration/delegation.test.ts
git commit -m "feat: add bounded Agent delegation"
```

---

### Task 13: Expose the Authenticated HTTP API and Replayable SSE

**Files:**
- Create: `src/interfaces/http/app.ts`, `auth.ts`, `problem.ts`, `schemas.ts`, `sse.ts`
- Create: `src/interfaces/http/routes/health.ts`, `agents.ts`, `config.ts`, `runs.ts`, `approvals.ts`, `tool-calls.ts`, `sessions.ts`
- Create: `src/application/delete-session.ts`
- Extend: `src/adapters/sqlite/session-repository.ts`
- Create: `test/helpers/start-test-app.ts`
- Test: `test/integration/http-auth.test.ts`, `http-runs.test.ts`, `http-decisions.test.ts`, `sse.test.ts`

**Interfaces:**
- Consumes: all completed application use cases, static Bearer Secret reference, RunStore event queries, CatalogService.
- Produces: every M1 endpoint except `POST /v1/backups`, which Task 14 adds with its backing service; `application/problem+json`; persisted SSE replay/tail.

- [ ] **Step 1: Write failing authentication and Problem Details tests**

```ts
it("leaves only health and readiness unauthenticated", async () => {
  expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  const response = await app.inject({ method: "GET", url: "/v1/agents" });
  expect(response.statusCode).toBe(401);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.json()).toMatchObject({ code: "unauthorized", traceId: expect.any(String) });
});
```

- [ ] **Step 2: Run HTTP tests and confirm failure**

Run: `npm run test:integration -- test/integration/http-auth.test.ts`

Expected: FAIL because the Fastify app does not exist.

- [ ] **Step 3: Implement constant-time Bearer authentication**

Resolve the configured token once during bootstrap. Parse exactly one `Authorization: Bearer <token>` value, compare equal-length Buffers with `timingSafeEqual`, and return a generic 401 for missing/malformed/wrong tokens. Register the hook only under `/v1`.

- [ ] **Step 4: Implement strict request/response schemas and routes**

Add:

- `GET /healthz`, `GET /readyz`;
- `GET /v1/agents`, `POST /v1/config/reload`;
- `POST /v1/runs`, `GET /v1/runs/:runId`, `GET /v1/runs/:runId/events`, `POST /v1/runs/:runId/cancel`;
- `GET /v1/approvals?status=pending`, `POST /v1/approvals/:approvalId/decision`;
- `POST /v1/tool-calls/:toolCallId/reconciliation`;
- `GET /v1/sessions?agentId=&sessionKey=`, `DELETE /v1/sessions/:sessionId`.

Reject unknown JSON properties. Require `Idempotency-Key` on Run creation, return 202 with `runId/status/eventsUrl`, return 409 for idempotency or opposite-decision conflicts, and 422 for valid but unavailable Agents.

- [ ] **Step 5: Implement centralized Problem Details**

Map typed application/domain errors to `{ type: "about:blank", title, status, code, detail, traceId }`. SQLite busy/unavailable conditions map to `database_unavailable` with HTTP 503. Unknown errors become a generic 500 and are logged only after redaction. Never serialize stack traces, SQLite messages, filesystem paths, provider bodies, or Secret values. Pending `run_command` Approval representations include the fixed risk notice `This command runs on the host and is not isolated by an OS sandbox.`

- [ ] **Step 6: Write failing SSE replay tests**

```ts
it("replays strictly after Last-Event-ID and sends no uncommitted delta", async () => {
  seedEvents(runId, [1, 2, 3]);
  const stream = await openSse(runId, { lastEventId: "1" });
  expect(await stream.takeEvents(2)).toEqual([
    expect.objectContaining({ id: "2" }),
    expect.objectContaining({ id: "3" }),
  ]);
});
```

- [ ] **Step 7: Implement persisted replay and tail**

Validate `Last-Event-ID` as a non-negative integer, query `sequence > cursor`, write standard `id/event/data` fields, and poll for committed events until the Run is terminal or the client disconnects. Send `: heartbeat\n\n` every 15 seconds without persistence. Apply backpressure by awaiting `drain`; abort polling on socket close.

- [ ] **Step 8: Implement Session query and cascade deletion**

Return only identifiers and lifecycle metadata, never message bodies in the list endpoint. Refuse deletion while any Run is `running` unless cancellation has completed. Delete the root Session in one transaction and rely on tested foreign keys for core and synthetic child data.

- [ ] **Step 9: Run all HTTP and SSE integration tests**

Run: `npm run test:integration -- test/integration/http-auth.test.ts test/integration/http-runs.test.ts test/integration/http-decisions.test.ts test/integration/sse.test.ts`

Expected: auth, status codes, reload, CRUD, replay, heartbeat, disconnect, and redacted errors all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/interfaces/http src/application/delete-session.ts src/adapters/sqlite/session-repository.ts test/helpers/start-test-app.ts test/integration/http-auth.test.ts test/integration/http-runs.test.ts test/integration/http-decisions.test.ts test/integration/sse.test.ts
git commit -m "feat: expose authenticated Run API and SSE"
```

---

### Task 14: Add Bootstrap, HTTP-Only CLI, Examples, and Consistent Backup

**Files:**
- Create: `src/bootstrap.ts`
- Create: `src/application/create-backup.ts`
- Create: `src/adapters/sqlite/backup.ts`
- Create: `src/interfaces/http/routes/backups.ts`
- Create: `src/interfaces/cli/main.ts`, `client.ts`, `formatters.ts`
- Create: `src/interfaces/cli/commands/serve.ts`, `config.ts`, `agents.ts`, `runs.ts`, `approvals.ts`, `tools.ts`, `sessions.ts`, `backup.ts`
- Create: `examples/myagent.yaml`, `examples/agents/primary/agent.yaml`, `AGENT.md`, `policy.yaml`
- Create: `examples/agents/researcher/agent.yaml`, `AGENT.md`, `policy.yaml`
- Create: `examples/skills/research/SKILL.md`
- Test: `test/integration/backup.test.ts`, `cli.test.ts`, `bootstrap.test.ts`

**Interfaces:**
- Consumes: completed configuration, adapters, use cases, API base URL and Bearer Token references.
- Produces: runnable `myagent serve`; local pure `myagent config validate`; all operational CLI commands through HTTP; `POST /v1/backups`; consistent backup directory.

- [ ] **Step 1: Write the failing backup integrity test**

```ts
it("backs up SQLite online and copies exactly the active versioned Agent files", async () => {
  const response = await authenticatedInject({
    method: "POST",
    url: "/v1/backups",
    payload: { destination },
  });
  expect(response.statusCode).toBe(201);
  expect(await readManifest(destination)).toMatchObject({
    schemaVersion: 1,
    database: "kernel.db",
    files: expect.arrayContaining(["agents/primary/AGENT.md", "skills/research/SKILL.md"]),
  });
  expect(() => openAndMigrate(join(destination, "kernel.db"))).not.toThrow();
});
```

- [ ] **Step 2: Run the backup test and confirm failure**

Run: `npm run test:integration -- test/integration/backup.test.ts`

Expected: FAIL because the endpoint and backup service are absent.

- [ ] **Step 3: Implement an atomic backup directory**

Resolve a server-local destination, reject an existing target, create a sibling `.<name>.partial-<id>` directory, call Node `node:sqlite` online backup into `kernel.db`, copy the active global/Agent/prompt/policy/Skill source files while preserving relative ownership, and write `manifest.json` with SHA-256 for every file and active revision IDs. Rename the completed directory to the requested destination; remove only the validated partial directory on failure.

- [ ] **Step 4: Add `POST /v1/backups`**

Require the normal Bearer Token, strict body `{ destination: string }`, and return 201 with manifest summary only after both database and file copies finish. Return 409 when the destination exists and a redacted Problem Detail on filesystem failure.

- [ ] **Step 5: Write failing CLI boundary tests**

Run each operational command against `startTestApp` while replacing `node:sqlite` with a test that throws if imported into `src/interfaces/cli/**`. Run `config validate` against the pure Catalog loader with no server and assert it never imports SQLite. Assert:

- local `config validate`, HTTP `config reload`, and `agents list`;
- `run create/watch/cancel`;
- `approvals list/approve/deny`;
- `tools reconcile --as succeeded|failed|retry`;
- `sessions list/delete`;
- `backup <destination>`.

- [ ] **Step 6: Implement the HTTP client and command modules**

Use native `fetch`, read API base URL and Bearer Token from explicit CLI options or environment references, attach Bearer and Idempotency headers, parse Problem Details, and keep formatting separate from transport. `run watch` parses SSE and reconnects with the latest Event ID. Approval listing prints the exact normalized Tool summary and this sentence for `run_command`: `This command runs on the host and is not isolated by an OS sandbox.`

- [ ] **Step 7: Implement bootstrap and graceful shutdown**

`bootstrap(configPath)` asserts Node 24, loads global config before listening, resolves secrets, opens/migrates SQLite, composes repositories/use cases/Tools/model, starts ApprovalExpirer and RunWorker, then starts Fastify. On SIGINT/SIGTERM stop accepting HTTP, stop the worker/scanner, abort active operations, close SQLite, and exit non-zero on startup validation failure.

- [ ] **Step 8: Add runnable M1 examples**

The primary Agent may use `research` and delegate to `researcher`. Both Workspaces are explicit. Policies allow `activate_skill/list_files/read_file`, ask for `write_file/run_command`, allow only declared delegation, and deny `"*"`. Example Secrets are environment references only.

- [ ] **Step 9: Run bootstrap, CLI, and backup tests**

Run: `npm run test:integration -- test/integration/backup.test.ts test/integration/cli.test.ts test/integration/bootstrap.test.ts`

Expected: operational commands use HTTP, local validation does not open SQLite, bootstrap ordering is deterministic, graceful shutdown closes resources, and backup reopens successfully.

- [ ] **Step 10: Commit**

```bash
git add src/bootstrap.ts src/application/create-backup.ts src/adapters/sqlite/backup.ts src/interfaces/http/routes/backups.ts src/interfaces/cli examples test/integration/backup.test.ts test/integration/cli.test.ts test/integration/bootstrap.test.ts
git commit -m "feat: add service bootstrap CLI and online backup"
```

---

### Task 15: Harden Readiness, Logging, Redaction, and Network Defaults

**Files:**
- Create: `src/observability/redactor.ts`, `logger.ts`
- Extend: `src/interfaces/http/routes/health.ts`, `app.ts`
- Extend: `src/bootstrap.ts`
- Test: `test/unit/redactor.test.ts`
- Test: `test/integration/readiness.test.ts`, `secret-leak.test.ts`, `network-defaults.test.ts`

**Interfaces:**
- Consumes: configured sensitive key names, structured log objects, catalog status, SQLite writable probe, listener host.
- Produces: redacted JSON logs with trace/entity IDs; boolean-only health/readiness; non-loopback warning; telemetry disabled.

- [ ] **Step 1: Write failing recursive redaction tests**

```ts
it("redacts by key and known Secret value without mutating input", () => {
  const input = {
    authorization: "Bearer operator-secret",
    nested: { apiKey: "provider-secret", safe: "ok" },
    message: "request failed with provider-secret",
  };
  expect(redact(input, secrets(["operator-secret", "provider-secret"]))).toEqual({
    authorization: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", safe: "ok" },
    message: "request failed with [REDACTED]",
  });
  expect(input.nested.apiKey).toBe("provider-secret");
});
```

- [ ] **Step 2: Run redaction tests and confirm failure**

Run: `npm run test:unit -- test/unit/redactor.test.ts`

Expected: FAIL because the redactor does not exist.

- [ ] **Step 3: Implement centralized bounded redaction**

Redact case-insensitive keys `authorization`, `cookie`, `apiKey`, `token`, `secret`, configured sensitive keys, and exact resolved Secret values in nested arrays/objects/strings. Cap recursion depth and collection size so logging hostile Tool results cannot exhaust memory. The redactor returns a copy.

- [ ] **Step 4: Implement structured logger bindings**

Every request receives a `traceId`; application logs attach known `runId`, `sessionId`, `toolCallId`, and provider operation ID. Do not log model input/output, full Tool arguments/results, captured command output, or SSE data. Set product telemetry and remote analytics to disabled with no network exporter dependency.

- [ ] **Step 5: Implement liveness and readiness probes**

`/healthz` returns only `{ "ok": true }` while the event loop serves. `/readyz` returns only `{ "ready": boolean }`; it is false when catalog startup/reload has no valid snapshot, migration is incomplete, or `BEGIN IMMEDIATE; ROLLBACK` cannot obtain a writable database within the busy timeout. Do not return paths, Agent errors, or credentials.

- [ ] **Step 6: Add network-default tests**

Assert omitted host binds `127.0.0.1`; explicit `0.0.0.0` starts but writes one structured `non_loopback_binding` warning. Assert no Channel route exists, no unauthenticated `/v1` route exists, and no telemetry request is made.

- [ ] **Step 7: Run hardening and leak tests**

Run: `npm run test:unit -- test/unit/redactor.test.ts`

Run: `npm run test:integration -- test/integration/readiness.test.ts test/integration/secret-leak.test.ts test/integration/network-defaults.test.ts`

Expected: seeded Secrets are absent from captured logs, HTTP bodies, events, errors, and snapshots; readiness and listener behavior PASS.

- [ ] **Step 8: Commit**

```bash
git add src/observability src/interfaces/http/routes/health.ts src/interfaces/http/app.ts src/bootstrap.ts test/unit/redactor.test.ts test/integration/readiness.test.ts test/integration/secret-leak.test.ts test/integration/network-defaults.test.ts
git commit -m "feat: harden observability and service readiness"
```

---

### Task 16: Prove the M1 Vertical Slice with Fault Injection and CI

**Files:**
- Create: `src/runtime/fault-injector.ts`
- Create: `test/helpers/fault-child.ts`, `fault-controller.ts`
- Create: `test/e2e/m1-vertical.test.ts`, `restart-recovery.test.ts`, `fault-boundaries.test.ts`, `live-provider.smoke.test.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed real HTTP, SQLite, worker, file/command Tools, local scripted provider, and no-op production `FaultInjector`.
- Produces: executable M1 release gate on Windows/Linux and opt-in live-provider smoke command.

- [ ] **Step 1: Write the failing full-chain end-to-end test**

```ts
it("completes HTTP -> Skill -> allow -> Approval -> restart -> Tool -> response -> child Run", async () => {
  const run = await client.createRun({
    agentId: "primary",
    sessionKey: "e2e:main",
    text: "Use the research Skill, inspect the Workspace, write the report, then delegate review.",
    idempotencyKey: "e2e-request-0001",
  });
  await events.waitFor("skill.activated");
  await events.waitFor("approval.required");
  await service.restart();
  await client.approve(await client.onlyPendingApproval());
  const terminal = await events.waitFor("run.completed");
  expect(terminal.payload).toMatchObject({ result: expect.any(String) });
  expect(await database.countChildRuns(run.runId)).toBe(1);
});
```

Use a real temporary SQLite file, real HTTP/SSE, real file Tools, a harmless Node command, and a local scripted Chat Completions server.

- [ ] **Step 2: Run the vertical test and confirm failure at any missing integration**

Run: `npm run test:e2e -- test/e2e/m1-vertical.test.ts`

Expected before final wiring: FAIL at the first unconnected composition boundary, not because of external credentials.

- [ ] **Step 3: Add an injectable durable-boundary hook**

```ts
export interface FaultInjector {
  hit(point: FaultPoint): Promise<void>;
}

export const noFaults: FaultInjector = { async hit() {} };
```

Call it immediately before/after Run claim, model-attempt commit, Tool execution, Approval resolution, Worker resume, and SSE write. Production bootstrap always uses `noFaults`; test child composition injects a controller that exits the child process at one selected point.

- [ ] **Step 4: Implement process-restart fault tests**

For every required boundary, launch the service as a child process, wait for the controller signal, terminate at that point, restart against the same SQLite/config, and assert:

- no unapproved Tool executes;
- no known side effect executes twice;
- side-effect ambiguity enters `waiting_reconciliation`;
- pre-execution crashes resume safely;
- Approval remains pending across restart;
- resolved Approval resumes once;
- SSE reconnect replays committed events and omits uncommitted output.

- [ ] **Step 5: Add explicit duplicate and isolation release cases**

Run concurrent duplicate HTTP creates and assert one Run. Create the same Session Key under two Agents and assert no message, summary, Skill, Tool result, or child context crosses Agent identity. Queue two Runs in one Session and assert the second cannot start while the first waits for Approval; prove another Session continues.

- [ ] **Step 6: Add the optional live-provider smoke test**

Run only when `MYAGENT_SMOKE_MODEL`, base URL, and API-key environment reference are present. Create one no-Tool Run and assert terminal success, usage presence, and no Secret leakage; never assert exact model prose.

- [ ] **Step 7: Configure Windows/Linux CI**

Use a matrix of `windows-latest` and `ubuntu-latest` with Node 24. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:contract`, `npm run test:integration`, `npm run test:e2e`, and `npm run build`. Do not configure provider credentials. Upload failing test logs only after the redaction test has run.

- [ ] **Step 8: Run the complete local release gate**

Run:

```bash
npm run check
npm run test:e2e
```

Expected: every deterministic suite passes with zero real credentials, the database migrates empty and reopens, duplicate ingress produces one Run, Secret leak assertions find zero matches, and the full M1 chain passes.

- [ ] **Step 9: Verify no post-M1 scaffolding exists**

Run:

```bash
rg -n "memory_write|kb_collections|feishu|schedule_occurrences|EmbeddingPort|ChannelPort|SchedulerPort" src test examples
```

Expected: no matches. References may remain only in design/ADR documents outside implementation directories.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/fault-injector.ts test/helpers/fault-child.ts test/helpers/fault-controller.ts test/e2e package.json package-lock.json .github/workflows/ci.yml
git commit -m "test: prove M1 recovery and release gates"
```

---

## Specification Coverage Map

| Specification requirement | Implementing tasks |
|---|---|
| Single-Operator trust, loopback default, Bearer auth | 3, 13, 15 |
| Durable HTTP Run and idempotency | 4, 5, 13, 16 |
| `(agentId, sessionKey)` isolation and FIFO | 2, 5, 10, 16 |
| Immutable per-Run configuration revisions | 3, 4, 5 |
| On-demand trusted `SKILL.md` activation | 3, 7, 9, 10 |
| Default-deny Tool Policy and exact argument digest | 6, 10, 11 |
| Workspace file Tools and controlled host command | 7, 8 |
| Model streaming, retries, canonical messages, summaries | 9, 10 |
| Approval pause, expiry, resume, and cancellation | 10, 11, 13 |
| Unknown side effects and manual reconciliation | 10, 11, 16 |
| Bounded one-level Delegation | 12, 16 |
| Persisted SSE replay and 15-second heartbeat | 10, 13, 16 |
| Session deletion and online backup | 12, 13, 14 |
| CLI uses HTTP only | 13, 14 |
| Redaction, readiness, and no telemetry | 15, 16 |
| Windows/Linux and fault-injected release gates | 16 |
| M2/M3/M4 excluded from M1 | Global Constraints, 16 |

## Execution Boundary

Stop after Task 16 and evaluate the M1 release gate. Do not add Memory/RAG, Feishu, Scheduler, web administration, MCP, browser automation, compatibility layers, container sandboxing, or multi-tenant behavior while executing this plan. Each later milestone requires its own reviewed specification and implementation plan.
