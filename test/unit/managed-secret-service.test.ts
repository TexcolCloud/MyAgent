import { describe, expect, it } from "vitest";

import { CompositeSecretResolver } from "../../src/adapters/composite-secret-resolver.js";
import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import { secretRefSchema } from "../../src/config/secret-ref.js";
import type { ManagedSecretVersionId } from "../../src/domain/ids.js";
import { managedSecretVersionIdFromUuid } from "../../src/domain/ids.js";
import type { ManagedSecretVersionMetadata } from "../../src/domain/managed-secret.js";
import { MutableDynamicRedactionRegistry } from "../../src/observability/redactor.js";
import type { ManagedSecretStore } from "../../src/ports/managed-secret-store.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

describe("SecretRef", () => {
  it("parses exactly one discriminated environment or managed reference", () => {
    const managedSecretVersionId = managedSecretVersionIdFromUuid("managed");

    expect(secretRefSchema.parse({ fromEnvironment: "DEEPSEEK_API_KEY" }))
      .toEqual({ fromEnvironment: "DEEPSEEK_API_KEY" });
    expect(secretRefSchema.parse({ managedSecretVersionId }))
      .toEqual({ managedSecretVersionId });
    expect(() => secretRefSchema.parse({})).toThrow();
    expect(() => secretRefSchema.parse({
      fromEnvironment: "DEEPSEEK_API_KEY",
      managedSecretVersionId,
    })).toThrow();
    expect(() => secretRefSchema.parse({ fromEnvironment: "DEEPSEEK_API_KEY", extra: true }))
      .toThrow();
  });
});

describe("CompositeSecretResolver", () => {
  it("dispatches each discriminant and registers non-empty values before returning", () => {
    const managedSecretVersionId = managedSecretVersionIdFromUuid("dispatch");
    const managed = resolvingStore(managedSecretVersionId, "managed-value");
    const registry = new MutableDynamicRedactionRegistry();
    const resolver = new CompositeSecretResolver(
      new EnvironmentSecretResolver({ DEEPSEEK_API_KEY: "environment-value" }),
      managed,
      registry,
    );

    expect(resolver.resolve({ fromEnvironment: "DEEPSEEK_API_KEY" }))
      .toBe("environment-value");
    expect(registry.values()).toEqual(["environment-value"]);
    expect(resolver.resolve({ managedSecretVersionId })).toBe("managed-value");
    expect(registry.values()).toEqual(["environment-value", "managed-value"]);
  });

  it("does not register empty resolved values", () => {
    const managedSecretVersionId = managedSecretVersionIdFromUuid("empty");
    const registry = new MutableDynamicRedactionRegistry();
    const resolver = new CompositeSecretResolver(
      { resolve: () => "" },
      resolvingStore(managedSecretVersionId, ""),
      registry,
    );

    expect(resolver.resolve({ managedSecretVersionId })).toBe("");
    expect(registry.values()).toEqual([]);
  });

  it("never exposes an unavailable environment reference name or value", () => {
    const resolver = new CompositeSecretResolver(
      new EnvironmentSecretResolver({}),
      resolvingStore(managedSecretVersionIdFromUuid("unused"), "unused"),
      new MutableDynamicRedactionRegistry(),
    );

    expect(() => resolver.resolve({ fromEnvironment: "PRIVATE_PROVIDER_KEY" }))
      .toThrowError("secret_locked");
    try {
      resolver.resolve({ fromEnvironment: "PRIVATE_PROVIDER_KEY" });
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_PROVIDER_KEY");
    }

    expect(() => new EnvironmentSecretResolver({}).resolve({
      managedSecretVersionId: managedSecretVersionIdFromUuid("wrong-reference"),
    })).toThrowError("secret_locked");
  });
});

describe("ManageSecretsService", () => {
  it("generates the version ID and supplies the clock for provider API key creation", () => {
    const versionId = managedSecretVersionIdFromUuid("service-create");
    const store = serviceStore({
      createVersion: (input) => {
        if (
          input.versionId !== versionId ||
          input.secretId !== "provider:deepseek:api-key" ||
          input.purpose !== "provider_api_key" ||
          input.plaintext !== "service-secret" ||
          input.now.getTime() !== NOW.getTime()
        ) {
          throw new Error("wrong_create_input");
        }
        return metadata(input.versionId, input.secretId, input.now);
      },
    });
    const service = new ManageSecretsService(
      store,
      { inspectSecretReferences: () => [] },
      new FakeClock(NOW),
      new FakeIds({ managedSecretVersionIds: [versionId] }),
      { run: (operation) => operation() },
    );

    expect(service.createProviderApiKey({
      secretId: "provider:deepseek:api-key",
      plaintext: "service-secret",
    })).toEqual(metadata(versionId, "provider:deepseek:api-key", NOW));
  });

  it("checks the expected revision before retained references and destruction", () => {
    const versionId = managedSecretVersionIdFromUuid("referenced");
    const operations: string[] = [];
    const store = serviceStore({
      assertActiveVersion: (input) => {
        operations.push(`assert:${input.expectedRevision}`);
      },
      destroy: () => { throw new Error("destroy_should_not_run"); },
    });
    const service = new ManageSecretsService(
      store,
      {
        inspectSecretReferences: () => {
          operations.push("inspect");
          return [{
            type: "retained_run_snapshot",
            id: "revision-retained",
          }];
        },
      },
      new FakeClock(NOW),
      new FakeIds(),
      {
        run: (operation) => {
          operations.push("transaction");
          return operation();
        },
      },
    );

    expect(() => service.destroyVersion({ versionId, expectedRevision: 0 }))
      .toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: { ownerCategories: ["retained_run_snapshot"] },
      }));
    expect(operations).toEqual(["transaction", "assert:0", "inspect"]);
  });

  it("supplies current time to allowed destruction and Keyring rotation", () => {
    const versionId = managedSecretVersionIdFromUuid("service-destroy");
    const destroyedAt = new Date("2026-08-09T00:00:00.000Z");
    const destroyed = { ...metadata(versionId, "provider:key", NOW), state: "destroyed" as const, recordRevision: 1, destroyedAt };
    const store = serviceStore({
      assertActiveVersion: (input) => {
        if (input.versionId !== versionId || input.expectedRevision !== 0) {
          throw new Error("wrong_assert_input");
        }
      },
      destroy: (input) => input.now.getTime() === NOW.getTime() && input.expectedRevision === 0
        ? destroyed
        : (() => { throw new Error("wrong_destroy_input"); })(),
      rotateMasterKey: (input) => input.now.getTime() === NOW.getTime() && input.expectedRevision === 4
        ? { reencrypted: 3, currentKeyId: "mk_next", recordRevision: 5 }
        : (() => { throw new Error("wrong_rotate_input"); })(),
    });
    const service = new ManageSecretsService(
      store,
      { inspectSecretReferences: () => [] },
      new FakeClock(NOW),
      new FakeIds(),
      { run: (operation) => operation() },
    );

    expect(service.destroyVersion({ versionId, expectedRevision: 0 })).toEqual(destroyed);
    expect(service.rotateMasterKey({ expectedRevision: 4 })).toEqual({
      reencrypted: 3,
      currentKeyId: "mk_next",
      recordRevision: 5,
    });
  });
});

function resolvingStore(
  expectedVersionId: ManagedSecretVersionId,
  value: string,
): ManagedSecretStore {
  return serviceStore({
    resolve: (versionId) => {
      if (versionId !== expectedVersionId) throw new Error("wrong_version_id");
      return value;
    },
  });
}

function serviceStore(
  overrides: Partial<ManagedSecretStore> = {},
): ManagedSecretStore {
  return {
    createVersion: () => { throw new Error("unexpected_create"); },
    resolve: () => { throw new Error("unexpected_resolve"); },
    assertActiveVersion: () => { throw new Error("unexpected_assert"); },
    destroy: () => { throw new Error("unexpected_destroy"); },
    rotateMasterKey: () => { throw new Error("unexpected_rotate"); },
    ...overrides,
  };
}

function metadata(
  versionId: ManagedSecretVersionId,
  secretId: string,
  createdAt: Date,
): ManagedSecretVersionMetadata {
  return {
    versionId,
    secretId,
    purpose: "provider_api_key",
    keyId: "mk_test",
    state: "active",
    recordRevision: 0,
    createdAt,
    destroyedAt: null,
  };
}
