import { describe, expect, it } from "vitest";

import { startTestApp } from "../helpers/start-test-app.js";

const headers = { authorization: "Bearer test-token", "idempotency-key": "request-0001" };

describe("HTTP catalog and session routes", () => {
  it("lists Agents and rejects unknown Run properties", async () => {
    const harness = await startTestApp();
    try {
      const agents = await harness.app.inject({ method: "GET", url: "/v1/agents", headers });
      expect(agents.statusCode).toBe(200);
      expect(agents.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "primary" })]));
      const invalid = await harness.app.inject({ method: "POST", url: "/v1/runs", headers, payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" }, extra: true } });
      expect(invalid.statusCode).toBe(400);
    } finally { await harness.close(); }
  });

  it("returns only Session lifecycle metadata and deletes an idle Session", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({ method: "POST", url: "/v1/runs", headers, payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" } } });
      const sessionId = created.json().runId ? (await harness.app.inject({ method: "GET", url: `/v1/runs/${created.json().runId}`, headers })).json().sessionId : "";
      const listed = await harness.app.inject({ method: "GET", url: "/v1/sessions?agentId=primary&sessionKey=session:a", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions[0]).toMatchObject({ sessionId, agentId: "primary", sessionKey: "session:a" });
      expect(listed.json().sessions[0]).not.toHaveProperty("messages");
      expect((await harness.app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}`, headers })).statusCode).toBe(204);
    } finally { await harness.close(); }
  });
});
