import { describe, expect, it } from "vitest";

import type { CatalogService } from "../../src/config/catalog-service.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";

import { startTestApp } from "../helpers/start-test-app.js";

describe("HTTP authentication", () => {
  it("leaves only health and readiness unauthenticated", async () => {
    const harness = await startTestApp();
    try {
      expect((await harness.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await harness.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);

      const response = await harness.app.inject({ method: "GET", url: "/v1/agents" });
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        code: "unauthorized",
        traceId: expect.any(String),
      });
    } finally {
      await harness.close();
    }
  });

  it("returns the same generic Problem Detail for missing, malformed, duplicate, and wrong credentials", async () => {
    const harness = await startTestApp();
    try {
      const credentials = [
        undefined,
        "Basic test-token",
        "Bearer wrong-token",
        "Bearer test-token trailing",
      ] as const;
      for (const authorization of credentials) {
        const response = await harness.app.inject({
          method: "GET",
          url: "/v1/agents",
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.json()).toEqual({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "unauthorized",
          detail: "Authentication is required.",
          traceId: expect.any(String),
        });
      }
      const duplicate = await harness.app.inject({
        method: "GET",
        url: "/v1/agents",
        headers: { authorization: ["Bearer test-token", "Bearer test-token"] as never },
      });
      expect(duplicate.statusCode).toBe(401);
      expect(duplicate.json()).toMatchObject({ code: "unauthorized" });
    } finally {
      await harness.close();
    }
  });

  it("maps malformed JSON to a redacted 400 Problem Detail", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "request-0001",
        },
        payload: "{\"secret\":",
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ status: 400, code: "invalid_request" });
      expect(response.payload).not.toContain("secret");
      expect(response.payload).not.toContain("JSON");
    } finally {
      await harness.close();
    }
  });

  it("rejects a response that violates the registered Agent response schema", async () => {
    const catalog = {
      current: () => ({
        available: [{ id: "primary", revision: { revisionId: "revision-1", displayName: 42 } }],
        unavailable: [],
      }),
    } as unknown as CatalogService;
    const app = createHttpApp({ bearerToken: "test-token", catalog });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/agents",
        headers: { authorization: "Bearer test-token" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "internal_error" });
    } finally {
      await app.close();
    }
  });
});
