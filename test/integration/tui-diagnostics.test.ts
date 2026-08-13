import { describe, expect, it } from "vitest";

import { DiagnosticsScreen } from "../../src/interfaces/tui/screens/diagnostics.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("TUI diagnostics", () => {
  it("loads the typed Admin diagnostic report without local filesystem access", async () => {
    const paths: string[] = [];
    const client = new TuiClient({
      runToken: "run-token",
      adminToken: "admin-token",
      fetcher: async (input, init) => {
        paths.push(`${new URL(String(input)).pathname}:${new Headers(init?.headers).get("authorization")}`);
        return Response.json({ checks: [
          { id: "config", status: "ok", detail: "config_readable" },
          { id: "permissions", status: "ok", detail: "project_permissions_ok" },
          { id: "sqlite", status: "ok", detail: "sqlite_migrations_current" },
          { id: "secrets", status: "ok", detail: "secret_references_resolved" },
          { id: "workers", status: "ok", detail: "worker_ready" },
          { id: "gateway", status: "ok", detail: "provider_gateway_available" },
          { id: "tty", status: "ok", detail: "interactive_tty_available" },
          { id: "binding", status: "ok", detail: "loopback_binding" },
        ] });
      },
    });
    const screen = new DiagnosticsScreen({ client });

    await screen.load();

    expect(paths).toEqual(["/v1/admin/diagnostics:Bearer admin-token"]);
    expect(screen.render(120).join("\n")).toContain("config: ok (config_readable)");
  });
});
