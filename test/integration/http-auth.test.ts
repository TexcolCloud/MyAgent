import { describe, expect, it } from "vitest";

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
});
