import { v7 as uuidV7 } from "uuid";

import {
  approvalIdFromUuid,
  attemptIdFromUuid,
  discoveryGenerationIdFromUuid,
  managedSecretVersionIdFromUuid,
  modelProfileRevisionIdFromUuid,
  modelRegistryEventIdFromUuid,
  modelVerificationIdFromUuid,
  providerConnectionRevisionIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
  type ApprovalId,
  type AttemptId,
  type DiscoveryGenerationId,
  type ManagedSecretVersionId,
  type ModelProfileRevisionId,
  type ModelRegistryEventId,
  type ModelVerificationId,
  type ProviderConnectionRevisionId,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "../domain/ids.js";
import type { IdGenerator } from "../ports/id-generator.js";

export class UuidIdGenerator implements IdGenerator {
  sessionId(): SessionId {
    return sessionIdFromUuid(uuidV7());
  }

  runId(): RunId {
    return runIdFromUuid(uuidV7());
  }

  toolCallId(): ToolCallId {
    return toolCallIdFromUuid(uuidV7());
  }

  approvalId(): ApprovalId {
    return approvalIdFromUuid(uuidV7());
  }

  attemptId(): AttemptId {
    return attemptIdFromUuid(uuidV7());
  }

  providerConnectionRevisionId(): ProviderConnectionRevisionId {
    return providerConnectionRevisionIdFromUuid(uuidV7());
  }

  modelProfileRevisionId(): ModelProfileRevisionId {
    return modelProfileRevisionIdFromUuid(uuidV7());
  }

  modelVerificationId(): ModelVerificationId {
    return modelVerificationIdFromUuid(uuidV7());
  }

  managedSecretVersionId(): ManagedSecretVersionId {
    return managedSecretVersionIdFromUuid(uuidV7());
  }

  modelRegistryEventId(): ModelRegistryEventId {
    return modelRegistryEventIdFromUuid(uuidV7());
  }

  discoveryGenerationId(): DiscoveryGenerationId {
    return discoveryGenerationIdFromUuid(uuidV7());
  }
}
