# Pi-AI Provider Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every newly resolved model Run through a version-pinned Pi-AI adapter and loopback Provider Egress Gateway while preserving the Model Registry, controlled discovery, verification, and historical Run recovery.

**Architecture:** Keep `ModelPort`, `ModelRequest`, and `ModelChunk` unchanged above the adapter boundary. Persist a project-owned Provider Driver and normalized Pi invocation contract in Model Profile Revisions and new Run snapshots; the `PiAiModelAdapter` sends only to a loopback gateway that resolves the exact Connection Revision and applies `NodeProviderHttpTransport` to the real provider. Snapshots created before this migration remain executable through the existing OpenAI adapters.

**Tech Stack:** Node.js 24, TypeScript 5.9 ESM, SQLite `node:sqlite`, Fastify 5, Zod 4, `@mariozechner/pi-ai@0.73.1`, OpenAI SDK 5 only for pre-migration readers and OpenAI-compatible remote discovery, Vitest 3.

## Global Constraints

- Pin `@mariozechner/pi-ai` and `@mariozechner/pi-tui` to exact version `0.73.1`; do not use a caret range.
- Preserve `ModelPort`, durable event ordering, one structured Tool Call, provider Tool Call IDs, cancellation, and retry semantics.
- A Pi invocation may reach only a loopback Provider Egress Gateway; it must never receive a real provider Base URL or Secret.
- The gateway reuses the existing Secret, SSRF, DNS pinning, redirect, timeout, response-size, and normalized-error policy; gateway failure is fail-closed for model execution.
- `GET /models` remote discovery remains distinct from static Pi catalog candidates, and neither is equivalent to Model Verification.
- Existing Run snapshots without a Pi runtime descriptor route to legacy OpenAI adapters and are never rewritten.
- The initial native Driver allowlist supports bearer API-key and explicit no-auth connections only. OAuth, Azure-special-header, and AWS identity-chain candidates are visible as unsupported but cannot be created or assigned.
- A Run has one explicit Model Assignment. Do not add model, protocol, or cross-provider runtime fallback.
- All normal tests run on Windows and Linux without provider credentials; real-provider checks remain opt-in smoke tests.

---

## File Structure

- Create: `src/domain/pi-runtime.ts` - stable Driver IDs, normalized Pi runtime contract, and catalog candidate types that do not import Pi.
- Create: `src/config/pi-runtime-catalog.ts` - project-owned mapping from Driver/Candidate IDs to Pi catalog entries and exact Pi version.
- Create: `src/adapters/model/pi-ai-client.ts` - narrow testable wrapper around `pi-ai` `stream()` and catalog lookups.
- Create: `src/adapters/model/pi-ai-model.ts` - `ModelPort` implementation that maps the local contract to/from Pi streaming events.
- Create: `src/adapters/provider-egress-gateway.ts` - loopback-only HTTP gateway that turns opaque Pi routes into controlled provider fetches.
- Create: `src/application/list-provider-drivers.ts` - safe catalog projection for the control plane.
- Create: `src/interfaces/http/routes/provider-drivers.ts` - authenticated, schema-backed Driver/Candidate endpoint.
- Create: `src/adapters/sqlite/migrations/0003-pi-runtime.sql` - additive storage migration for Drivers and immutable runtime contracts.
- Create: `test/unit/pi-runtime-catalog.test.ts`, `test/contract/pi-ai-model.test.ts`, `test/contract/provider-egress-gateway.test.ts`, `test/integration/pi-runtime-registry.test.ts`, `test/integration/provider-drivers-http.test.ts`.
- Modify: `package.json`, `package-lock.json`, `src/domain/model-registry.ts`, `src/domain/provider-connection.ts`, `src/domain/model-profile.ts`, `src/domain/agent-revision.ts`, `src/ports/model-registry-store.ts`.
- Modify: `src/adapters/sqlite/model-registry-repository.ts`, `src/application/agent-resolver.ts`, `src/application/verify-model.ts`, `src/application/manage-provider-connections.ts`, `src/application/manage-model-profiles.ts`.
- Modify: `src/adapters/model/model-runtime-router.ts`, `src/bootstrap.ts`, `src/interfaces/http/app.ts`, `src/interfaces/http/model-control-schemas.ts`, `src/interfaces/http/routes/provider-connections.ts`, `src/interfaces/http/routes/model-profiles.ts`.
- Modify: `src/interfaces/cli/commands/providers.ts`, `src/interfaces/cli/commands/models.ts`, `src/interfaces/cli/commands/model-setup.ts`, `src/interfaces/cli/main.ts`, existing model/transport/migration tests, `docs/operations/model-registry.md`, and `CONTEXT.md` only where implementation exposes a newly settled domain term.

## Target Interfaces

Task 1 defines the types every later task consumes:

```ts
// src/domain/pi-runtime.ts
export type ProviderDriverId = `pi/${string}`;

export interface PiRuntimeContract {
  readonly kind: "pi_ai";
  readonly piVersion: "0.73.1";
  readonly driverId: ProviderDriverId;
  readonly catalogProviderId: string;
  readonly api: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly compatibility: Readonly<Record<string, boolean | number | string>>;
}

export interface ProviderCatalogCandidate {
  readonly candidateId: string;
  readonly driverId: ProviderDriverId;
  readonly displayName: string;
  readonly modelId: string;
  readonly invocation: Omit<PiRuntimeContract, "kind">;
  readonly credentialSupport: "bearer" | "none" | "unsupported";
}
```

```ts
// src/domain/agent-revision.ts
export interface EffectiveModelRuntime {
  // Existing fields remain for historical snapshots and the gateway target.
  readonly providerConnectionRevisionId: ProviderConnectionRevisionId;
  readonly providerKind: ProviderKind;
  readonly baseUrl: string;
  readonly providerAuth: ProviderAuth;
  readonly allowInsecureHttp: boolean;
  readonly modelId: string;
  readonly invocationProtocol: InvocationProtocol;
  readonly maxInputTokens: number;
  readonly verifiedCapabilities: readonly ModelCapability[];
  readonly compatibilityPresetVersion: string;
  readonly piRuntime?: PiRuntimeContract;
}
```

`piRuntime === undefined` is the sole legacy discriminator. New Profile Revisions always persist a complete `PiRuntimeContract`; the router never derives one from a mutable catalog during Run execution.

### Task 1: Pin Pi and Define Stable Runtime Contracts

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/domain/model-registry.ts`, `src/domain/provider-connection.ts`, `src/domain/model-profile.ts`, `src/domain/agent-revision.ts`
- Create: `src/domain/pi-runtime.ts`, `src/config/pi-runtime-catalog.ts`
- Test: `test/unit/pi-runtime-catalog.test.ts`, `test/unit/model-registry.test.ts`, `test/unit/agent-resolver.test.ts`

**Interfaces:**
- Consumes: existing `ProviderKind`, `InvocationProtocol`, `EffectiveModelRuntime`, and `ModelProfileRevision`.
- Produces: `ProviderDriverId`, `PiRuntimeContract`, `ProviderCatalogCandidate`, `PI_RUNTIME_VERSION`, `listProviderCatalogCandidates()`, and `resolveProviderCatalogCandidate()` for Tasks 2-6.

- [ ] **Step 1: Add failing catalog and snapshot-contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  PI_RUNTIME_VERSION,
  resolveProviderCatalogCandidate,
} from "../../src/config/pi-runtime-catalog.js";

describe("Pi runtime catalog", () => {
  it("returns a project-owned OpenAI candidate with a pinned invocation", () => {
    expect(resolveProviderCatalogCandidate("pi/openai", "gpt-4.1-mini")).toMatchObject({
      driverId: "pi/openai",
      modelId: "gpt-4.1-mini",
      invocation: { piVersion: PI_RUNTIME_VERSION, api: expect.any(String) },
      credentialSupport: "bearer",
    });
  });

  it("surfaces an OAuth-only candidate as unsupported", () => {
    expect(resolveProviderCatalogCandidate("pi/github-copilot", "any")).toMatchObject({
      driverId: "pi/github-copilot",
      credentialSupport: "unsupported",
    });
  });
});
```

Add an `AgentResolver` assertion that a current Profile Revision contributes a frozen `piRuntime`, while a fixture decoded from a pre-0003 `agent_revisions.content_json` has no `piRuntime`.

- [ ] **Step 2: Run the focused tests to verify the missing contract fails**

Run: `npm run test:unit -- test/unit/pi-runtime-catalog.test.ts test/unit/agent-resolver.test.ts`

Expected: FAIL because `pi-runtime-catalog.js` and the `piRuntime` field do not exist.

- [ ] **Step 3: Install exact Pi packages and add pure domain/catalog modules**

Run:

```powershell
npm install @mariozechner/pi-ai@0.73.1 @mariozechner/pi-tui@0.73.1 --save-exact
```

Implement `src/domain/pi-runtime.ts` using the target interfaces. In `src/config/pi-runtime-catalog.ts`, import `getProviders`, `getModels`, and `getModel` only in this adapter-side configuration module. Build a frozen list of project-owned Driver IDs and safe candidate projections. Preserve OAuth/AWS-only candidates with `credentialSupport: "unsupported"` so clients can explain why they are unavailable; allow Connection/Profile creation only for candidates whose credential requirement is `bearer` or `none`.

Extend `InvocationProtocol` with `"pi_ai"`. Add optional `piRuntime` to `ModelProfileRevision` and `EffectiveModelRuntime`. Keep the existing legacy protocols and fields so old data remains representable.

- [ ] **Step 4: Run the focused tests to verify the contract passes**

Run: `npm run test:unit -- test/unit/pi-runtime-catalog.test.ts test/unit/model-registry.test.ts test/unit/agent-resolver.test.ts`

Expected: PASS; candidates use project-owned Driver IDs and all catalog contracts contain `piVersion: "0.73.1"`.

- [ ] **Step 5: Commit the dependency and pure-contract boundary**

```powershell
git add package.json package-lock.json src/domain/pi-runtime.ts src/config/pi-runtime-catalog.ts src/domain/model-registry.ts src/domain/provider-connection.ts src/domain/model-profile.ts src/domain/agent-revision.ts test/unit/pi-runtime-catalog.test.ts test/unit/model-registry.test.ts test/unit/agent-resolver.test.ts
git commit -m "feat: define pinned pi runtime contracts"
```

### Task 2: Persist Drivers and Immutable Pi Contracts Without Rewriting History

**Files:**
- Create: `src/adapters/sqlite/migrations/0003-pi-runtime.sql`
- Modify: `src/ports/model-registry-store.ts`, `src/adapters/sqlite/model-registry-repository.ts`, `src/application/manage-provider-connections.ts`, `src/application/manage-model-profiles.ts`, `src/application/agent-resolver.ts`, `src/application/verify-model.ts`
- Test: `test/contract/sqlite-migrations.test.ts`, `test/contract/model-registry-repository.test.ts`, `test/integration/legacy-model-migration.test.ts`, `test/integration/pi-runtime-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 `ProviderDriverId` and `PiRuntimeContract`.
- Produces: repository reads/writes that expose `providerDriver` and `piRuntime` on current revisions, while accepting `undefined` in historical JSON snapshots for Tasks 3-5.

- [ ] **Step 1: Write failing migration and repository tests**

```ts
it("adds a driver and immutable Pi contract while preserving a legacy snapshot", () => {
  migrate(database);
  const connection = repository.createConnection({
    connectionId: providerConnectionIdFrom("pc_pi"),
    providerDriver: "pi/anthropic",
    // Remaining safe fields use the existing test fixture helpers.
  });
  expect(connection.providerDriver).toBe("pi/anthropic");

  const profile = repository.createProfile({
    piRuntime: anthropicContract,
    // Existing profile fields.
  });
  expect(profile.revisions[0]!.piRuntime).toEqual(anthropicContract);
  expect(decodeLegacyAgentSnapshot(legacyJson).model.piRuntime).toBeUndefined();
});
```

Add a migration assertion that modifying `runtime_contract_json` after insertion aborts with `immutable_model_profile_revision`.

- [ ] **Step 2: Run the focused tests to verify the schema is absent**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts`

Expected: FAIL because migration `0003` and `providerDriver`/`piRuntime` storage do not exist.

- [ ] **Step 3: Add the additive migration and repository mapping**

In `0003-pi-runtime.sql`:

```sql
ALTER TABLE provider_connections ADD COLUMN provider_driver TEXT;
UPDATE provider_connections
SET provider_driver = CASE provider_kind
  WHEN 'openai' THEN 'pi/openai'
  WHEN 'deepseek' THEN 'pi/deepseek'
  ELSE 'pi/openai-compatible'
END
WHERE provider_driver IS NULL;

ALTER TABLE model_profile_revisions
ADD COLUMN runtime_contract_json TEXT;
```

Drop and recreate `model_profile_revisions_content_immutable` with `runtime_contract_json` included in both the `BEFORE UPDATE OF ...` list and the `NEW ... IS NOT OLD ...` condition. Repository SQL must always write `provider_driver` for new Connections and serialize `runtime_contract_json` canonically for new Pi Profiles. Map a null `runtime_contract_json` to `piRuntime: undefined` only; reject malformed non-null JSON with the existing typed invalid-registry path.

Treat `provider_kind` as the compatibility projection required by older rows and migrations. New runtime behavior reads `providerDriver`; use `openai_compatible` only as the compatibility projection for a new native Driver that has no legacy kind, never as the execution selector.

Update `AgentResolver` and `VerifyModelService.resolveRuntime()` to freeze and snapshot the exact stored contract. Do not query `pi-runtime-catalog.ts` from either class.

- [ ] **Step 4: Run migration, repository, and legacy regression tests**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts`

Run: `npm run test:integration -- test/integration/legacy-model-migration.test.ts test/integration/pi-runtime-registry.test.ts`

Expected: PASS; the upgrade maps legacy Drivers, Pi contracts are immutable, and pre-migration snapshot JSON remains readable.

- [ ] **Step 5: Commit persisted-runtime compatibility**

```powershell
git add src/adapters/sqlite/migrations/0003-pi-runtime.sql src/ports/model-registry-store.ts src/adapters/sqlite/model-registry-repository.ts src/application/manage-provider-connections.ts src/application/manage-model-profiles.ts src/application/agent-resolver.ts src/application/verify-model.ts test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts test/integration/legacy-model-migration.test.ts test/integration/pi-runtime-registry.test.ts
git commit -m "feat: persist pi model runtime contracts"
```

### Task 3: Build the Loopback Provider Egress Gateway

**Files:**
- Create: `src/adapters/provider-egress-gateway.ts`
- Modify: `src/ports/provider-http-transport.ts`, `src/bootstrap.ts`
- Test: `test/contract/provider-egress-gateway.test.ts`, `test/contract/provider-http-transport.test.ts`, `test/e2e/multi-provider-models.test.ts`

**Interfaces:**
- Consumes: `EffectiveModelRuntime` and existing `ProviderHttpTransport.createFetch()`.
- Produces: `ProviderEgressGateway.start()`, `ProviderEgressGateway.routeFor(model)`, and `ProviderEgressGateway.stop()` for Task 4.

- [ ] **Step 1: Write failing gateway isolation tests**

```ts
it("accepts only an opaque loopback route and applies the controlled provider fetch", async () => {
  const gateway = await new ProviderEgressGateway({ transport, randomBytes }).start();
  const route = gateway.routeFor(runtime);

  expect(route.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pi\/[^/]+$/u);
  expect(route.baseUrl).not.toContain(runtime.baseUrl);
  expect(route.apiKey).not.toBe(runtime.providerAuth.type === "bearer" ? secretValue : undefined);

  await expect(fetch(`${route.baseUrl}/models`, {
    headers: { authorization: `Bearer ${route.apiKey}` },
  })).resolves.toHaveProperty("ok", true);
});

it("rejects a missing route capability before contacting the provider", async () => {
  await expect(fetch(`${gateway.baseUrl}/pi/missing/models`)).resolves.toMatchObject({ status: 401 });
  expect(resolveAddresses).not.toHaveBeenCalled();
});
```

Cover gateway stop, non-loopback binding, an attempted host escape, redirect rejection, request abort, and a provider Secret that is resolved only inside `NodeProviderHttpTransport`.

- [ ] **Step 2: Run the gateway tests to verify they fail**

Run: `npm run test:contract -- test/contract/provider-egress-gateway.test.ts`

Expected: FAIL because `ProviderEgressGateway` does not exist.

- [ ] **Step 3: Implement a bounded loopback gateway**

Use `node:http.createServer`, bind exactly to `127.0.0.1` with port `0`, and never expose the listener URL through HTTP control-plane responses. `routeFor()` stores an in-memory random route capability mapped to one immutable `EffectiveModelRuntime` and returns:

```ts
export interface PiGatewayRoute {
  readonly baseUrl: string;
  readonly apiKey: string;
}
```

For `POST` and `GET` requests under `/pi/:capability/*`, require a constant-time match of the supplied bearer capability, reconstruct `new URL(suffix, runtime.baseUrl)`, and call `transport.createFetch({ connection: providerRuntimeConnection(runtime), timeoutMs, maxResponseBytes })`. Copy only safe request headers, stream the controlled response back, and remove the capability on gateway shutdown. Do not forward the Pi capability or any incoming authorization header to the provider; the transport supplies the true authorization.

Extend `BootstrapOptions` only with test seams for a deterministic gateway listener and shutdown behavior. Bootstrap starts the gateway before constructing the Pi adapter and always stops it in the existing failure-cleanup and `shutdown()` paths.

- [ ] **Step 4: Run focused policy and lifecycle regressions**

Run: `npm run test:contract -- test/contract/provider-egress-gateway.test.ts test/contract/provider-http-transport.test.ts`

Run: `npm run test:e2e -- test/e2e/multi-provider-models.test.ts`

Expected: PASS; direct provider access is absent from Pi routes and all existing provider policy assertions still pass.

- [ ] **Step 5: Commit the fail-closed gateway**

```powershell
git add src/adapters/provider-egress-gateway.ts src/ports/provider-http-transport.ts src/bootstrap.ts test/contract/provider-egress-gateway.test.ts test/contract/provider-http-transport.test.ts test/e2e/multi-provider-models.test.ts
git commit -m "feat: gateway pi provider egress"
```

### Task 4: Map Pi Streams to the Existing ModelPort Contract

**Files:**
- Create: `src/adapters/model/pi-ai-client.ts`, `src/adapters/model/pi-ai-model.ts`
- Modify: `src/adapters/model/model-runtime-router.ts`, `src/bootstrap.ts`
- Test: `test/contract/pi-ai-model.test.ts`, `test/contract/model-runtime-router.test.ts`, `test/e2e/responses-approval-restart.test.ts`

**Interfaces:**
- Consumes: Task 1 `PiRuntimeContract`, Task 3 `ProviderEgressGateway`, and existing `ModelRequest`/`ModelChunk`.
- Produces: `PiAiModelAdapter implements ModelPort`; the router selects it only when `request.model.piRuntime !== undefined`.

- [ ] **Step 1: Write failing Pi stream normalization tests**

```ts
it("maps Pi text, usage, and one function call into ModelChunk values", async () => {
  const model = new PiAiModelAdapter({ client: scriptedPiClient([
    { type: "text_delta", text: "hello" },
    { type: "tool_call", id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
  ]), gateway });

  await expect(collect(model.streamAttempt(piRequest, new AbortController().signal))).resolves.toEqual([
    { type: "text_delta", text: "hello" },
    { type: "tool_call", callId: "call_1", name: "read_file", arguments: { path: "a.txt" } },
    { type: "completed", finishReason: "tool_call", usage: { inputTokens: 3, outputTokens: 2 } },
  ]);
});

it("rejects a second Pi function call before emitting a terminal chunk", async () => {
  await expect(collect(model.streamAttempt(twoToolCallRequest, signal))).rejects.toMatchObject({
    code: "model_protocol_error", transient: false,
  });
});
```

Add cases for malformed tool JSON, provider error mapping, cancellation, `tool_result` continuation preserving the original call ID, and a legacy request reaching the old Chat/Responses adapter.

- [ ] **Step 2: Run the focused tests to verify Pi mapping is missing**

Run: `npm run test:contract -- test/contract/pi-ai-model.test.ts test/contract/model-runtime-router.test.ts`

Expected: FAIL because the Pi adapter and runtime branch do not exist.

- [ ] **Step 3: Implement a narrow Pi client seam and adapter**

`pi-ai-client.ts` owns imports from `@mariozechner/pi-ai` and exposes a local interface:

```ts
export interface PiAiClient {
  stream(input: {
    contract: PiRuntimeContract;
    route: PiGatewayRoute;
    input: readonly ModelInput[];
    tools: readonly ModelRequest["tools"];
    signal: AbortSignal;
  }): AsyncIterable<PiStreamEvent>;
}
```

Use the frozen contract to construct the Pi model, replace only its Base URL and API key with `gateway.routeFor(request.model)`, set the resolved API/compatibility values, and pass the abort signal. `PiAiModelAdapter` converts local message/tool inputs to Pi context, disables parallel tool calls when the Pi API offers that switch, buffers arguments by call ID, emits one `tool_call`, and emits exactly one `completed` chunk. It must never import or call the Model Registry, Secret Store, or raw `fetch`.

Update `ModelRuntimeRouter` to use an explicit `piAi` option and branch on `request.model.piRuntime`; otherwise preserve the existing exact legacy protocol branch. Delete neither legacy adapter in this task.

- [ ] **Step 4: Run adapter, recovery, and router regressions**

Run: `npm run test:contract -- test/contract/pi-ai-model.test.ts test/contract/model-runtime-router.test.ts`

Run: `npm run test:e2e -- test/e2e/responses-approval-restart.test.ts test/e2e/multi-provider-models.test.ts`

Expected: PASS; Pi calls preserve one Tool Call and legacy Responses recovery still runs through its frozen reader.

- [ ] **Step 5: Commit the Pi adapter boundary**

```powershell
git add src/adapters/model/pi-ai-client.ts src/adapters/model/pi-ai-model.ts src/adapters/model/model-runtime-router.ts src/bootstrap.ts test/contract/pi-ai-model.test.ts test/contract/model-runtime-router.test.ts test/e2e/responses-approval-restart.test.ts
git commit -m "feat: route new model runs through pi ai"
```

### Task 5: Expose Safe Drivers and Candidates Through the Control Plane

**Files:**
- Create: `src/application/list-provider-drivers.ts`, `src/interfaces/http/routes/provider-drivers.ts`
- Modify: `src/interfaces/http/app.ts`, `src/interfaces/http/model-control-schemas.ts`, `src/interfaces/http/routes/provider-connections.ts`, `src/interfaces/http/routes/model-profiles.ts`, `src/interfaces/cli/commands/providers.ts`, `src/interfaces/cli/commands/models.ts`, `src/interfaces/cli/commands/model-setup.ts`, `src/interfaces/cli/main.ts`
- Test: `test/integration/provider-drivers-http.test.ts`, `test/integration/model-cli.test.ts`, `test/integration/http-model-control.test.ts`

**Interfaces:**
- Consumes: Task 1 catalog projection and Task 2 persisted Driver/contract fields.
- Produces: `GET /v1/admin/provider-drivers`, strict create/revise schemas using Driver/Candidate selection, and CLI fields that never accept arbitrary Pi API strings.

- [ ] **Step 1: Write failing HTTP and CLI tests**

```ts
it("lists supported Pi candidates separately from remote discovery", async () => {
  const response = await app.inject({
    method: "GET", url: "/v1/admin/provider-drivers", headers: adminHeaders,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    piVersion: "0.73.1",
    drivers: expect.arrayContaining([
      expect.objectContaining({ driverId: "pi/openai", candidates: expect.any(Array) }),
    ]),
  });
});

it("rejects a client-supplied unknown Pi API instead of persisting it", async () => {
  const response = await app.inject({
    method: "POST", url: "/v1/admin/model-profiles", headers: adminHeaders,
    payload: { invocation: { kind: "pi_ai", api: "made-up-api" } },
  });
  expect(response.statusCode).toBe(400);
});
```

Extend the interactive CLI fixture to choose a `pi/openai` Candidate, assert that its Driver/Candidate identifiers go to the control plane, and assert that a static candidate is labeled as a catalog choice rather than a discovered model.

- [ ] **Step 2: Run focused HTTP and CLI tests to verify routes are absent**

Run: `npm run test:integration -- test/integration/provider-drivers-http.test.ts test/integration/http-model-control.test.ts test/integration/model-cli.test.ts`

Expected: FAIL with `not_found` for `/v1/admin/provider-drivers` and schema rejection for Driver/Candidate input.

- [ ] **Step 3: Add server-side catalog projection and strict request parsing**

`ListProviderDriversService` returns only safe candidate fields. Register its GET route under the existing loopback/Admin middleware. Extend connection/profile mutation schemas with either a `catalogCandidateId` resolved by the service or the existing explicit OpenAI-compatible manual form. Resolve a Pi contract only on the server from a known Candidate; reject an unsupported credential mode, an unknown Driver, an unknown Candidate, or a mismatch between the candidate Driver and Connection Driver.

Keep remote discovery endpoints unchanged. When an endpoint returns `unsupported` or `empty`, the existing explicit manual model-ID path remains available only for the OpenAI-compatible Driver and still requires verification.

Update CLI options and `model setup` so the guided flow first loads the Driver catalog, calls its choice `Catalog model`, then independently invokes remote discovery for the created Connection. Preserve `--json`, existing OpenAI/DeepSeek inputs, and hidden Secret handling.

- [ ] **Step 4: Run control-plane and CLI regressions**

Run: `npm run test:integration -- test/integration/provider-drivers-http.test.ts test/integration/http-model-control.test.ts test/integration/model-cli.test.ts`

Expected: PASS; catalog candidates are safe metadata, unknown Pi API strings never persist, and existing custom OpenAI-compatible setup still works.

- [ ] **Step 5: Commit Driver control-plane support**

```powershell
git add src/application/list-provider-drivers.ts src/interfaces/http/routes/provider-drivers.ts src/interfaces/http/app.ts src/interfaces/http/model-control-schemas.ts src/interfaces/http/routes/provider-connections.ts src/interfaces/http/routes/model-profiles.ts src/interfaces/cli/commands/providers.ts src/interfaces/cli/commands/models.ts src/interfaces/cli/commands/model-setup.ts src/interfaces/cli/main.ts test/integration/provider-drivers-http.test.ts test/integration/http-model-control.test.ts test/integration/model-cli.test.ts
git commit -m "feat: expose pi provider drivers"
```

### Task 6: Prove Boot, Migration, and Release Safety

**Files:**
- Modify: `src/bootstrap.ts`, `test/e2e/multi-provider-models.test.ts`, `test/e2e/live-provider.smoke.test.ts`, `test/unit/e2e-fixture-cleanup.test.ts`, `docs/operations/model-registry.md`, `docs/superpowers/specs/2026-08-11-pi-ai-provider-runtime-and-pi-tui-design.md`
- Test: `test/e2e/multi-provider-models.test.ts`, `test/e2e/responses-approval-restart.test.ts`, `test/e2e/fault-boundaries.test.ts`, full `npm run check`

**Interfaces:**
- Consumes: Tasks 1-5 production runtime and control-plane APIs.
- Produces: release evidence that gateway startup/shutdown is leak-free, active assignments are stable across Pi failures, and the documented operational sequence is accurate.

- [ ] **Step 1: Add failing end-to-end release cases**

```ts
it("keeps an active Pi assignment byte-stable when gateway startup fails", async () => {
  const before = await assignmentSnapshot(app, "primary");
  await expect(startWithGatewayFailure()).rejects.toThrow("provider_egress_unavailable");
  expect(await assignmentSnapshot(app, "primary")).toEqual(before);
});

it("runs a new Pi profile through the gateway without exposing its Secret", async () => {
  const transcript = await configureVerifyPromoteAssign({ driver: "pi/openai" });
  expect(transcript.providerRequests).toContain("gateway");
  expect(JSON.stringify(transcript.observations)).not.toContain("provider-secret");
});
```

Add fixture cleanup assertions that the gateway listener is closed after partial bootstrap failure and normal shutdown.

- [ ] **Step 2: Run the E2E cases to prove release gaps exist**

Run: `npm run test:e2e -- test/e2e/multi-provider-models.test.ts test/e2e/fault-boundaries.test.ts`

Expected: FAIL until the Pi path is fully composed and listener cleanup is implemented.

- [ ] **Step 3: Finish bootstrap composition and operational documentation**

Ensure `bootstrap()` starts the gateway before the Pi adapter, injects the adapter into `ModelRuntimeRouter`, exposes the Driver service to `createHttpApp()`, and tears all resources down in reverse start order on both startup error and `shutdown()`. Document catalog-versus-discovery labels, unsupported auth states, exact Pi version, no-fallback behavior, and gateway health diagnostics in `docs/operations/model-registry.md`.

Keep the opt-in smoke test credential contract unchanged. Add a Pi Driver smoke configuration only when a configured Base URL, model ID, and API-key environment reference exist; never add credentials to CI.

- [ ] **Step 4: Run the full release gate**

Run: `npm run check`

Expected: PASS with lint, typecheck, all unit/contract/integration/E2E tests, build, and postbuild. The live-provider smoke test may remain skipped when credentials are absent.

- [ ] **Step 5: Commit release proof and documentation**

```powershell
git add src/bootstrap.ts test/e2e/multi-provider-models.test.ts test/e2e/live-provider.smoke.test.ts test/unit/e2e-fixture-cleanup.test.ts docs/operations/model-registry.md docs/superpowers/specs/2026-08-11-pi-ai-provider-runtime-and-pi-tui-design.md
git commit -m "test: prove pi provider runtime release gate"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 cover stable Drivers, exact Pi versions, persisted contracts, and historical snapshots; Task 3 covers the mandatory loopback egress boundary; Task 4 covers Pi stream semantics and no fallback; Task 5 covers safe catalog/discovery/control-plane behavior; Task 6 covers failure behavior, cross-platform release proof, and operating documentation.
- Placeholder scan: this plan contains no deferred work markers. Each task states its files, inputs, output interface, RED command, GREEN command, and commit boundary.
- Type consistency: `PiRuntimeContract`, `ProviderDriverId`, and optional `EffectiveModelRuntime.piRuntime` are defined before Tasks 2-5 consume them. The router's legacy discriminator is the same optional field used by resolver, verification, gateway, and adapter tests.
