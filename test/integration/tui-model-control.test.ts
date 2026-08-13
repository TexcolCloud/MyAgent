import { describe, expect, it, vi } from "vitest";

import type { CliPrompt } from "../../src/interfaces/cli/commands/model-setup.js";
import type { ModelProfileResponse } from "../../src/interfaces/http/model-control-schemas.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";
import { ProfileScreen } from "../../src/interfaces/tui/screens/profiles.js";
import { AssignmentScreen } from "../../src/interfaces/tui/screens/assignments.js";
import { VerificationScreen } from "../../src/interfaces/tui/screens/verifications.js";

describe("TUI model control workflows", () => {
  it("requires verified immutable revisions before promotion or assignment and reviews exact capabilities", async () => {
    const profile = modelProfile();
    const promoteModelProfile = vi.fn(async () => profile);
    const inspector = new InspectorScreen();
    const screen = new ProfileScreen({
      client: profileClient({ promoteModelProfile }),
      inspector,
      promptFactory: () => prompt({ selects: ["mpr_verified"], confirms: [true] }),
    });
    await screen.load();

    screen.handleInput("p");
    await screen.settled();

    expect(promoteModelProfile).toHaveBeenCalledWith("profile-one", {
      profileRevisionId: "mpr_verified",
      expectedRevision: 2,
    });
    expect(inspector.render(100).join("\n")).toContain("Capabilities: streaming_text, single_tool_call");

    const assignModel = vi.fn(async () => ({
      agentId: "agent-one", state: "assigned" as const, modelProfileRevisionId: "mpr_verified",
      source: "explicit" as const, recordRevision: 1, updatedAt: "2026-08-13T00:00:00.000Z",
    }));
    const assignments = new AssignmentScreen({
      client: assignmentClient({ assignModel }),
      inspector,
      promptFactory: () => prompt({ selects: ["agent-one", "mpr_draft"], confirms: [true] }),
    });
    await assignments.load();
    assignments.handleInput("a");
    await assignments.settled();

    expect(assignModel).not.toHaveBeenCalled();
    expect(inspector.render(100).join("\n")).toContain("Verification required");
  });

  it("cancels the selected Verification with its own revision after explicit confirmation", async () => {
    const cancelModelVerification = vi.fn(async () => verification("cancelled", 4));
    const screen = new VerificationScreen({
      client: { verifyModel: vi.fn(), getModelVerification: vi.fn(), cancelModelVerification } as never,
      inspector: new InspectorScreen(),
      promptFactory: () => prompt({ confirms: [true] }),
    });
    (screen as unknown as { verification: unknown }).verification = verification("running", 3);

    screen.handleInput("x");
    await screen.settled();

    expect(cancelModelVerification).toHaveBeenCalledWith("ver_one", { expectedRevision: 3 });
    expect(screen.render(100).join("\n")).toContain("ver_one (cancelled)");
  });

  it("does not rewrite an existing Assignment when setting the default Profile", async () => {
    const getModelAssignment = vi.fn(async () => ({
      agentId: "agent-one", state: "assigned" as const, modelProfileRevisionId: "mpr_active",
      source: "explicit" as const, recordRevision: 7, updatedAt: "2026-08-13T00:00:00.000Z",
    }));
    const assignModel = vi.fn();
    const setDefaultModelProfile = vi.fn(async () => ({ state: "configured" as const, profileId: "profile-one", recordRevision: 2 }));
    const inspector = new InspectorScreen();
    const screen = new AssignmentScreen({
      client: assignmentClient({ getModelAssignment, assignModel, setDefaultModelProfile }), inspector,
      promptFactory: () => prompt({ selects: ["profile-one"], confirms: [true] }),
    });
    await screen.load();
    screen.handleInput("d");
    await screen.settled();

    expect(setDefaultModelProfile).toHaveBeenCalledWith({ profileId: "profile-one", expectedRevision: 0 });
    expect(assignModel).not.toHaveBeenCalled();
    expect(getModelAssignment).not.toHaveBeenCalled();
    expect(inspector.render(100).join("\n")).toContain("Existing Assignments are not rewritten.");
  });

  it("reviews retirement as preserving historical Runs before the mutation", async () => {
    let release: ((value: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => { release = resolve; });
    const retireModelProfile = vi.fn(async () => ({ ...modelProfile(), retiredAt: "2026-08-13T00:00:00.000Z" }));
    const inspector = new InspectorScreen();
    const screen = new ProfileScreen({ client: profileClient({ retireModelProfile }), inspector, promptFactory: () => prompt({ confirms: [confirmation] }) });
    await screen.load();
    screen.handleInput("x");
    await vi.waitFor(() => expect(inspector.render(100).join("\n")).toContain("Profile retirement"));
    expect(retireModelProfile).not.toHaveBeenCalled();
    release?.(true);
    await screen.settled();
    expect(retireModelProfile).toHaveBeenCalledWith("profile-one", { expectedRevision: 2 });
    expect(inspector.render(100).join("\n")).toContain("historical Runs remain unchanged");
  });
});

function profileClient(overrides: Record<string, unknown> = {}) {
  return {
    listModelProfiles: async () => ({ profiles: [{ profileId: "profile-one", displayName: "Profile One", activeRevisionId: "mpr_active", retiredAt: null }] }),
    getModelProfile: async () => modelProfile(),
    createModelProfile: async () => modelProfile(),
    promoteModelProfile: async () => modelProfile(),
    retireModelProfile: async () => modelProfile(),
    ...overrides,
  } as never;
}

function assignmentClient(overrides: Record<string, unknown> = {}) {
  return {
    listAgents: async () => ({ agents: [{ id: "agent-one", revisionId: "agent-rev", displayName: "Agent One" }], unavailable: [] }),
    listModelProfiles: async () => ({ profiles: [{ profileId: "profile-one", displayName: "Profile One", activeRevisionId: "mpr_active", retiredAt: null }] }),
    getModelProfile: async () => modelProfile(),
    getModelAssignment: async () => ({ agentId: "agent-one", state: "unassigned" as const, modelProfileRevisionId: null, source: null, recordRevision: null, updatedAt: null }),
    assignModel: async () => ({ agentId: "agent-one", state: "assigned" as const, modelProfileRevisionId: "mpr_verified", source: "explicit" as const, recordRevision: 1, updatedAt: "2026-08-13T00:00:00.000Z" }),
    getDefaultModelProfile: async () => ({ state: "unset" as const, profileId: null, recordRevision: null }),
    setDefaultModelProfile: async () => ({ state: "configured" as const, profileId: "profile-one", recordRevision: 1 }),
    ...overrides,
  } as never;
}

function modelProfile(): ModelProfileResponse {
  return {
    profileId: "profile-one", displayName: "Profile One", activeRevisionId: "mpr_active", retiredAt: null, recordRevision: 2,
    revisions: [
      revision("mpr_active", "active", ["streaming_text", "single_tool_call"]),
      revision("mpr_verified", "verified", ["streaming_text", "single_tool_call"]),
      revision("mpr_draft", "draft", []),
    ],
  };
}

function revision(revisionId: string, state: ModelProfileResponse["revisions"][number]["state"], verifiedCapabilities: ModelProfileResponse["revisions"][number]["verifiedCapabilities"]): ModelProfileResponse["revisions"][number] {
  return { revisionId, profileId: "profile-one", connectionRevisionId: "pcr_one", providerModelId: "model-one", invocationProtocol: "responses", maxInputTokens: 128_000, contextWindowSource: "preset", capabilityBaseline: "text_and_single_tool_call_v1", verifiedCapabilities, state, createdAt: "2026-08-13T00:00:00.000Z" };
}

function prompt(values: { readonly selects?: string[]; readonly confirms?: boolean[] }): CliPrompt {
  return { select: async <T extends string>() => values.selects?.shift() as T, selectChoice: async <T extends string>() => values.selects?.shift() as T, input: async () => "", secret: async () => "", confirm: async () => values.confirms?.shift() ?? false };
}

function verification(status: "queued" | "running" | "passed" | "failed" | "cancelled", recordRevision: number) {
  return { verificationId: "ver_one", profileRevisionId: "mpr_verified", capabilityBaseline: "text_and_single_tool_call_v1" as const, status, resultCode: null, safeStatus: null, capabilities: [], traceId: "trace_one", recordRevision, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", cancellationRequestedAt: null, fallbackProfileRevisionId: null, fallbackVerificationId: null };
}
