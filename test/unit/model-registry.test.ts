import { describe, expect, it } from "vitest";

import type { DiscoveryView } from "../../src/domain/model-registry.js";
import type { ModelAssignment } from "../../src/domain/model-assignment.js";
import {
  assertExistingAssignmentUsable,
  assertNewAssignmentEligible,
} from "../../src/domain/model-assignment.js";
import type { ModelProfileRevision } from "../../src/domain/model-profile.js";
import {
  assertProfilePromotable,
  assertPurgeAllowed,
} from "../../src/domain/model-profile.js";
import type { ProviderConnectionRevision } from "../../src/domain/provider-connection.js";
import { assertConnectionPromotable } from "../../src/domain/provider-connection.js";
import {
  parseAgentId,
  type ModelProfileRevisionId,
  type ProviderConnectionRevisionId,
} from "../../src/domain/ids.js";

const createdAt = new Date("2026-08-09T00:00:00.000Z");

function profile(
  overrides: Partial<ModelProfileRevision> = {},
): ModelProfileRevision {
  return {
    revisionId: "mpr_old" as ModelProfileRevisionId,
    profileId: "primary" as ModelProfileRevision["profileId"],
    connectionRevisionId: "pcr_old" as ModelProfileRevision["connectionRevisionId"],
    providerModelId: "gpt-test",
    invocationProtocol: "chat_completions",
    maxInputTokens: 16_384,
    contextWindowSource: "preset",
    capabilityBaseline: "text_and_single_tool_call_v1",
    verifiedCapabilities: ["streaming_text", "single_tool_call"],
    state: "active",
    createdAt,
    ...overrides,
  };
}

function connection(
  overrides: Partial<ProviderConnectionRevision> = {},
): ProviderConnectionRevision {
  return {
    revisionId: "pcr_old" as ProviderConnectionRevision["revisionId"],
    connectionId: "primary" as ProviderConnectionRevision["connectionId"],
    state: "active",
    baseUrl: "https://example.test/v1",
    auth: { type: "none" },
    allowInsecureHttp: false,
    protocolPreference: "chat_completions",
    presetVersion: "v1",
    createdAt,
    ...overrides,
  };
}

function assignment(
  source: ModelAssignment["source"],
  revisionId: ModelProfileRevisionId = "mpr_old" as ModelProfileRevisionId,
): ModelAssignment {
  return {
    agentId: parseAgentId("primary"),
    modelProfileRevisionId: revisionId,
    source,
    recordRevision: 1,
    updatedAt: createdAt,
  };
}

describe("Model Registry lifecycle invariants", () => {
  it("represents discovery freshness without exposing a credential", () => {
    const discovery: DiscoveryView = {
      connectionRevisionId: "pcr_old" as ProviderConnectionRevisionId,
      state: "fresh",
      models: [{ id: "gpt-test", owner: "openai", createdAt }],
      fetchedAt: createdAt,
      expiresAt: new Date("2026-08-09T01:00:00.000Z"),
    };

    expect(discovery.models).toEqual([{ id: "gpt-test", owner: "openai", createdAt }]);
  });

  it("requires a verified Connection revision for promotion", () => {
    expect(() => assertConnectionPromotable(connection({ state: "verified" }))).not.toThrow();
    expect(() => assertConnectionPromotable(connection({ state: "draft" }))).toThrow(
      "verification_required",
    );
  });

  it("makes Profile revision content immutable", () => {
    const revision = profile();

    // @ts-expect-error Profile revision content must not be mutated in place.
    revision.providerModelId = "other-model";
    expect(revision.providerModelId).toBe("other-model");
  });

  it("makes nested Provider credentials immutable", () => {
    const revision = connection({
      auth: { type: "bearer", secret: { fromEnvironment: "OPENAI_API_KEY" } },
    });

    if (revision.auth.type === "bearer" && "fromEnvironment" in revision.auth.secret) {
      // @ts-expect-error Nested credential content must not be mutated in place.
      revision.auth.secret.fromEnvironment = "OPENAI_API_KEY";
      expect(revision.auth.secret.fromEnvironment).toBe("OPENAI_API_KEY");
    }
  });

  it("requires an active Connection and verified Profile capabilities for Profile promotion", () => {
    expect(() => assertProfilePromotable(profile({ state: "verified" }), connection())).not.toThrow();
    expect(() => assertProfilePromotable(profile({ state: "verified" }), connection({ state: "superseded" }))).toThrow(
      "connection_revision_not_active",
    );
    expect(() => assertProfilePromotable(profile({ state: "verified", verifiedCapabilities: ["streaming_text"] }), connection())).toThrow(
      "verification_required",
    );
  });

  it("never treats Profile promotion as assignment movement", () => {
    const oldRevisionId = "mpr_old" as ModelProfileRevisionId;
    const currentAssignment = assignment("explicit", oldRevisionId);

    expect(assertExistingAssignmentUsable(currentAssignment, profile({ revisionId: oldRevisionId, state: "superseded" }))).toBeUndefined();
    expect(currentAssignment.modelProfileRevisionId).toBe("mpr_old");
  });

  it("rejects an assignment when the supplied Profile revision has a different identity", () => {
    expect(() => assertExistingAssignmentUsable(assignment("explicit"), profile({ revisionId: "mpr_other" as ModelProfileRevisionId }))).toThrow(
      "verification_required",
    );
    expect(() => assertExistingAssignmentUsable(assignment("legacy_import"), profile({ revisionId: "mpr_other" as ModelProfileRevisionId, state: "legacy_trusted", verifiedCapabilities: [] }))).toThrow(
      "verification_required",
    );
  });

  it("allows only imported assignments to keep a Legacy-Trusted revision", () => {
    expect(() => assertExistingAssignmentUsable(assignment("legacy_import"), profile({ state: "legacy_trusted", verifiedCapabilities: [] }))).not.toThrow();
    expect(() => assertExistingAssignmentUsable(assignment("explicit"), profile({ state: "legacy_trusted", verifiedCapabilities: [] }))).toThrow(
      "verification_required",
    );
    expect(() => assertNewAssignmentEligible(profile({ state: "legacy_trusted" }))).toThrow(
      "legacy_assignment_forbidden",
    );
  });

  it("requires an active Profile with both verified capabilities for new assignments", () => {
    expect(() => assertNewAssignmentEligible(profile())).not.toThrow();
    expect(() => assertNewAssignmentEligible(profile({ state: "superseded" }))).toThrow(
      "verification_required",
    );
    expect(() => assertNewAssignmentEligible(profile({ verifiedCapabilities: ["single_tool_call"] }))).toThrow(
      "verification_required",
    );
  });

  it("forbids purging referenced resources", () => {
    expect(() => assertPurgeAllowed(0)).not.toThrow();
    expect(() => assertPurgeAllowed(1)).toThrow("resource_in_use");
  });
});
