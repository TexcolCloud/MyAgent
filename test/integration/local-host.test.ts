import type { BootstrappedService, BootstrapOptions } from "../../src/bootstrap.js";
import { runLocalHost } from "../../src/interfaces/local/local-host.js";
import type { RunWorkbenchOptions } from "../../src/interfaces/tui/workbench.js";
import { describe, expect, it, vi } from "vitest";

describe("runLocalHost", () => {
  it("owns one loopback service and supplies its URL with distinct CSPRNG credentials to the TUI", async () => {
    const shutdown = vi.fn(async () => undefined);
    const bootstrapService = vi.fn(async (
      configPath: string,
      options: BootstrapOptions = {},
    ): Promise<BootstrappedService> => {
      expect(configPath).toBe("C:/project/.myagent/myagent.yaml");
      expect(options.listen).toEqual({ host: "127.0.0.1", port: 0 });
      expect(options.signals).toBe(false);
      expect(options.auth).toBeDefined();
      expect(Object.isFrozen(options.auth)).toBe(true);
      expect(options.auth?.bearerToken).not.toBe(options.auth?.adminToken);
      expect(options.auth?.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(options.auth?.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return { url: "http://127.0.0.1:49152", shutdown };
    });
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const url = new URL(String(input));
      if (url.pathname === "/v1/runs") {
        return Response.json({ runs: [{ runId: "run_1", status: "waiting_approval" }] });
      }
      if (url.pathname === "/v1/approvals") {
        return Response.json({ approvals: [approval("apr_1"), approval("apr_2")] });
      }
      if (url.pathname === "/v1/admin/model-profiles") {
        return Response.json({ profiles: [] });
      }
      return Response.json({ agents: [], unavailable: [] });
    }) as typeof fetch;
    const runTui = vi.fn(async (options: RunWorkbenchOptions) => {
      await options.client.listAgents();
      await options.client.listModelProfiles();
      await expect(options.beforeExit?.()).resolves.toEqual({
        activeRuns: [{ runId: "run_1", status: "waiting_approval" }],
        pendingApprovalCount: 2,
      });
      return 23;
    });

    try {
      await expect(runLocalHost({
        configPath: "C:/project/.myagent/myagent.yaml",
        dependencies: { bootstrapService, runTui },
      })).resolves.toBe(23);
    } finally {
      globalThis.fetch = previousFetch;
    }

    expect(bootstrapService).toHaveBeenCalledTimes(1);
    expect(runTui).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      expect.objectContaining({ url: "http://127.0.0.1:49152/v1/agents" }),
      expect.objectContaining({ url: "http://127.0.0.1:49152/v1/admin/model-profiles" }),
      expect.objectContaining({ url: "http://127.0.0.1:49152/v1/runs?state=active" }),
      expect.objectContaining({ url: "http://127.0.0.1:49152/v1/approvals?status=pending" }),
    ]);
    expect(requests[0]?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u);
    expect(requests[1]?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u);
    expect(requests[0]?.authorization).not.toBe(requests[1]?.authorization);
    expect(requests[2]?.authorization).toBe(requests[0]?.authorization);
    expect(requests[3]?.authorization).toBe(requests[0]?.authorization);
  });

  it("shuts down exactly once when the TUI rejects", async () => {
    const shutdown = vi.fn(async () => undefined);
    const tuiError = new Error("tui_failed");
    const bootstrapService = vi.fn(async (): Promise<BootstrappedService> => ({
      url: "http://127.0.0.1:49152",
      shutdown,
    }));
    const runTui = vi.fn(async (): Promise<number> => { throw tuiError; });

    await expect(runLocalHost({
      configPath: "C:/project/.myagent/myagent.yaml",
      dependencies: { bootstrapService, runTui },
    })).rejects.toBe(tuiError);

    expect(bootstrapService).toHaveBeenCalledTimes(1);
    expect(runTui).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("leaves startup cleanup to bootstrap when startup rejects", async () => {
    const startupError = new Error("startup_failed");
    const bootstrapService = vi.fn(async (): Promise<BootstrappedService> => {
      throw startupError;
    });
    const runTui = vi.fn(async (): Promise<number> => 0);

    await expect(runLocalHost({
      configPath: "C:/project/.myagent/myagent.yaml",
      dependencies: { bootstrapService, runTui },
    })).rejects.toBe(startupError);

    expect(bootstrapService).toHaveBeenCalledTimes(1);
    expect(runTui).not.toHaveBeenCalled();
  });
});

function approval(approvalId: string) {
  return {
    approvalId,
    runId: "run_1",
    toolCallId: `tool_${approvalId}`,
    state: "pending",
    toolName: "write_file",
    arguments: {},
    expiresAt: "2026-08-13T00:00:00.000Z",
  };
}
