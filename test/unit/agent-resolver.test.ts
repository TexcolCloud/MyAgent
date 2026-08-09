import { describe, expect, it } from "vitest";

import { AgentResolver } from "../../src/application/agent-resolver.js";
import type { AgentDefinitionRevision } from "../../src/domain/agent-revision.js";
import {
  managedSecretVersionIdFromUuid,
  modelProfileRevisionIdFromUuid,
  parseAgentId,
  parseModelProfileId,
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ModelAssignment } from "../../src/domain/model-assignment.js";
import type { ModelProfileView } from "../../src/domain/model-profile.js";
import type { RegistryRevisionState } from "../../src/domain/model-registry.js";
import type { ProviderConnectionView } from "../../src/domain/provider-connection.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";

describe("AgentResolver", () => {
  it("snapshots the exact assigned revision and ignores later promotion", () => {
    const fixture = registryFixture();
    const resolver = new AgentResolver({
      catalog: { resolve: () => ({ id: agentId, definition }) },
      registry: fixture.registry,
      secrets: { resolve: () => "resolved-secret" },
    });

    const first = resolver.resolve(agentId);
    fixture.promoteProfile();
    const second = resolver.resolve(agentId);

    expect(first.modelProfileRevisionId).toBe(oldProfileRevisionId);
    expect(second.modelProfileRevisionId).toBe(oldProfileRevisionId);
    expect(first).toEqual(second);
  });

  it("rejects an Agent without an exact model assignment", () => {
    const resolver = new AgentResolver({
      catalog: { resolve: () => ({ id: agentId, definition }) },
      registry: {
        getAssignment: () => null,
        listProfiles: () => {
          throw new Error("profiles_must_not_be_read");
        },
        listConnections: () => {
          throw new Error("connections_must_not_be_read");
        },
      },
      secrets: { resolve: () => "resolved-secret" },
    });

    expect(() => resolver.resolve(agentId)).toThrowError(
      expect.objectContaining({ code: "model_assignment_required", status: 422 }),
    );
  });

  it("rejects an assignment whose exact Connection revision is ineligible", () => {
    const fixture = registryFixture({ connectionState: "draft" });
    const resolver = new AgentResolver({
      catalog: { resolve: () => ({ id: agentId, definition }) },
      registry: fixture.registry,
      secrets: { resolve: () => "resolved-secret" },
    });

    expect(() => resolver.resolve(agentId)).toThrowError(
      expect.objectContaining({ code: "verification_required", status: 422 }),
    );
  });

  it("maps an unresolved managed provider credential to a locked model", () => {
    const secretVersionId = managedSecretVersionIdFromUuid(
      "00000000-0000-7000-8000-000000000009",
    );
    const fixture = registryFixture({
      providerAuth: {
        type: "bearer",
        secret: { managedSecretVersionId: secretVersionId },
      },
    });
    const resolver = new AgentResolver({
      catalog: { resolve: () => ({ id: agentId, definition }) },
      registry: fixture.registry,
      secrets: {
        resolve() {
          throw new DomainError("secret_locked", "must-not-escape");
        },
      },
    });

    const error = catchError(() => resolver.resolve(agentId));
    expect(error).toMatchObject({
      code: "model_provider_locked",
      status: 503,
      message: "model_provider_locked",
      details: undefined,
    });
    expect(JSON.stringify(error)).not.toContain(secretVersionId);
    expect(String(error)).not.toContain("must-not-escape");
  });

  it("keeps exact superseded and retired revisions usable", () => {
    for (const state of ["superseded", "retired"] as const) {
      const fixture = registryFixture({
        profileState: state,
        connectionState: state,
      });
      const snapshot = new AgentResolver({
        catalog: { resolve: () => ({ id: agentId, definition }) },
        registry: fixture.registry,
        secrets: { resolve: () => "resolved-secret" },
      }).resolve(agentId);

      expect(snapshot.modelProfileRevisionId).toBe(oldProfileRevisionId);
      expect(snapshot.model.providerConnectionRevisionId).toBe(connectionRevisionId);
    }
  });

  it("accepts a legacy-trusted revision only for its imported assignment", () => {
    const imported = registryFixture({
      assignmentSource: "legacy_import",
      profileState: "legacy_trusted",
      connectionState: "legacy_trusted",
    });
    const explicit = registryFixture({
      assignmentSource: "explicit",
      profileState: "legacy_trusted",
      connectionState: "legacy_trusted",
    });
    const options = {
      catalog: { resolve: () => ({ id: agentId, definition }) },
      secrets: { resolve: () => "resolved-secret" },
    };

    expect(new AgentResolver({ ...options, registry: imported.registry }).resolve(agentId))
      .toMatchObject({ modelProfileRevisionId: oldProfileRevisionId });
    expect(() => new AgentResolver({ ...options, registry: explicit.registry }).resolve(agentId))
      .toThrowError(expect.objectContaining({ code: "verification_required", status: 422 }));
  });

  it("uses a provider credential only as a lock check", () => {
    const plaintext = "provider-plaintext-must-not-persist";
    const fixture = registryFixture();
    const snapshot = new AgentResolver({
      catalog: { resolve: () => ({ id: agentId, definition }) },
      registry: fixture.registry,
      secrets: { resolve: () => plaintext },
    }).resolve(agentId);

    expect(JSON.stringify(snapshot)).not.toContain(plaintext);
    expect(snapshot.revisionId).toBe(`rev_${snapshot.contentSha256}`);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.model.providerAuth)).toBe(true);
  });
});

const agentId = parseAgentId("primary");
const profileId = parseModelProfileId("assistant");
const connectionId = parseProviderConnectionId("openai");
const oldProfileRevisionId = modelProfileRevisionIdFromUuid(
  "00000000-0000-7000-8000-000000000001",
);
const newProfileRevisionId = modelProfileRevisionIdFromUuid(
  "00000000-0000-7000-8000-000000000002",
);
const connectionRevisionId = providerConnectionRevisionIdFromUuid(
  "00000000-0000-7000-8000-000000000001",
);
const now = new Date("2026-08-09T00:00:00.000Z");

const definition: AgentDefinitionRevision = {
  definitionRevisionId: "def_primary",
  agentId,
  displayName: "Primary",
  prompt: "Be precise.",
  workspace: "C:/workspace",
  skills: [],
  policy: [],
  delegates: [],
  limits: DEFAULT_RUN_LIMITS,
  contentSha256: "1".repeat(64),
};

function registryFixture(options: {
  connectionState?: RegistryRevisionState;
  profileState?: RegistryRevisionState;
  assignmentSource?: ModelAssignment["source"];
  providerAuth?: ProviderConnectionView["revisions"][number]["auth"];
} = {}): {
  registry: {
    getAssignment: () => ModelAssignment;
    listProfiles: () => readonly ModelProfileView[];
    listConnections: () => readonly ProviderConnectionView[];
  };
  promoteProfile(): void;
} {
  let activeRevisionId = oldProfileRevisionId;
  const assignment: ModelAssignment = {
    agentId,
    modelProfileRevisionId: oldProfileRevisionId,
    source: options.assignmentSource ?? "explicit",
    recordRevision: 0,
    updatedAt: now,
  };
  const profileRevisions: ModelProfileView["revisions"] = [
    {
      revisionId: oldProfileRevisionId,
      profileId,
      connectionRevisionId,
      providerModelId: "gpt-test-old",
      invocationProtocol: "chat_completions",
      maxInputTokens: 8_192,
      contextWindowSource: "operator",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      state: options.profileState ?? "active",
      createdAt: now,
    },
    {
      revisionId: newProfileRevisionId,
      profileId,
      connectionRevisionId,
      providerModelId: "gpt-test-new",
      invocationProtocol: "chat_completions",
      maxInputTokens: 16_384,
      contextWindowSource: "operator",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      state: "active",
      createdAt: now,
    },
  ];
  const connections: readonly ProviderConnectionView[] = [{
    connectionId,
    displayName: "OpenAI",
    providerKind: "openai",
    activeRevisionId: connectionRevisionId,
    retiredAt: null,
    recordRevision: 0,
    revisions: [{
      revisionId: connectionRevisionId,
      connectionId,
      state: options.connectionState ?? "active",
      baseUrl: "https://api.openai.example/v1",
      auth: options.providerAuth ?? {
        type: "bearer",
        secret: { fromEnvironment: "OPENAI_API_KEY" },
      },
      allowInsecureHttp: false,
      protocolPreference: "chat_completions",
      presetVersion: "openai-v1",
      createdAt: now,
    }],
  }];

  return {
    registry: {
      getAssignment: () => assignment,
      listProfiles: () => [{
        profileId,
        displayName: "Assistant",
        activeRevisionId,
        retiredAt: null,
        recordRevision: 0,
        revisions: profileRevisions,
      }],
      listConnections: () => connections,
    },
    promoteProfile() {
      activeRevisionId = newProfileRevisionId;
    },
  };
}

function catchError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected_error");
}
