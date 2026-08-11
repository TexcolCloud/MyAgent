import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UuidIdGenerator } from "../../src/adapters/uuid-id-generator.js";
import {
  discoveryGenerationIdFromUuid,
  managedSecretVersionIdFromUuid,
  modelProfileRevisionIdFromUuid,
  modelRegistryEventIdFromUuid,
  modelVerificationIdFromUuid,
  type ModelProfileId,
  parseAgentId,
  parseIdempotencyKey,
  parseModelProfileId,
  parseProviderConnectionId,
  parseSessionKey,
  providerConnectionRevisionIdFromUuid,
  runIdFromUuid,
} from "../../src/domain/ids.js";
import { FakeIds } from "../helpers/fake-ids.js";

describe("stable identifiers", () => {
  it("scopes valid session keys without normalizing case", () => {
    expect(parseSessionKey("Feishu:dm:Open_ID")).toBe("Feishu:dm:Open_ID");
  });

  it("rejects invalid lengths and characters", () => {
    expect(() => parseAgentId("Primary_Agent")).toThrow("invalid_agent_id");
    expect(() => parseProviderConnectionId("Primary_Connection")).toThrow("invalid_provider_connection_id");
    expect(() => parseModelProfileId("Primary_Profile")).toThrow("invalid_model_profile_id");
    expect(() => parseSessionKey("contains space")).toThrow("invalid_session_key");
    expect(() => parseIdempotencyKey("short")).toThrow("invalid_idempotency_key");
  });

  it("uses the stable slug grammar for Connection and Profile identifiers", () => {
    expect(parseProviderConnectionId("openai-prod")).toBe("openai-prod");
    expect(parseModelProfileId("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("prevents Connection IDs from being used as Profile IDs", () => {
    const connectionId = parseProviderConnectionId("openai-prod");

    // @ts-expect-error Provider Connection and Model Profile IDs are distinct brands.
    const profileId: ModelProfileId = connectionId;
    void profileId;
  });

  it("accepts every allowed session-key character", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(
            ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@/-",
          ),
          minLength: 1,
          maxLength: 200,
        }),
        (value) => {
          expect(parseSessionKey(value)).toBe(value);
        },
      ),
    );
  });

  it("prefixes generated UUIDv7 identifiers by resource type", () => {
    const ids = new UuidIdGenerator();

    expect(ids.sessionId()).toMatch(/^ses_[0-9a-f-]{36}$/);
    expect(ids.runId()).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(ids.toolCallId()).toMatch(/^call_[0-9a-f-]{36}$/);
    expect(ids.approvalId()).toMatch(/^apr_[0-9a-f-]{36}$/);
    expect(ids.attemptId()).toMatch(/^att_[0-9a-f-]{36}$/);
    expect(ids.providerConnectionRevisionId()).toMatch(/^pcr_[0-9a-f-]{36}$/);
    expect(ids.modelProfileRevisionId()).toMatch(/^mpr_[0-9a-f-]{36}$/);
    expect(ids.modelVerificationId()).toMatch(/^ver_[0-9a-f-]{36}$/);
    expect(ids.managedSecretVersionId()).toMatch(/^msv_[0-9a-f-]{36}$/);
    expect(ids.modelRegistryEventId()).toMatch(/^mre_[0-9a-f-]{36}$/);
    expect(ids.discoveryGenerationId()).toMatch(/^dgn_[0-9a-f-]{36}$/);
  });

  it("prefixes registry UUID identifiers by resource type", () => {
    const uuid = "00000000-0000-7000-8000-000000000001";

    expect(providerConnectionRevisionIdFromUuid(uuid)).toBe(`pcr_${uuid}`);
    expect(modelProfileRevisionIdFromUuid(uuid)).toBe(`mpr_${uuid}`);
    expect(modelVerificationIdFromUuid(uuid)).toBe(`ver_${uuid}`);
    expect(managedSecretVersionIdFromUuid(uuid)).toBe(`msv_${uuid}`);
    expect(modelRegistryEventIdFromUuid(uuid)).toBe(`mre_${uuid}`);
    expect(discoveryGenerationIdFromUuid(uuid)).toBe(`dgn_${uuid}`);
  });

  it("fails fast when a deterministic ID was not seeded", () => {
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000001");
    const ids = new FakeIds({ runIds: [runId] });

    expect(ids.runId()).toBe(runId);
    expect(() => ids.runId()).toThrow("FakeIds.runId queue is empty");
  });
});
