import type {
  ApprovalId,
  AttemptId,
  DiscoveryGenerationId,
  ManagedSecretVersionId,
  ModelProfileRevisionId,
  ModelRegistryEventId,
  ModelVerificationId,
  ProviderConnectionRevisionId,
  RunId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids.js";
import type { IdGenerator } from "../../src/ports/id-generator.js";

export interface FakeIdSeed {
  sessionIds?: readonly SessionId[];
  runIds?: readonly RunId[];
  toolCallIds?: readonly ToolCallId[];
  approvalIds?: readonly ApprovalId[];
  attemptIds?: readonly AttemptId[];
  providerConnectionRevisionIds?: readonly ProviderConnectionRevisionId[];
  modelProfileRevisionIds?: readonly ModelProfileRevisionId[];
  modelVerificationIds?: readonly ModelVerificationId[];
  managedSecretVersionIds?: readonly ManagedSecretVersionId[];
  modelRegistryEventIds?: readonly ModelRegistryEventId[];
  discoveryGenerationIds?: readonly DiscoveryGenerationId[];
}

function take<T>(queue: T[], method: string): T {
  const value = queue.shift();
  if (value === undefined) {
    throw new Error(`FakeIds.${method} queue is empty`);
  }

  return value;
}

export class FakeIds implements IdGenerator {
  private readonly sessionIds: SessionId[];
  private readonly runIds: RunId[];
  private readonly toolCallIds: ToolCallId[];
  private readonly approvalIds: ApprovalId[];
  private readonly attemptIds: AttemptId[];
  private readonly providerConnectionRevisionIds: ProviderConnectionRevisionId[];
  private readonly modelProfileRevisionIds: ModelProfileRevisionId[];
  private readonly modelVerificationIds: ModelVerificationId[];
  private readonly managedSecretVersionIds: ManagedSecretVersionId[];
  private readonly modelRegistryEventIds: ModelRegistryEventId[];
  private readonly discoveryGenerationIds: DiscoveryGenerationId[];

  constructor(seed: FakeIdSeed = {}) {
    this.sessionIds = [...(seed.sessionIds ?? [])];
    this.runIds = [...(seed.runIds ?? [])];
    this.toolCallIds = [...(seed.toolCallIds ?? [])];
    this.approvalIds = [...(seed.approvalIds ?? [])];
    this.attemptIds = [...(seed.attemptIds ?? [])];
    this.providerConnectionRevisionIds = [...(seed.providerConnectionRevisionIds ?? [])];
    this.modelProfileRevisionIds = [...(seed.modelProfileRevisionIds ?? [])];
    this.modelVerificationIds = [...(seed.modelVerificationIds ?? [])];
    this.managedSecretVersionIds = [...(seed.managedSecretVersionIds ?? [])];
    this.modelRegistryEventIds = [...(seed.modelRegistryEventIds ?? [])];
    this.discoveryGenerationIds = [...(seed.discoveryGenerationIds ?? [])];
  }

  sessionId(): SessionId {
    return take(this.sessionIds, "sessionId");
  }

  runId(): RunId {
    return take(this.runIds, "runId");
  }

  toolCallId(): ToolCallId {
    return take(this.toolCallIds, "toolCallId");
  }

  approvalId(): ApprovalId {
    return take(this.approvalIds, "approvalId");
  }

  attemptId(): AttemptId {
    return take(this.attemptIds, "attemptId");
  }

  providerConnectionRevisionId(): ProviderConnectionRevisionId {
    return take(this.providerConnectionRevisionIds, "providerConnectionRevisionId");
  }

  modelProfileRevisionId(): ModelProfileRevisionId {
    return take(this.modelProfileRevisionIds, "modelProfileRevisionId");
  }

  modelVerificationId(): ModelVerificationId {
    return take(this.modelVerificationIds, "modelVerificationId");
  }

  managedSecretVersionId(): ManagedSecretVersionId {
    return take(this.managedSecretVersionIds, "managedSecretVersionId");
  }

  modelRegistryEventId(): ModelRegistryEventId {
    return take(this.modelRegistryEventIds, "modelRegistryEventId");
  }

  discoveryGenerationId(): DiscoveryGenerationId {
    return take(this.discoveryGenerationIds, "discoveryGenerationId");
  }
}
