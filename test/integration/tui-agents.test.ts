import { describe, expect, it, vi } from "vitest";

import { CliHttpError } from "../../src/interfaces/cli/client.js";
import { AgentScreen } from "../../src/interfaces/tui/screens/agents.js";
import { TuiRevisionConflictError } from "../../src/interfaces/tui/tui-client.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";

describe("Agent TUI workflow", () => {
  it("shows a complete review before confirmed creation and assigns no model or Tool authority", async () => {
    let confirm: ((value: boolean) => void) | undefined;
    const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
    const createManagedAgent = vi.fn(async () => ({ catalogRevision: "catalog_2", agent: { id: "writer", displayName: "Writer", revisionId: "def_1", assignment: { state: "unassigned" as const } } }));
    const screen = new AgentScreen({ client: { listAgents: vi.fn(async () => ({ catalogRevision: "catalog_1", agents: [], unavailable: [] })), createManagedAgent }, inspector: new InspectorScreen(), promptFactory: () => ({ input: vi.fn().mockResolvedValueOnce("writer").mockResolvedValueOnce("Writer").mockResolvedValueOnce("./workspace").mockResolvedValueOnce("Write clearly."), secret: vi.fn(), select: vi.fn(), confirm: vi.fn(() => confirmed) }) });
    await screen.load();
    screen.handleInput("n");
    await vi.waitFor(() => expect(screen.render(100).join("\n")).toContain("Confirmation: required"));
    expect(screen.render(100).join("\n")).toContain("Policy rules: 0 (no Tool authority)");
    expect(screen.render(100).join("\n")).toContain("Model Assignment: unassigned");
    expect(createManagedAgent).not.toHaveBeenCalled();
    confirm?.(true);
    await screen.settled();
    expect(createManagedAgent).toHaveBeenCalledWith(expect.objectContaining({ expectedCatalogRevision: "catalog_1", policy: { rules: [] } }));
  });

  it("locks creation after conflict until explicit reload and never retries", async () => {
    const listAgents = vi.fn(async () => ({ catalogRevision: "catalog_1", agents: [], unavailable: [] }));
    const createManagedAgent = vi.fn(async () => { throw new TuiRevisionConflictError(new CliHttpError(409, "revision_conflict", "stale", "trace")); });
    const promptFactory = () => ({ input: vi.fn().mockResolvedValueOnce("writer").mockResolvedValueOnce("Writer").mockResolvedValueOnce("./workspace").mockResolvedValueOnce("Prompt"), secret: vi.fn(), select: vi.fn(), confirm: vi.fn(async () => true) });
    const screen = new AgentScreen({ client: { listAgents, createManagedAgent }, inspector: new InspectorScreen(), promptFactory });
    await screen.load(); screen.handleInput("n"); await screen.settled();
    expect(screen.render(100).join("\n")).toContain("Reload required");
    screen.handleInput("n"); await Promise.resolve(); expect(createManagedAgent).toHaveBeenCalledOnce();
    screen.handleInput("r"); await screen.settled(); expect(listAgents).toHaveBeenCalledTimes(2);
  });
});
