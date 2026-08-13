import { randomUUID } from "node:crypto";

import type { JsonValue } from "../../domain/json.js";
import { CliClient, CliHttpError } from "../cli/client.js";
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
import { TuiTokensMustDifferError, type TuiCredentials } from "./credentials.js";

export interface TuiClientOptions extends TuiCredentials {
  readonly apiUrl?: string;
  readonly fetcher?: typeof fetch;
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
  readonly result?: JsonValue;
  readonly failure?: { readonly code: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActiveRunView {
  readonly runId: string;
  readonly status: Extract<RunStatus,
    "queued" | "running" | "waiting_approval" | "cancelling"
  >;
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly state: "pending";
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly expiresAt: string;
  readonly riskNotice?: string;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly runId: string;
  readonly state: "approved" | "denied";
  readonly resolvedAt: string | null;
}

export type ProviderDriverCatalog = ReadonlyResponse<ProviderDriversResponse>;

export interface AgentListView {
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
    return this.runClient.request("/v1/runs", {
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
    return this.runClient.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  listActiveRuns(): Promise<{ readonly runs: readonly ActiveRunView[] }> {
    return this.runClient.request("/v1/runs?state=active");
  }

  decideApproval(approvalId: string, decision: "approve" | "deny"): Promise<ApprovalDecision> {
    return this.runClient.request(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      body: { decision },
    });
  }

  listPendingApprovals(): Promise<{ readonly approvals: readonly PendingApproval[] }> {
    return this.runClient.request("/v1/approvals?status=pending");
  }

  listAgents(): Promise<AgentListView> {
    return this.runClient.request("/v1/agents");
  }

  listProviderConnections(): Promise<ProviderConnectionsView> {
    return this.adminRequest("/v1/admin/provider-connections");
  }

  getProviderConnection(connectionId: string): Promise<ProviderConnectionResponse> {
    return this.adminRequest(`/v1/admin/provider-connections/${resourceId(connectionId)}`);
  }

  createProvider(input: CreateProviderConnectionInput): Promise<ProviderConnectionResponse> {
    return this.adminRequest("/v1/admin/provider-connections", { method: "POST", body: input });
  }

  reviseProvider(
    connectionId: string,
    input: ReviseProviderConnectionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.adminRequest(
      `/v1/admin/provider-connections/${resourceId(connectionId)}/revisions`,
      { method: "POST", body: input },
    );
  }

  promoteProvider(
    connectionId: string,
    input: PromoteProviderConnectionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.adminRequest(
      `/v1/admin/provider-connections/${resourceId(connectionId)}/promotions`,
      { method: "POST", body: input },
    );
  }

  retireProvider(
    connectionId: string,
    input: ExpectedRevisionInput,
  ): Promise<ProviderConnectionResponse> {
    return this.adminRequest(
      `/v1/admin/provider-connections/${resourceId(connectionId)}/retirement`,
      { method: "POST", body: input },
    );
  }

  purgeProvider(connectionId: string, input: ConfirmedDestructionInput): Promise<void> {
    return this.adminRequest(
      `/v1/admin/provider-connections/${resourceId(connectionId)}/purge`,
      { method: "POST", body: input },
    );
  }

  discoverProviderModels(
    connectionRevisionId: string,
    input: DiscoverModelsInput,
  ): Promise<DiscoveryResponse> {
    return this.adminRequest(
      `/v1/admin/provider-connection-revisions/${resourceId(connectionRevisionId)}/discover`,
      { method: "POST", body: input },
    );
  }

  getProviderModels(connectionRevisionId: string): Promise<DiscoveryResponse> {
    return this.adminRequest(
      `/v1/admin/provider-connection-revisions/${resourceId(connectionRevisionId)}/models`,
    );
  }

  listModelProfiles(): Promise<ModelProfilesView> {
    return this.adminRequest("/v1/admin/model-profiles");
  }

  getModelProfile(profileId: string): Promise<ModelProfileResponse> {
    return this.adminRequest(`/v1/admin/model-profiles/${resourceId(profileId)}`);
  }

  createModelProfile(input: CreateModelProfileInput): Promise<ModelProfileResponse> {
    return this.adminRequest("/v1/admin/model-profiles", { method: "POST", body: input });
  }

  promoteModelProfile(
    profileId: string,
    input: PromoteModelProfileInput,
  ): Promise<ModelProfileResponse> {
    return this.adminRequest(
      `/v1/admin/model-profiles/${resourceId(profileId)}/promotions`,
      { method: "POST", body: input },
    );
  }

  retireModelProfile(
    profileId: string,
    input: ExpectedRevisionInput,
  ): Promise<ModelProfileResponse> {
    return this.adminRequest(
      `/v1/admin/model-profiles/${resourceId(profileId)}/retirement`,
      { method: "POST", body: input },
    );
  }

  purgeModelProfile(profileId: string, input: ConfirmedDestructionInput): Promise<void> {
    return this.adminRequest(
      `/v1/admin/model-profiles/${resourceId(profileId)}/purge`,
      { method: "POST", body: input },
    );
  }

  verifyModel(
    profileRevisionId: string,
    input: QueueModelVerificationInput,
  ): Promise<QueuedModelVerificationResponse> {
    return this.adminRequest(
      `/v1/admin/model-profile-revisions/${resourceId(profileRevisionId)}/verifications`,
      { method: "POST", body: input },
    );
  }

  getModelVerification(verificationId: string): Promise<ModelVerificationResponse> {
    return this.adminRequest(`/v1/admin/model-verifications/${resourceId(verificationId)}`);
  }

  cancelModelVerification(
    verificationId: string,
    input: ExpectedRevisionInput,
  ): Promise<ModelVerificationResponse> {
    return this.adminRequest(
      `/v1/admin/model-verifications/${resourceId(verificationId)}/cancel`,
      { method: "POST", body: input },
    );
  }

  getModelAssignment(agentId: string): Promise<ModelAssignmentResponse> {
    return this.adminRequest(`/v1/admin/agents/${resourceId(agentId)}/model-assignment`);
  }

  assignModel(agentId: string, input: PutModelAssignmentInput): Promise<ModelAssignmentResponse> {
    return this.adminRequest(`/v1/admin/agents/${resourceId(agentId)}/model-assignment`, {
      method: "PUT",
      body: input,
    });
  }

  getDefaultModelProfile(): Promise<DefaultModelProfileResponse> {
    return this.adminRequest("/v1/admin/default-model-profile");
  }

  setDefaultModelProfile(input: PutDefaultModelProfileInput): Promise<DefaultModelProfileResponse> {
    return this.adminRequest("/v1/admin/default-model-profile", { method: "PUT", body: input });
  }

  listProviderDrivers(): Promise<ProviderDriverCatalog> {
    return this.adminRequest("/v1/admin/provider-drivers");
  }

  destroyManagedSecretVersion(
    secretVersionId: string,
    input: ConfirmedDestructionInput,
  ): Promise<void> {
    return this.adminRequest(
      `/v1/admin/managed-secret-versions/${resourceId(secretVersionId)}/destruction`,
      { method: "POST", body: input },
    );
  }

  rotateManagedSecretsMasterKey(input: ExpectedRevisionInput): Promise<MasterKeyRotationResponse> {
    return this.adminRequest("/v1/admin/managed-secrets/master-key-rotation", {
      method: "POST",
      body: input,
    });
  }

  adminRequest<T>(path: string, init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<T> {
    return this.adminClient.request<T>(path, { ...init, authority: "admin" })
      .catch((error: unknown) => {
        if (error instanceof CliHttpError && error.status === 409 && isRevisionConflict(error)) {
          throw new TuiRevisionConflictError(error);
        }
        throw error;
      });
  }

  stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    return this.runClient.stream(path, lastEventId, signal);
  }
}

function resourceId(value: string): string {
  return encodeURIComponent(value);
}

type ReadonlyResponse<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyResponse<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyResponse<T[Key]> }
    : T;
