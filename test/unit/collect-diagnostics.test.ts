import { describe, expect, it, vi } from "vitest";

import {
  activeSecretReferencesResolvable,
  collectDiagnostics,
  projectStatePermissionsAvailable,
} from "../../src/application/collect-diagnostics.js";

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

  it("checks an explicit project state root plus an external SQLite parent and file", async () => {
    const access = vi.fn(async (target: string) => {
      if (target.endsWith("state.sqlite")) throw new Error("denied");
    });

    await expect(projectStatePermissionsAvailable("D:\\repo\\.myagent", "E:\\database\\state.sqlite", access)).resolves.toBe(false);
    expect(access).toHaveBeenCalledWith("D:\\repo\\.myagent", expect.any(Number));
    expect(access).toHaveBeenCalledWith("E:\\database", expect.any(Number));
    expect(access).toHaveBeenCalledWith("E:\\database\\state.sqlite", expect.any(Number));
  });

  it("checks post-boot active durable environment and managed Secret references", () => {
    const assertManaged = vi.fn((versionId: string) => {
      if (versionId === "msv_missing") throw new Error("missing");
    });
    const registry = {
      listConnections: () => [{
        activeRevisionId: "pcr_active",
        revisions: [{ revisionId: "pcr_active", auth: { type: "bearer" as const, secret: { managedSecretVersionId: "msv_missing" } } }],
      }, {
        activeRevisionId: "pcr_env",
        revisions: [{ revisionId: "pcr_env", auth: { type: "bearer" as const, secret: { fromEnvironment: "POST_BOOT_KEY" } } }],
      }],
      listProfiles: () => [{
        activeRevisionId: "mpr_active",
        revisions: [{ revisionId: "mpr_active", connectionRevisionId: "pcr_active" }],
      }],
    };

    expect(activeSecretReferencesResolvable(registry, { POST_BOOT_KEY: "present" }, assertManaged)).toBe(false);
    expect(assertManaged).toHaveBeenCalledExactlyOnceWith("msv_missing");
  });

  it("treats an empty environment Secret value as unresolved", () => {
    const registry = {
      listConnections: () => [{
        activeRevisionId: "pcr_env",
        revisions: [{ revisionId: "pcr_env", auth: { type: "bearer" as const, secret: { fromEnvironment: "EMPTY_KEY" } } }],
      }],
      listProfiles: () => [],
    };

    expect(activeSecretReferencesResolvable(registry, { EMPTY_KEY: "" }, vi.fn())).toBe(false);
  });
});
