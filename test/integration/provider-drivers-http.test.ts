import { describe, expect, it } from "vitest";

import { startTestApp } from "../helpers/start-test-app.js";

const adminHeaders = { authorization: "Bearer test-admin-token" } as const;

describe("HTTP provider Driver catalog", () => {
  it("lists safe Pi catalog candidates separately from remote discovery", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/v1/admin/provider-drivers",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        piVersion: "0.73.1",
        drivers: expect.arrayContaining([
          expect.objectContaining({
            driverId: "pi/openai",
            candidates: expect.arrayContaining([
              expect.objectContaining({
                candidateId: "pi/openai:gpt-4.1-mini",
                modelId: "gpt-4.1-mini",
                credentialSupport: "bearer",
              }),
            ]),
          }),
          expect.objectContaining({
            driverId: "pi/anthropic",
            candidates: expect.arrayContaining([
              expect.objectContaining({ credentialSupport: "unsupported" }),
            ]),
          }),
        ]),
      });
      expect(response.payload).not.toMatch(
        /"(?:api|baseUrl|headers|apiKey|secret|authorization)"/u,
      );
    } finally {
      await harness.close();
    }
  });

  it("blocks a native Driver whose credential headers the gateway cannot represent", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: adminHeaders,
        payload: {
          slug: "unsupported-anthropic",
          displayName: "Unsupported Anthropic",
          driverId: "pi/anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: { type: "environment", fromEnvironment: "ANTHROPIC_API_KEY" },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_provider_connection" });
      expect(harness.modelRegistry.listConnections()).not.toContainEqual(
        expect.objectContaining({ connectionId: "unsupported-anthropic" }),
      );
    } finally {
      await harness.close();
    }
  });
});
