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
} from "../domain/ids.js";

export interface IdGenerator {
  sessionId(): SessionId;
  runId(): RunId;
  toolCallId(): ToolCallId;
  approvalId(): ApprovalId;
  attemptId(): AttemptId;
  providerConnectionRevisionId(): ProviderConnectionRevisionId;
  modelProfileRevisionId(): ModelProfileRevisionId;
  modelVerificationId(): ModelVerificationId;
  managedSecretVersionId(): ManagedSecretVersionId;
  modelRegistryEventId(): ModelRegistryEventId;
  discoveryGenerationId(): DiscoveryGenerationId;
}
