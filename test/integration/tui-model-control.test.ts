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

  it("polls only the returned opaque Verification operation URL and allows explicit cancellation while polling", async () => {
    let releaseSleep: (() => void) | undefined;
    const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
    const getModelVerificationAt = vi.fn(async (operationUrl: string) => {
      expect(operationUrl).toBe("/v1/admin/operations/opaque-verification-status");
      return verification("running", 3);
    });
    const cancelModelVerification = vi.fn(async () => verification("cancelled", 4));
    const screen = new VerificationScreen({
      client: {
        verifyModel: vi.fn(async () => ({
          verificationId: "ver_one", profileRevisionId: "mpr_verified",
          capabilityBaseline: "text_and_single_tool_call_v1", status: "queued",
          recordRevision: 1, operationUrl: "/v1/admin/operations/opaque-verification-status",
        })),
        getModelVerificationAt,
        cancelModelVerification,
      } as never,
      inspector: new InspectorScreen(),
      promptFactory: () => prompt({ inputs: ["mpr_verified", "2"], confirms: [true] }),
      sleep: async () => await sleeping,
    });

    screen.handleInput("q");
    await vi.waitFor(() => expect(getModelVerificationAt).toHaveBeenCalledOnce());
    screen.handleInput("x");
    releaseSleep?.();
    await screen.settled();

    expect(cancelModelVerification).toHaveBeenCalledWith("ver_one", { expectedRevision: 3 });
    expect(screen.render(100).join("\n")).toContain("ver_one (cancelled)");
  });

  it("does not let an aborted in-flight poll overwrite successful cancellation", async () => {
    let releasePoll: ((value: ReturnType<typeof verification>) => void) | undefined;
    const deferredPoll = new Promise<ReturnType<typeof verification>>((resolve) => { releasePoll = resolve; });
    let markPollStarted: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve; });
    const screen = new VerificationScreen({
      client: {
        verifyModel: async () => ({
          verificationId: "ver_one", profileRevisionId: "mpr_verified",
          capabilityBaseline: "text_and_single_tool_call_v1", status: "queued",
          recordRevision: 1, operationUrl: "/v1/admin/operations/deferred",
        }),
        getModelVerificationAt: async () => { markPollStarted?.(); return await deferredPoll; },
        cancelModelVerification: async () => verification("cancelled", 4),
      } as never,
      inspector: new InspectorScreen(),
      promptFactory: () => prompt({ inputs: ["mpr_verified", "2"], confirms: [true] }),
    });

    screen.handleInput("q");
    await pollStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    (screen as unknown as { verification: unknown }).verification = verification("running", 3);
    screen.handleInput("x");
    await vi.waitFor(() => expect(screen.render(100).join("\n")).toContain("ver_one (cancelled)"));
    releasePoll?.(verification("running", 3));
    await screen.settled();

    expect(screen.render(100).join("\n")).toContain("ver_one (cancelled)");
    expect(screen.render(100).join("\n")).not.toContain("ver_one (running)");
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

  it("does not offer or accept legacy-trusted revisions for a new Agent Assignment", async () => {
    const selections: Array<{ readonly message: string; readonly choices: readonly unknown[] }> = [];
    const assignModel = vi.fn();
    const inspector = new InspectorScreen();
    const screen = new AssignmentScreen({
      client: assignmentClient({ assignModel }),
      inspector,
      promptFactory: () => prompt({ selects: ["agent-one", "mpr_legacy"], confirmations: [true], selections }),
    });
    await screen.load();

    screen.handleInput("a");
    await screen.settled();

    expect(selections.find(({ message }) => message === "Verified Profile revision")?.choices)
      .not.toContain("mpr_legacy");
    expect(assignModel).not.toHaveBeenCalled();
    expect(inspector.render(100).join("\n")).toContain("Verification required");
  });

  it("reviews retirement as preserving historical Runs before the mutation", async () => {
    let confirmationRequested = false;
    let release: (() => void) | undefined;
    const confirmation = new Promise<void>((resolve) => { release = resolve; });
    const retireModelProfile = vi.fn(async () => ({ ...modelProfile(), retiredAt: "2026-08-13T00:00:00.000Z" }));
    const inspector = new InspectorScreen();
    const screen = new ProfileScreen({ client: profileClient({ retireModelProfile }), inspector, promptFactory: () => ({
      ...prompt({}),
      confirm: async () => { confirmationRequested = true; await confirmation; return true; },
    }) });
    await screen.load();
    screen.handleInput("x");
    await vi.waitFor(() => expect(confirmationRequested).toBe(true));
    expect(retireModelProfile).not.toHaveBeenCalled();
    release?.();
    await screen.settled();
    expect(retireModelProfile).toHaveBeenCalledWith("profile-one", { expectedRevision: 2 });
    expect(inspector.render(100).join("\n")).toContain("historical Runs remain unchanged");
  });

  it("creates native-driver Profiles from a safe Catalog Candidate without manual acknowledgement", async () => {
    const createModelProfile = vi.fn(async () => modelProfile());
    const screen = new ProfileScreen({
      client: profileClient({
        createModelProfile,
        listProviderConnections: async () => ({ connections: [{ connectionId: "provider-one", displayName: "Provider One", activeRevisionId: "pcr_native", retiredAt: null }] }),
        getProviderConnection: async () => ({ providerDriver: "pi/openai", providerKind: "openai", revisions: [{ revisionId: "pcr_native" }] }),
        listProviderDrivers: async () => ({ piVersion: "0.73.1", drivers: [{ driverId: "pi/openai", candidates: [{ candidateId: "pi/openai:gpt-4.1-mini", displayName: "GPT-4.1 mini", modelId: "gpt-4.1-mini", credentialSupport: "bearer" }] }] }),
      }),
      inspector: new InspectorScreen(),
      promptFactory: () => prompt({ inputs: ["catalog-profile", "Catalog Profile"], selects: ["pcr_native", "pi/openai:gpt-4.1-mini"], confirms: [true] }),
    });
    await screen.load();
    screen.handleInput("n");
    await screen.settled();

    expect(createModelProfile).toHaveBeenCalledWith({
      slug: "catalog-profile",
      displayName: "Catalog Profile",
      connectionRevisionId: "pcr_native",
      catalogCandidateId: "pi/openai:gpt-4.1-mini",
    });
  });

  it("allows acknowledged manual creation for the custom OpenAI-compatible driver", async () => {
    const createModelProfile = vi.fn(async () => modelProfile());
    const listProviderDrivers = vi.fn(async () => ({ piVersion: "0.73.1" as const, drivers: [] }));
    const screen = new ProfileScreen({
      client: profileClient({
        createModelProfile,
        listProviderConnections: async () => ({ connections: [{ connectionId: "custom", displayName: "Custom", activeRevisionId: "pcr_custom", retiredAt: null }] }),
        getProviderConnection: async () => ({ providerDriver: "pi/openai-compatible", providerKind: "openai_compatible", revisions: [{ revisionId: "pcr_custom" }] }),
        listProviderDrivers,
      }),
      inspector: new InspectorScreen(),
      promptFactory: () => prompt({
        inputs: ["manual-profile", "Manual Profile", "custom-model"],
        selects: ["pcr_custom", "responses"],
        confirms: [true, true],
      }),
    });
    await screen.load();

    screen.handleInput("n");
    await screen.settled();

    expect(listProviderDrivers).not.toHaveBeenCalled();
    expect(createModelProfile).toHaveBeenCalledWith({
      slug: "manual-profile",
      displayName: "Manual Profile",
      connectionRevisionId: "pcr_custom",
      modelId: "custom-model",
      protocol: "responses",
      manualEntryAcknowledged: true,
    });
  });
});

function profileClient(overrides: Record<string, unknown> = {}) {
  return {
    listModelProfiles: async () => ({ profiles: [{ profileId: "profile-one", displayName: "Profile One", activeRevisionId: "mpr_active", retiredAt: null }] }),
    getModelProfile: async () => modelProfile(),
    createModelProfile: async () => modelProfile(),
    promoteModelProfile: async () => modelProfile(),
    retireModelProfile: async () => modelProfile(),
    listProviderConnections: async () => ({ connections: [] }),
    getProviderConnection: async () => ({ providerDriver: undefined, providerKind: "openai_compatible", revisions: [] }),
    listProviderDrivers: async () => ({ piVersion: "0.73.1", drivers: [] }),
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
      revision("mpr_legacy", "legacy_trusted", ["streaming_text", "single_tool_call"]),
      revision("mpr_draft", "draft", []),
    ],
  };
}

function revision(revisionId: string, state: ModelProfileResponse["revisions"][number]["state"], verifiedCapabilities: ModelProfileResponse["revisions"][number]["verifiedCapabilities"]): ModelProfileResponse["revisions"][number] {
  return { revisionId, profileId: "profile-one", connectionRevisionId: "pcr_one", providerModelId: "model-one", invocationProtocol: "responses", maxInputTokens: 128_000, contextWindowSource: "preset", capabilityBaseline: "text_and_single_tool_call_v1", verifiedCapabilities, state, createdAt: "2026-08-13T00:00:00.000Z" };
}

function prompt(values: { readonly selects?: string[]; readonly inputs?: string[]; readonly confirms?: boolean[]; readonly confirmations?: boolean[]; readonly selections?: Array<{ readonly message: string; readonly choices: readonly unknown[] }> }): CliPrompt {
  return {
    select: async <T extends string>(message: string, choices: readonly unknown[]) => { values.selections?.push({ message, choices }); return values.selects?.shift() as T; },
    selectChoice: async <T extends string>(message: string, choices: readonly unknown[]) => { values.selections?.push({ message, choices }); return values.selects?.shift() as T; },
    input: async () => values.inputs?.shift() ?? "",
    secret: async () => "",
    confirm: async () => values.confirms?.shift() ?? values.confirmations?.shift() ?? false,
  };
}

function verification(status: "queued" | "running" | "passed" | "failed" | "cancelled", recordRevision: number) {
  return { verificationId: "ver_one", profileRevisionId: "mpr_verified", capabilityBaseline: "text_and_single_tool_call_v1" as const, status, resultCode: null, safeStatus: null, capabilities: [], traceId: "trace_one", recordRevision, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", cancellationRequestedAt: null, fallbackProfileRevisionId: null, fallbackVerificationId: null };
}
