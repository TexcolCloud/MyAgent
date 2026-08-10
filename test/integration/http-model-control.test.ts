import { describe, expect, it } from "vitest";

import { ModelProviderError } from "../../src/ports/model.js";
import { startTestApp } from "../helpers/start-test-app.js";

const adminHeaders = { authorization: "Bearer test-admin-token" } as const;

describe("HTTP model control plane", () => {
  it("maps missing control-plane resources to generic typed Problems", async () => {
    const harness = await startTestApp();
    try {
      const cases = [
        ["/v1/admin/provider-connections/missing-provider", "provider_connection_not_found"],
        ["/v1/admin/provider-connection-revisions/pcr_missing/models", "provider_connection_revision_not_found"],
        ["/v1/admin/model-profiles/missing-profile", "model_profile_not_found"],
      ] as const;
      for (const [url, code] of cases) {
        const response = await harness.app.inject({
          method: "GET",
          url,
          remoteAddress: "127.0.0.1",
          headers: adminHeaders,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          code,
          detail: "The requested resource does not exist.",
          traceId: expect.any(String),
        });
        expect(response.payload).not.toContain("missing-provider");
        expect(response.payload).not.toContain("pcr_missing");
        expect(response.payload).not.toContain("missing-profile");
      }
    } finally {
      await harness.close();
    }
  });

  it("maps malformed control-plane path identifiers to a generic invalid request", async () => {
    const harness = await startTestApp();
    try {
      for (const url of [
        "/v1/admin/provider-connections/Invalid!",
        "/v1/admin/model-profiles/Invalid!",
      ]) {
        const response = await harness.app.inject({
          method: "GET",
          url,
          remoteAddress: "127.0.0.1",
          headers: adminHeaders,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: "invalid_request",
          traceId: expect.any(String),
        });
        expect(response.payload).not.toContain("Invalid!");
      }
    } finally {
      await harness.close();
    }
  });


  it("creates a Provider Connection without echoing its write-only API key", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "task-13-provider",
          displayName: "Task 13 Provider",
          kind: "openai",
          auth: { type: "api_key" },
          apiKey: "needle-provider-secret",
          allowInsecureHttp: false,
          protocolPreference: "responses",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        connectionId: "task-13-provider",
        displayName: "Task 13 Provider",
        providerKind: "openai",
        activeRevisionId: null,
        recordRevision: 0,
        credentialConfigured: true,
        secretVersionId: expect.any(String),
        revisions: [
          expect.objectContaining({
            state: "draft",
            baseUrl: "https://api.openai.com/v1",
            credentialConfigured: true,
            protocolPreference: "responses",
            presetVersion: "openai-v1",
          }),
        ],
      });
      expect(response.payload).not.toContain("needle-provider-secret");
    } finally {
      await harness.close();
    }
  });

  it("maps invalid and insecure Provider URLs to typed validation Problems", async () => {
    const harness = await startTestApp();
    try {
      const invalid = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "invalid-url-provider",
          displayName: "Invalid URL Provider",
          kind: "openai_compatible",
          baseUrl: "https://user@example.test/v1",
          auth: { type: "none" },
        },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ code: "invalid_provider_url" });

      const insecure = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "insecure-url-provider",
          displayName: "Insecure URL Provider",
          kind: "openai_compatible",
          baseUrl: "http://8.8.8.8/v1",
          auth: { type: "none" },
          allowInsecureHttp: true,
        },
      });
      expect(insecure.statusCode).toBe(422);
      expect(insecure.json()).toMatchObject({ code: "insecure_provider_url" });

      const valid = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "revision-url-provider",
          displayName: "Revision URL Provider",
          kind: "openai_compatible",
          baseUrl: "https://revision-url.example.test/v1",
          auth: { type: "none" },
        },
      });
      expect(valid.statusCode).toBe(201);
      const invalidRevision = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/revision-url-provider/revisions",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: 0,
          displayName: "Revision URL Provider",
          baseUrl: "https://user@example.test/v2",
          auth: { type: "none" },
          allowInsecureHttp: false,
          protocolPreference: "chat_completions",
        },
      });
      expect(invalidRevision.statusCode).toBe(422);
      expect(invalidRevision.json()).toMatchObject({ code: "invalid_provider_url" });
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown request properties before persisting a submitted credential", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "strict-provider",
          displayName: "Strict Provider",
          kind: "openai",
          auth: { type: "api_key" },
          apiKey: "strict-schema-secret-needle",
          unexpected: true,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(response.payload).not.toContain("strict-schema-secret-needle");
      expect(() => harness.modelRegistry.getConnection("strict-provider" as never))
        .toThrowError("provider_connection_not_found");
    } finally {
      await harness.close();
    }
  });

  it("lists and reads Provider Connections without exposing environment Secret names", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "environment-provider",
          displayName: "Environment Provider",
          kind: "deepseek",
          auth: { type: "environment", fromEnvironment: "NEEDLE_PROVIDER_KEY" },
        },
      });
      expect(created.statusCode).toBe(201);

      const listed = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().connections).toContainEqual(
        expect.objectContaining({
          connectionId: "environment-provider",
          credentialConfigured: true,
        }),
      );

      const detail = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/provider-connections/environment-provider",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        connectionId: "environment-provider",
        credentialConfigured: true,
      });
      expect(`${created.payload}${listed.payload}${detail.payload}`)
        .not.toContain("NEEDLE_PROVIDER_KEY");
    } finally {
      await harness.close();
    }
  });

  it("creates full Provider Connection revisions with optimistic concurrency", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "revision-provider",
          displayName: "Revision Provider",
          kind: "openai_compatible",
          baseUrl: "https://models.example.test/v1",
          auth: { type: "none" },
          allowInsecureHttp: false,
          protocolPreference: "chat_completions",
        },
      });
      expect(created.statusCode).toBe(201);

      const revisionPayload = {
        expectedRevision: 0,
        displayName: "Revision Provider v2",
        baseUrl: "https://models.example.test/v2",
        auth: { type: "api_key" },
        apiKey: "replacement-provider-secret",
        allowInsecureHttp: false,
        protocolPreference: "responses",
      } as const;
      const revised = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/revision-provider/revisions",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: revisionPayload,
      });
      expect(revised.statusCode).toBe(200);
      expect(revised.json()).toMatchObject({
        connectionId: "revision-provider",
        displayName: "Revision Provider v2",
        recordRevision: 1,
        activeRevisionId: null,
        credentialConfigured: true,
        secretVersionId: expect.any(String),
        revisions: [
          expect.objectContaining({ credentialConfigured: false }),
          expect.objectContaining({
            state: "draft",
            baseUrl: "https://models.example.test/v2",
            protocolPreference: "responses",
            credentialConfigured: true,
          }),
        ],
      });
      expect(revised.payload).not.toContain("replacement-provider-secret");

      const stale = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/revision-provider/revisions",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { ...revisionPayload, apiKey: "another-provider-secret" },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: "revision_conflict",
        traceId: expect.any(String),
      });
      expect(stale.payload).not.toContain("another-provider-secret");
    } finally {
      await harness.close();
    }
  });

  it("refreshes and reads discovery state, cache metadata, and models without promotion", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => ({
          state: "fresh",
          models: [
            { id: "provider-model-a", owner: "provider-owner" },
            { id: "provider-model-b", createdAt: new Date("2026-08-01T00:00:00.000Z") },
          ],
          fetchedAt: new Date("2026-08-07T00:00:00.000Z"),
        }),
      },
    });
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "discovery-provider",
          displayName: "Discovery Provider",
          kind: "openai_compatible",
          baseUrl: "https://discovery.example.test/v1",
          auth: { type: "none" },
        },
      });
      const revisionId = created.json().revisions[0].revisionId as string;

      const refreshed = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${revisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toEqual({
        connectionRevisionId: revisionId,
        recordRevision: 1,
        state: "fresh",
        models: [
          { id: "provider-model-a", owner: "provider-owner" },
          { id: "provider-model-b", createdAt: "2026-08-01T00:00:00.000Z" },
        ],
        cache: {
          fetchedAt: "2026-08-07T00:00:00.000Z",
          expiresAt: "2026-08-07T00:10:00.000Z",
        },
        error: null,
      });

      const models = await harness.app.inject({
        method: "GET",
        url: `/v1/admin/provider-connection-revisions/${revisionId}/models`,
        remoteAddress: "::1",
        headers: adminHeaders,
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toEqual(refreshed.json());

      const connection = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/provider-connections/discovery-provider",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(connection.json()).toMatchObject({
        activeRevisionId: null,
        recordRevision: 1,
        revisions: [expect.objectContaining({ state: "verified" })],
      });
    } finally {
      await harness.close();
    }
  });

  it("returns only safe discovery failure metadata", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => {
          throw new Error("raw-provider-body-secret-needle", {
            cause: new ModelProviderError({
              code: "provider_auth_failed",
              transient: false,
              status: 401,
            }),
          });
        },
      },
    });
    try {
      const connection = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "failed-discovery-provider",
          displayName: "Failed Discovery Provider",
          kind: "openai_compatible",
          baseUrl: "https://failed-discovery.example.test/v1",
          auth: { type: "none" },
        },
      });
      const revisionId = connection.json().revisions[0].revisionId as string;
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${revisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: "failed",
        models: [],
        error: {
          code: "provider_auth_failed",
          status: 401,
          traceId: expect.any(String),
        },
      });
      expect(response.payload).not.toContain("raw-provider-body-secret-needle");
    } finally {
      await harness.close();
    }
  });

  it("creates and reads draft Model Profiles with fixed protocol and preset context", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => ({
          state: "fresh",
          models: [{ id: "gpt-4o-mini", owner: "openai" }],
          fetchedAt: new Date("2026-08-07T00:00:00.000Z"),
        }),
      },
    });
    try {
      const connection = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "profile-provider",
          displayName: "Profile Provider",
          kind: "openai",
          auth: { type: "environment", fromEnvironment: "PROFILE_PROVIDER_KEY" },
        },
      });
      const connectionRevisionId = connection.json().revisions[0].revisionId as string;
      const discovery = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(discovery.statusCode).toBe(200);

      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "gpt-mini",
          displayName: "GPT Mini",
          connectionRevisionId,
          modelId: "gpt-4o-mini",
          protocol: "auto",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        profileId: "gpt-mini",
        displayName: "GPT Mini",
        activeRevisionId: null,
        recordRevision: 0,
        revisions: [
          expect.objectContaining({
            connectionRevisionId,
            providerModelId: "gpt-4o-mini",
            invocationProtocol: "responses",
            maxInputTokens: 128_000,
            contextWindowSource: "preset",
            state: "draft",
          }),
        ],
      });

      const listed = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().profiles).toContainEqual(created.json());

      const detail = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/model-profiles/gpt-mini",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(created.json());

      const duplicate = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "gpt-mini",
          displayName: "Duplicate GPT Mini",
          connectionRevisionId,
          modelId: "gpt-4o-mini",
          protocol: "responses",
        },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "resource_conflict" });
    } finally {
      await harness.close();
    }
  });

  it("requires acknowledged manual entry and explicit unknown-model context", async () => {
    const harness = await startTestApp();
    try {
      const connection = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "manual-provider",
          displayName: "Manual Provider",
          kind: "openai_compatible",
          baseUrl: "https://manual.example.test/v1",
          auth: { type: "none" },
        },
      });
      const connectionRevisionId = connection.json().revisions[0].revisionId as string;
      const discovery = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(discovery.json()).toMatchObject({ state: "unsupported" });

      const baseProfile = {
        slug: "manual-profile",
        displayName: "Manual Profile",
        connectionRevisionId,
        modelId: "custom-model",
        protocol: "auto",
      } as const;
      const unacknowledged = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          ...baseProfile,
          maxInputTokens: 32_768,
          contextWindowSource: "assumed_32768",
        },
      });
      expect(unacknowledged.statusCode).toBe(422);
      expect(unacknowledged.json()).toMatchObject({ code: "manual_model_entry_required" });

      const missingContext = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { ...baseProfile, manualEntryAcknowledged: true },
      });
      expect(missingContext.statusCode).toBe(422);
      expect(missingContext.json()).toMatchObject({ code: "invalid_model_context_window" });

      const assumed = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          ...baseProfile,
          manualEntryAcknowledged: true,
          maxInputTokens: 32_768,
          contextWindowSource: "assumed_32768",
        },
      });
      expect(assumed.statusCode).toBe(201);
      expect(assumed.json()).toMatchObject({
        activeRevisionId: null,
        revisions: [expect.objectContaining({
          invocationProtocol: "chat_completions",
          maxInputTokens: 32_768,
          contextWindowSource: "assumed_32768",
        })],
      });

      const operator = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          ...baseProfile,
          slug: "operator-profile",
          displayName: "Operator Profile",
          protocol: "responses",
          manualEntryAcknowledged: true,
          maxInputTokens: 12_345,
          contextWindowSource: "operator",
        },
      });
      expect(operator.statusCode).toBe(201);
      expect(operator.json()).toMatchObject({
        revisions: [expect.objectContaining({
          invocationProtocol: "responses",
          maxInputTokens: 12_345,
          contextWindowSource: "operator",
        })],
      });
    } finally {
      await harness.close();
    }
  });
});
