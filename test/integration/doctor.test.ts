import { describe, expect, it } from "vitest";

import type { DiagnosticReport } from "../../src/application/collect-diagnostics.js";
import { executeCli } from "../../src/interfaces/cli/main.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";

const report: DiagnosticReport = {
  checks: [
    { id: "config", status: "ok", detail: "config_readable" },
    { id: "permissions", status: "failed", detail: "project_permissions_unavailable" },
  ],
};

describe("doctor diagnostics", () => {
  it("serves the exact redacted report only through the Admin HTTP boundary", async () => {
    const app = createHttpApp({
      bearerToken: "run-token",
      adminToken: "admin-token",
      diagnostics: async () => report,
    });
    try {
      const denied = await app.inject({ method: "GET", url: "/v1/admin/diagnostics", headers: { authorization: "Bearer run-token" } });
      const allowed = await app.inject({ method: "GET", url: "/v1/admin/diagnostics", headers: { authorization: "Bearer admin-token" } });
      expect(denied.statusCode).toBe(401);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual(report);
    } finally { await app.close(); }
  });

  it("derives human and JSON doctor output from the same Admin report", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(`${new URL(String(input)).pathname}:${new Headers(init?.headers).get("authorization")}`);
      return Response.json(report);
    };
    const json: string[] = [];
    const human: string[] = [];

    await expect(executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token", "--json"], { fetcher, write: (line) => json.push(line) })).resolves.toBe(0);
    await expect(executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token"], { fetcher, write: (line) => human.push(line) })).resolves.toBe(0);

    expect(JSON.parse(json[0]!)).toEqual(report);
    expect(human.join("\n")).toContain("config: ok (config_readable)");
    expect(human.join("\n")).toContain("permissions: failed (project_permissions_unavailable)");
    expect(calls).toEqual(["/v1/admin/diagnostics:Bearer admin-token", "/v1/admin/diagnostics:Bearer admin-token"]);
  });
});
