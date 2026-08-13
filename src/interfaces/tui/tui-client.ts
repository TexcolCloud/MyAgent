import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { JsonValue } from "../../domain/json.js";
import { CliClient, CliHttpError } from "../cli/client.js";
import {
  CliPromptCancelledError,
  setupModel,
  type CliPrompt,
  type SetupModelProgressCallback,
} from "../cli/commands/model-setup.js";
import type { AdminClient, AdminRequestInit } from "../cli/commands/providers.js";
import type {
  ConfirmedDestructionInput,
  CreateModelProfileInput,
  CreateProviderConnectionInput,
  DefaultModelProfileResponse,
  DiscoveryResponse,
  DiscoverModelsInput,
  ExpectedRevisionInput,
  MasterKeyRotationResponse,
  ModelAssignmentResponse,
  ModelProfileResponse,
  ModelVerificationResponse,
  PromoteModelProfileInput,
  PromoteProviderConnectionInput,
  ProviderConnectionResponse,
  ProviderDriversResponse,
  PutDefaultModelProfileInput,
  PutModelAssignmentInput,
  QueuedModelVerificationResponse,
  QueueModelVerificationInput,
  ReviseProviderConnectionInput,
} from "../http/model-control-schemas.js";
import type { CreateManagedAgentInput } from "../../application/create-managed-agent.js";
import {
  createdManagedAgentResponseSchema,
} from "../http/routes/managed-agents.js";
import {
  defaultModelProfileResponseSchema,
  discoveryResponseSchema,
  masterKeyRotationResponseSchema,
  modelAssignmentResponseSchema,
  modelProfileResponseSchema,
  modelProfilesResponseSchema,
  modelVerificationResponseSchema,
  providerConnectionResponseSchema,
  providerConnectionsResponseSchema,
  providerDriversResponseSchema,
  queuedModelVerificationResponseSchema,
} from "../http/model-control-schemas.js";
import {
  activeRunsResponseSchema,
  agentsResponseSchema,
  approvalDecisionResponseSchema,
  approvalsResponseSchema,
  createRunResponseSchema,
  diagnosticsResponseSchema,
  runResponseSchema,
  runHistoryResponseSchema,
  sessionHistoryResponseSchema,
} from "../http/schemas.js";
import type { DiagnosticReport } from "../../application/collect-diagnostics.js";
import { TuiTokensMustDifferError, type TuiCredentials } from "./credentials.js";

export interface TuiClientOptions extends TuiCredentials {
  readonly apiUrl?: string;
  readonly fetcher?: typeof fetch;
}

export interface RunTuiModelSetupInput {
  readonly prompt: CliPrompt;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly write: (line: string) => void;
  readonly onProgress?: SetupModelProgressCallback;
  readonly signal?: AbortSignal;
}

export interface CreateRunInput {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly text: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface CreateRunResult {
  readonly runId: string;
  readonly status: "queued";
  readonly eventsUrl: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "waiting_reconciliation"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunView {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly fifoSequence: number;
  readonly parentRunId: string | null;
  readonly rootRunId: string;
  readonly delegationDepth: number;
  readonly budget: {
    readonly modelTurns: number;
    readonly toolCalls: number;
    readonly childRuns: number;
    readonly delegationDepth: number;
    readonly activeExecutionSeconds: number;
    readonly toolOutputBytes: number;
  };
  readonly result?: JsonValue | undefined;
  readonly failure?: { readonly code: string } | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActiveRunView {
  readonly runId: string;
  readonly status: Extract<RunStatus,
    "queued" | "running" | "waiting_approval" | "cancelling"
  >;
}

export interface RunHistoryInput { readonly agentId: string; readonly sessionKey: string; readonly limit?: number; readonly cursor?: string; }
export interface RunHistoryView { readonly items: readonly RunView[]; readonly nextCursor?: string | undefined; }
export interface SessionHistoryInput { readonly agentId?: string; readonly sessionKey?: string; readonly limit?: number; readonly cursor?: string; }
export interface SessionHistoryView { readonly items: readonly { readonly sessionId: string; readonly agentId: string; readonly sessionKey: string; readonly createdAt: string; readonly updatedAt: string; }[]; readonly nextCursor?: string | undefined; }

export interface PendingApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly state: "pending";
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly expiresAt: string;
  readonly riskNotice?: string | undefined;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly runId: string;
  readonly state: "approved" | "denied";
  readonly resolvedAt: string | null;
}

export type ProviderDriverCatalog = ReadonlyResponse<ProviderDriversResponse>;

export interface AgentListView {
  readonly catalogRevision?: string;
  readonly agents: readonly { readonly id: string; readonly revisionId: string; readonly displayName: string }[];
  readonly unavailable: readonly { readonly label: string; readonly code: "invalid_agent_config" }[];
}

export interface ProviderConnectionsView {
  readonly connections: readonly Pick<
    ProviderConnectionResponse,
    "connectionId" | "displayName" | "activeRevisionId" | "retiredAt"
  >[];
}

export interface ModelProfilesView {
  readonly profiles: readonly Pick<
    ModelProfileResponse,
    "profileId" | "displayName" | "activeRevisionId" | "retiredAt"
  >[];
}

export class TuiRevisionConflictError extends CliHttpError {
  readonly reloadRequired = true;

  constructor(error: CliHttpError) {
    super(error.status, error.code, error.detail, error.traceId);
    this.name = "TuiRevisionConflictError";
  }
}

export class TuiResponseValidationError extends Error {
  readonly code = "invalid_tui_response";
  readonly detail = "The service returned an invalid response.";
  readonly traceId = "tui";

  constructor() {
    super("invalid_tui_response");
    this.name = "TuiResponseValidationError";
  }
}

export function isRevisionConflict(error: unknown): error is CliHttpError {
  return error instanceof CliHttpError && error.code === "revision_conflict";
}

export class TuiClient {
  private readonly runClient: CliClient;
  private readonly adminClient: CliClient;

  constructor(options: TuiClientOptions) {
    if (options.runToken === options.adminToken) throw new TuiTokensMustDifferError();
    const baseUrl = options.apiUrl ?? "http://127.0.0.1:8787";
    this.runClient = new CliClient({
      baseUrl,
      bearerToken: options.runToken,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
    this.adminClient = new CliClient({
      baseUrl,
      adminToken: options.adminToken,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
  }

  createRun(input: CreateRunInput): Promise<CreateRunResult> {
    return this.requestAndParse(this.runClient, createRunResponseSchema, "/v1/runs", {
      method: "POST",
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      body: {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        input: { type: "text", text: input.text },
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  getRun(runId: string): Promise<RunView> {
    return this.requestAndParse(this.runClient, runResponseSchema, `/v1/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string, expectedRevision: string): Promise<RunView> {
    return this.requestAndParse(this.runClient, runResponseSchema, `/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: { confirm: true, expectedRevision } });
  }

  listActiveRuns(): Promise<{ readonly runs: readonly ActiveRunView[] }> {
    return this.requestAndParse(this.runClient, activeRunsResponseSchema, "/v1/runs?state=active");
  }

  listRunHistory(input: RunHistoryInput): Promise<RunHistoryView> {
    return this.requestAndParse(this.runClient, runHistoryResponseSchema, `/v1/runs?${historyQuery({ agentId: input.agentId, sessionKey: input.sessionKey, limit: input.limit, cursor: input.cursor })}`);
  }

  listSessions(input: SessionHistoryInput = {}): Promise<SessionHistoryView> {
    const combinedFilter = input.agentId !== undefined && input.sessionKey !== undefined;
    return this.requestAndParse(this.runClient, sessionHistoryResponseSchema, `/v1/sessions?${historyQuery({ agentId: input.agentId, sessionKey: input.sessionKey, limit: input.limit ?? (combinedFilter ? 50 : undefined), cursor: input.cursor })}`);
  }

  decideApproval(approvalId: string, decision: "approve" | "deny"): Promise<ApprovalDecision> {
    return this.requestAndParse(
      this.runClient,
      approvalDecisionResponseSchema,
      `/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
      method: "POST",
      body: { decision },
      },
    );
  }

  listPendingApprovals(): Promise<{ readonly approvals: readonly PendingApproval[] }> {
    return this.requestAndParse(this.runClient, approvalsResponseSchema, "/v1/approvals?status=pending");
  }

  getDiagnostics(): Promise<DiagnosticReport> {
    return this.requestAdmin(diagnosticsResponseSchema, "/v1/admin/diagnostics");
  }

  listAgents(): Promise<AgentListView> {
    return this.requestAndParse(this.runClient, agentsResponseSchema, "/v1/agents");
  }

  createManagedAgent(
    input: CreateManagedAgentInput,
  ): Promise<z.output<typeof createdManagedAgentResponseSchema>> {
    return this.requestAdmin(createdManagedAgentResponseSchema, "/v1/admin/agents", {
      method: "POST",
      body: input,
    });
  }

  listProviderConnections(): Promise<ProviderConnectionsView> {
    return this.requestAdmin(providerConnectionsResponseSchema, "/v1/admin/provider-connections");
  }

  getProviderConnection(connectionId: string): Promise<ProviderConnectionResponse> {
    return this.requestAdmin(
      providerConnectionResponseSchema,
      `/v1/admin/provider-connections/${resourceId(connectionId)}`,
    );
  }

  createProvider(input: CreateProviderConnectionInput): Promise<ProviderConnectionResponse> {
    return this.requestAdmin(providerConnectionResponseSchema, "/v1/admin/provider-connections", {
      method: "POST",
      body: input,
    });
  }

  reviseProvider(
    connectionId: string,
    input: ReviseProviderConnectionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.requestAdmin(
      providerConnectionResponseSchema,
      `/v1/admin/provider-connections/${resourceId(connectionId)}/revisions`,
      { method: "POST", body: input },
    );
  }

  promoteProvider(
    connectionId: string,
    input: PromoteProviderConnectionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.requestAdmin(
      providerConnectionResponseSchema,
      `/v1/admin/provider-connections/${resourceId(connectionId)}/promotions`,
      { method: "POST", body: input },
    );
  }

  retireProvider(
    connectionId: string,
    input: ExpectedRevisionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.requestAdmin(
      providerConnectionResponseSchema,
      `/v1/admin/provider-connections/${resourceId(connectionId)}/retirement`,
      { method: "POST", body: input },
    );
  }

  purgeProvider(connectionId: string, input: ConfirmedDestructionInput): Promise<void> {
    return this.requestAdmin(
      z.undefined(),
      `/v1/admin/provider-connections/${resourceId(connectionId)}/purge`,
      { method: "POST", body: input },
    );
  }

  discoverProviderModels(
    connectionRevisionId: string,
    input: DiscoverModelsInput,
  ): Promise<DiscoveryResponse> {
    return this.requestAdmin(
      discoveryResponseSchema,
      `/v1/admin/provider-connection-revisions/${resourceId(connectionRevisionId)}/discover`,
      { method: "POST", body: input },
    );
  }

  getProviderModels(connectionRevisionId: string): Promise<DiscoveryResponse> {
    return this.requestAdmin(
      discoveryResponseSchema,
      `/v1/admin/provider-connection-revisions/${resourceId(connectionRevisionId)}/models`,
    );
  }

  listModelProfiles(): Promise<ModelProfilesView> {
    return this.requestAdmin(modelProfilesResponseSchema, "/v1/admin/model-profiles");
  }

  getModelProfile(profileId: string): Promise<ModelProfileResponse> {
    return this.requestAdmin(
      modelProfileResponseSchema,
      `/v1/admin/model-profiles/${resourceId(profileId)}`,
    );
  }

  createModelProfile(input: CreateModelProfileInput): Promise<ModelProfileResponse> {
    return this.requestAdmin(modelProfileResponseSchema, "/v1/admin/model-profiles", {
      method: "POST",
      body: input,
    });
  }

  promoteModelProfile(
    profileId: string,
    input: PromoteModelProfileInput,
  ): Promise<ModelProfileResponse> {
    return this.requestAdmin(
      modelProfileResponseSchema,
      `/v1/admin/model-profiles/${resourceId(profileId)}/promotions`,
      { method: "POST", body: input },
    );
  }

  retireModelProfile(
    profileId: string,
    input: ExpectedRevisionInput,
  ): Promise<ModelProfileResponse> {
    return this.requestAdmin(
      modelProfileResponseSchema,
      `/v1/admin/model-profiles/${resourceId(profileId)}/retirement`,
      { method: "POST", body: input },
    );
  }

  purgeModelProfile(profileId: string, input: ConfirmedDestructionInput): Promise<void> {
    return this.requestAdmin(
      z.undefined(),
      `/v1/admin/model-profiles/${resourceId(profileId)}/purge`,
      { method: "POST", body: input },
    );
  }

  verifyModel(
    profileRevisionId: string,
    input: QueueModelVerificationInput,
  ): Promise<QueuedModelVerificationResponse> {
    return this.requestAdmin(
      queuedModelVerificationResponseSchema,
      `/v1/admin/model-profile-revisions/${resourceId(profileRevisionId)}/verifications`,
      { method: "POST", body: input },
    );
  }

  getModelVerification(verificationId: string): Promise<ModelVerificationResponse> {
    return this.requestAdmin(
      modelVerificationResponseSchema,
      `/v1/admin/model-verifications/${resourceId(verificationId)}`,
    );
  }

  getModelVerificationAt(operationUrl: string): Promise<ModelVerificationResponse> {
    if (!operationUrl.startsWith("/v1/admin/")) return Promise.reject(new TuiResponseValidationError());
    return this.requestAdmin(modelVerificationResponseSchema, operationUrl);
  }

  cancelModelVerification(
    verificationId: string,
    input: ExpectedRevisionInput,
  ): Promise<ModelVerificationResponse> {
    return this.requestAdmin(
      modelVerificationResponseSchema,
      `/v1/admin/model-verifications/${resourceId(verificationId)}/cancel`,
      { method: "POST", body: input },
    );
  }

  getModelAssignment(agentId: string): Promise<ModelAssignmentResponse> {
    return this.requestAdmin(
      modelAssignmentResponseSchema,
      `/v1/admin/agents/${resourceId(agentId)}/model-assignment`,
    );
  }

  assignModel(agentId: string, input: PutModelAssignmentInput): Promise<ModelAssignmentResponse> {
    return this.requestAdmin(
      modelAssignmentResponseSchema,
      `/v1/admin/agents/${resourceId(agentId)}/model-assignment`,
      { method: "PUT", body: input },
    );
  }

  getDefaultModelProfile(): Promise<DefaultModelProfileResponse> {
    return this.requestAdmin(defaultModelProfileResponseSchema, "/v1/admin/default-model-profile");
  }

  setDefaultModelProfile(input: PutDefaultModelProfileInput): Promise<DefaultModelProfileResponse> {
    return this.requestAdmin(defaultModelProfileResponseSchema, "/v1/admin/default-model-profile", {
      method: "PUT",
      body: input,
    });
  }

  listProviderDrivers(): Promise<ProviderDriverCatalog> {
    return this.requestAdmin(providerDriversResponseSchema, "/v1/admin/provider-drivers");
  }

  destroyManagedSecretVersion(
    secretVersionId: string,
    input: ConfirmedDestructionInput,
  ): Promise<void> {
    return this.requestAdmin(
      z.undefined(),
      `/v1/admin/managed-secret-versions/${resourceId(secretVersionId)}/destruction`,
      { method: "POST", body: input },
    );
  }

  rotateManagedSecretsMasterKey(input: ExpectedRevisionInput): Promise<MasterKeyRotationResponse> {
    return this.requestAdmin(
      masterKeyRotationResponseSchema,
      "/v1/admin/managed-secrets/master-key-rotation",
      { method: "POST", body: input },
    );
  }

  runModelSetup(input: RunTuiModelSetupInput): Promise<number> {
    return setupModel(
      this.modelSetupClient(input.signal),
      input.prompt,
      input.sleep,
      input.write,
      true,
      input.onProgress,
    );
  }

  private requestAdmin<Schema extends z.ZodType>(
    schema: Schema,
    path: string,
    init: RequestInitBody = {},
  ): Promise<z.output<Schema>> {
    return this.requestAndParse(this.adminClient, schema, path, { ...init, authority: "admin" });
  }

  private modelSetupClient(signal: AbortSignal | undefined): AdminClient {
    return {
      request: <T>(path: string, init: AdminRequestInit = {}) => {
        if (signal?.aborted === true) return Promise.reject(new CliPromptCancelledError());
        return this.modelSetupRequest(path, init) as Promise<T>;
      },
    };
  }

  private modelSetupRequest(path: string, init: AdminRequestInit): Promise<unknown> {
    const body = init.body;
    if (path === "/v1/admin/provider-drivers" && method(init, "GET")) {
      return this.listProviderDrivers();
    }
    if (path === "/v1/admin/provider-connections" && method(init, "POST")) {
      return this.createProvider(body as CreateProviderConnectionInput);
    }
    const discovery = /^\/v1\/admin\/provider-connection-revisions\/([^/]+)\/discover$/u.exec(path);
    if (discovery?.[1] !== undefined && method(init, "POST")) {
      return this.discoverProviderModels(decodeURIComponent(discovery[1]), body as DiscoverModelsInput);
    }
    if (path === "/v1/admin/model-profiles" && method(init, "POST")) {
      return this.createModelProfile(body as CreateModelProfileInput);
    }
    const queue = /^\/v1\/admin\/model-profile-revisions\/([^/]+)\/verifications$/u.exec(path);
    if (queue?.[1] !== undefined && method(init, "POST")) {
      return this.verifyModel(decodeURIComponent(queue[1]), body as QueueModelVerificationInput);
    }
    const verification = /^\/v1\/admin\/model-verifications\/([^/]+)$/u.exec(path);
    if (verification?.[1] !== undefined && method(init, "GET")) {
      return this.getModelVerification(decodeURIComponent(verification[1]));
    }
    const profile = /^\/v1\/admin\/model-profiles\/([^/]+)$/u.exec(path);
    if (profile?.[1] !== undefined && method(init, "GET")) {
      return this.getModelProfile(decodeURIComponent(profile[1]));
    }
    if (path === "/v1/admin/default-model-profile" && method(init, "GET")) {
      return this.getDefaultModelProfile();
    }
    if (path === "/v1/admin/default-model-profile" && method(init, "PUT")) {
      return this.setDefaultModelProfile(body as PutDefaultModelProfileInput);
    }
    const assignment = /^\/v1\/admin\/agents\/([^/]+)\/model-assignment$/u.exec(path);
    if (assignment?.[1] !== undefined && method(init, "GET")) {
      return this.getModelAssignment(decodeURIComponent(assignment[1]));
    }
    if (assignment?.[1] !== undefined && method(init, "PUT")) {
      return this.assignModel(decodeURIComponent(assignment[1]), body as PutModelAssignmentInput);
    }
    const providerPromotion = /^\/v1\/admin\/provider-connections\/([^/]+)\/promotions$/u.exec(path);
    if (providerPromotion?.[1] !== undefined && method(init, "POST")) {
      return this.promoteProvider(
        decodeURIComponent(providerPromotion[1]),
        body as PromoteProviderConnectionInput,
      );
    }
    const profilePromotion = /^\/v1\/admin\/model-profiles\/([^/]+)\/promotions$/u.exec(path);
    if (profilePromotion?.[1] !== undefined && method(init, "POST")) {
      return this.promoteModelProfile(
        decodeURIComponent(profilePromotion[1]),
        body as PromoteModelProfileInput,
      );
    }
    return Promise.reject(new TuiResponseValidationError());
  }

  private async requestAndParse<Schema extends z.ZodType>(
    client: CliClient,
    schema: Schema,
    path: string,
    init: RequestInitBody & { readonly authority?: "run" | "admin" } = {},
  ): Promise<z.output<Schema>> {
    let response: unknown;
    try {
      response = await client.request<unknown>(path, init);
    } catch (error) {
      if (error instanceof CliHttpError && error.status === 409 && isRevisionConflict(error)) {
        throw new TuiRevisionConflictError(error);
      }
      throw error;
    }
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new TuiResponseValidationError();
    return parsed.data;
  }

  stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    return this.runClient.stream(path, lastEventId, signal);
  }
}

function historyQuery(input: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
  return query.toString();
}

interface RequestInitBody {
  readonly method?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

function method(init: AdminRequestInit, expected: "GET" | "POST" | "PUT"): boolean {
  return (init.method ?? "GET") === expected;
}

function resourceId(value: string): string {
  return encodeURIComponent(value);
}

type ReadonlyResponse<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyResponse<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyResponse<T[Key]> }
    : T;
