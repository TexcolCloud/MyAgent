import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import { executeCli } from "../../src/interfaces/cli/main.js";

describe("CLI HTTP boundary", () => {
  it("validates config locally without an HTTP client", async () => {
    const fetcher = vi.fn();
    const write = vi.fn();
    const configPath = fileURLToPath(new URL("../fixtures/config/valid/myagent.yaml", import.meta.url));

    await executeCli(["config", "validate", "--config", configPath], { fetcher, write });

    expect(fetcher).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("primary"));
  });

  it("sends operational commands through the authenticated HTTP client", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({ authorization: "Bearer operator-token" });
      if (url.pathname === "/v1/runs") {
        expect(init?.headers).toMatchObject({ "idempotency-key": expect.any(String) });
        return jsonResponse({ runId: "run-cli-1", status: "queued", eventsUrl: "/v1/runs/run-cli-1/events" }, 202);
      }
      if (url.pathname === "/v1/backups") return jsonResponse({ destination: "C:/backup", database: "kernel.db", fileCount: 2, activeRevisionIds: [] }, 201);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ agents: [{ id: "primary", revisionId: "rev-1", displayName: "Primary" }], unavailable: [] });
    });
    const write = vi.fn();
    const options = { environment: { MYAGENT_API_URL: "http://127.0.0.1:8787", MYAGENT_BEARER_TOKEN: "operator-token" }, fetcher, write };

    await executeCli(["agents", "list"], options);
    await executeCli(["run", "create", "--agent", "primary", "--session", "cli:test", "--text", "hello"], options);
    await executeCli(["config", "reload"], options);
    await executeCli(["run", "cancel", "run-cli-1"], options);
    await executeCli(["approvals", "list"], options);
    await executeCli(["approvals", "approve", "approval-cli-1"], options);
    await executeCli(["approvals", "deny", "approval-cli-2"], options);
    await executeCli(["tools", "reconcile", "tool-cli-1", "--as", "succeeded"], options);
    await executeCli(["sessions", "list", "--agent", "primary", "--session", "cli:test"], options);
    await executeCli(["sessions", "delete", "session-cli-1"], options);
    await executeCli(["backup", "C:/backup"], options);

    expect(fetcher).toHaveBeenCalledTimes(11);
    expect(write).toHaveBeenCalledTimes(11);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("http://127.0.0.1:8787/v1/runs");
    expect(String(fetcher.mock.calls[10]?.[0])).toBe("http://127.0.0.1:8787/v1/backups");
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
