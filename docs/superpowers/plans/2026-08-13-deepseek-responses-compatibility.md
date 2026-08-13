# DeepSeek Responses Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, versioned DeepSeek `deepseek-v4-flash` Pi-AI
Responses compatibility variant that performs the verified tool probe without
runtime fallback or secret-boundary changes.

**Architecture:** Extend the immutable Pi runtime contract with a small,
closed Provider Compatibility Contract and publish a project-owned Catalog
Compatibility Variant. The Pi client transforms only that variant's
Pi-generated Responses payload before it reaches the existing loopback Provider
Egress Gateway. Profile revisions and Run snapshots keep the exact contract;
legacy records read as `none`, and unknown contracts fail closed.

**Tech Stack:** Node.js 24, TypeScript 5.9 ESM, SQLite `node:sqlite`, Fastify
5, Vitest 3, `@mariozechner/pi-ai@0.73.1`, and the existing Provider Egress
Gateway.

## Global Constraints

- Keep `@mariozechner/pi-ai` and `@mariozechner/pi-tui` pinned at exact version
  `0.73.1`; do not modify `node_modules` or fork Pi-AI.
- Top-level `InvocationProtocol` remains `pi_ai`; `deepseek-responses-v1` is a
  nested, immutable Provider Compatibility Contract, not a runtime fallback.
- Only `pi/deepseek:deepseek-v4-flash-responses` enables
  `deepseek-responses-v1`; never infer it from Base URL, host name, or model ID.
- The existing `pi/deepseek:deepseek-v4-flash` Chat Completions candidate must
  remain selectable and behaviorally unchanged.
- A native candidate still requires live remote discovery of
  `deepseek-v4-flash`, bounded verification, explicit promotion, and explicit
  assignment.
- Pi-AI provider traffic continues only through `ProviderEgressGateway`; never
  expose a Provider Base URL, provider Secret, raw provider body, authorization
  header, or gateway capability in public output, logs, fixtures, or test names.
- A model attempt may produce one logical Tool Call only. Multiple distinct
  calls must be rejected as `model_protocol_error` before any Tool Proposal,
  Approval, or Tool execution occurs.
- Missing compatibility fields in existing Profile Revisions and snapshots
  mean `none`; no stored record is migrated or rewritten. Unknown values fail
  closed as `invalid_model_profile` in the control plane and
  `model_protocol_error` for captured Run execution.
- Do not alter normal deterministic CI credential requirements. The live
  DeepSeek check remains opt-in, environment-only, and does not run a real Tool.

---

## File Structure

- Modify: `src/domain/pi-runtime.ts` - defines the closed compatibility
  contract value and makes it part of immutable Pi runtime identity.
- Modify: `src/config/pi-runtime-catalog.ts` - adds the explicit DeepSeek
  Responses Compatibility Variant and exact contract/candidate resolution.
- Modify: `src/application/list-provider-drivers.ts` - continues to project
  candidates by their exact IDs, including the new variant.
- Modify: `src/interfaces/http/routes/model-profiles.ts` - projects the exact
  candidate ID from an immutable runtime contract rather than from a shared
  `driverId + modelId` pair.
- Modify: `src/adapters/sqlite/model-registry-repository.ts` - accepts legacy
  contracts without the field, persists the new field canonically, and rejects
  unknown values.
- Modify: `src/application/agent-resolver.ts`, `src/application/verify-model.ts`,
  `src/application/manage-model-profiles.ts` - preserve and freeze the exact
  contract across verification and Run snapshots.
- Modify: `src/adapters/model/pi-ai-client.ts` - passes request purpose into the
  payload transform and emits the DeepSeek minimum request shape only for the
  Compatibility Variant.
- Modify: `src/adapters/model/pi-ai-model.ts` - rejects unknown captured
  contracts before allocating a gateway route or emitting a Tool Call.
- Modify: `test/unit/pi-runtime-catalog.test.ts`,
  `test/contract/model-registry-repository.test.ts`,
  `test/integration/pi-runtime-registry.test.ts`,
  `test/integration/http-model-control.test.ts`,
  `test/contract/pi-ai-model.test.ts`,
  `test/e2e/responses-approval-restart.test.ts`, and
  `test/e2e/live-provider.smoke.test.ts` - lock behavior with deterministic
  local loops plus an opt-in live smoke test.
- Modify: `test/helpers/start-test-app.ts` and
  `test/helpers/fake-openai-provider.ts` - select the exact native candidate
  and provide a deterministic Responses multi-call fixture without credentials.
- Modify: `docs/operations/model-registry.md` - document the opt-in environment
  preconditions for the explicit Responses Variant.

## Target Interfaces

```ts
// src/domain/pi-runtime.ts
export type ProviderCompatibilityContract =
  | "none"
  | "deepseek-responses-v1";

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
  readonly providerCompatibilityContract: ProviderCompatibilityContract;
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
// src/config/pi-runtime-catalog.ts
export function resolveProviderCatalogCandidate(
  candidateId: string,
): ProviderCatalogCandidate | undefined;

export function resolveProviderCatalogCandidateForRuntime(
  runtime: Omit<PiRuntimeContract, "kind">,
): ProviderCatalogCandidate | undefined;
```

`resolveProviderCatalogCandidateForRuntime()` compares all immutable
invocation fields, including `providerCompatibilityContract`, and returns
`undefined` if there is no exact supported catalog identity. It must not guess
between candidates that share a provider model ID. Before comparison, it treats
an omitted historical field as `"none"` without mutating the runtime object;
this preserves unambiguous legacy Chat candidate projection without letting a
legacy runtime masquerade as the Responses variant.

```ts
// src/adapters/model/pi-ai-client.ts
function transformPayload(
  contract: PiRuntimeContract,
  purpose: ModelRequest["purpose"],
  payload: unknown,
): unknown | undefined;
```

The callback is closed over `purpose` by `PiAiSdkClient.stream()`. It is not a
new public runtime selector.

### Task 1: Define Compatibility Identity and Publish the Variant

**Files:**

- Modify: `src/domain/pi-runtime.ts`, `src/config/pi-runtime-catalog.ts`,
  `src/application/list-provider-drivers.ts`
- Test: `test/unit/pi-runtime-catalog.test.ts`,
  `test/integration/provider-drivers-http.test.ts`

**Interfaces:**

- Consumes: the existing `PiRuntimeContract`, static Pi catalog projections,
  and `ListProviderDriversService`.
- Produces: `ProviderCompatibilityContract`, an explicit
  `pi/deepseek:deepseek-v4-flash-responses` candidate, and exact candidate
  resolution for Tasks 2 and 3.

- [ ] **Step 1: Write failing catalog behavior tests**

Add tests that distinguish both DeepSeek `deepseek-v4-flash` candidates:

```ts
it("publishes explicit Chat Completions and Responses variants for DeepSeek V4 Flash", () => {
  const candidates = listProviderCatalogCandidates().filter((candidate) =>
    candidate.driverId === "pi/deepseek" && candidate.modelId === "deepseek-v4-flash",
  );

  expect(candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({
      candidateId: "pi/deepseek:deepseek-v4-flash",
      invocation: expect.objectContaining({
        api: "openai-completions",
        providerCompatibilityContract: "none",
      }),
    }),
    expect.objectContaining({
      candidateId: "pi/deepseek:deepseek-v4-flash-responses",
      displayName: "DeepSeek V4 Flash (Responses)",
      invocation: expect.objectContaining({
        api: "openai-responses",
        providerCompatibilityContract: "deepseek-responses-v1",
      }),
    }),
  ]));
});

it("resolves a runtime only when every immutable variant field matches", () => {
  const variant = resolveProviderCatalogCandidate(
    "pi/deepseek:deepseek-v4-flash-responses",
  );
  expect(variant).toBeDefined();
  expect(resolveProviderCatalogCandidateForRuntime(variant!.invocation))
    .toBe(variant);
  expect(resolveProviderCatalogCandidateForRuntime({
    ...variant!.invocation,
    providerCompatibilityContract: "none",
  })).toBeUndefined();
});
```

Add an HTTP catalog assertion that `/v1/admin/provider-drivers` exposes both
exact candidate IDs without transport or credential fields.

- [ ] **Step 2: Run the focused tests and confirm the expected red state**

Run:

```powershell
npm run test:unit -- test/unit/pi-runtime-catalog.test.ts
npm run test:integration -- test/integration/provider-drivers-http.test.ts
```

Expected: FAIL because `providerCompatibilityContract` and the explicit
Responses candidate/resolver do not exist.

- [ ] **Step 3: Add the closed compatibility type and frozen catalog variant**

In `src/domain/pi-runtime.ts`, add the two-value union and require it on new
in-memory `PiRuntimeContract` objects. In `src/config/pi-runtime-catalog.ts`:

1. Add `providerCompatibilityContract: "none"` to generated Pi candidates.
2. Append one frozen project-owned candidate for
   `pi/deepseek:deepseek-v4-flash-responses`; clone the native V4 Flash
   metadata for context and output limits, replace `api` with
   `openai-responses`, and set `providerCompatibilityContract` to
   `deepseek-responses-v1`.
3. Replace the current `(driverId, modelId)` resolver with an exact
   `candidateId` resolver, retaining the unsupported `:any` behavior only when
   it cannot collide with a concrete candidate ID.
4. Add `resolveProviderCatalogCandidateForRuntime()` that compares exact
   immutable runtime values without resolving mutable Pi catalog metadata.
5. Keep all exposed candidate collections and nested contracts frozen.

Do not alter `ListProviderDriversService` response types unless needed for the
existing candidate ID projection; the candidate ID is already the required
selection identity.

- [ ] **Step 4: Run the focused tests and confirm green**

Run:

```powershell
npm run test:unit -- test/unit/pi-runtime-catalog.test.ts
npm run test:integration -- test/integration/provider-drivers-http.test.ts
```

Expected: PASS; the catalog exposes both distinct variants and no resolver can
mistake the Responses contract for the Chat Completions contract.

- [ ] **Step 5: Commit the catalog identity boundary**

```powershell
git add src/domain/pi-runtime.ts src/config/pi-runtime-catalog.ts src/application/list-provider-drivers.ts test/unit/pi-runtime-catalog.test.ts test/integration/provider-drivers-http.test.ts
git commit -m "feat: add deepseek responses compatibility variant"
```

### Task 2: Persist, Snapshot, and Project Exact Contracts

**Files:**

- Modify: `src/adapters/sqlite/model-registry-repository.ts`,
  `src/application/manage-model-profiles.ts`, `src/application/agent-resolver.ts`,
  `src/application/verify-model.ts`, `src/interfaces/http/routes/model-profiles.ts`
- Test: `test/contract/model-registry-repository.test.ts`,
  `test/integration/pi-runtime-registry.test.ts`,
  `test/integration/http-model-control.test.ts`,
  `test/contract/catalog-repository.test.ts`

**Interfaces:**

- Consumes: Task 1 exact runtime/candidate resolver and existing immutable
  Profile Revision and Agent Revision storage.
- Produces: canonical persistence and exact Profile API projection for Task 3,
  and frozen snapshot propagation for Tasks 4 and 5.

- [ ] **Step 1: Write failing persistence and response-projection tests**

Add a repository test that writes a `deepseek-responses-v1` runtime and checks
canonical JSON contains the new field. Add legacy and invalid-record tests:

```ts
it("reads a historical Pi contract without a compatibility field as none", () => {
  insertRawRuntimeContract({ ...ANTHROPIC_CONTRACT });
  expect(repository.getProfile(profileId).revisions[0]!.piRuntime)
    .toMatchObject({ providerCompatibilityContract: "none" });
});

it("rejects an unknown persisted compatibility contract", () => {
  insertRawRuntimeContract({
    ...ANTHROPIC_CONTRACT,
    providerCompatibilityContract: "unreleased-v99",
  });
  expect(() => repository.getProfile(profileId))
    .toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
});
```

In `http-model-control.test.ts`, create a `pi/deepseek` Connection whose
discovery advertises `deepseek-v4-flash`, then create a Profile using
`pi/deepseek:deepseek-v4-flash-responses`. Assert the returned revision exposes
that exact candidate ID. Create a second Profile with
`pi/deepseek:deepseek-v4-flash`; assert it exposes the Chat candidate ID.

Add a snapshot test that Profile Verification and `AgentResolver.resolve()`
retain a frozen `providerCompatibilityContract`, and a catalog/run snapshot
read test that a hand-authored historical `piRuntime` lacking the field is
accepted without rewriting stored JSON.

- [ ] **Step 2: Run the focused tests and confirm the expected red state**

Run:

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts test/contract/catalog-repository.test.ts
npm run test:integration -- test/integration/pi-runtime-registry.test.ts test/integration/http-model-control.test.ts
```

Expected: FAIL because the repository validator rejects a missing field rather
than defaulting it, accepts no new field, and Profile response projection
resolves by only `driverId + modelId`.

- [ ] **Step 3: Make runtime persistence backward-compatible and fail closed**

Update `assertPiRuntime()` in `model-registry-repository.ts` to allow
`providerCompatibilityContract` in the strict key set. Normalize a missing
field to `"none"` only on parse/read. Validate only the two declared values.
When serializing a new or revised Pi runtime, always write the normalized
field, so newly created records are explicit and canonical.

Update all copy/freeze helpers in `ManageModelProfilesService`, `AgentResolver`,
and `VerifyModelService` to preserve the scalar field. Do not query the catalog
from these snapshot boundaries.

In `profileResponse()`, replace the two-argument resolver with
`resolveProviderCatalogCandidateForRuntime(piRuntime)`. The response must omit
`catalogCandidateId` for legacy/manual/unknown-equivalence runtimes rather
than guessing. Keep the HTTP create route unchanged except for taking the full
runtime built from the exact catalog candidate.

Use an internal normalization helper rather than mutating parsed JSON objects;
stored Profile Revision JSON and `agent_revisions.content_json` stay byte-stable
until the Operator deliberately creates a new Revision.

- [ ] **Step 4: Run focused persistence, snapshot, and HTTP tests**

Run:

```powershell
npm run test:contract -- test/contract/model-registry-repository.test.ts test/contract/catalog-repository.test.ts
npm run test:integration -- test/integration/pi-runtime-registry.test.ts test/integration/http-model-control.test.ts
```

Expected: PASS; legacy records read as `none`, unknown values fail closed, new
records persist explicitly, and each shared-model-ID variant round-trips to its
own exact candidate ID.

- [ ] **Step 5: Commit durable compatibility contracts**

```powershell
git add src/adapters/sqlite/model-registry-repository.ts src/application/manage-model-profiles.ts src/application/agent-resolver.ts src/application/verify-model.ts src/interfaces/http/routes/model-profiles.ts test/contract/model-registry-repository.test.ts test/contract/catalog-repository.test.ts test/integration/pi-runtime-registry.test.ts test/integration/http-model-control.test.ts
git commit -m "feat: persist deepseek responses compatibility contracts"
```

### Task 3: Produce the DeepSeek Responses Request Shape Through Pi and the Gateway

**Files:**

- Modify: `src/adapters/model/pi-ai-client.ts`
- Test: `test/contract/pi-ai-model.test.ts`,
  `test/contract/provider-egress-gateway.test.ts`

**Interfaces:**

- Consumes: Task 1 runtime contract identity, existing Pi `stream()` wrapper,
  and the established loopback Provider Egress Gateway.
- Produces: a minimal DeepSeek Responses request form for Task 4's end-to-end
  verification and Run scenarios.

- [ ] **Step 1: Write failing local-loopback request-shape tests**

In `pi-ai-model.test.ts`, add a real `PiAiSdkClient` local-loopback test using
the new runtime variant and a local `ProviderEgressGateway`. Capture the provider
request body after Pi serialization and assert:

```ts
expect(provider.responsesRequests[0]!.body).toMatchObject({
  model: "deepseek-v4-flash",
  stream: true,
  input: expect.any(Array),
  tools: [expect.any(Object)],
  tool_choice: "required",
});
expect(provider.responsesRequests[0]!.body).not.toHaveProperty("store");
expect(provider.responsesRequests[0]!.body).not.toHaveProperty("parallel_tool_calls");
expect(provider.responsesRequests[0]!.body.tools).toEqual([
  expect.not.objectContaining({ strict: expect.anything() }),
]);
```

Use a `verification_tool` request containing `capability_probe` and a fake
Responses SSE sequence that completes it. Add a separate regular `run` test
with tools that asserts no `tool_choice` appears. Add a tool-result continuation
request test that asserts no `tool_choice`, `store`, `parallel_tool_calls`, or
tool `strict` field appears while the original provider call ID is preserved.

Add a non-variant regression test proving an existing Pi Responses/manual
contract still receives its existing payload transform and does not gain a
forced `tool_choice` merely because its model ID is `deepseek-v4-flash`.

- [ ] **Step 2: Run the focused test and confirm the expected red state**

Run:

```powershell
npm run test:contract -- test/contract/pi-ai-model.test.ts test/contract/provider-egress-gateway.test.ts
```

Expected: FAIL because Pi-AI does not serialize `tool_choice` for Responses,
and the current generic transform adds `parallel_tool_calls: false`.

- [ ] **Step 3: Add an explicit, purpose-aware payload transformer**

Pass `input.purpose` into the closure used by `onPayload`:

```ts
onPayload: (payload) => transformPayload(
  input.contract,
  input.purpose,
  payload,
),
```

Extend `PiAiClient.stream()` input to carry `purpose`, and pass
`request.purpose` from `PiAiModelAdapter`. Keep `toolChoice` forwarded to Pi
for all existing contracts, but for `deepseek-responses-v1` return a cloned
payload that:

1. preserves only Pi-produced `model`, `input`, `stream`, and `tools` when
   present;
2. clones each tool object and deletes `strict` without changing canonical Tool
   schemas;
3. writes `tool_choice: "required"` only when `purpose === "verification_tool"`
   and the payload has a nonempty tools array;
4. otherwise emits no `tool_choice`.

This is a strict whitelist for `deepseek-responses-v1`, rather than a delete
list: no `store`, `parallel_tool_calls`, prompt-cache, output-token,
temperature, reasoning, service-tier, session, or future Pi-generated field
may cross the compatibility boundary without an explicit contract revision.

Do not use Base URL, driver name alone, or model ID to select this behavior.
Do not alter gateway authorization, headers, route capability, or provider
request URL construction.

- [ ] **Step 4: Run focused serializer and gateway tests**

Run:

```powershell
npm run test:contract -- test/contract/pi-ai-model.test.ts test/contract/provider-egress-gateway.test.ts
```

Expected: PASS; the compatibility transform is observed after real Pi
serialization and before controlled provider egress, with no direct provider
bypass or secret exposure.

- [ ] **Step 5: Commit the Pi request compatibility boundary**

```powershell
git add src/adapters/model/pi-ai-client.ts src/adapters/model/pi-ai-model.ts test/contract/pi-ai-model.test.ts test/contract/provider-egress-gateway.test.ts
git commit -m "fix: shape deepseek responses tool requests"
```

### Task 4: Enforce Contract and Tool-Call Failure Boundaries End to End

**Files:**

- Modify: `src/adapters/model/pi-ai-model.ts`,
  `test/helpers/fake-openai-provider.ts` if its scripted stream needs a
  malformed/multiple-call fixture
- Test: `test/contract/pi-ai-model.test.ts`,
  `test/e2e/responses-approval-restart.test.ts`,
  `test/e2e/multi-provider-models.test.ts`

**Interfaces:**

- Consumes: Task 2 snapshot contract and Task 3 purpose-aware request shape.
- Produces: explicit no-execution behavior for malformed/unknown compatibility
  attempts and validates the existing Approval path for one valid call.

- [ ] **Step 1: Write failing execution-boundary tests**

Add a contract test with a captured Pi runtime whose
`providerCompatibilityContract` is an unsafe cast such as `"unknown-v9"`.
Assert `PiAiModelAdapter.streamAttempt()` rejects with
`{ code: "model_protocol_error", transient: false }` before calling
`gateway.routeFor()` or `client.stream()`.

Extend `FakeProviderTurn` with a deterministic `multi_tool` Responses turn
containing two distinct `callId` values, names, and argument objects; its
`responsesEvents()` branch emits both completed function-call items in one
Responses stream. Add an E2E Responses-variant scenario using that turn and
assert:

```ts
expect(await service.onlyPendingApproval()).rejects.toThrow();
expect(database.prepare(
  "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
).get(run.runId)).toEqual({ count: 0 });
expect(await service.waitForRunStatus(run.runId, "failed")).toBeDefined();
```

Assert the only public failure code is `model_protocol_error` and that the
captured events, logs, and database strings do not contain a deliberately
inserted raw provider body sentinel. Keep the existing one-Tool-Call
approval/restart test and add an assertion that its Responses Compatibility
Variant continuation carries the same provider call ID and executes once.

- [ ] **Step 2: Run the focused test and confirm the expected red state**

Run:

```powershell
npm run test:contract -- test/contract/pi-ai-model.test.ts
npm run test:e2e -- test/e2e/responses-approval-restart.test.ts test/e2e/multi-provider-models.test.ts
```

Expected: FAIL because unknown contract values are not guarded at the adapter
entry point and the E2E helper has not selected the explicit Responses Variant.

- [ ] **Step 3: Guard captured contracts before egress and wire deterministic E2E selection**

In `PiAiModelAdapter`, validate the compatibility contract using the closed
type guard before `routeFor()` and before iterating Pi events. `none` and
`deepseek-responses-v1` are allowed; every other value throws the existing
non-transient `model_protocol_error` without including the bad value.

Do not change the existing buffered one-call algorithm: it already rejects a
second distinct call before yielding a Tool Call. Extend only the local test
helper/setup input to select an exact `catalogCandidateId` for a native
`pi/deepseek` profile after remote discovery. Do not inject provider Secrets
into test arguments, fixtures, logs, or configs.

- [ ] **Step 4: Run focused contract and E2E tests**

Run:

```powershell
npm run test:contract -- test/contract/pi-ai-model.test.ts
npm run test:e2e -- test/e2e/responses-approval-restart.test.ts test/e2e/multi-provider-models.test.ts
```

Expected: PASS; unknown captured contracts stop before egress, multiple calls
produce no Approval or Tool Call, and one valid call preserves the existing
Approval/restart semantics.

- [ ] **Step 5: Commit the execution failure boundary**

```powershell
git add src/adapters/model/pi-ai-model.ts test/helpers/fake-openai-provider.ts test/helpers/start-test-app.ts test/contract/pi-ai-model.test.ts test/e2e/responses-approval-restart.test.ts test/e2e/multi-provider-models.test.ts
git commit -m "test: cover deepseek responses tool boundaries"
```

### Task 5: Update the Opt-In Smoke Test and Operator Documentation

**Files:**

- Modify: `test/e2e/live-provider.smoke.test.ts`,
  `docs/operations/model-registry.md`
- Test: `test/e2e/live-provider.smoke.test.ts`

**Interfaces:**

- Consumes: Tasks 1-4's exact catalog candidate, live discovery, full
  verification, and no-Tool Run path.
- Produces: a documented opt-in verification command that does not broaden CI
  or credential handling.

- [ ] **Step 1: Write the failing smoke configuration test/guard**

Change `smokeSettings()` so it returns `null` unless
`MYAGENT_DEEPSEEK_BASE_URL` and `MYAGENT_DEEPSEEK_API_KEY` are present and
`MYAGENT_DEEPSEEK_MODEL` is either unset or exactly `deepseek-v4-flash`.
When the optional model variable names another model, add a skipped-test-safe
assertion that fails with `deepseek_responses_variant_requires_v4_flash` before
provider setup begins.

Update the setup request expectations to use:

```ts
driverId: "pi/deepseek",
catalogCandidateId: "pi/deepseek:deepseek-v4-flash-responses",
modelId: "deepseek-v4-flash",
protocol: "responses",
```

Extend the existing database assertion to require
`$.model.piRuntime.providerCompatibilityContract = 'deepseek-responses-v1'`.

- [ ] **Step 2: Run the focused test without credentials to confirm it stays skipped**

Run:

```powershell
npm run test:smoke:live
```

Expected: PASS with the live suite skipped when no DeepSeek environment
credentials are present. Do not set or print any credential to make it run.

- [ ] **Step 3: Document the explicit Responses Variant workflow**

In `docs/operations/model-registry.md`, replace any statement that a generic
`pi/deepseek:${MYAGENT_DEEPSEEK_MODEL}` catalog candidate is used. State that
the smoke check requires remote discovery of `deepseek-v4-flash` and selects
the explicit `pi/deepseek:deepseek-v4-flash-responses` Compatibility Variant.
Document that `MYAGENT_DEEPSEEK_MODEL`, when supplied, must equal
`deepseek-v4-flash`; the Base URL may be an Operator-owned proxy but does not
trigger compatibility inference. Keep credentials environment-only and never
suggest command-line secret values.

- [ ] **Step 4: Run the focused smoke command again**

Run:

```powershell
npm run test:smoke:live
```

Expected: PASS with no network request when the opt-in environment is absent;
the suite remains eligible to run full verification plus one no-Tool Run when
the Operator supplies valid environment references.

- [ ] **Step 5: Commit the smoke and operations contract**

```powershell
git add test/e2e/live-provider.smoke.test.ts docs/operations/model-registry.md
git commit -m "test: pin deepseek responses live smoke variant"
```

### Task 6: Run Full Release Verification and Review the Change Set

**Files:**

- Modify only if verification exposes a defect in Tasks 1-5.
- Test: the complete deterministic suite, lint, typecheck, build, and diff
  hygiene checks.

**Interfaces:**

- Consumes: all completed tasks.
- Produces: evidence required before integration, with no claim based only on
  targeted tests.

- [ ] **Step 1: Run focused regression groups together**

Run:

```powershell
npm run test:unit -- test/unit/pi-runtime-catalog.test.ts test/unit/model-verification.test.ts
npm run test:contract -- test/contract/pi-ai-model.test.ts test/contract/model-registry-repository.test.ts test/contract/catalog-repository.test.ts test/contract/provider-egress-gateway.test.ts
npm run test:integration -- test/integration/pi-runtime-registry.test.ts test/integration/http-model-control.test.ts test/integration/provider-drivers-http.test.ts
npm run test:e2e -- test/e2e/responses-approval-restart.test.ts test/e2e/multi-provider-models.test.ts
```

Expected: PASS. If any test fails, follow systematic debugging: capture the
exact error, reproduce the smallest failure, trace whether catalog identity,
persisted runtime parsing, payload translation, or stream handling is the
source, then add a minimal regression before changing implementation.

- [ ] **Step 2: Run full deterministic release gates**

Run:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:smoke:live
```

Expected: all deterministic commands PASS; the smoke command either skips due
to absent opt-in environment or passes without exposing credentials.

- [ ] **Step 3: Inspect privacy and repository hygiene**

Run:

```powershell
git diff --check
git status --short
rg -n "MYAGENT_DEEPSEEK_API_KEY|authorization|providerCompatibilityContract" test docs src --glob '!node_modules/**'
```

Expected: no whitespace errors, no committed `examples/data/` files, no
literal API-key values, no provider raw-body sentinels in public paths, and
only expected environment-variable references in the smoke test/documentation.

- [ ] **Step 4: Commit any release-gate-only corrections**

```powershell
git add [only files required by the verified correction]
git commit -m "test: verify deepseek responses compatibility"
```

Skip this step when no release-gate correction is needed.

- [ ] **Step 5: Request independent code review before integration**

Use the `requesting-code-review` skill with the pre-feature base SHA and the
current HEAD. The review must check: explicit-only variant selection; exact
candidate restoration; missing-field legacy parsing; unknown-contract
rejection; request shape after real Pi serialization; gateway-only egress;
single-call rejection before Approval; and credential/raw-body containment.
Fix every Critical or Important finding with a regression test, rerun the
affected focused suite, then rerun the full release gates above.
