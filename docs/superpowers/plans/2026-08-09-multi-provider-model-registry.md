# Multi-Provider Model Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Operator-managed Model Registry that discovers and verifies OpenAI, DeepSeek, and custom OpenAI-compatible models, fixes Chat Completions or Responses per immutable model revision, stores managed credentials safely, and assigns exact verified revisions to Agents without weakening Run, Session, Skill, Tool, or Approval guarantees.

**Architecture:** Keep one ESM TypeScript modular monolith and one SQLite database. File configuration continues to own Agent prompts, Skills, Policy, Workspace, delegation, and limits; a versioned SQLite Model Registry owns provider connections, model profiles, verification, promotion, defaults, and exact per-Agent assignments, while `AgentResolver` combines both sides only when a new Run snapshot is created. One policy-enforcing Provider HTTP Transport is shared by discovery, verification, and the protocol-specific Chat Completions and stateless Responses adapters.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9 strict ESM, npm, Fastify 5, Zod 4, YAML 2, OpenAI Node SDK 5, Node `node:sqlite`, Node `node:crypto`, Node `node:http`/`node:https`, Commander 14, RFC 8785 `canonicalize` 2, UUID 11, Vitest 3, fast-check 4, ESLint 9.

## Global Constraints

- Preserve the M1 HTTP, `(agentId, sessionKey)` isolation, immutable Run snapshot, Skill, Tool Policy, exact Approval, restart-recovery, reconciliation, delegation, SSE, and backup behavior.
- Static configuration version is exactly `2`; it includes separate environment Secret references for `server.bearerToken` and `server.adminToken`, and contains no active model or Agent model selection.
- The Model Control Plane is rooted at `/v1/admin`, accepts only actual loopback socket peers, requires the Admin Token, ignores forwarded-address headers, and grants no authority to the ordinary Run Token.
- Every Operator/control-plane mutation and stable-resource mutation except stable resource creation requires `expectedRevision`; a mismatch returns HTTP 409 with `revision_conflict` and leaves active revisions, defaults, and assignments unchanged. Internal Verification claim/begin/renew/complete transitions use durable state plus `leaseOwner` CAS, while informational Provider Health observations carry no configuration authority or Registry audit event.
- Stable Provider Connection and Model Profile IDs are immutable lowercase ASCII slugs of 1-63 characters; revision and operation IDs are opaque UUID-derived identifiers.
- Provider kinds are exactly `openai`, `deepseek`, and `openai_compatible`; invocation protocols are exactly `chat_completions` and `responses`.
- OpenAI and DeepSeek presets require Bearer auth and prefer Responses; Custom permits Bearer or no auth and prefers Chat Completions.
- A known preset may supply a maintained context-window suggestion; every unknown model visibly defaults to the explicit assumption of 32,768 input tokens until the Operator overrides it.
- A custom Base URL is preserved except for trailing slash removal; MyAgent never appends `/v1`, probes alternate prefixes, accepts URL credentials/query/fragment, or silently applies a changed preset.
- Discovery uses the standard Models API, follows pagination, stores at most 1,000 normalized entries, caps each response at 2,097,152 bytes, and defaults to a 600-second cache lifetime and 10,000 ms request timeout.
- Verification uses capability baseline `text_and_single_tool_call_v1`, a 30,000 ms per-request timeout, a 120,000 ms job timeout, concurrency one, and at most two attempts per required probe after transient request failure while honoring bounded `Retry-After`.
- Verification requires streamed public text plus exactly one valid synthetic `capability_probe` Tool Call; the synthetic call never enters Tool Policy, Approval, Run Tool persistence, or execution.
- Automatic protocol fallback may create a second immutable candidate only after HTTP 404, 405, 501, or validated provider code `unsupported_endpoint`; authentication, rate limit, timeout, transport, refusal, and capability failures never fall back.
- Runtime routing uses only the Invocation Protocol fixed in the stored Run snapshot; it never retries through another protocol or provider.
- Responses requests set `store: false`, never use `previous_response_id`, reconstruct all context locally, and neither expose nor persist reasoning items.
- Both protocol adapters disable SDK retries, request one Tool Call at most, preserve the provider `callId`, allow missing Usage, and reject malformed or multiple Tool Calls as `model_protocol_error`.
- Provider/runtime failure codes are the closed stable set `invalid_provider_url`, `insecure_provider_url`, `provider_auth_failed`, `provider_unavailable`, `provider_rate_limited`, `model_discovery_unsupported`, `model_not_found`, `invocation_protocol_unsupported`, `streaming_unsupported`, `tool_call_unsupported`, `model_protocol_error`, `secret_locked`, `verification_required`, `model_assignment_required`, `revision_conflict`, and `model_provider_locked`; raw provider codes are normalized into this set except validated `unsupported_endpoint`, which is internal fallback evidence only. Control-plane resource/lifecycle operations retain their separately typed codes, including `legacy_assignment_forbidden`, `resource_in_use`, `connection_revision_not_active`, and `legacy_import_already_completed`.
- Managed Secret Versions are immutable AES-256-GCM records with random 12-byte nonces, 16-byte tags, authenticated identity/version/purpose metadata, and a Base64 32-byte external master key; plaintext, ciphertext, key fragments, raw provider payloads, and reasoning never enter public responses, logs, events, snapshots, backups manifests, Verification records, health, or audit events.
- A missing or mismatched master key does not block local service readiness; affected managed provider resources are Locked, and Run creation fails with `model_provider_locked` only when it needs one.
- Provider network policy permits HTTPS and loopback HTTP by default, requires `allowInsecureHttp` for RFC1918 HTTP, and denies public HTTP, link-local, metadata, multicast, unspecified, URL credentials/query/fragment, cross-origin redirects, TLS bypass, and DNS rebinding.
- Existing version-1 YAML models import once, transactionally and idempotently, as restricted `legacy_trusted` exact assignments; version 2 rejects `models:` and Agent `model:` fields.
- Embedding, Rerank, RAG/Memory binding, multimodal input, native Anthropic/Gemini protocols, Azure/OAuth/custom headers, Web UI, runtime fallback, automatic failover, and remote administration remain out of scope; retain extension boundaries without adding placeholder adapters or routes.
- Normal tests and CI require no real provider credential. The live DeepSeek `deepseek-v4-flash` Responses smoke test is opt-in through environment variables.

---

## Locked File Map

Do not collapse the following ownership boundaries. Existing files not listed here should not change unless a task identifies an unavoidable compile-only update.

**Domain and canonical snapshots**

- Modify `src/domain/ids.ts`: branded Provider, Profile, revision, Verification, Secret Version, and registry event IDs plus stable-slug parsers.
- Modify `src/ports/id-generator.ts`, `src/adapters/uuid-id-generator.ts`: deterministic factories for all new opaque registry IDs.
- Create `src/domain/model-registry.ts`: shared provider kind, protocol, revision lifecycle, discovery state, capability baseline, health, audit, and optimistic-record metadata.
- Create `src/domain/provider-connection.ts`: stable Provider Connection, immutable connection revision, auth, network policy, preset provenance, and promotion eligibility.
- Create `src/domain/model-profile.ts`: stable Model Profile, immutable exact model revision, verified capabilities, and profile promotion eligibility.
- Create `src/domain/model-verification.ts`: durable Verification states, results, retry classification, and lease record.
- Create `src/domain/model-assignment.ts`: Default Profile and exact Agent Assignment records and Legacy-Trusted restrictions.
- Create `src/domain/managed-secret.ts`: immutable encrypted Secret envelope metadata and lifecycle types.
- Modify `src/domain/agent-revision.ts`: separate file-defined `AgentDefinitionRevision` from effective `AgentRevisionSnapshot` and use exact model runtime configuration.
- Modify `src/domain/tool-call.ts`, `src/domain/states.ts`: persist immutable provider `callId` and preserve existing Tool lifecycle.
- Modify `src/domain/errors.ts`: keep typed, Secret-free application/domain codes used by the control plane and runtime.

**Application services and Ports**

- Create `src/ports/model-registry-store.ts`: atomic registry commands, queries, audit writes, discovery cache, health, Verification queue/lease, defaults, and assignments.
- Create `src/ports/managed-secret-store.ts`: write-only create, resolve, destroy, reference inspection, and transactional master-key re-encryption.
- Create `src/ports/provider-http-transport.ts`: policy-enforced SDK-compatible fetch factory and normalized provider errors.
- Create `src/ports/model-discovery.ts`: normalized discovery result contract.
- Modify `src/ports/model.ts`: protocol-neutral structured inputs/chunks, optional Usage, fixed-protocol adapter options, and stable provider error taxonomy.
- Modify `src/ports/secret-resolver.ts`: resolve environment or opaque Managed Secret Version references.
- Create `src/application/manage-provider-connections.ts`: create/revise/promote/retire/purge connections and write audit records.
- Create `src/application/discover-models.ts`: cached/refresh discovery orchestration and connection promotion evidence.
- Create `src/application/manage-model-profiles.ts`: create/promote/retire/purge profiles.
- Create `src/application/verify-model.ts`: enqueue/cancel/probe/complete Verification and automatic protocol candidate handling.
- Create `src/application/assign-model.ts`: set/get default and exact per-Agent assignment with optimistic concurrency.
- Create `src/application/manage-secrets.ts`: write-only API Key versions, destruction checks, and master-key rotation.
- Create `src/application/agent-resolver.ts`: combine current Agent definition with one exact eligible Profile revision.
- Create `src/application/import-legacy-models.ts`: one-time version-1 import and stored source-hash mapping.
- Modify `src/application/create-run.ts`, `delegate-agent.ts`: consume `AgentResolver`, not a complete model-bearing Catalog revision.
- Modify `src/application/prompt-assembler.ts`, `advance-run.ts`: emit structured assistant Tool Calls/results and preserve provider call IDs through Approval and restart.

**Configuration and adapters**

- Modify `src/config/secret-ref.ts`: discriminated environment and Managed Secret Version references.
- Modify `src/config/schemas.ts`, `catalog-loader.ts`, `catalog-service.ts`: version-2 static config, model-control limits, model-free Agent definitions, and one-version legacy seed parsing.
- Create `src/config/provider-presets.ts`: immutable versioned OpenAI, DeepSeek, and Custom creation suggestions.
- Create `src/adapters/sqlite/migrations/0002-model-registry.sql`: all registry, discovery, Verification, health, audit, Secret, assignment, and legacy-import state plus provider Tool Call ID.
- Create `src/adapters/sqlite/model-registry-repository.ts`: atomic implementation of `ModelRegistryStore` and purge/reference checks.
- Create `src/adapters/sqlite/encrypted-secret-store.ts`: SQLite plus AES-256-GCM `ManagedSecretStore`.
- Create `src/adapters/composite-secret-resolver.ts`: environment/managed dispatch and dynamic redaction registration.
- Create `src/adapters/provider-http-transport.ts`: DNS validation/pinning, redirect, auth, timeout, streaming, and byte limits using Node HTTP(S).
- Create `src/adapters/model/openai-model-discovery.ts`: Models API pagination and normalized metadata only.
- Modify `src/adapters/model/openai-chat-completions.ts`: structured history/call IDs, optional Usage, shared transport, and normalized finish/error handling.
- Create `src/adapters/model/openai-responses.ts`: stateless Responses stream mapping.
- Create `src/adapters/model/model-runtime-router.ts`: fixed-protocol dispatch.
- Modify `src/adapters/sqlite/tool-repository.ts`, `run-repository.ts`, `catalog-repository.ts`: provider call ID persistence and effective snapshot compatibility.
- Modify `src/adapters/sqlite/backup.ts`: retain encrypted rows while guaranteeing manifest/key exclusion.

**Workers, HTTP, CLI, observability, and composition**

- Create `src/runtime/model-verification-worker.ts`: one-concurrency durable queue with lease recovery, cancellation, bounded retries, and safe shutdown.
- Modify `src/observability/redactor.ts`, `logger.ts`: runtime Secret registration and provider/control-plane payload suppression.
- Modify `src/interfaces/http/auth.ts`, `app.ts`, `problem.ts`, `schemas.ts`: separate Run/Admin authentication, actual-peer loopback enforcement, typed Problems, and composition.
- Create `src/interfaces/http/model-control-schemas.ts`: strict write-only request and safe response schemas.
- Create `src/interfaces/http/routes/provider-connections.ts`, `model-profiles.ts`, `model-verifications.ts`, `model-assignments.ts`, `managed-secrets.ts`: complete `/v1/admin` resources.
- Modify `src/interfaces/cli/main.ts`, `client.ts`, `formatters.ts`: Admin Token selection, `--json`, trace-aware errors, stable exit codes, and interactive prompting boundary.
- Create `src/interfaces/cli/commands/model-setup.ts`, `providers.ts`, `models.ts`, `verifications.ts`, `secrets.ts`; modify `agents.ts` for assignment commands.
- Modify `src/bootstrap.ts`: approved startup order, legacy import, Agent synchronization, two workers, router, Admin Token, and locked-provider tolerance.
- Modify `examples/myagent.yaml` and `examples/agents/*/agent.yaml`: version-2 model-free examples.
- Modify `.github/workflows/ci.yml`, `package.json`: deterministic release gates and opt-in DeepSeek smoke command.

**Tests and deterministic provider fixtures**

- Create `test/helpers/fake-openai-provider.ts`: local Models, Chat, and Responses endpoints with request capture, streaming scripts, redirects, limits, and typed failures.
- Create `test/helpers/fake-model-registry.ts`, `fake-managed-secret-store.ts`: focused unit doubles using the canonical Port signatures.
- Extend `test/helpers/scripted-model.ts`, `start-test-app.ts`, `fake-ids.ts`: optional Usage, call IDs, registry composition, Run/Admin tokens, and Verification worker control.
- Add `test/unit/model-registry.test.ts`, `model-verification.test.ts`, `provider-presets.test.ts`, `provider-network-policy.test.ts`, `agent-resolver.test.ts`, `legacy-model-import.test.ts`, `managed-secret-service.test.ts`.
- Add `test/contract/model-registry-repository.test.ts`, `managed-secret-store.test.ts`, `provider-http-transport.test.ts`, `openai-model-discovery.test.ts`, `openai-responses.test.ts`, `model-runtime-router.test.ts`; modify `openai-chat-completions.test.ts`, `sqlite-migrations.test.ts`.
- Add `test/integration/http-model-control.test.ts`, `model-verification-worker.test.ts`, `model-assignments.test.ts`, `model-cli.test.ts`, `legacy-model-migration.test.ts`, `model-secret-leak.test.ts`, `provider-readiness.test.ts`; modify auth/bootstrap/backup tests.
- Add `test/e2e/multi-provider-models.test.ts`, `responses-approval-restart.test.ts`; replace `test/e2e/live-provider.smoke.test.ts` with the opt-in DeepSeek Responses scenario.

## Canonical Cross-Task Contracts

Later tasks must use these exact names and shapes. If implementation exposes a type mismatch, update this section and all consuming task snippets before continuing.

```ts
export type ProviderKind = "openai" | "deepseek" | "openai_compatible";
export type InvocationProtocol = "chat_completions" | "responses";
export type RegistryRevisionState =
  | "draft" | "verifying" | "failed" | "verified"
  | "active" | "superseded" | "retired" | "legacy_trusted";
export type VerificationState = "queued" | "running" | "passed" | "failed" | "cancelled";
export type DiscoveryState = "fresh" | "stale" | "empty" | "unsupported" | "failed";
export const MODEL_CAPABILITY_BASELINE = "text_and_single_tool_call_v1" as const;

export type SecretRef =
  | { fromEnvironment: string }
  | { managedSecretVersionId: ManagedSecretVersionId };

export type ProviderAuth =
  | { type: "bearer"; secret: SecretRef }
  | { type: "none" };

export interface ProviderConnectionRevision {
  revisionId: ProviderConnectionRevisionId;
  connectionId: ProviderConnectionId;
  state: RegistryRevisionState;
  baseUrl: string;
  auth: ProviderAuth;
  allowInsecureHttp: boolean;
  protocolPreference: InvocationProtocol;
  presetVersion: string;
  createdAt: Date;
}

export interface ModelProfileRevision {
  revisionId: ModelProfileRevisionId;
  profileId: ModelProfileId;
  connectionRevisionId: ProviderConnectionRevisionId;
  providerModelId: string;
  invocationProtocol: InvocationProtocol;
  maxInputTokens: number;
  contextWindowSource: "preset" | "operator" | "assumed_32768";
  capabilityBaseline: typeof MODEL_CAPABILITY_BASELINE;
  verifiedCapabilities: readonly ("streaming_text" | "single_tool_call")[];
  state: RegistryRevisionState;
  createdAt: Date;
}
```

```ts
export interface EffectiveModelRuntime {
  providerConnectionRevisionId: ProviderConnectionRevisionId;
  providerKind: ProviderKind;
  baseUrl: string;
  providerAuth: ProviderAuth;
  modelId: string;
  invocationProtocol: InvocationProtocol;
  maxInputTokens: number;
  verifiedCapabilities: readonly ("streaming_text" | "single_tool_call")[];
  compatibilityPresetVersion: string;
}

export interface AgentDefinitionRevision {
  definitionRevisionId: string;
  agentId: AgentId;
  displayName: string;
  prompt: string;
  workspace: string;
  skills: readonly SkillSnapshot[];
  policy: readonly PolicyRule[];
  delegates: readonly AgentId[];
  limits: RunLimits;
  contentSha256: string;
}

export interface AgentRevisionSnapshot extends Omit<AgentDefinitionRevision, "definitionRevisionId"> {
  revisionId: string;
  definitionRevisionId: string;
  modelProfileRevisionId: ModelProfileRevisionId;
  model: EffectiveModelRuntime;
}

export interface AgentResolverPort {
  resolve(agentId: AgentId): AgentRevisionSnapshot;
}
```

```ts
export type ModelInput =
  | { type: "message"; role: "system" | "user" | "assistant"; name?: string; content: string }
  | { type: "assistant_tool_call"; callId: string; name: string; arguments: JsonValue }
  | { type: "tool_result"; callId: string; name: string; output: JsonValue };

export interface ModelRequest {
  purpose: "run" | "session_summary" | "verification_text" | "verification_tool";
  model: EffectiveModelRuntime;
  input: readonly ModelInput[];
  tools: readonly { name: string; description: string; inputSchema: JsonValue }[];
  toolChoice?: "required";
}

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; arguments: JsonValue }
  | {
      type: "completed";
      finishReason: "completed" | "tool_call" | "length" | "content_filter" | "unknown";
      usage?: ModelUsage;
    };

export interface ModelPort {
  streamAttempt(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}
```

```ts
export interface DiscoveryResult {
  state: "fresh" | "empty" | "unsupported";
  models: readonly { id: string; owner?: string; createdAt?: Date }[];
  fetchedAt: Date;
}

export interface ModelDiscoveryPort {
  discover(
    connection: ProviderConnectionRevision,
    limits: { timeoutMs: number; maxItems: number; maxResponseBytes: number },
    signal: AbortSignal,
  ): Promise<DiscoveryResult>;
}

export interface ProviderHttpTransport {
  createFetch(input: {
    connection: ProviderConnectionRevision;
    timeoutMs: number;
    maxResponseBytes: number;
  }): typeof fetch;
}

export interface ManagedSecretStore {
  createVersion(input: { versionId: ManagedSecretVersionId; secretId: string; purpose: "provider_api_key"; plaintext: string; now: Date }): ManagedSecretVersionMetadata;
  resolve(versionId: ManagedSecretVersionId): string;
  destroy(input: { versionId: ManagedSecretVersionId; expectedRevision: number; now: Date }): ManagedSecretVersionMetadata;
  rotateMasterKey(input: { expectedRevision: number; now: Date }): { reencrypted: number; currentKeyId: string; recordRevision: number };
}

export interface DynamicRedactionRegistry {
  register(value: string): void;
  values(): readonly string[];
}
```

```ts
export interface ManagedSecretVersionMetadata {
  versionId: ManagedSecretVersionId;
  secretId: string;
  purpose: "provider_api_key";
  keyId: string;
  state: "active" | "destroyed";
  recordRevision: number;
  createdAt: Date;
  destroyedAt: Date | null;
}

export interface ManagedSecretKeyringState {
  currentKeyId: string;
  recordRevision: number;
  updatedAt: Date;
}

export interface ProviderConnectionView {
  connectionId: ProviderConnectionId;
  displayName: string;
  providerKind: ProviderKind;
  activeRevisionId: ProviderConnectionRevisionId | null;
  retiredAt: Date | null;
  recordRevision: number;
  revisions: readonly ProviderConnectionRevision[];
}

export interface ModelProfileView {
  profileId: ModelProfileId;
  displayName: string;
  activeRevisionId: ModelProfileRevisionId | null;
  retiredAt: Date | null;
  recordRevision: number;
  revisions: readonly ModelProfileRevision[];
}

export interface DiscoveryView {
  connectionRevisionId: ProviderConnectionRevisionId;
  state: DiscoveryState;
  models: readonly { id: string; owner?: string; createdAt?: Date }[];
  fetchedAt: Date | null;
  expiresAt: Date | null;
  refreshError?: { code: string; status?: number; traceId: string };
}

export interface ModelVerification {
  verificationId: ModelVerificationId;
  profileRevisionId: ModelProfileRevisionId;
  capabilityBaseline: typeof MODEL_CAPABILITY_BASELINE;
  state: VerificationState;
  attemptCount: number;
  capabilities: readonly ("streaming_text" | "single_tool_call")[];
  resultCode?: string;
  safeStatus?: number;
  usage?: ModelUsage;
  traceId: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  cancellationRequestedAt: Date | null;
  fallbackVerificationId: ModelVerificationId | null;
  recordRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DefaultModelProfile {
  profileId: ModelProfileId;
  recordRevision: number;
}

export type AssignmentSource = "explicit" | "default" | "legacy_import";
export interface ModelAssignment {
  agentId: AgentId;
  modelProfileRevisionId: ModelProfileRevisionId;
  source: AssignmentSource;
  recordRevision: number;
  updatedAt: Date;
}

export type SecretReferenceOwner =
  | { type: "provider_connection_revision"; id: ProviderConnectionRevisionId }
  | { type: "retained_run_snapshot"; id: string };
```

Store command types are defined once here so application, SQLite, HTTP, and tests do not invent competing signatures:

```ts
export interface MutationContext { eventId: ModelRegistryEventId; traceId: string; now: Date }
export interface CreateConnectionRecord extends MutationContext {
  connectionId: ProviderConnectionId; displayName: string; providerKind: ProviderKind;
  revision: ProviderConnectionRevision;
}
export interface CreateConnectionRevisionRecord extends MutationContext {
  connectionId: ProviderConnectionId; expectedRevision: number;
  displayName?: string; revision: ProviderConnectionRevision;
}
export interface RecordDiscoveryInput extends MutationContext {
  connectionRevisionId: ProviderConnectionRevisionId;
  generationId: DiscoveryGenerationId;
  expectedRevision: number;
  state: "fresh" | "empty" | "unsupported" | "failed";
  models: DiscoveryView["models"];
  expiresAt?: Date;
  error?: { code: string; status?: number };
}
export interface CreateProfileRecord extends MutationContext {
  profileId: ModelProfileId; displayName: string; revision: ModelProfileRevision;
}
export interface CreateProfileRevisionRecord extends MutationContext {
  profileId: ModelProfileId; expectedRevision: number;
  displayName?: string; revision: ModelProfileRevision;
}
export interface QueueVerificationRecord extends MutationContext {
  verificationId: ModelVerificationId; profileRevisionId: ModelProfileRevisionId;
  expectedRevision: number;
  capabilityBaseline: typeof MODEL_CAPABILITY_BASELINE;
}
export interface ClaimVerificationInput { leaseOwner: string; now: Date; leaseUntil: Date }
export interface BeginVerificationAttemptInput {
  verificationId: ModelVerificationId; leaseOwner: string; now: Date;
}
export interface RenewVerificationLeaseInput {
  verificationId: ModelVerificationId; leaseOwner: string; now: Date; leaseUntil: Date;
}
export interface CompleteVerificationInput extends MutationContext {
  verificationId: ModelVerificationId; leaseOwner: string;
  outcome: "passed" | "failed"; capabilities: ModelVerification["capabilities"];
  resultCode?: string; safeStatus?: number; usage?: ModelUsage;
  fallback?: { revision: ModelProfileRevision; verification: QueueVerificationRecord };
}
export interface CancelVerificationInput extends MutationContext {
  verificationId: ModelVerificationId; expectedRevision: number;
}
export interface PromoteConnectionInput extends MutationContext {
  connectionId: ProviderConnectionId; revisionId: ProviderConnectionRevisionId; expectedRevision: number;
}
export interface PromoteProfileInput extends MutationContext {
  profileId: ModelProfileId; revisionId: ModelProfileRevisionId; expectedRevision: number;
}
export interface SetDefaultProfileInput extends MutationContext {
  profileId: ModelProfileId; expectedRevision: number;
}
export interface SetModelAssignmentInput extends MutationContext {
  agentId: AgentId; profileRevisionId: ModelProfileRevisionId;
  source: Exclude<AssignmentSource, "legacy_import">; expectedRevision: number;
}
export interface SynchronizeAgentsInput extends MutationContext { agentIds: readonly AgentId[] }
export interface RetireConnectionInput extends MutationContext {
  connectionId: ProviderConnectionId; expectedRevision: number;
}
export interface RetireProfileInput extends MutationContext {
  profileId: ModelProfileId; expectedRevision: number;
}
export interface PurgeConnectionInput extends MutationContext {
  connectionId: ProviderConnectionId; expectedRevision: number;
}
export interface PurgeProfileInput extends MutationContext {
  profileId: ModelProfileId; expectedRevision: number;
}
export interface RecordProviderHealthInput {
  connectionRevisionId: ProviderConnectionRevisionId;
  profileRevisionId?: ModelProfileRevisionId;
  outcome: "success" | "failure"; code?: string; safeStatus?: number;
  traceId: string; observedAt: Date;
}
export interface LegacyImportRecord extends MutationContext {
  migrationVersion: 1; sourceSha256: string;
  models: readonly LegacyModelSeed[];
  agentAliases: Readonly<Record<string, string>>;
}
export interface LegacyImportResult {
  sourceSha256: string;
  aliases: Readonly<Record<string, { connectionId: ProviderConnectionId; profileId: ModelProfileId; revisionId: ModelProfileRevisionId }>>;
  assignments: readonly ModelAssignment[];
  created: boolean;
}

export interface LegacyModelSeed {
  alias: string;
  providerKind: ProviderKind;
  baseUrl: string;
  apiKey: { fromEnvironment: string };
  modelId: string;
  maxInputTokens: number;
}

export interface LegacyModelImportSeed {
  sourceSha256: string;
  models: Readonly<Record<string, Omit<LegacyModelSeed, "alias">>>;
  agentAliases: Readonly<Record<string, string>>;
}
```

The `ModelRegistryStore` is one atomic persistence boundary. Its public methods are:

```ts
export interface ModelRegistryStore {
  createConnection(input: CreateConnectionRecord): ProviderConnectionView;
  createConnectionRevision(input: CreateConnectionRevisionRecord): ProviderConnectionView;
  getConnection(id: ProviderConnectionId): ProviderConnectionView;
  listConnections(): readonly ProviderConnectionView[];
  recordDiscovery(input: RecordDiscoveryInput): DiscoveryView;
  getDiscoveredModels(revisionId: ProviderConnectionRevisionId, now: Date): DiscoveryView;
  createProfile(input: CreateProfileRecord): ModelProfileView;
  createProfileRevision(input: CreateProfileRevisionRecord): ModelProfileView;
  getProfile(id: ModelProfileId): ModelProfileView;
  listProfiles(): readonly ModelProfileView[];
  queueVerification(input: QueueVerificationRecord): ModelVerification;
  claimVerification(input: ClaimVerificationInput): ModelVerification | null;
  beginVerificationAttempt(input: BeginVerificationAttemptInput): ModelVerification;
  renewVerificationLease(input: RenewVerificationLeaseInput): boolean;
  completeVerification(input: CompleteVerificationInput): ModelVerification;
  cancelVerification(input: CancelVerificationInput): ModelVerification;
  getVerification(id: ModelVerificationId): ModelVerification;
  promoteConnection(input: PromoteConnectionInput): ProviderConnectionView;
  promoteProfile(input: PromoteProfileInput): ModelProfileView;
  setDefaultProfile(input: SetDefaultProfileInput): DefaultModelProfile;
  getDefaultProfile(): DefaultModelProfile | null;
  setAssignment(input: SetModelAssignmentInput): ModelAssignment;
  getAssignment(agentId: AgentId): ModelAssignment | null;
  synchronizeAgents(input: SynchronizeAgentsInput): readonly ModelAssignment[];
  retireConnection(input: RetireConnectionInput): ProviderConnectionView;
  retireProfile(input: RetireProfileInput): ModelProfileView;
  purgeConnection(input: PurgeConnectionInput): void;
  purgeProfile(input: PurgeProfileInput): void;
  inspectSecretReferences(versionId: ManagedSecretVersionId): readonly SecretReferenceOwner[];
  recordProviderHealth(input: RecordProviderHealthInput): void;
  importLegacy(input: LegacyImportRecord): LegacyImportResult;
}
```

Every view returned by the HTTP layer excludes `SecretRef` internals except opaque Managed Secret Version IDs, and exposes `credentialConfigured: boolean` instead.

---

### Task 1: Define Registry Domain Types, IDs, and Invariants

**Files:**
- Modify: `src/domain/ids.ts`, `errors.ts`
- Modify: `src/ports/id-generator.ts`, `src/adapters/uuid-id-generator.ts`
- Modify: `test/helpers/fake-ids.ts`
- Create: `src/domain/model-registry.ts`, `provider-connection.ts`, `model-profile.ts`, `model-verification.ts`, `model-assignment.ts`, `managed-secret.ts`
- Test: `test/unit/model-registry.test.ts`, `model-verification.test.ts`, `ids.test.ts`

**Interfaces:**
- Consumes: existing branded ID, `JsonValue`, Run snapshot, and transition conventions.
- Produces: every domain type in Canonical Cross-Task Contracts plus pure assertions `assertConnectionPromotable`, `assertProfilePromotable`, `assertNewAssignmentEligible`, `assertExistingAssignmentUsable`, `assertPurgeAllowed`, and `classifyVerificationRetry`.

- [ ] **Step 1: Write failing lifecycle and assignment tests**

```ts
it("never treats Profile promotion as assignment movement", () => {
  const assignment = assigned("primary", "mpr_old", "explicit");
  expect(assertExistingAssignmentUsable(assignment, supersededRevision("mpr_old"))).toBeUndefined();
  expect(assignment.modelProfileRevisionId).toBe("mpr_old");
});

it("allows fallback only for endpoint absence", () => {
  expect(canTryFallback({ status: 404, code: "invocation_protocol_unsupported" })).toBe(true);
  expect(canTryFallback({ status: 401, code: "provider_auth_failed" })).toBe(false);
  expect(canTryFallback({ status: 429, code: "provider_rate_limited" })).toBe(false);
});
```

- [ ] **Step 2: Run focused tests and confirm missing exports**

Run: `npm run test:unit -- test/unit/model-registry.test.ts test/unit/model-verification.test.ts test/unit/ids.test.ts`

Expected: FAIL with unresolved registry modules and ID factories.

- [ ] **Step 3: Add exact IDs, enums, and immutable records**

Use the registry-specific canonical shapes above without changing the existing `AgentRevisionSnapshot`, `ToolCall`, or Model Port yet. Add `parseProviderConnectionId`, `parseModelProfileId`, and UUID factories `providerConnectionRevisionIdFromUuid`, `modelProfileRevisionIdFromUuid`, `modelVerificationIdFromUuid`, `managedSecretVersionIdFromUuid`, `modelRegistryEventIdFromUuid`, and `discoveryGenerationIdFromUuid`. Their exact serialized prefixes are respectively `pcr_`, `mpr_`, `ver_`, `msv_`, `mre_`, and `dgn_`. Extend `IdGenerator`, `UuidIdGenerator`, and `FakeIds` with matching zero-argument methods. Reuse the existing 1-63 lowercase slug grammar for stable connection/profile IDs and reject cross-type assignment at compile time.

- [ ] **Step 4: Implement pure lifecycle assertions**

```ts
export function assertNewAssignmentEligible(revision: ModelProfileRevision): void {
  if (revision.state === "active"
      && revision.verifiedCapabilities.includes("streaming_text")
      && revision.verifiedCapabilities.includes("single_tool_call")) return;
  throw new DomainError(revision.state === "legacy_trusted" ? "legacy_assignment_forbidden" : "verification_required");
}

export function assertExistingAssignmentUsable(assignment: ModelAssignment, revision: ModelProfileRevision): void {
  if (assignment.source === "legacy_import" && revision.state === "legacy_trusted") return;
  if (["active", "superseded", "retired"].includes(revision.state)
      && revision.verifiedCapabilities.includes("streaming_text")
      && revision.verifiedCapabilities.includes("single_tool_call")) return;
  throw new DomainError("verification_required");
}

export function assertConnectionPromotable(revision: ProviderConnectionRevision): void {
  if (revision.state === "verified") return;
  throw new DomainError("verification_required");
}

export function assertProfilePromotable(
  revision: ModelProfileRevision,
  connectionRevision: ProviderConnectionRevision,
): void {
  if (connectionRevision.state !== "active") throw new DomainError("connection_revision_not_active");
  if (revision.state === "verified"
      && revision.verifiedCapabilities.includes("streaming_text")
      && revision.verifiedCapabilities.includes("single_tool_call")) return;
  throw new DomainError("verification_required");
}

export function assertPurgeAllowed(referenceCount: number): void {
  if (referenceCount === 0) return;
  throw new DomainError("resource_in_use");
}

export type VerificationRetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; delayMs: number };

export interface VerificationProviderError {
  readonly code: ProviderRuntimeErrorCode;
  readonly transient: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
}

export function classifyVerificationRetry(
  error: Pick<VerificationProviderError, "code" | "transient" | "retryAfterMs">,
  attemptNumber: number,
): VerificationRetryDecision {
  const retryableCode = error.code === "provider_unavailable" || error.code === "provider_rate_limited";
  if (!error.transient || !retryableCode || attemptNumber >= 2) return { shouldRetry: false };
  return {
    shouldRetry: true,
    delayMs: Math.min(Math.max(error.retryAfterMs ?? 1_000, 1_000), 30_000),
  };
}

const validatedUnsupportedEndpointBrand: unique symbol = Symbol("validated_unsupported_endpoint");
export interface ValidatedUnsupportedEndpointEvidence {
  readonly code: "unsupported_endpoint";
  readonly [validatedUnsupportedEndpointBrand]: true;
}

export function validateUnsupportedEndpointCode(
  code: string,
): ValidatedUnsupportedEndpointEvidence | null {
  return code === "unsupported_endpoint"
    ? { code, [validatedUnsupportedEndpointBrand]: true }
    : null;
}

export function canTryFallback(
  error:
    | Pick<VerificationProviderError, "status" | "code">
    | ValidatedUnsupportedEndpointEvidence,
): boolean {
  if (error.code === "unsupported_endpoint") return true;
  return error.code === "invocation_protocol_unsupported"
    && (error.status === 404 || error.status === 405 || error.status === 501);
}
```

`unsupported_endpoint` is not a `ProviderRuntimeErrorCode` and never enters a public failure record. Only the branded evidence returned by `validateUnsupportedEndpointCode` can carry it into fallback classification.

Keep content immutable even when lifecycle state changes. A Legacy-Trusted revision is usable only by its imported assignment and is never defaultable, copyable, promotable, or newly assignable.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run test:unit -- test/unit/model-registry.test.ts test/unit/model-verification.test.ts test/unit/ids.test.ts`

Run: `npm run typecheck`

Expected: domain tests and the full repository typecheck PASS without changing current Run behavior.

- [ ] **Step 6: Commit**

```bash
git add src/domain src/ports/id-generator.ts src/adapters/uuid-id-generator.ts test/helpers/fake-ids.ts test/unit/model-registry.test.ts test/unit/model-verification.test.ts test/unit/ids.test.ts
git commit -m "feat: define Model Registry domain invariants"
```

---

### Task 2: Add the Core SQLite Model Registry

**Files:**
- Create: `src/ports/model-registry-store.ts`
- Create once and finalize: `src/adapters/sqlite/migrations/0002-model-registry.sql`
- Create: `src/adapters/sqlite/model-registry-repository.ts`
- Modify: `src/adapters/sqlite/migrator.ts`
- Test: `test/contract/sqlite-migrations.test.ts`, `model-registry-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 records and existing `DatabaseSync` transaction conventions.
- Produces: core connection/profile CRUD, optimistic immutable revision append for both resource types, promotion, assignment/default, retirement, purge, append-only audit, and optimistic `recordRevision` methods of `ModelRegistryStore`.

- [ ] **Step 1: Write failing schema and atomicity tests**

```ts
it("promotes a Profile without moving its exact Agent Assignments", () => {
  const oldRevision = seedActiveProfile(db, "assistant", "mpr_old");
  repository.setAssignment(assign("primary", oldRevision, 0));
  const promoted = repository.promoteProfile(promote("assistant", "mpr_new", 1));
  expect(promoted.activeRevisionId).toBe("mpr_new");
  expect(repository.getAssignment(parseAgentId("primary"))?.modelProfileRevisionId).toBe("mpr_old");
});

it("rolls back head and audit when expectedRevision conflicts", () => {
  expect(() => repository.promoteProfile(promote("assistant", "mpr_new", 99)))
    .toThrowError(expect.objectContaining({ code: "revision_conflict" }));
  expect(eventsFor("assistant")).toEqual([]);
});
```

- [ ] **Step 2: Confirm the migration/repository tests fail**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts`

Expected: FAIL because migration 2 tables and repository are absent.

- [ ] **Step 3: Create migration 0002 with ownership constraints**

Create the final migration in this task; later tasks must not rewrite an applied migration. Include `provider_connections`, `provider_connection_revisions`, `model_profiles`, `model_profile_revisions`, `model_assignments`, `default_model_profile`, `model_registry_events`, `discovery_generations`, `discovered_models`, `model_verifications`, `provider_health`, `managed_secret_versions`, singleton `managed_secret_keyring`, and `legacy_model_imports`. Add nullable `provider_call_id` to existing `tool_calls` for pre-migration history and an immutability trigger for non-null values; Task 8 makes it mandatory for all new Tool proposals in application code. Store immutable revision content in typed columns, reject changes to base URL/auth/network/preset/model/protocol/context/baseline fields, and reject update/delete of append-only audit rows. Foreign keys must make every profile revision point to an exact connection revision and every assignment point to an exact profile revision. Add `record_revision INTEGER NOT NULL DEFAULT 0` to every mutable stable record, including the Keyring singleton.

- [ ] **Step 4: Implement transaction and optimistic update helpers**

```ts
private mutate<T>(expectedRevision: number, sql: string, params: readonly unknown[], read: () => T): T {
  return this.immediate(() => {
    const result = this.db.prepare(sql).run(...params, expectedRevision);
    if (result.changes !== 1) throw new ApplicationError("revision_conflict", 409);
    return read();
  });
}
```

Each successful mutation writes one `model_registry_events` row in the same transaction. Audit payloads contain resource IDs, action, previous/new record revision, trace ID, and timestamp only; they never serialize request bodies, Secret references, provider data, or errors.

- [ ] **Step 5: Implement promotion/default/assignment/retirement/purge rules**

`createConnectionRevision` and `createProfileRevision` check the stable resource's `expectedRevision` before business eligibility, reject retired resources, append immutable content, increment the stable record revision, and emit one audit event without moving active heads. Connection Promotion first requires successful discovery or a passing exact dependent Verification. Profile Promotion first requires a passing exact baseline Verification and an active referenced Connection revision. Both Promotion paths require the selected revision itself to be `verified`, then mark the previous active revision `superseded`, activate only the selected revision, and update only the stable head. Every Promotion/default/assignment mutation checks its governing `expectedRevision` before target evidence or eligibility so stale callers consistently receive `revision_conflict`. Default stores a stable Profile ID. `synchronizeAgents` creates an explicit `source = 'default'` assignment only for a new unassigned Agent and snapshots the default Profile's then-active revision. Retirement blocks new promotion/assignment but retains existing exact assignments. Purge queries all revisions, assignments, Run `agent_revisions.content_json`, Secret references, and default pointers, returning `resource_in_use` when any reference exists.

- [ ] **Step 6: Prove forward-only migration and reopen behavior**

Run: `npm run test:contract -- test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts`

Expected: versions `[1, 2]`, immutability triggers, optimistic conflicts, atomic audit, exact assignment, retirement, and reference-safe purge all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ports/model-registry-store.ts src/adapters/sqlite/migrations/0002-model-registry.sql src/adapters/sqlite/model-registry-repository.ts src/adapters/sqlite/migrator.ts test/contract/sqlite-migrations.test.ts test/contract/model-registry-repository.test.ts
git commit -m "feat: persist versioned model registry"
```

---

### Task 3: Persist Discovery, Verification Leases, and Provider Health

**Files:**
- Modify: `src/ports/model-registry-store.ts`
- Modify: `src/adapters/sqlite/model-registry-repository.ts`
- Test: `test/contract/model-registry-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 transaction helper and Task 1 Verification/Discovery/Health records.
- Produces: cache generations, Verification queue/claim/renew/complete/cancel, recovery of expired leases, safe provider health observations, and the remaining `ModelRegistryStore` persistence methods.

- [ ] **Step 1: Write failing cache and lease tests**

```ts
it("reclaims an expired Verification but not a live lease", () => {
  const queued = repository.queueVerification(queue("mpr_candidate"));
  expect(repository.claimVerification(claim("worker-a", at(0), at(30)))?.verificationId).toBe(queued.verificationId);
  expect(repository.claimVerification(claim("worker-b", at(10), at(40)))).toBeNull();
  expect(repository.claimVerification(claim("worker-b", at(31), at(61)))?.verificationId).toBe(queued.verificationId);
});

it("keeps stale models when explicit refresh fails", () => {
  seedDiscovery({ fetchedAt: at(0), expiresAt: at(600), models: [{ id: "model-a" }] });
  repository.recordDiscovery(failedRefresh(at(700), "provider_unavailable"));
  expect(repository.getDiscoveredModels(connectionRevisionId, at(700))).toMatchObject({
    state: "stale", models: [{ id: "model-a" }], refreshError: { code: "provider_unavailable" },
  });
});
```

- [ ] **Step 2: Run the repository test and confirm failure**

Run: `npm run test:contract -- test/contract/model-registry-repository.test.ts`

Expected: FAIL on missing discovery/Verification persistence.

- [ ] **Step 3: Map the existing discovery and Verification tables**

Use the final Task 2 migration without changing it. Verification rows store exact profile revision, baseline, state, attempts, capabilities JSON, normalized result code/status/Usage, trace ID, lease owner/expiry, timestamps, and cancellation request; they store no prompt, streamed text, Tool arguments, provider payload, or raw error. The migration's partial FIFO index covers `queued` and expired `running` rows.

- [ ] **Step 4: Implement durable state operations**

`claimVerification` uses `BEGIN IMMEDIATE`, selects the oldest queued or expired-running row, and assigns the lease without counting a provider request. `beginVerificationAttempt` validates the live owner immediately before each external probe attempt and increments `attempt_count`. `completeVerification` validates the owner and unexpired lease, writes terminal result plus health observation, transitions the exact Profile revision to `verified` or `failed`, and marks its exact Connection revision verified on pass without promoting it. A successful `fresh` or `empty` discovery likewise makes only the exact Connection revision promotion-eligible; unsupported/failed discovery does not. Cancellation is idempotent before terminal state. Discovery generation replacement is atomic and bounded to the configured normalized fields.

- [ ] **Step 5: Test recovery and authority separation**

Run: `npm run test:contract -- test/contract/model-registry-repository.test.ts`

Expected: lease ownership, restart reclaim, cancellation, stale cache, health updates, and the rule that health/cache never modifies promotion/default/assignment all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/model-registry-store.ts src/adapters/sqlite/model-registry-repository.ts test/contract/model-registry-repository.test.ts
git commit -m "feat: persist discovery and model verification jobs"
```

---

### Task 4: Encrypt Managed Secrets and Add Dynamic Redaction

**Files:**
- Modify: `src/config/secret-ref.ts`, `src/ports/secret-resolver.ts`
- Create: `src/ports/managed-secret-store.ts`
- Create: `src/adapters/sqlite/encrypted-secret-store.ts`
- Create: `src/adapters/composite-secret-resolver.ts`
- Modify: `src/adapters/environment-secret-resolver.ts`
- Create: `src/application/manage-secrets.ts`
- Modify: `src/observability/redactor.ts`, `logger.ts`
- Test: `test/contract/managed-secret-store.test.ts`
- Test: `test/unit/redactor.test.ts`, `managed-secret-service.test.ts`

**Interfaces:**
- Consumes: external current/previous master-key material, Task 2 Secret reference inspection, and existing environment Secret resolution.
- Produces: canonical `SecretRef`, `ManagedSecretStore`, `CompositeSecretResolver`, and `DynamicRedactionRegistry.register(value): void`.
- Exact adapter constructor: `new SqliteEncryptedSecretStore(db, environment)`, where `environment` is `Readonly<{ MYAGENT_MASTER_KEY?: string; MYAGENT_PREVIOUS_MASTER_KEY?: string }>` and defaults to `process.env` only at the composition root.
- Exact application constructor: `new ManageSecretsService(store, registry, clock, ids)`, with `registry: Pick<ModelRegistryStore, "inspectSecretReferences">`, `clock: Clock`, and `ids: Pick<IdGenerator, "managedSecretVersionId">`.
- Exact application methods are `createProviderApiKey({ secretId, plaintext })`, `destroyVersion({ versionId, expectedRevision })`, and `rotateMasterKey({ expectedRevision })`; the service supplies generated IDs and `clock.now()` to the Store.

- [ ] **Step 1: Write failing crypto and leak tests**

```ts
it("authenticates identity version and purpose as AES-GCM AAD", () => {
  const created = store.createVersion({ versionId, secretId: "provider:deepseek:api-key", purpose: "provider_api_key", plaintext: "deep-secret", now });
  expect(store.resolve(created.versionId)).toBe("deep-secret");
  tamperColumn(db, created.versionId, "purpose", "different");
  expect(() => store.resolve(created.versionId)).toThrowError("secret_locked");
});

it("never reuses a nonce", () => {
  const rows = Array.from({ length: 256 }, () => create("same-value"));
  expect(new Set(rows.map((row) => row.nonceBase64)).size).toBe(256);
});
```

- [ ] **Step 2: Confirm Secret tests fail**

Run: `npm run test:contract -- test/contract/managed-secret-store.test.ts`

Run: `npm run test:unit -- test/unit/redactor.test.ts test/unit/managed-secret-service.test.ts`

Expected: FAIL because managed references, cipher store, and dynamic registration do not exist.

- [ ] **Step 3: Implement strict master-key parsing and AES-GCM envelopes**

```ts
const encoded = environment.MYAGENT_MASTER_KEY;
const key = encoded === undefined || encoded.length === 0 ? null : decodeExact32Bytes(encoded);
if (key === null) throw new DomainError("secret_locked"); // only on create/resolve, never at bootstrap
const nonce = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, nonce);
cipher.setAAD(Buffer.from(canonicalize({ secretId, versionId, purpose }), "utf8"));
const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
```

Initialize the adapter even when no key is configured. Store only ciphertext/nonce/tag/current non-secret key ID/lifecycle/timestamps. On create/resolve, map missing, wrong, tampered, or destroyed keys to `secret_locked` without revealing which check failed. Never resolve legacy environment references during import.

Derive each non-secret Key ID exactly as `mk_${base64url(sha256(decoded32ByteKey))}` using the full unpadded Base64URL digest. Parse configured material without throwing during construction; invalid or absent generations become unavailable and fail only Secret operations.

The first successful `createVersion` inserts the absent Keyring singleton with the configured current Key ID and `recordRevision = 0` in the same transaction. Later creation requires either that the stored Keyring ID equals the configured current Key ID or that an explicit two-key transition is in progress with the stored Keyring matching the configured previous generation. Construction/restart never rewrites the Keyring: during that transition, old rows remain resolvable through the previous generation while new Secret Versions use the configured current generation until explicit rotation. A missing Keyring cannot be rotated.

- [ ] **Step 4: Implement two-key rotation and destruction**

Rotation requires both valid, distinct configured generations, a stored Keyring whose current ID equals the configured previous generation, and the singleton Keyring's exact `expectedRevision`. In one `BEGIN IMMEDIATE` transaction it validates current-key rows, decrypts and re-encrypts every active old-key row under fresh nonces/current key, verifies that no active old-key envelope remains, increments the Keyring `recordRevision`, and rolls back all rows plus the Keyring on any error. Destruction requires `inspectSecretReferences(versionId)` to return empty and an exact `expectedRevision`; it overwrites ciphertext/nonce/tag with empty blobs and marks `destroyed` without deleting audit metadata.

Missing, malformed, mismatched, tampered, destroyed, absent-Keyring, and invalid rotation-key conditions throw `DomainError("secret_locked")`. Store/Keyring optimistic mismatches throw `ApplicationError("revision_conflict", 409)`. `ManageSecretsService.destroyVersion` calls `assertPurgeAllowed(references.length)` before Store destruction, producing `DomainError("resource_in_use")` for referenced versions.

- [ ] **Step 5: Make redaction registration dynamic**

Change the logger to hold a mutable registry whose snapshot is read for every log event. `CompositeSecretResolver.resolve` dispatches the discriminated `SecretRef`, registers every resolved non-empty value before returning it, and never logs reference names or values. Keep existing bounded recursive redaction and payload-key suppression.

- [ ] **Step 6: Run Secret and redaction tests**

Run: `npm run test:contract -- test/contract/managed-secret-store.test.ts`

Run: `npm run test:unit -- test/unit/redactor.test.ts test/unit/managed-secret-service.test.ts`

Expected: round trip, AAD/tag/ciphertext tamper, wrong/missing key, nonce uniqueness, immutability, destruction checks, restart at both key generations, transaction rollback, and dynamic plaintext leak scans PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/secret-ref.ts src/ports/secret-resolver.ts src/ports/managed-secret-store.ts src/adapters/sqlite/encrypted-secret-store.ts src/adapters/composite-secret-resolver.ts src/adapters/environment-secret-resolver.ts src/application/manage-secrets.ts src/observability test/contract/managed-secret-store.test.ts test/unit/redactor.test.ts test/unit/managed-secret-service.test.ts
git commit -m "feat: encrypt managed provider secrets"
```

---

### Task 5: Introduce Static Config Version 2 and Provider Presets

**Files:**
- Modify: `src/config/schemas.ts`
- Create: `src/config/boot-config.ts`
- Create: `src/config/provider-presets.ts`
- Create: `test/fixtures/config/version-2/myagent.yaml`, `test/fixtures/config/legacy-v1/**`
- Test: `test/unit/config-schemas.test.ts`, `boot-config.test.ts`, `provider-presets.test.ts`

**Interfaces:**
- Consumes: approved static values and existing YAML/Secret-reference conventions.
- Produces: pure `loadBootConfig`, `GlobalConfigV2`, `LegacyGlobalConfigV1`, `LegacyModelSeed`, and `providerPreset(kind)`; current Catalog composition remains unchanged until Task 8 switches it atomically with `AgentResolver`.

- [ ] **Step 1: Write failing version/config tests**

```ts
it("accepts only model-free version 2 configuration", () => {
  expect(globalConfigV2Schema.parse(validV2).version).toBe(2);
  expect(() => globalConfigV2Schema.parse({ ...validV2, models: legacyModels })).toThrow();
  expect(() => agentConfigV2Schema.parse({ ...validAgentV2, model: "default" })).toThrow();
});

it("keeps legacy aliases only as import seeds", async () => {
  const boot = await loadBootConfig(legacyFixture);
  expect(boot.legacyModelImport?.models.default.modelId).toBe("test-model");
  expect(boot.version).toBe(1);
});
```

- [ ] **Step 2: Run configuration tests and confirm failure**

Run: `npm run test:unit -- test/unit/config-schemas.test.ts test/unit/boot-config.test.ts test/unit/provider-presets.test.ts`

Expected: FAIL because the existing schemas require flat models and Agent aliases.

- [ ] **Step 3: Implement discriminated boot schemas**

Treat an unversioned existing file as legacy version 1 for one deprecation version. Version 2 must match the approved YAML exactly, including defaults `600`, `10000`, `30000`, `120000`, `1000`, `2097152`, and `1`. Require `server.adminToken`; both tokens remain environment references. For v1 only, shallow-read confined `agent.yaml` files to collect validated Agent ID to model-alias mappings without loading prompts, Skills, or Policy. Compute `sourceSha256` from RFC 8785 canonicalized legacy model records plus sorted Agent-to-alias mappings, return `LegacyModelImportSeed { sourceSha256, models, agentAliases }` separately from `GlobalConfigV2`, and do not change the active Catalog loader in this task.

- [ ] **Step 4: Build immutable preset suggestions**

```ts
export const PROVIDER_PRESETS = Object.freeze({
  openai: { version: "openai-v1", baseUrl: "https://api.openai.com/v1", auth: "bearer", protocolPreference: "responses" },
  deepseek: { version: "deepseek-v1", baseUrl: "https://api.deepseek.com", auth: "bearer", protocolPreference: "responses" },
  openai_compatible: { version: "custom-v1", auth: "bearer", protocolPreference: "chat_completions" },
} as const);
```

Presets are copied into new connection revision values. Task 8 will make Catalog reload compare Admin Token, database, and model-control settings as restart-only fields while reloading only Agent/Prompt/Skill/Policy content.

- [ ] **Step 5: Add dedicated v2 and legacy parser fixtures**

Create dedicated parser fixtures without replacing the runtime fixture used by current M1 tests. Preserve `test/fixtures/config/legacy-v1/**` unchanged for Task 12. Runtime fixtures/examples switch only in Task 8, when model-free Agent definitions and resolution land together.

- [ ] **Step 6: Run configuration tests**

Run: `npm run test:unit -- test/unit/config-schemas.test.ts test/unit/boot-config.test.ts test/unit/provider-presets.test.ts`

Expected: strict v2 parsing, one-version legacy seed, exact defaults, and immutable preset behavior PASS while the existing M1 suite remains green.

- [ ] **Step 7: Commit**

```bash
git add src/config/schemas.ts src/config/boot-config.ts src/config/provider-presets.ts test/fixtures/config/version-2 test/fixtures/config/legacy-v1 test/unit/config-schemas.test.ts test/unit/boot-config.test.ts test/unit/provider-presets.test.ts
git commit -m "feat: separate static Agent config from model registry"
```

---

### Task 6: Enforce Provider URL and Network Policy in One HTTP Transport

**Files:**
- Create: `src/ports/provider-http-transport.ts`
- Create: `src/adapters/provider-http-transport.ts`
- Test: `test/unit/provider-network-policy.test.ts`
- Test: `test/contract/provider-http-transport.test.ts`

**Interfaces:**
- Consumes: Task 1 Connection revision/auth and Task 4 `SecretResolver`.
- Produces: canonical `ProviderHttpTransport.createFetch`, URL normalization, DNS classification, pinned connection, redirect, timeout, and byte-cap behavior.

- [ ] **Step 1: Write failing URL/property tests**

```ts
it.each([
  "https://user@example.com/v1", "https://example.com/v1?q=x", "https://example.com/v1#x",
  "http://169.254.169.254/latest", "http://0.0.0.0/v1", "http://8.8.8.8/v1",
])("rejects unsafe provider URL %s", async (baseUrl) => {
  await expect(probe(baseUrl)).rejects.toMatchObject({ code: expect.stringMatching(/provider_url/) });
});
```

Use fast-check to cover IPv4, IPv6, IPv4-mapped IPv6, loopback, RFC1918, link-local, multicast, unspecified, and public ranges.

- [ ] **Step 2: Run transport tests and confirm failure**

Run: `npm run test:unit -- test/unit/provider-network-policy.test.ts`

Run: `npm run test:contract -- test/contract/provider-http-transport.test.ts`

Expected: FAIL because the shared transport does not exist.

- [ ] **Step 3: Implement strict URL and address classification**

Normalize only trailing slashes. Permit `https:` after every resolved address passes policy. Permit `http:` only for loopback or RFC1918 when `allowInsecureHttp === true`. Deny mixed safe/unsafe DNS results. Resolve on every request and retain the validated selected address in the Node request `lookup` callback so the socket cannot perform a second unvalidated lookup.

- [ ] **Step 4: Implement SDK-compatible fetch over Node HTTP(S)**

Convert `RequestInfo | URL` plus `RequestInit` into `http.request`/`https.request`; preserve TLS hostname verification/SNI while pinning lookup, stream request/response bodies, map abort to `AbortError`, enforce connect/request/response-byte limits, and return a WHATWG `Response`. Strip any SDK-supplied `Authorization`, then add exactly one resolved Bearer header or none. Set redirects to manual; follow only same-origin redirects through the full validation path and never forward authorization across origins.

- [ ] **Step 5: Normalize safe transport errors**

Map 401/403 to `provider_auth_failed`, 429 to `provider_rate_limited`, timeout to `provider_unavailable`, endpoint statuses without fallback inference, and malformed/oversized responses to `model_protocol_error`. Preserve only code, safe status, transient flag, bounded Retry-After, and cause-free message.

- [ ] **Step 6: Run network contract tests**

Run: `npm run test:unit -- test/unit/provider-network-policy.test.ts`

Run: `npm run test:contract -- test/contract/provider-http-transport.test.ts`

Expected: DNS rebinding, mixed resolution, same/cross-origin redirect, auth suppression, loopback/private/public HTTP, TLS, timeout, cancellation, and byte limits PASS on Windows and Linux.

- [ ] **Step 7: Commit**

```bash
git add src/ports/provider-http-transport.ts src/adapters/provider-http-transport.ts test/unit/provider-network-policy.test.ts test/contract/provider-http-transport.test.ts
git commit -m "feat: enforce provider network policy"
```

---

### Task 7: Discover and Cache Advertised Models

**Files:**
- Create: `src/ports/model-discovery.ts`
- Create: `src/adapters/model/openai-model-discovery.ts`
- Create: `src/application/discover-models.ts`
- Create: `test/helpers/fake-openai-provider.ts`
- Test: `test/contract/openai-model-discovery.test.ts`
- Test: `test/unit/model-discovery-service.test.ts`

**Interfaces:**
- Consumes: Task 3 discovery cache methods and Task 6 transport.
- Produces: canonical `ModelDiscoveryPort`, `DiscoverModelsService.execute({ revisionId, refresh, traceId, now }, signal): Promise<DiscoveryView>`.

- [ ] **Step 1: Write failing pagination/cache tests**

```ts
it("follows Models pagination and persists only normalized fields", async () => {
  provider.modelsPages([{ data: [{ id: "a", owned_by: "team", created: 1 }], has_more: true, last_id: "a" }, { data: [{ id: "b", secret: "raw" }] }]);
  const result = await service.execute(refresh(connectionRevisionId), signal);
  expect(result.models.map((model) => model.id)).toEqual(["a", "b"]);
  expect(JSON.stringify(readDiscoveryRows(db))).not.toContain("raw");
});
```

- [ ] **Step 2: Confirm discovery tests fail**

Run: `npm run test:contract -- test/contract/openai-model-discovery.test.ts`

Run: `npm run test:unit -- test/unit/model-discovery-service.test.ts`

Expected: FAIL on missing discovery adapter/service.

- [ ] **Step 3: Implement Models API discovery**

Create an OpenAI SDK client with a non-secret placeholder API key, `maxRetries: 0`, and Task 6 custom fetch. Follow provider cursors until completion or 1,000 unique IDs; reject duplicate/cursor loops and oversized pages. Normalize only `id`, optional `owned_by`, and optional Unix `created`; do not infer capabilities, context, family, pricing, or protocol.

- [ ] **Step 4: Implement cache semantics**

Normal reads return `fresh`, `stale`, or the last terminal empty/unsupported state. Explicit refresh always attempts live discovery. Classify only clear endpoint absence as `unsupported`; success with zero IDs is `empty`; other failures are `failed`. Preserve stale rows and attach a safe `refreshError` when refresh fails. Permit manual model entry only when the latest authoritative state is `empty` or `unsupported`.

- [ ] **Step 5: Run tests**

Run: `npm run test:contract -- test/contract/openai-model-discovery.test.ts`

Run: `npm run test:unit -- test/unit/model-discovery-service.test.ts`

Expected: pagination, item/byte/time limits, no raw persistence, cache expiry, stale-on-error, unsupported/empty/manual eligibility, cancellation, and Secret-free errors PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/model-discovery.ts src/adapters/model/openai-model-discovery.ts src/application/discover-models.ts test/helpers/fake-openai-provider.ts test/contract/openai-model-discovery.test.ts test/unit/model-discovery-service.test.ts
git commit -m "feat: discover provider model identifiers"
```

---

### Task 8: Resolve Model-Free Agents and Make Runtime Input Protocol-Neutral

**Files:**
- Modify: `src/config/schemas.ts`, `catalog-loader.ts`, `catalog-service.ts`
- Modify: `src/domain/agent-revision.ts`, `tool-call.ts`
- Create: `src/application/agent-resolver.ts`
- Modify: `src/application/create-run.ts`, `delegate-agent.ts`, `prompt-assembler.ts`, `advance-run.ts`, `session-summarizer.ts`, `tool-proposal.ts`
- Modify: `src/ports/model.ts`, `tool-store.ts`, `run-store.ts`, `session-store.ts`
- Modify: `src/adapters/sqlite/tool-repository.ts`, `run-repository.ts`, `session-repository.ts`, `catalog-repository.ts`
- Modify: `src/adapters/sqlite/backup.ts`, `src/adapters/model/openai-chat-completions.ts`
- Modify: `src/interfaces/http/routes/agents.ts`, `config.ts`, `src/interfaces/cli/commands/config.ts`
- Modify: `src/bootstrap.ts`
- Modify: `test/helpers/scripted-model.ts`, `start-test-app.ts`
- Modify: `test/fixtures/config/valid/**`, `examples/myagent.yaml`, `examples/agents/*/agent.yaml`
- Test: `test/unit/agent-resolver.test.ts`, `catalog-loader.test.ts`, `catalog-service.test.ts`, `create-run.test.ts`, `delegate-agent.test.ts`, `prompt-assembler.test.ts`, `advance-run.test.ts`, `tool-proposal.test.ts`
- Test: `test/integration/approval-resume.test.ts`, `run-worker.test.ts`

**Interfaces:**
- Consumes: Task 5 boot schema, Task 2 exact assignments/revisions, and canonical `ModelInput`, `ModelChunk`, `EffectiveModelRuntime`.
- Produces: model-free `AgentDefinitionRevision`, `AgentResolverPort`, exact effective Run snapshots, structured local history, optional Usage, normalized finish reasons, and immutable provider `callId` from model chunk through durable Tool Call and continuation input.

- [ ] **Step 1: Write failing resolver and structured-history tests**

```ts
it("snapshots the exact assigned revision and ignores later promotion", () => {
  const first = resolver.resolve(parseAgentId("primary"));
  promoteProfile("assistant", "mpr_new");
  expect(first.modelProfileRevisionId).toBe("mpr_old");
});

it("reconstructs an approved Tool continuation with the provider call ID", async () => {
  const request = await prompts.build(inputWithCompletedTool({ providerCallId: "call_provider_7" }));
  expect(request.input).toContainEqual({
    type: "assistant_tool_call", callId: "call_provider_7", name: "read_file", arguments: { path: "report.md" },
  });
  expect(request.input).toContainEqual({
    type: "tool_result", callId: "call_provider_7", name: "read_file", output: { ok: true },
  });
});
```

- [ ] **Step 2: Run focused tests and confirm the old Catalog/model contract fails**

Run: `npm run test:unit -- test/unit/agent-resolver.test.ts test/unit/catalog-loader.test.ts test/unit/catalog-service.test.ts test/unit/create-run.test.ts test/unit/delegate-agent.test.ts test/unit/prompt-assembler.test.ts test/unit/advance-run.test.ts test/unit/tool-proposal.test.ts`

Run: `npm run test:integration -- test/integration/approval-resume.test.ts test/integration/run-worker.test.ts`

Expected: FAIL because Catalog embeds flat models, Run creation resolves Catalog directly, Tool results are user wrappers, and Tool Calls have no provider ID.

- [ ] **Step 3: Switch Catalog and runtime fixtures to version 2**

Use `loadBootConfig` from Task 5. Build `AgentDefinitionRevision` without a model alias, return it as `AvailableAgent.definition`, and retain only Agent/Prompt/Skill/Policy/Workspace/delegation/limits source ownership. Select `agentConfigV1Schema` only when the boot config is legacy, discard its already-seeded model alias from the definition, and use strict `agentConfigV2Schema` otherwise. Normal fixtures/examples gain `version: 2`, Admin Token, model-control defaults, remove `models`, and remove Agent `model`. Catalog reload treats token/database/model-control fields as restart-only and reloads only file-defined Agent resources.

- [ ] **Step 4: Implement exact Agent resolution**

Resolve the current file definition, exact assignment, profile revision, and connection revision. Return `model_assignment_required` 422 for none, `verification_required` 422 for an ineligible non-legacy revision, and `model_provider_locked` 503 when its Managed Secret cannot resolve. Existing verified assignments remain usable when their exact Profile or Connection revision becomes `superseded` or `retired`; only creation/replacement requires an active Profile revision. A Legacy-Trusted revision is accepted only when the stored assignment source is `legacy_import`. Compute snapshot `revisionId/contentSha256` from canonical combined definition/model content without resolving plaintext.

- [ ] **Step 5: Change Run creation and delegation to `AgentResolverPort`**

`CreateRunService` and `DelegateAgentService` depend on `Pick<AgentResolverPort, "resolve">`. They pass the returned complete snapshot to the existing transactional Run store. Recovery continues reading stored `agent_revisions.content_json` only and never re-resolves assignments. Update Agent/config/CLI list responses and backup manifests to use definition revision IDs. Update test helpers to seed explicit verified Chat assignments before creating Runs.

- [ ] **Step 6: Keep the composition root buildable during protocol migration**

Initialize the Model Registry, encrypted/composite Secret resolver, Provider HTTP Transport, and `AgentResolver` in bootstrap. Mechanically adapt the existing Chat adapter to the canonical model field names and shared transport, and make it reject any non-`chat_completions` snapshot with `invocation_protocol_unsupported`; Task 9 supplies its full contract coverage and Task 10 replaces direct wiring with the two-protocol router. This task's normal fixtures seed Chat profiles, so existing Run tests remain executable without a protocol fallback or temporary model configuration.

- [ ] **Step 7: Replace `messages` with canonical `input`**

Keep safety/prompt/Skill/summary/history/operator text as typed `message` entries. Append a paired `assistant_tool_call` and `tool_result` for every completed call in sequence. Never convert Tool output into an instruction-bearing user message. Session summaries use the same model snapshot/protocol but no Tools.

- [ ] **Step 8: Persist provider call IDs using the finalized migration**

Add `providerCallId: string` to `ToolCall`/proposal inputs. Validate 1-200 printable non-whitespace characters, require it for every new proposal, store it in Task 2's nullable `provider_call_id` column, and return it on recovery. Existing pre-migration rows may remain null and are never resumed as a provider continuation; encountering one produces `model_protocol_error`. Internal reconciliation never fabricates or reuses a provider ID.

- [ ] **Step 9: Make Usage optional and record informational Provider Health**

Change attempt completion and Session summary persistence to accept `usage?: ModelUsage`. Store/emit token data only when supplied and normalize completion reasons to the canonical union before Run persistence. Inject `Pick<ModelRegistryStore, "recordProviderHealth">` into `AdvanceRunService`; record a safe success/failure observation for the exact snapshot revision after each provider attempt, and prove the observation never changes Verification, active heads, default, or assignment state.

- [ ] **Step 10: Run the full affected regression set and typecheck**

Run: `npm run test:unit -- test/unit/agent-resolver.test.ts test/unit/catalog-loader.test.ts test/unit/catalog-service.test.ts test/unit/create-run.test.ts test/unit/delegate-agent.test.ts test/unit/prompt-assembler.test.ts test/unit/advance-run.test.ts test/unit/tool-proposal.test.ts`

Run: `npm run test:integration -- test/integration/approval-resume.test.ts test/integration/run-worker.test.ts`

Run: `npm run typecheck`

Expected: model-free Catalog, exact snapshot isolation, existing M1 behavior, structured call/result ordering, call-ID restart recovery, optional Usage, one-call invariant, and no Session leakage PASS.

- [ ] **Step 11: Commit**

```bash
git add src/config/schemas.ts src/config/catalog-loader.ts src/config/catalog-service.ts src/domain/agent-revision.ts src/domain/tool-call.ts src/application/agent-resolver.ts src/application/create-run.ts src/application/delegate-agent.ts src/application/prompt-assembler.ts src/application/advance-run.ts src/application/session-summarizer.ts src/application/tool-proposal.ts src/ports/model.ts src/ports/tool-store.ts src/ports/run-store.ts src/ports/session-store.ts src/adapters/sqlite/tool-repository.ts src/adapters/sqlite/run-repository.ts src/adapters/sqlite/session-repository.ts src/adapters/sqlite/catalog-repository.ts src/adapters/sqlite/backup.ts src/adapters/model/openai-chat-completions.ts src/interfaces/http/routes/agents.ts src/interfaces/http/routes/config.ts src/interfaces/cli/commands/config.ts src/bootstrap.ts test/helpers/scripted-model.ts test/helpers/start-test-app.ts test/fixtures/config/valid examples test/unit/agent-resolver.test.ts test/unit/catalog-loader.test.ts test/unit/catalog-service.test.ts test/unit/create-run.test.ts test/unit/delegate-agent.test.ts test/unit/prompt-assembler.test.ts test/unit/advance-run.test.ts test/unit/tool-proposal.test.ts test/integration/approval-resume.test.ts test/integration/run-worker.test.ts
git commit -m "feat: resolve assigned models into canonical Run input"
```

---

### Task 9: Refactor the Chat Completions Adapter

**Files:**
- Modify: `src/adapters/model/openai-chat-completions.ts`
- Modify: `test/contract/openai-chat-completions.test.ts`

**Interfaces:**
- Consumes: Task 6 transport and Task 8 canonical model contract.
- Produces: `OpenAiChatCompletionsModel` with exact structured message mapping, call IDs, optional Usage, normalized completion, cancellation, and safe errors.

- [ ] **Step 1: Rewrite contract tests first**

```ts
expect(captured.messages).toEqual([
  { role: "assistant", tool_calls: [{ id: "call_7", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
  { role: "tool", tool_call_id: "call_7", content: '{"ok":true}' },
]);
expect(chunks).toContainEqual({ type: "tool_call", callId: "call_8", name: "read_file", arguments: { path: "b" } });
```

Add cases for missing Usage success, fragmented ID/name/arguments, normalized `stop/tool_calls/length/content_filter/unknown`, multiple calls, malformed JSON, cancellation, safe 401/429/500, and absence of Authorization in `none` mode.

- [ ] **Step 2: Run and confirm old adapter failures**

Run: `npm run test:contract -- test/contract/openai-chat-completions.test.ts`

Expected: FAIL on strict fragmented call-ID, optional Usage, finish normalization, and safe provider-error cases that Task 8's compile-safe mapping does not yet satisfy.

- [ ] **Step 3: Implement exact Chat mapping**

Map message inputs to system/user/assistant parameters; group each assistant Tool Call and following result into provider-valid messages using canonical JSON. Set `stream: true`, `stream_options.include_usage: true`, `parallel_tool_calls: false`, and `tool_choice: "required"` only for Verification Tool probes. Instantiate SDK with `maxRetries: 0`, placeholder `apiKey`, fixed base URL, and Task 6 fetch so transport owns authorization.

- [ ] **Step 4: Assemble and validate streamed output**

Track one Tool Call index and its non-empty ID/name/arguments fragments. Emit public text deltas, one canonical Tool chunk after valid JSON parsing, and exactly one normalized completion. Usage may be absent. Reject a missing terminal reason, multiple choices/calls, inconsistent call ID/index, non-JSON arguments, or textless/non-call completion as `model_protocol_error`.

- [ ] **Step 5: Run contract tests**

Run: `npm run test:contract -- test/contract/openai-chat-completions.test.ts`

Expected: all Chat streaming, structured continuation, error, cancellation, auth, and optional Usage cases PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/model/openai-chat-completions.ts test/contract/openai-chat-completions.test.ts
git commit -m "feat: adapt Chat Completions to canonical model input"
```

---

### Task 10: Add Stateless Responses and Fixed-Protocol Routing

**Files:**
- Create: `src/adapters/model/openai-responses.ts`
- Create: `src/adapters/model/model-runtime-router.ts`
- Modify: `src/bootstrap.ts`
- Test: `test/contract/openai-responses.test.ts`, `model-runtime-router.test.ts`

**Interfaces:**
- Consumes: Tasks 6 and 8 contracts.
- Produces: `OpenAiResponsesModel`, `ModelRuntimeRouter({ chatCompletions, responses })`, and no runtime protocol fallback.

- [ ] **Step 1: Write failing Responses request/event tests**

```ts
expect(captured).toMatchObject({
  model: "deepseek-v4-flash", store: false, stream: true, parallel_tool_calls: false,
});
expect(captured).not.toHaveProperty("previous_response_id");
expect(captured.input).toContainEqual({ type: "function_call_output", call_id: "call_7", output: '{"ok":true}' });
```

Script `response.output_text.delta`, function-call argument deltas/done, `response.completed`, `response.failed`, `response.incomplete`, reasoning items, missing Usage, malformed/multiple calls, abort, and 401/429/500.

- [ ] **Step 2: Run Responses/router tests and confirm failure**

Run: `npm run test:contract -- test/contract/openai-responses.test.ts test/contract/model-runtime-router.test.ts`

Expected: FAIL because neither adapter nor router exists.

- [ ] **Step 3: Implement stateless Responses input mapping**

Map canonical messages to Responses message items, assistant calls to `function_call`, and Tool results to `function_call_output`. Set `store: false`, never set `previous_response_id`, use Task 6 fetch and `maxRetries: 0`, and force the synthetic Verification Tool with required choice. Do not map reasoning items into any local type, event, log, or error.

- [ ] **Step 4: Implement strict event assembly**

Yield only public output text, one complete function call with provider `call_id`, and one terminal canonical completion with optional Usage. Treat failed/incomplete terminal events as normalized errors, not successful completion. Reject multiple calls and malformed argument streams exactly like Chat.

- [ ] **Step 5: Implement the router**

```ts
streamAttempt(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
  return request.model.invocationProtocol === "responses"
    ? this.responses.streamAttempt(request, signal)
    : this.chatCompletions.streamAttempt(request, signal);
}
```

The router does not catch protocol errors to call the other adapter. Provider kind is available only to compatibility/error normalization, never dispatch.
Replace Task 8's direct Chat wiring in `bootstrap.ts` with this router and inject both adapters over the same Provider HTTP Transport.

- [ ] **Step 6: Run contract tests**

Run: `npm run test:contract -- test/contract/openai-responses.test.ts test/contract/model-runtime-router.test.ts`

Expected: stateless input reconstruction, reasoning omission, event/error normalization, call IDs, optional Usage, cancellation, and exact one-adapter routing PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/model/openai-responses.ts src/adapters/model/model-runtime-router.ts src/bootstrap.ts test/contract/openai-responses.test.ts test/contract/model-runtime-router.test.ts
git commit -m "feat: add stateless Responses protocol routing"
```

---

### Task 11: Verify Candidate Models with a Durable Worker

**Files:**
- Create: `src/application/verify-model.ts`
- Create: `src/runtime/model-verification-worker.ts`
- Create: `src/application/manage-model-profiles.ts`
- Test: `test/unit/model-verification.test.ts`
- Test: `test/integration/model-verification-worker.test.ts`

**Interfaces:**
- Consumes: Task 3 Verification persistence, Task 10 router, Task 1 fallback classifier, configured timeouts/concurrency.
- Produces: `VerifyModelService.queue/cancel/runClaimed`, durable worker lifecycle, exact capability result, and automatic second candidate creation.

- [ ] **Step 1: Write failing capability and fallback tests**

```ts
it("passes only after streamed text and one synthetic Tool Call", async () => {
  model.script(textProbe("ok"), toolProbe("provider-call", { nonce: "probe" }));
  await service.runClaimed(claimedVerification, signal);
  expect(store.getVerification(id)).toMatchObject({
    state: "passed", capabilities: ["streaming_text", "single_tool_call"],
  });
  expect(toolStore.recordedProposals).toEqual([]);
});

it.each([401, 429, 500])("does not protocol-fallback after HTTP %i", async (status) => {
  model.fail(status);
  await service.runClaimed(claimedAutomatic, signal);
  expect(store.getProfile(profileId).revisions).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test/unit/model-verification.test.ts`

Run: `npm run test:integration -- test/integration/model-verification-worker.test.ts`

Expected: FAIL because Verification orchestration/worker are absent.

- [ ] **Step 3: Implement bounded probes**

Queueing requires the owning Model Profile's `expectedRevision` and atomically moves the exact draft Profile revision to `verifying`. The text request contains a fixed harmless prompt and no Tools; require at least one non-empty text delta and terminal completion. The Tool request exposes only `capability_probe` with strict schema `{ nonce: string }`, sets `toolChoice: "required"`, and accepts exactly one valid call whose nonce matches the probe. Use no Run/Session/Tool/Approval repositories. Store Usage only when supplied and discard generated text/arguments immediately after validation.

- [ ] **Step 4: Implement retry and automatic protocol candidate rules**

Perform at most two attempts for the text probe and at most two attempts for the Tool probe; call `beginVerificationAttempt` before each request and sleep for `min(max(retryAfterMs, 1000), 30000)` within the total job deadline. Do not retry auth/validation/protocol/capability errors. When an automatic preferred candidate fails only with the allowed endpoint-absence classifier, pass `fallback: { revision, verification }` to one `completeVerification` transaction so it keeps the preferred candidate failed, creates one immutable fallback-protocol revision, queues its own Verification, and returns the new operation ID without changing active heads. A request to formally verify a `legacy_trusted` assignment first creates a normal draft candidate with copied effective values; it never changes or promotes the legacy revision itself.

- [ ] **Step 5: Implement worker recovery/cancellation**

The worker defaults to concurrency one, claims FIFO, renews a 30-second lease every 10 seconds, aborts on cancellation/shutdown, and allows expired lease recovery after restart. Terminal completion validates lease ownership. Unexpected worker errors produce a safe failed Verification and continue the lane unless SQLite itself is unavailable.

- [ ] **Step 6: Run Verification tests**

Run: `npm run test:unit -- test/unit/model-verification.test.ts`

Run: `npm run test:integration -- test/integration/model-verification-worker.test.ts`

Expected: required capabilities, no real Tool persistence/execution, retry limits, allowed-only fallback, deadlines, cancellation, lease renewal/reclaim, restart, and Secret-free records PASS.

- [ ] **Step 7: Commit**

```bash
git add src/application/verify-model.ts src/application/manage-model-profiles.ts src/runtime/model-verification-worker.ts test/unit/model-verification.test.ts test/integration/model-verification-worker.test.ts
git commit -m "feat: verify model protocol capabilities"
```

---

### Task 12: Import Legacy Models and Recompose Startup

**Files:**
- Create: `src/application/import-legacy-models.ts`, `manage-provider-connections.ts`, `assign-model.ts`
- Modify: `src/bootstrap.ts`
- Modify: `src/adapters/sqlite/backup.ts`
- Modify: `src/interfaces/http/app.ts`, `routes/config.ts`
- Test: `test/unit/legacy-model-import.test.ts`
- Test: `test/integration/legacy-model-migration.test.ts`, `model-assignments.test.ts`, `bootstrap.test.ts`, `backup.test.ts`, `provider-readiness.test.ts`

**Interfaces:**
- Consumes: Tasks 4/7/8/10/11 adapters/services and the approved startup order.
- Produces: default synchronization, Legacy-Trusted continuity, complete management services, and fully composed runtime/Verification workers.

- [ ] **Step 1: Write failing legacy/default/startup tests**

```ts
it("imports the same legacy source exactly once", async () => {
  const first = await importer.execute(seed);
  const retry = await importer.execute(seed);
  expect(retry).toEqual(first);
  expect(count("provider_connections")).toBe(Object.keys(seed.models).length);
});

it("assigns the current default only when an Agent is first synchronized", () => {
  synchronize([parseAgentId("primary")]);
  promoteProfile("assistant", "mpr_new");
  synchronize([parseAgentId("primary")]);
  expect(registry.getAssignment(parseAgentId("primary"))?.modelProfileRevisionId).toBe("mpr_old");
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:unit -- test/unit/legacy-model-import.test.ts`

Run: `npm run test:integration -- test/integration/legacy-model-migration.test.ts test/integration/model-assignments.test.ts test/integration/bootstrap.test.ts`

Expected: FAIL because one-time import, management services, default synchronization, and the new startup composition are absent.

- [ ] **Step 3: Implement idempotent legacy import**

For each alias create one unshared connection/profile pair preserving kind/base URL/environment Secret reference/model/max tokens/Chat protocol, mark exact revisions `legacy_trusted`, and create only imported Agent assignments with `source = 'legacy_import'`. Store migration version, source SHA-256, alias-to-ID map, and generated IDs in the same transaction. A repeated hash returns the stored result; a different v1 file after the marker returns `legacy_import_already_completed` and never overwrites registry state.

- [ ] **Step 4: Implement management service boundaries**

`ManageProviderConnectionsService` validates preset-effective revisions and delegates atomic create/revise/promote/retire/purge to the Registry. Supplying a replacement API Key creates a new immutable Secret Version and a draft Connection revision; old Secret/revision state remains referenced and active until separate Verification/Promotion, and failures never move the active head. `AssignModelService` validates exact active verified revisions for explicit assignment/default. Inject it into startup and the existing Catalog reload prepare callback so `synchronizeAgents` runs after every successful Catalog load/reload but before the candidate becomes visible. `ManageModelProfilesService` from Task 11 and `ManageSecretsService` from Task 4 complete the composition; none imports Fastify or CLI types.

- [ ] **Step 5: Reorder bootstrap exactly**

Parse static config; resolve and register the Run/Admin tokens with dynamic redaction; open/migrate SQLite; initialize Registry/Secret Store; run legacy import; load Agent resources; synchronize Agent IDs/default assignments; create shared Provider HTTP Transport, discovery, Chat, Responses, router; start Run/Approval/Verification workers; then listen. A missing Admin Token fails before migration. Missing/mismatched master key leaves readiness true and resources Locked. Shutdown stops HTTP acceptance, Verification worker, Run worker, Approval scanner, then SQLite.

- [ ] **Step 6: Preserve backup and readiness guarantees**

Backups copy encrypted SQLite rows and versioned Agent sources but never key material, plaintext, or Secret references in `manifest.json`. Restore tests open the backup with the matching external key. `/readyz` continues to check local Catalog/migrations/writeability/worker infrastructure only, not provider health or credential unlock state.

- [ ] **Step 7: Run import/bootstrap/backup tests**

Run: `npm run test:unit -- test/unit/legacy-model-import.test.ts`

Run: `npm run test:integration -- test/integration/legacy-model-migration.test.ts test/integration/model-assignments.test.ts test/integration/bootstrap.test.ts test/integration/backup.test.ts test/integration/provider-readiness.test.ts`

Expected: default-on-first-seen only, legacy idempotency/restrictions, startup ordering, locked-provider tolerance, restore, and graceful shutdown PASS.

- [ ] **Step 8: Commit**

```bash
git add src/application/import-legacy-models.ts src/application/manage-provider-connections.ts src/application/assign-model.ts src/bootstrap.ts src/adapters/sqlite/backup.ts src/interfaces/http/app.ts src/interfaces/http/routes/config.ts test/unit/legacy-model-import.test.ts test/integration/legacy-model-migration.test.ts test/integration/model-assignments.test.ts test/integration/bootstrap.test.ts test/integration/backup.test.ts test/integration/provider-readiness.test.ts
git commit -m "feat: import legacy models and compose registry runtime"
```

---

### Task 13: Secure Provider, Discovery, and Profile Control-Plane Routes

**Files:**
- Modify: `src/interfaces/http/auth.ts`, `app.ts`, `problem.ts`, `schemas.ts`
- Create: `src/interfaces/http/model-control-schemas.ts`
- Create: `src/interfaces/http/routes/provider-connections.ts`, `model-profiles.ts`
- Modify: `test/helpers/start-test-app.ts`
- Test: `test/integration/http-auth.test.ts`, `http-model-control.test.ts`, `model-secret-leak.test.ts`

**Interfaces:**
- Consumes: Tasks 7/12 management services, separate resolved tokens, and Fastify actual socket peer.
- Produces: safe connection/profile/discovery routes and response schemas from specification section 6.3.

- [ ] **Step 1: Write failing authorization and write-only tests**

```ts
it("requires loopback plus Admin Token for every /v1/admin route", async () => {
  expect((await injectAdmin({ token: runToken })).statusCode).toBe(401);
  expect((await injectAdmin({ token: adminToken, remoteAddress: "192.168.1.8" })).statusCode).toBe(403);
  expect((await injectAdmin({ token: adminToken, remoteAddress: "127.0.0.1", forwardedFor: "8.8.8.8" })).statusCode).toBe(200);
});

it("never echoes a submitted API key", async () => {
  const response = await createConnection({ apiKey: "needle-provider-secret" });
  expect(response.json()).toMatchObject({ credentialConfigured: true, secretVersionId: expect.any(String) });
  expect(response.body).not.toContain("needle-provider-secret");
});
```

- [ ] **Step 2: Run HTTP tests and confirm failure**

Run: `npm run test:integration -- test/integration/http-auth.test.ts test/integration/http-model-control.test.ts test/integration/model-secret-leak.test.ts`

Expected: FAIL because the existing single-token hook grants no separate Admin plane and routes are absent.

- [ ] **Step 3: Split authentication hooks**

Keep `/v1` Run routes on the Run Token. For `/v1/admin`, read only `request.raw.socket.remoteAddress`, normalize IPv4-mapped loopback, ignore all `Forwarded`/`X-Forwarded-*`, require the Admin Token using the existing constant-time comparison, and return generic 401/403 Problems without token/peer details.

- [ ] **Step 4: Add strict request/response schemas**

Connection create accepts slug/display name/kind/base URL/auth/optional write-only `apiKey`/environment Secret/`allowInsecureHttp`/protocol preference. Revision create requires `expectedRevision` and full changed effective fields; discovery refresh also requires the owning Connection's `expectedRevision`. Profile create accepts slug/display name/connection revision/model ID/protocol `auto | chat_completions | responses`/context limit/source plus manual-entry acknowledgement when required. Resolve `auto` to one fixed preferred protocol before persistence, use a maintained preset context when known, and otherwise require the visible `assumed_32768` value or an Operator override. Reject unknown properties; response schemas expose only safe metadata and `credentialConfigured`.

- [ ] **Step 5: Register Provider/Profile/Discovery routes**

Implement the exact `POST/GET` Provider and Profile routes and `POST .../discover`, `GET .../models`. Return 201 for stable creation, 200 for reads/revisions, and discovery state/cache/error separately. Creating a Profile or discovering never promotes. Map typed errors to stable Problem codes/status and include trace ID only.

- [ ] **Step 6: Run route and leakage tests**

Run: `npm run test:integration -- test/integration/http-auth.test.ts test/integration/http-model-control.test.ts test/integration/model-secret-leak.test.ts`

Expected: Run/Admin token separation, actual-peer enforcement, strict schema, write-only credential, safe list/detail, discovery state, optimistic revisions, and HTTP/log/database plaintext scans PASS.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/http/auth.ts src/interfaces/http/app.ts src/interfaces/http/problem.ts src/interfaces/http/schemas.ts src/interfaces/http/model-control-schemas.ts src/interfaces/http/routes/provider-connections.ts src/interfaces/http/routes/model-profiles.ts test/helpers/start-test-app.ts test/integration/http-auth.test.ts test/integration/http-model-control.test.ts test/integration/model-secret-leak.test.ts
git commit -m "feat: expose secure model control plane"
```

---

### Task 14: Expose Verification, Promotion, Assignment, Retirement, and Secret Operations

**Files:**
- Create: `src/interfaces/http/routes/model-verifications.ts`, `model-assignments.ts`, `managed-secrets.ts`
- Modify: `src/interfaces/http/routes/provider-connections.ts`, `model-profiles.ts`
- Modify: `src/interfaces/http/model-control-schemas.ts`, `app.ts`, `problem.ts`
- Test: `test/integration/http-model-control.test.ts`, `model-verification-worker.test.ts`, `model-assignments.test.ts`, `model-secret-leak.test.ts`

**Interfaces:**
- Consumes: Tasks 11/12 services and all remaining section 6.3 operations.
- Produces: complete Model Control Plane lifecycle, operation polling, exact assignments/default, retirement/purge, Secret destruction, and master-key rotation.

- [ ] **Step 1: Write failing lifecycle route tests**

```ts
it("requires explicit ordered promotion and never rebinds Agents", async () => {
  expect((await promoteProfileBeforeConnection()).json()).toMatchObject({ code: "connection_revision_not_active" });
  await promoteConnection();
  await promoteProfile();
  expect(await getAssignment("primary")).toMatchObject({ modelProfileRevisionId: "mpr_old" });
});

it("returns an asynchronous Verification operation", async () => {
  const response = await postVerification(profileRevisionId);
  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({ verificationId: expect.any(String), status: "queued", operationUrl: expect.any(String) });
});
```

- [ ] **Step 2: Run lifecycle integration tests and confirm failure**

Run: `npm run test:integration -- test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts`

Expected: FAIL because these endpoints are absent.

- [ ] **Step 3: Add Verification routes**

`POST .../verifications` requires the exact revision/baseline plus the owning Model Profile's `expectedRevision`, and returns 202 plus operation URL. GET returns only state, safe result code/status, capabilities, optional Usage, timestamps, trace ID, and fallback candidate/operation IDs. Cancel requires the Verification's `expectedRevision`; it aborts queued/running work without deleting history.

- [ ] **Step 4: Add promotion/default/assignment routes**

Connection Promotion requires either successful discovery or a passing Verification for a Profile that references the exact Connection revision. Profile Promotion requires a current passing Verification for the exact revision/baseline and an already-active referenced Connection revision. `PUT default` stores a stable verified Profile only and never moves assignments. `PUT Agent assignment` requires exact active verified Profile revision and `expectedRevision`; GET returns explicit/unassigned state and source. Assignment changes affect only future Runs.

- [ ] **Step 5: Add retirement/purge/Secret routes**

Retirement is optimistic and non-destructive. Purge returns `resource_in_use` with safe owner categories, not Run contents. Secret destruction is separate, write-only, reference-checked, and confirmation-bearing. Master-key rotation requires the Keyring singleton's `expectedRevision`, invokes transactional re-encryption, reports only `{ reencrypted, currentKeyId, recordRevision }`, and never accepts key material over HTTP.

- [ ] **Step 6: Run full control-plane tests**

Run: `npm run test:integration -- test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts`

Expected: Verification polling/cancel, ordered promotion, no implicit rebind, default/new-Agent semantics, retirement continuity, purge references, destruction, rotation, conflicts, and leakage scans PASS.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/http/routes/model-verifications.ts src/interfaces/http/routes/model-assignments.ts src/interfaces/http/routes/managed-secrets.ts src/interfaces/http/routes/provider-connections.ts src/interfaces/http/routes/model-profiles.ts src/interfaces/http/model-control-schemas.ts src/interfaces/http/app.ts src/interfaces/http/problem.ts test/integration/http-model-control.test.ts test/integration/model-verification-worker.test.ts test/integration/model-assignments.test.ts test/integration/model-secret-leak.test.ts
git commit -m "feat: complete model registry lifecycle API"
```

---

### Task 15: Add Interactive Setup and Automation CLI Commands

**Files:**
- Modify: `src/interfaces/cli/main.ts`, `client.ts`, `formatters.ts`, `commands/agents.ts`
- Create: `src/interfaces/cli/commands/model-setup.ts`, `providers.ts`, `models.ts`, `verifications.ts`, `secrets.ts`
- Test: `test/integration/model-cli.test.ts`, `cli.test.ts`

**Interfaces:**
- Consumes: HTTP control plane only; Run Token for ordinary commands and Admin Token for model commands.
- Produces: all approved commands, non-interactive flags, `--json`, stable exit codes, trace IDs, and injectable interactive prompt interface.

- [ ] **Step 1: Write failing CLI boundary tests**

```ts
it("completes setup only through HTTP and asks before Promotion", async () => {
  const prompt = scriptedPrompts(["deepseek", "assistant", "https://api.deepseek.com", "secret", "deepseek-v4-flash", "yes"]);
  await executeCli(["model", "setup"], { prompt, fetcher, environment });
  expect(prompt.confirmations).toContain("Promote the verified connection and model profile?");
  expect(importsUnder("src/interfaces/cli")).not.toContain("node:sqlite");
});
```

Add table-driven non-interactive tests for every command and JSON error output `{ code, detail, traceId }` with stable exit codes: validation 2, authentication/authorization 3, conflict 4, provider/verification failure 5, transport/service failure 6.

- [ ] **Step 2: Run CLI tests and confirm failure**

Run: `npm run test:integration -- test/integration/model-cli.test.ts test/integration/cli.test.ts`

Expected: FAIL because Admin auth, model commands, JSON mode, and prompt injection are absent.

- [ ] **Step 3: Extend the HTTP client safely**

Accept both `bearerToken` and optional `adminToken`; `request(path, { authority: "run" | "admin" })` selects one and rejects missing Admin credentials before fetch. Read `MYAGENT_ADMIN_TOKEN` or `--admin-token`; never print it. Preserve Problem trace IDs and map errors to the fixed exit codes. Change the pure entry point to `executeCli(argumentsList, options): Promise<number>` and let only the executable wrapper assign the returned value to `process.exitCode`.

- [ ] **Step 4: Implement non-interactive commands**

Support exactly:

```text
myagent providers add|update|list|discover|promote|retire
myagent models create|verify|promote|list|retire
myagent models set-default
myagent agents set-model
myagent verifications get
myagent secrets rotate-master-key
```

Every mutation exposes `--expected-revision`; creation accepts provider/model/protocol/context/auth flags; API key input is `--api-key-env` by default and `--api-key-stdin` for managed plaintext, never a visible command-line value. `--json` emits one JSON object/line with no decorative prose.

- [ ] **Step 5: Implement the interactive setup state machine**

Inject this boundary so tests need no TTY:

```ts
export interface CliPrompt {
  select<T extends string>(message: string, choices: readonly T[]): Promise<T>;
  input(message: string, initial?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}
```

Follow the approved nine-step sequence exactly: provider, connection, Secret/revision, discovery/manual eligibility, model/context, async Verification poll, capability review, explicit promotion, optional default/Agent binding. Display destination/auth/model/protocol/capabilities/Usage/context source/affected Agents before final confirmation. Cancellation returns exit code 0 after leaving drafts/Verification history but never changes active/default/assignment state.

- [ ] **Step 6: Run CLI tests**

Run: `npm run test:integration -- test/integration/model-cli.test.ts test/integration/cli.test.ts`

Expected: interactive and automation workflows, Admin/Run token selection, no SQLite/YAML writes, stdin Secret containment, JSON stability, trace IDs, cancellation, and exit codes PASS.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/cli test/integration/model-cli.test.ts test/integration/cli.test.ts
git commit -m "feat: manage providers and models through CLI"
```

---

### Task 16: Prove Multi-Provider Isolation, Recovery, Security, and Release Gates

**Files:**
- Create: `test/e2e/multi-provider-models.test.ts`, `responses-approval-restart.test.ts`
- Modify: `test/helpers/fake-openai-provider.ts`, `start-test-app.ts`
- Modify: `test/e2e/live-provider.smoke.test.ts`
- Modify: `test/integration/secret-leak.test.ts`, `model-secret-leak.test.ts`, `network-defaults.test.ts`, `readiness.test.ts`
- Modify: `.github/workflows/ci.yml`, `package.json`, `examples/myagent.yaml`
- Create: `docs/operations/model-registry.md`

**Interfaces:**
- Consumes: the fully composed service, real HTTP/SSE/SQLite/workers, local fake provider, and external Secrets only for the opt-in smoke test.
- Produces: deterministic Windows/Linux release gate and concise Operator procedures for setup, rotation, backup/restore, retirement, and locked providers.

- [ ] **Step 1: Write the failing two-Agent protocol isolation test**

```ts
it("runs separate Chat and Responses profiles without Session or Tool leakage", async () => {
  const chatRun = await client.createRun("chat-agent", "shared:key", "chat-request-01");
  const responseRun = await client.createRun("responses-agent", "shared:key", "responses-request-01");
  await Promise.all([waitCompleted(chatRun), waitCompleted(responseRun)]);
  expect(provider.chatRequests).toHaveLength(1);
  expect(provider.responseRequests).toHaveLength(1);
  expect(JSON.stringify(provider.responseRequests)).not.toContain("chat-agent");
  expect(JSON.stringify(provider.chatRequests)).not.toContain("responses-agent");
});
```

- [ ] **Step 2: Write the failing Responses Approval/restart test**

Start through real HTTP and Responses fake provider, persist a provider call ID, pause for an actual Tool Approval, stop the process, restart against the same SQLite file, approve, execute the Tool once, submit `function_call_output` with the original call ID, and complete. Assert there is no `previous_response_id`, no duplicate Tool execution, and SSE reconnect replays committed events only.

- [ ] **Step 3: Run the new end-to-end tests and confirm the missing harness fails**

Run: `npm run test:e2e -- test/e2e/multi-provider-models.test.ts test/e2e/responses-approval-restart.test.ts`

Expected: FAIL because the real-process fake-provider/Verification harness has not yet been added.

- [ ] **Step 4: Implement the real-process multi-provider harness**

```ts
const provider = await FakeOpenAiProvider.start({ chat: chatScript, responses: responsesScript });
const service = await startTestApp({
  providerBaseUrl: provider.baseUrl,
  runToken: "run-test-token",
  adminToken: "admin-test-token",
  startVerificationWorker: true,
});
```

The helper must create a real temporary SQLite file, bind both servers to `127.0.0.1`, expose explicit `stop()`/`restart()` over the same database/config/master key, and capture normalized provider requests without Authorization values. Use the public HTTP/CLI boundary to create, discover, verify, promote, default/assign, Run, approve, and poll; direct database reads are assertions only.

- [ ] **Step 5: Expand whole-system leakage and failure tests**

Seed unique plaintext/ciphertext/reasoning/provider-body markers, then scan database text/blob renderings, online backup, logs, HTTP JSON, SSE, Run events, snapshots, Verification records, health, audit, CLI stdout/stderr, and thrown error strings. Exercise failed verification, API Key rotation, master-key mismatch, provider outage, timeout, cancellation, and cross-origin redirect; active assignments must remain byte-for-byte unchanged.

- [ ] **Step 6: Replace the opt-in live smoke test**

Run only when `MYAGENT_DEEPSEEK_BASE_URL`, `MYAGENT_DEEPSEEK_API_KEY`, and optional `MYAGENT_DEEPSEEK_MODEL` are present; default model ID to `deepseek-v4-flash`. Discover models, create a Responses profile, perform both Verification probes without Tool execution, promote/assign, execute one no-Tool Run, accept optional Usage, and assert only protocol completion/containment, never exact prose.

- [ ] **Step 7: Document operations without exposing Secrets**

Document loopback/Admin prerequisites, version-2 config, setup command, manual model eligibility, Verification/promotion/assignment order, API Key rotation, four-step two-key master rotation, encrypted backup restore key requirement, Locked diagnosis, retirement versus purge/destruction, and opt-in smoke environment names. Do not include example key values or suggest public binding.

- [ ] **Step 8: Run the complete deterministic release gate**

Run:

```bash
npm run check
npm run test:e2e
```

Expected: lint, strict typecheck, all unit/property/contract/integration/e2e tests, and build PASS with zero real credentials; migrations open/reopen/recover, two protocols remain Agent/Session isolated, Responses call ID survives Approval/restart, and all leak scans return zero matches.

- [ ] **Step 9: Verify deferred surface did not leak into implementation**

Run:

```bash
rg -n "EmbeddingPort|RerankPort|KnowledgeBase|previous_response_id|Anthropic|GenerateContent|Azure|OAuth|automatic_failover|runtime_fallback" src test examples
```

Expected: `previous_response_id` appears only in negative assertions; other terms have no implementation matches. RAG/Memory, channels, and Scheduler remain governed by their future extension boundaries rather than this milestone.

- [ ] **Step 10: Commit**

```bash
git add test/helpers/fake-openai-provider.ts test/helpers/start-test-app.ts test/e2e/multi-provider-models.test.ts test/e2e/responses-approval-restart.test.ts test/e2e/live-provider.smoke.test.ts test/integration/secret-leak.test.ts test/integration/model-secret-leak.test.ts test/integration/network-defaults.test.ts test/integration/readiness.test.ts .github/workflows/ci.yml package.json package-lock.json examples/myagent.yaml docs/operations/model-registry.md
git commit -m "test: prove multi-provider model registry release gates"
```

---

## Specification Coverage Map

| Approved specification requirement | Implementing tasks |
|---|---|
| Protocol-first OpenAI, DeepSeek, and custom connections | 1, 5, 6, 9, 10 |
| SQLite stable resources, immutable revisions, audit, optimistic concurrency | 1, 2, 3 |
| Discovery pagination/cache/manual eligibility | 3, 6, 7, 13 |
| Durable capability Verification, retry, recovery, automatic candidate fallback | 1, 3, 10, 11, 14 |
| Explicit ordered Promotion with no implicit assignment movement | 1, 2, 11, 14, 16 |
| Default and exact per-Agent Assignment | 1, 2, 12, 14, 16 |
| Model-free Catalog plus exact Run snapshot | 5, 8, 12 |
| Chat Completions and stateless Responses routing | 8, 9, 10, 16 |
| Provider Tool Call ID across Approval and restart | 8, 9, 10, 16 |
| Managed Secret encryption, rotation, destruction, backup restore | 2, 4, 12, 14, 16 |
| Provider network and authorization policy | 5, 6, 7, 9, 10, 16 |
| Separate loopback Admin Token control plane | 5, 12, 13, 14 |
| Interactive and non-interactive HTTP-only CLI | 13, 14, 15 |
| Idempotent restricted legacy import | 2, 5, 12, 16 |
| Health/readiness authority separation and Secret-free observability | 3, 4, 12, 13, 14, 16 |
| Windows/Linux deterministic gates and DeepSeek live smoke | 6, 16 |
| RAG/Memory, messaging channels, Scheduler, native providers, multimodal, Web UI, failover deferred | Global Constraints, 16 |

## Execution Boundary

Stop after Task 16 and evaluate all release gates. Do not add Embedding/Rerank/RAG binding, long-term Memory, instant-messaging Channels, scheduled jobs, native Anthropic/Gemini adapters, multimodal input, Web UI, Azure/OAuth/custom auth headers, runtime protocol fallback, or cross-provider failover while executing this plan. The existing architectural boundaries may accept those future milestones, but each requires its own approved written specification and implementation plan.
