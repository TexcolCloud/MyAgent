import { randomUUID } from "node:crypto";

import type { JsonValue } from "../../domain/json.js";
import { CliClient } from "../cli/client.js";
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

export interface ProviderDriverCatalog {
  readonly piVersion: "0.73.1";
  readonly drivers: readonly {
    readonly driverId: string;
    readonly candidates: readonly {
      readonly candidateId: string;
      readonly displayName: string;
      readonly modelId: string;
      readonly credentialSupport: "bearer" | "none" | "unsupported";
    }[];
  }[];
}

export interface AgentListView {
  readonly agents: readonly { readonly id: string; readonly revisionId: string; readonly displayName: string }[];
  readonly unavailable: readonly { readonly label: string; readonly code: "invalid_agent_config" }[];
}

export interface ProviderConnectionsView {
  readonly connections: readonly {
    readonly connectionId: string;
    readonly displayName: string;
    readonly activeRevisionId: string | null;
    readonly retiredAt: string | null;
  }[];
}

export interface ModelProfilesView {
  readonly profiles: readonly {
    readonly profileId: string;
    readonly displayName: string;
    readonly activeRevisionId: string | null;
    readonly retiredAt: string | null;
  }[];
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
    return this.adminClient.request("/v1/admin/provider-connections", { authority: "admin" });
  }

  listModelProfiles(): Promise<ModelProfilesView> {
    return this.adminClient.request("/v1/admin/model-profiles", { authority: "admin" });
  }

  listProviderDrivers(): Promise<ProviderDriverCatalog> {
    return this.adminClient.request("/v1/admin/provider-drivers", { authority: "admin" });
  }

  adminRequest<T>(path: string, init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<T> {
    return this.adminClient.request<T>(path, { ...init, authority: "admin" });
  }

  stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    return this.runClient.stream(path, lastEventId, signal);
  }
}
