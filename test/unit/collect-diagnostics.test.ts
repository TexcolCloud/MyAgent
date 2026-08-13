import { describe, expect, it, vi } from "vitest";

import { collectDiagnostics } from "../../src/application/collect-diagnostics.js";

describe("collectDiagnostics", () => {
  it("runs every read-only check independently and redacts thrown details", async () => {
    const probes = {
      config: vi.fn(async () => undefined),
      permissions: vi.fn(async () => { throw new Error("C:\\private\\myagent.yaml token=secret-value"); }),
      sqlite: vi.fn(async () => undefined),
      secrets: vi.fn(async () => { throw new Error("MYAGENT_SECRET=secret-value"); }),
      workers: vi.fn(async () => false),
      gateway: vi.fn(async () => true),
      tty: vi.fn(async () => false),
      binding: vi.fn(async () => true),
    };

    const report = await collectDiagnostics(probes);

    expect(report).toEqual({
      checks: [
        { id: "config", status: "ok", detail: "config_readable" },
        { id: "permissions", status: "failed", detail: "project_permissions_unavailable" },
        { id: "sqlite", status: "ok", detail: "sqlite_migrations_current" },
        { id: "secrets", status: "failed", detail: "secret_references_unavailable" },
        { id: "workers", status: "failed", detail: "worker_not_ready" },
        { id: "gateway", status: "ok", detail: "provider_gateway_available" },
        { id: "tty", status: "failed", detail: "interactive_tty_unavailable" },
        { id: "binding", status: "ok", detail: "loopback_binding" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("secret-value");
    for (const probe of Object.values(probes)) expect(probe).toHaveBeenCalledOnce();
  });
});
