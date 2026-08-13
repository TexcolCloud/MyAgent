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
        return Response.json({ checks: [{ id: "config", status: "ok", detail: "config_readable" }] });
      },
    });
    const screen = new DiagnosticsScreen({ client });

    await screen.load();

    expect(paths).toEqual(["/v1/admin/diagnostics:Bearer admin-token"]);
    expect(screen.render(120).join("\n")).toContain("config: ok (config_readable)");
  });
});
