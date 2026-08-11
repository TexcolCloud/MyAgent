import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
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
        ["/v1/admin/model-verifications/ver_missing", "model_verification_not_found"],
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

  it("maps a missing Verification target to a generic typed Problem", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profile-revisions/mpr_missing/verifications",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: 0,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "model_profile_revision_not_found",
        detail: "The requested resource does not exist.",
      });
      expect(response.payload).not.toContain("mpr_missing");
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      code: "file_changed" as const,
      message: "private changed-file path",
      detailNeedle: "workspace/private.txt",
    },
    {
      code: "private_registry_diagnostic" as never,
      message: "private owner and revision detail",
      detailNeedle: "owner-secret-id",
    },
  ])("maps unapproved Domain error $code to a generic Problem without echo", async ({
    code,
    message,
    detailNeedle,
  }) => {
    const harness = await startTestApp();
    const registry = harness.modelRegistry as unknown as {
      getProfile: () => never;
    };
    const original = registry.getProfile;
    registry.getProfile = () => {
      throw new DomainError(code, message, { diagnostic: detailNeedle });
    };
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/model-profiles/test-chat",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error" });
      expect(response.payload).not.toContain(code);
      expect(response.payload).not.toContain(message);
      expect(response.payload).not.toContain(detailNeedle);
    } finally {
      registry.getProfile = original;
      await harness.close();
    }
  });

  it("maps missing lifecycle mutation targets to resource-specific Problems", async () => {
    const harness = await startTestApp();
    try {
      const cases = [
        {
          url: "/v1/admin/provider-connections/missing-provider/promotions",
          payload: { connectionRevisionId: "pcr_missing", expectedRevision: 0 },
          code: "provider_connection_not_found",
        },
        {
          url: "/v1/admin/provider-connections/missing-provider/retirement",
          payload: { expectedRevision: 0 },
          code: "provider_connection_not_found",
        },
        {
          url: "/v1/admin/provider-connections/missing-provider/purge",
          payload: { expectedRevision: 0, confirm: true },
          code: "provider_connection_not_found",
        },
        {
          url: "/v1/admin/model-profiles/missing-profile/retirement",
          payload: { expectedRevision: 0 },
          code: "model_profile_not_found",
        },
        {
          url: "/v1/admin/model-profiles/missing-profile/purge",
          payload: { expectedRevision: 0, confirm: true },
          code: "model_profile_not_found",
        },
      ] as const;
      for (const lifecycleCase of cases) {
        const response = await harness.app.inject({
          method: "POST",
          url: lifecycleCase.url,
          remoteAddress: "127.0.0.1",
          headers: adminHeaders,
          payload: lifecycleCase.payload,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: lifecycleCase.code });
        expect(response.payload).not.toContain("missing-provider");
        expect(response.payload).not.toContain("missing-profile");
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

  it("creates a native Provider Connection from a server-resolved Driver", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "native-openai",
          displayName: "Native OpenAI",
          driverId: "pi/openai",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        connectionId: "native-openai",
        providerKind: "openai",
        providerDriver: "pi/openai",
      });
      expect(harness.modelRegistry.getConnection("native-openai" as never))
        .toMatchObject({ providerDriver: "pi/openai" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a bearer-only native Driver Connection without its required credential", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "deepseek-without-bearer",
          displayName: "DeepSeek Without Bearer",
          driverId: "pi/deepseek",
          auth: { type: "none" },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_provider_connection" });
      expect(harness.modelRegistry.listConnections()).not.toContainEqual(
        expect.objectContaining({ connectionId: "deepseek-without-bearer" }),
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a bearer-only native Driver Connection revision without its required credential", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "deepseek-revision-bearer",
          displayName: "DeepSeek Revision Bearer",
          driverId: "pi/deepseek",
          auth: { type: "environment", fromEnvironment: "DEEPSEEK_API_KEY" },
        },
      });
      expect(created.statusCode).toBe(201);

      const revised = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/deepseek-revision-bearer/revisions",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: 0,
          displayName: "DeepSeek Revision Bearer",
          baseUrl: "https://api.deepseek.com/v1",
          auth: { type: "none" },
          allowInsecureHttp: false,
          protocolPreference: "responses",
        },
      });

      expect(revised.statusCode).toBe(422);
      expect(revised.json()).toMatchObject({ code: "invalid_provider_connection" });
      expect(harness.modelRegistry.getConnection("deepseek-revision-bearer" as never))
        .toMatchObject({ recordRevision: 0 });
    } finally {
      await harness.close();
    }
  });

  it("rejects a mismatched Driver on a Provider Connection revision", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "immutable-driver",
          displayName: "Immutable Driver",
          driverId: "pi/openai",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
        },
      });
      expect(created.statusCode).toBe(201);

      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/immutable-driver/revisions",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: 0,
          displayName: "Immutable Driver",
          driverId: "pi/deepseek",
          baseUrl: "https://api.openai.com/v1",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
          allowInsecureHttp: false,
          protocolPreference: "responses",
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_provider_connection" });
      expect(harness.modelRegistry.getConnection("immutable-driver" as never))
        .toMatchObject({ recordRevision: 0, providerDriver: "pi/openai" });
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
          catalogCandidateId: "pi/openai:gpt-4o-mini",
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
            catalogCandidateId: "pi/openai:gpt-4o-mini",
            invocationProtocol: "pi_ai",
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
          catalogCandidateId: "pi/openai:gpt-4o-mini",
        },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "resource_conflict" });
    } finally {
      await harness.close();
    }
  });

  it("creates a Pi Model Profile from a server-resolved catalog Candidate", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => ({
          state: "fresh",
          models: [{ id: "gpt-4.1-mini", owner: "openai" }],
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
          slug: "catalog-openai",
          displayName: "Catalog OpenAI",
          driverId: "pi/openai",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
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

      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "catalog-gpt-mini",
          displayName: "Catalog GPT Mini",
          connectionRevisionId,
          catalogCandidateId: "pi/openai:gpt-4.1-mini",
          maxInputTokens: 65_536,
          contextWindowSource: "operator",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        revisions: [expect.objectContaining({
          providerModelId: "gpt-4.1-mini",
          catalogCandidateId: "pi/openai:gpt-4.1-mini",
          invocationProtocol: "pi_ai",
          maxInputTokens: 65_536,
          contextWindowSource: "operator",
        })],
      });
      expect(harness.modelRegistry.getProfile("catalog-gpt-mini" as never))
        .toMatchObject({
          revisions: [expect.objectContaining({
            piRuntime: expect.objectContaining({
              kind: "pi_ai",
              piVersion: "0.73.1",
              driverId: "pi/openai",
              modelId: "gpt-4.1-mini",
              api: expect.any(String),
            }),
          })],
        });

      for (const [slug, catalogCandidateId, code] of [
        ["unknown-candidate", "pi/openai:not-in-catalog", "invalid_model_profile"],
        ["mismatched-candidate", "pi/deepseek:deepseek-chat", "invalid_model_profile"],
        ["undiscovered-candidate", "pi/openai:gpt-4o-mini", "manual_model_entry_required"],
      ] as const) {
        const rejected = await harness.app.inject({
          method: "POST",
          url: "/v1/admin/model-profiles",
          remoteAddress: "127.0.0.1",
          headers: adminHeaders,
          payload: {
            slug,
            displayName: slug,
            connectionRevisionId,
            catalogCandidateId,
          },
        });
        expect(rejected.statusCode).toBe(422);
        expect(rejected.json()).toMatchObject({ code });
      }
      expect(harness.modelRegistry.listProfiles()).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ profileId: "unknown-candidate" }),
          expect.objectContaining({ profileId: "mismatched-candidate" }),
          expect.objectContaining({ profileId: "undiscovered-candidate" }),
        ]),
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a catalog Candidate when an inconsistent native Connection has no bearer credential", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => ({
          state: "fresh",
          models: [{ id: "gpt-4.1-mini", owner: "openai" }],
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
          slug: "inconsistent-native-auth",
          displayName: "Inconsistent Native Auth",
          driverId: "pi/openai",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
        },
      });
      expect(connection.statusCode).toBe(201);
      const connectionRevisionId = connection.json().revisions[0].revisionId as string;
      harness.connection.db.exec(
        "DROP TRIGGER provider_connection_revisions_content_immutable",
      );
      harness.connection.db.prepare(
        "UPDATE provider_connection_revisions SET auth_json = ? WHERE revision_id = ?",
      ).run('{"type":"none"}', connectionRevisionId);
      const discovery = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(discovery.statusCode).toBe(200);

      const profile = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "inconsistent-native-profile",
          displayName: "Inconsistent Native Profile",
          connectionRevisionId,
          catalogCandidateId: "pi/openai:gpt-4.1-mini",
        },
      });

      expect(profile.statusCode).toBe(422);
      expect(profile.json()).toMatchObject({ code: "invalid_model_profile" });
      expect(harness.modelRegistry.listProfiles()).not.toContainEqual(
        expect.objectContaining({ profileId: "inconsistent-native-profile" }),
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects the manual Model Profile shape for a native Driver", async () => {
    const harness = await startTestApp({
      modelDiscovery: {
        discover: async () => ({
          state: "fresh",
          models: [{ id: "gpt-4.1-mini" }],
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
          slug: "strict-native",
          displayName: "Strict Native",
          driverId: "pi/openai",
          auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
        },
      });
      const connectionRevisionId = connection.json().revisions[0].revisionId as string;
      await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });

      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "forbidden-native-manual",
          displayName: "Forbidden Native Manual",
          connectionRevisionId,
          modelId: "gpt-4.1-mini",
          protocol: "responses",
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_model_profile" });
      expect(harness.modelRegistry.listProfiles()).not.toContainEqual(
        expect.objectContaining({ profileId: "forbidden-native-manual" }),
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a client-supplied Pi invocation instead of persisting it", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "forged-pi-profile",
          displayName: "Forged Pi Profile",
          connectionRevisionId: "pcr_forged",
          catalogCandidateId: "pi/openai:gpt-4.1-mini",
          invocation: { kind: "pi_ai", api: "made-up-api" },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
      expect(harness.modelRegistry.listProfiles()).not.toContainEqual(
        expect.objectContaining({ profileId: "forged-pi-profile" }),
      );
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
      expect(assumed.json().revisions[0]).not.toHaveProperty("catalogCandidateId");
      expect(harness.modelRegistry.getProfile("manual-profile" as never)).toMatchObject({
        revisions: [expect.objectContaining({
          piRuntime: {
            kind: "pi_ai",
            piVersion: "0.73.1",
            driverId: "pi/openai-compatible",
            catalogProviderId: "openai-compatible",
            api: "openai-completions",
            modelId: "custom-model",
            contextWindow: 32_768,
            compatibility: {},
          },
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
      expect(operator.json().revisions[0]).not.toHaveProperty("catalogCandidateId");
      expect(harness.modelRegistry.getProfile("operator-profile" as never)).toMatchObject({
        revisions: [expect.objectContaining({
          piRuntime: {
            kind: "pi_ai",
            piVersion: "0.73.1",
            driverId: "pi/openai-compatible",
            catalogProviderId: "openai-compatible",
            api: "openai-responses",
            modelId: "custom-model",
            contextWindow: 12_345,
            compatibility: {},
          },
        })],
      });
    } finally {
      await harness.close();
    }
  });

  it("returns an asynchronous Verification operation for an exact draft revision", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "verification");
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profile.profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: profile.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        verificationId: expect.any(String),
        profileRevisionId: profile.profileRevisionId,
        capabilityBaseline: "text_and_single_tool_call_v1",
        status: "queued",
        recordRevision: 0,
        operationUrl: expect.stringMatching(/^\/v1\/admin\/model-verifications\/ver_/),
      });
    } finally {
      await harness.close();
    }
  });

  it("polls Verification state without exposing worker lease internals", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "polling");
      const queued = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profile.profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: profile.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      const operation = queued.json() as { verificationId: string; operationUrl: string };

      const response = await harness.app.inject({
        method: "GET",
        url: operation.operationUrl,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        verificationId: operation.verificationId,
        profileRevisionId: profile.profileRevisionId,
        capabilityBaseline: "text_and_single_tool_call_v1",
        status: "queued",
        resultCode: null,
        safeStatus: null,
        capabilities: [],
        traceId: expect.any(String),
        recordRevision: 0,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
        cancellationRequestedAt: null,
        fallbackProfileRevisionId: null,
        fallbackVerificationId: null,
      });
      expect(response.payload).not.toContain("leaseOwner");
      expect(response.payload).not.toContain("leaseExpiresAt");
    } finally {
      await harness.close();
    }
  });

  it("rejects a persisted lifecycle code from Verification projection", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "closed-result");
      const queued = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profile.profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: profile.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      const operation = queued.json() as {
        verificationId: string;
        operationUrl: string;
      };
      harness.connection.db.prepare(
        `UPDATE model_verifications
         SET state = 'failed', result_code = 'revision_conflict'
         WHERE verification_id = ?`,
      ).run(operation.verificationId);

      const response = await harness.app.inject({
        method: "GET",
        url: operation.operationUrl,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error" });
      expect(response.payload).not.toContain("revision_conflict");
    } finally {
      await harness.close();
    }
  });

  it("cancels queued Verification history with its own optimistic revision", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "cancel");
      const queued = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profile.profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: profile.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      const operation = queued.json() as { verificationId: string; operationUrl: string };
      const cancelled = await harness.app.inject({
        method: "POST",
        url: `${operation.operationUrl}/cancel`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });

      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        verificationId: operation.verificationId,
        status: "cancelled",
        recordRevision: 1,
        cancellationRequestedAt: "2026-08-07T00:00:00.000Z",
      });

      const stale = await harness.app.inject({
        method: "POST",
        url: `${operation.operationUrl}/cancel`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "revision_conflict" });
    } finally {
      await harness.close();
    }
  });

  it("requires ordered explicit promotion and never rebinds existing Agents", async () => {
    const harness = await startTestApp();
    try {
      const before = harness.modelRegistry.getAssignment("primary" as never);
      const profile = await createDraftProfile(harness, "promotion");
      const queued = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profile.profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          expectedRevision: profile.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      passQueuedVerification(harness, queued.json().verificationId as string);

      const profileFirst = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profiles/${profile.profileId}/promotions`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          profileRevisionId: profile.profileRevisionId,
          expectedRevision: 1,
        },
      });
      expect(profileFirst.statusCode).toBe(422);
      expect(profileFirst.json()).toMatchObject({ code: "connection_revision_not_active" });

      const promotedConnection = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connections/${profile.connectionId}/promotions`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          connectionRevisionId: profile.connectionRevisionId,
          expectedRevision: 1,
        },
      });
      expect(promotedConnection.statusCode).toBe(200);
      expect(promotedConnection.json()).toMatchObject({
        activeRevisionId: profile.connectionRevisionId,
        recordRevision: 2,
      });

      const promotedProfile = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profiles/${profile.profileId}/promotions`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          profileRevisionId: profile.profileRevisionId,
          expectedRevision: 1,
        },
      });
      expect(promotedProfile.statusCode).toBe(200);
      expect(promotedProfile.json()).toMatchObject({
        activeRevisionId: profile.profileRevisionId,
        recordRevision: 2,
      });
      expect(harness.modelRegistry.getAssignment("primary" as never)).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("retires Profiles and Connections without breaking retained assignments", async () => {
    const harness = await startTestApp();
    try {
      const before = harness.modelRegistry.getAssignment("primary" as never);
      const retiredProfile = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles/test-chat/retirement",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 2 },
      });
      expect(retiredProfile.statusCode).toBe(200);
      expect(retiredProfile.json()).toMatchObject({
        profileId: "test-chat",
        recordRevision: 3,
        retiredAt: "2026-08-07T00:00:00.000Z",
        revisions: [expect.objectContaining({ state: "retired" })],
      });

      const stale = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles/test-chat/retirement",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 2 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "revision_conflict" });

      const retiredConnection = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/test-chat/retirement",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 2 },
      });
      expect(retiredConnection.statusCode).toBe(200);
      expect(retiredConnection.json()).toMatchObject({
        connectionId: "test-chat",
        recordRevision: 3,
        retiredAt: "2026-08-07T00:00:00.000Z",
        revisions: [expect.objectContaining({ state: "retired" })],
      });
      expect(harness.modelRegistry.getAssignment("primary" as never)).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("requires separate confirmation before purging unused registry resources", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "purge");
      const unconfirmed = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profiles/${profile.profileId}/purge`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0 },
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect(unconfirmed.json()).toMatchObject({ code: "invalid_request" });
      expect(harness.modelRegistry.getProfile(profile.profileId as never).profileId)
        .toBe(profile.profileId);

      const purgedProfile = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profiles/${profile.profileId}/purge`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 0, confirm: true },
      });
      expect(purgedProfile.statusCode).toBe(204);

      const purgedConnection = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connections/${profile.connectionId}/purge`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 1, confirm: true },
      });
      expect(purgedConnection.statusCode).toBe(204);
      expect(() => harness.modelRegistry.getProfile(profile.profileId as never))
        .toThrowError("model_profile_not_found");
      expect(() => harness.modelRegistry.getConnection(profile.connectionId as never))
        .toThrowError("provider_connection_not_found");
    } finally {
      await harness.close();
    }
  });

  it("returns only safe owner categories when a Profile purge is blocked", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles/test-chat/purge",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 2, confirm: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        code: "resource_in_use",
        detail: "The request could not be completed.",
        traceId: expect.any(String),
        ownerCategories: ["model_assignment"],
      });
      expect(response.payload).not.toContain("primary");
      expect(response.payload).not.toContain("mpr_test-chat");
      expect(harness.modelRegistry.getProfile("test-chat" as never).recordRevision)
        .toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("returns only safe owner categories when a Connection purge is blocked", async () => {
    const harness = await startTestApp();
    try {
      const profile = await createDraftProfile(harness, "in-use-connection");
      const response = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connections/${profile.connectionId}/purge`,
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: { expectedRevision: 1, confirm: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "resource_in_use",
        ownerCategories: ["model_profile"],
      });
      expect(response.payload).not.toContain(profile.profileId);
      expect(response.payload).not.toContain(profile.profileRevisionId);
      expect(harness.modelRegistry.getConnection(profile.connectionId as never).recordRevision)
        .toBe(1);
    } finally {
      await harness.close();
    }
  });
});

async function createDraftProfile(
  harness: Awaited<ReturnType<typeof startTestApp>>,
  suffix: string,
): Promise<{
  connectionId: string;
  connectionRevisionId: string;
  profileId: string;
  profileRevisionId: string;
  recordRevision: number;
}> {
  const connection = await harness.app.inject({
    method: "POST",
    url: "/v1/admin/provider-connections",
    remoteAddress: "127.0.0.1",
    headers: adminHeaders,
    payload: {
      slug: `${suffix}-provider`,
      displayName: `${suffix} Provider`,
      kind: "openai_compatible",
      baseUrl: `https://${suffix}.example.test/v1`,
      auth: { type: "none" },
    },
  });
  expect(connection.statusCode).toBe(201);
  const connectionRevisionId = connection.json().revisions[0].revisionId as string;
  const discovery = await harness.app.inject({
    method: "POST",
    url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
    remoteAddress: "127.0.0.1",
    headers: adminHeaders,
    payload: { expectedRevision: 0 },
  });
  expect(discovery.statusCode).toBe(200);
  const profile = await harness.app.inject({
    method: "POST",
    url: "/v1/admin/model-profiles",
    remoteAddress: "127.0.0.1",
    headers: adminHeaders,
    payload: {
      slug: `${suffix}-profile`,
      displayName: `${suffix} Profile`,
      connectionRevisionId,
      modelId: `${suffix}-model`,
      protocol: "responses",
      maxInputTokens: 32_768,
      contextWindowSource: "operator",
      manualEntryAcknowledged: true,
    },
  });
  expect(profile.statusCode).toBe(201);
  return {
    connectionId: `${suffix}-provider`,
    connectionRevisionId,
    profileId: `${suffix}-profile`,
    profileRevisionId: profile.json().revisions[0].revisionId as string,
    recordRevision: profile.json().recordRevision as number,
  };
}

function passQueuedVerification(
  harness: Awaited<ReturnType<typeof startTestApp>>,
  verificationId: string,
): void {
  const now = harness.clock.now();
  const leaseOwner = "http-model-control-test";
  const claimed = harness.modelRegistry.claimVerification({
    leaseOwner,
    now,
    leaseUntil: new Date(now.getTime() + 60_000),
  });
  expect(claimed?.verificationId).toBe(verificationId);
  harness.modelRegistry.beginVerificationAttempt({
    verificationId: verificationId as never,
    leaseOwner,
    now: new Date(now.getTime() + 1_000),
  });
  harness.modelRegistry.completeVerification({
    verificationId: verificationId as never,
    leaseOwner,
    outcome: "passed",
    capabilities: ["streaming_text", "single_tool_call"],
    eventId: `mre_http_${verificationId}` as never,
    traceId: `complete-${verificationId}`,
    now: new Date(now.getTime() + 2_000),
  });
}
