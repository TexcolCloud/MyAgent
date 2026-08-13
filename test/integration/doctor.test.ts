import { describe, expect, it } from "vitest";

import type { DiagnosticReport } from "../../src/application/collect-diagnostics.js";
import { executeCli } from "../../src/interfaces/cli/main.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import { diagnosticsResponseSchema } from "../../src/interfaces/http/schemas.js";

const report: DiagnosticReport = {
  checks: [
    { id: "config", status: "ok", detail: "config_readable" },
    { id: "permissions", status: "failed", detail: "project_permissions_unavailable" },
    { id: "sqlite", status: "ok", detail: "sqlite_migrations_current" },
    { id: "secrets", status: "ok", detail: "secret_references_resolved" },
    { id: "workers", status: "ok", detail: "worker_ready" },
    { id: "gateway", status: "ok", detail: "provider_gateway_available" },
    { id: "tty", status: "ok", detail: "interactive_tty_available" },
    { id: "binding", status: "ok", detail: "loopback_binding" },
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

    await expect(executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token", "--json"], { fetcher, write: (line) => json.push(line) })).resolves.toBe(1);
    await expect(executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token"], { fetcher, write: (line) => human.push(line) })).resolves.toBe(1);

    expect(JSON.parse(json[0]!)).toEqual(report);
    expect(human.join("\n")).toContain("config: ok (config_readable)");
    expect(human.join("\n")).toContain("permissions: failed (project_permissions_unavailable)");
    expect(calls).toEqual(["/v1/admin/diagnostics:Bearer admin-token", "/v1/admin/diagnostics:Bearer admin-token"]);
  });

  it("rejects malformed diagnostic reports before doctor output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const malformed = { checks: [{ id: "config", status: "ok", detail: "secret-value" }] };
    const exitCode = await executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token", "--json"], {
      fetcher: async () => Response.json(malformed),
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(7);
    expect(JSON.parse(stdout[0]!)).toEqual({
      code: "invalid_diagnostic_response",
      detail: "The service returned an invalid diagnostic report.",
      traceId: "cli",
    });
    expect(stdout.join("\n")).not.toContain("secret-value");
    expect(stderr.join("\n")).not.toContain("secret-value");
  });

  it("reports malformed human responses as a safe protocol error on stderr", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeCli(["doctor", "--api-url", "http://127.0.0.1:8787", "--admin-token", "admin-token"], {
      fetcher: async () => Response.json({ checks: [], raw: "secret-value" }),
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["invalid_diagnostic_response: The service returned an invalid diagnostic report. (traceId: cli)"]);
    expect(stderr.join("\n")).not.toContain("secret-value");
  });

  it("accepts only the eight ordered fixed diagnostic checks", () => {
    expect(diagnosticsResponseSchema.safeParse(report).success).toBe(true);
    expect(diagnosticsResponseSchema.safeParse({ checks: [...report.checks, report.checks[0]] }).success).toBe(false);
    expect(diagnosticsResponseSchema.safeParse({ checks: report.checks.slice(1) }).success).toBe(false);
    expect(diagnosticsResponseSchema.safeParse({ checks: [{ ...report.checks[0], detail: "secret-value" }, ...report.checks.slice(1) ] }).success).toBe(false);
  });
});
