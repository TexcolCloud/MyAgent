import {
  normalizeProviderBaseUrl,
  validateLiteralAddress,
} from "../adapters/provider-http-policy.js";
import { ApplicationError, DomainError } from "../domain/errors.js";
import type {
  ManagedSecretVersionId,
  ProviderConnectionId,
  ProviderConnectionRevisionId,
} from "../domain/ids.js";
import type {
  InvocationProtocol,
  ProviderKind,
} from "../domain/model-registry.js";
import type {
  ProviderAuth,
  ProviderConnectionRevision,
  ProviderConnectionView,
} from "../domain/provider-connection.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";
import { providerPreset } from "../config/provider-presets.js";
import type { ManageSecretsService } from "./manage-secrets.js";

type ConnectionManagementRegistry = Pick<
  ModelRegistryStore,
  | "createConnection"
  | "createConnectionRevision"
  | "getConnection"
  | "listConnections"
  | "promoteConnection"
  | "purgeConnection"
  | "retireConnection"
>;

export type ProviderCredentialInput =
  | { readonly type: "none" }
  | { readonly type: "environment"; readonly fromEnvironment: string }
  | {
      readonly type: "managed_secret";
      readonly managedSecretVersionId: ManagedSecretVersionId;
    };

export interface ReplacementProviderApiKey {
  readonly secretId: string;
  readonly plaintext: string;
}

export interface CreateProviderConnectionInput {
  readonly connectionId: ProviderConnectionId;
  readonly displayName: string;
  readonly providerKind: ProviderKind;
  readonly baseUrl?: string;
  readonly credential: ProviderCredentialInput;
  readonly replacementApiKey?: ReplacementProviderApiKey;
  readonly allowInsecureHttp?: boolean;
  readonly protocolPreference?: InvocationProtocol;
  readonly traceId: string;
}

export interface ReviseProviderConnectionInput {
  readonly connectionId: ProviderConnectionId;
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credential?: ProviderCredentialInput;
  readonly replacementApiKey?: ReplacementProviderApiKey;
  readonly allowInsecureHttp?: boolean;
  readonly protocolPreference?: InvocationProtocol;
  readonly traceId: string;
}

export interface MutateProviderConnectionInput {
  readonly connectionId: ProviderConnectionId;
  readonly expectedRevision: number;
  readonly traceId: string;
}

export interface ProviderConnectionTransaction {
  run<Result>(operation: () => Result): Result;
}

export interface PromoteProviderConnectionInput extends MutateProviderConnectionInput {
  readonly connectionRevisionId: ProviderConnectionRevisionId;
}

export class ManageProviderConnectionsService {
  constructor(
    private readonly registry: ConnectionManagementRegistry,
    private readonly secrets: Pick<
      ManageSecretsService,
      "assertVersionActive" | "createProviderApiKey"
    >,
    private readonly clock: Pick<Clock, "now">,
    private readonly ids: Pick<
      IdGenerator,
      "providerConnectionRevisionId" | "modelRegistryEventId"
    >,
    private readonly transaction: ProviderConnectionTransaction,
  ) {}

  create(input: CreateProviderConnectionInput): ProviderConnectionView {
    return this.transaction.run(() => {
      const now = this.clock.now();
      const preset = providerPreset(input.providerKind);
      const allowInsecureHttp = input.allowInsecureHttp ?? false;
      const baseUrl = validatedBaseUrl(
        input.baseUrl ?? preset.baseUrl ?? "",
        allowInsecureHttp,
      );
      const auth = this.resolveAuth(
        input.providerKind,
        input.credential,
        input.replacementApiKey,
      );
      return this.registry.createConnection({
        connectionId: input.connectionId,
        displayName: requiredText(input.displayName),
        providerKind: input.providerKind,
        revision: {
          revisionId: this.ids.providerConnectionRevisionId(),
          connectionId: input.connectionId,
          state: "draft",
          baseUrl,
          auth,
          allowInsecureHttp,
          protocolPreference:
            input.protocolPreference ?? preset.protocolPreference,
          presetVersion: preset.version,
          createdAt: now,
        },
        eventId: this.ids.modelRegistryEventId(),
        traceId: input.traceId,
        now,
      });
    });
  }

  revise(input: ReviseProviderConnectionInput): ProviderConnectionView {
    return this.transaction.run(() => {
      const connection = this.registry.getConnection(input.connectionId);
      if (connection.recordRevision !== input.expectedRevision) {
        throw new ApplicationError("revision_conflict", 409);
      }
      if (connection.retiredAt !== null) throw new DomainError("resource_retired");
      const base = currentRevision(connection);
      const allowInsecureHttp =
        input.allowInsecureHttp ?? base.allowInsecureHttp;
      const now = this.clock.now();
      const revision: ProviderConnectionRevision = {
        revisionId: this.ids.providerConnectionRevisionId(),
        connectionId: input.connectionId,
        state: "draft",
        baseUrl: validatedBaseUrl(
          input.baseUrl ?? base.baseUrl,
          allowInsecureHttp,
        ),
        auth: this.resolveAuth(
          connection.providerKind,
          input.credential ?? authAsCredential(base.auth),
          input.replacementApiKey,
        ),
        allowInsecureHttp,
        protocolPreference:
          input.protocolPreference ?? base.protocolPreference,
        presetVersion: base.presetVersion,
        createdAt: now,
      };
      return this.registry.createConnectionRevision({
        connectionId: input.connectionId,
        expectedRevision: input.expectedRevision,
        ...(input.displayName === undefined
          ? {}
          : { displayName: requiredText(input.displayName) }),
        revision,
        eventId: this.ids.modelRegistryEventId(),
        traceId: input.traceId,
        now,
      });
    });
  }

  promote(input: PromoteProviderConnectionInput): ProviderConnectionView {
    return this.registry.promoteConnection({
      connectionId: input.connectionId,
      revisionId: input.connectionRevisionId,
      expectedRevision: input.expectedRevision,
      eventId: this.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now: this.clock.now(),
    });
  }

  retire(input: MutateProviderConnectionInput): ProviderConnectionView {
    return this.registry.retireConnection({
      ...input,
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  purge(input: MutateProviderConnectionInput): void {
    this.registry.purgeConnection({
      ...input,
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  private resolveAuth(
    providerKind: ProviderKind,
    credential: ProviderCredentialInput,
    replacementApiKey: ReplacementProviderApiKey | undefined,
  ): ProviderAuth {
    if (replacementApiKey !== undefined) {
      if (credential.type !== "none" && credential.type !== "environment" &&
        credential.type !== "managed_secret") {
        throw new DomainError("invalid_provider_connection");
      }
      const secret = this.secrets.createProviderApiKey({
        secretId: requiredText(replacementApiKey.secretId),
        plaintext: requiredText(replacementApiKey.plaintext),
      });
      return {
        type: "bearer",
        secret: { managedSecretVersionId: secret.versionId },
      };
    }
    switch (credential.type) {
      case "none":
        if (providerKind !== "openai_compatible") {
          throw new DomainError("invalid_provider_connection");
        }
        return { type: "none" };
      case "environment":
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.fromEnvironment)) {
          throw new DomainError("invalid_provider_connection");
        }
        return {
          type: "bearer",
          secret: { fromEnvironment: credential.fromEnvironment },
        };
      case "managed_secret":
        this.secrets.assertVersionActive(credential.managedSecretVersionId);
        return {
          type: "bearer",
          secret: {
            managedSecretVersionId: credential.managedSecretVersionId,
          },
        };
    }
  }
}

function currentRevision(connection: ProviderConnectionView): ProviderConnectionRevision {
  const active = connection.revisions.find(
    ({ revisionId }) => revisionId === connection.activeRevisionId,
  );
  const revision = active ?? connection.revisions.at(-1);
  if (revision === undefined) throw new DomainError("invalid_provider_connection");
  return revision;
}

function authAsCredential(auth: ProviderAuth): ProviderCredentialInput {
  if (auth.type === "none") return { type: "none" };
  if ("fromEnvironment" in auth.secret) {
    return {
      type: "environment",
      fromEnvironment: auth.secret.fromEnvironment,
    };
  }
  return {
    type: "managed_secret",
    managedSecretVersionId: auth.secret.managedSecretVersionId,
  };
}

function validatedBaseUrl(value: string, allowInsecureHttp: boolean): string {
  const normalized = normalizeProviderBaseUrl(value);
  validateLiteralAddress(new URL(normalized), allowInsecureHttp);
  return normalized;
}

function requiredText(value: string): string {
  if (value.trim().length === 0) {
    throw new DomainError("invalid_provider_connection");
  }
  return value;
}
