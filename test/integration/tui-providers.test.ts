import type { Terminal } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { CliPrompt } from "../../src/interfaces/cli/commands/model-setup.js";
import type {
  DiscoveryResponse,
  ModelProfileResponse,
  ProviderConnectionResponse,
} from "../../src/interfaces/http/model-control-schemas.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";
import { ProviderScreen } from "../../src/interfaces/tui/screens/providers.js";
import { TuiRevisionConflictError } from "../../src/interfaces/tui/tui-client.js";
import { runWorkbench } from "../../src/interfaces/tui/workbench.js";
import { CliHttpError } from "../../src/interfaces/cli/client.js";

describe("Provider TUI workflows", () => {
  it("selects a Provider and renders safe health, lock, Secret-reference, and remote-discovery status", async () => {
    const inspector = new InspectorScreen();
    const client = providerClient({
      getProviderConnection: async () => providerConnection({
        retiredAt: "2026-08-13T00:00:00.000Z",
        credentialConfigured: true,
        secretVersionId: "secret_v1",
        revisions: [providerRevision({ state: "failed", secretVersionId: "secret_v1" })],
      }),
      getProviderModels: async () => discovery({ state: "failed", error: { code: "provider_unavailable", traceId: "trace_1" } }),
    });
    const screen = new ProviderScreen({ client, inspector });

    await screen.load();
    screen.handleInput("\r");
    await screen.settled();

    expect(screen.render(100).join("\n")).toContain("Catalog Candidate: GPT-4.1 mini");
    const detail = inspector.render(100).join("\n");
    expect(detail).toContain("Provider provider-one");
    expect(detail).toContain("Health: degraded");
    expect(detail).toContain("Status: locked");
    expect(detail).toContain("Secret reference: managed Secret configured");
    expect(detail).toContain("Remote discovery: failed");
    expect(detail).not.toContain("provider_unavailable");
  });

  it("requires a visible review before create and never retains masked managed-Secret plaintext", async () => {
    const plaintext = "sentinel-provider-plaintext";
    const inspector = new InspectorScreen();
    let releaseConfirmation: ((value: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => { releaseConfirmation = resolve; });
    const createProvider = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        slug: "new-provider",
        displayName: "New Provider",
        driverId: "pi/openai",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "api_key" },
        apiKey: plaintext,
      });
      return providerConnection({ connectionId: "new-provider", displayName: "New Provider" });
    });
    const screen = new ProviderScreen({
      client: providerClient({ createProvider }),
      inspector,
      promptFactory: () => scriptedPrompt({
        selects: ["pi/openai", "managed_secret", "responses"],
        inputs: ["new-provider", "New Provider", "https://api.openai.com/v1"],
        secrets: [plaintext],
        confirms: [confirmation],
      }),
    });
    await screen.load();

    screen.handleInput("n");
    await vi.waitFor(() => {
      expect(inspector.render(100).join("\n")).toContain("Confirmation: required");
    });
    expect(inspector.render(100).join("\n")).toContain("Current revision: none");
    expect(inspector.render(100).join("\n")).toContain("Proposed revision: new draft");
    expect(inspector.render(100).join("\n")).toContain("Affected Profiles: none");
    expect(createProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(screen)).not.toContain(plaintext);
    expect(screen.render(100).join("\n")).not.toContain(plaintext);
    expect(inspector.render(100).join("\n")).not.toContain(plaintext);

    releaseConfirmation?.(true);
    await screen.settled();

    expect(createProvider).toHaveBeenCalledOnce();
    expect(JSON.stringify(screen)).not.toContain(plaintext);
  });

  it("submits an environment reference by name and keeps Catalog candidates distinct from remote discovery", async () => {
    const createProvider = vi.fn(async () => providerConnection({ connectionId: "env-provider" }));
    const screen = new ProviderScreen({
      client: providerClient({ createProvider }),
      inspector: new InspectorScreen(),
      promptFactory: () => scriptedPrompt({
        selects: ["pi/openai", "environment", "responses"],
        inputs: ["env-provider", "Environment Provider", "https://api.openai.com/v1", "OPENAI_API_KEY"],
        confirms: [true],
      }),
    });
    await screen.load();

    expect(screen.render(100).join("\n")).toContain("Catalog Candidate: GPT-4.1 mini");
    expect(screen.render(100).join("\n")).not.toContain("Remote discovery: GPT-4.1 mini");
    screen.handleInput("n");
    await screen.settled();

    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      auth: { type: "environment", fromEnvironment: "OPENAI_API_KEY" },
    }));
  });

  it("reviews revision impact, discovery, promotion, and retirement before each confirmed request", async () => {
    const inspector = new InspectorScreen();
    const reviseProvider = vi.fn(async () => providerConnection({ recordRevision: 3 }));
    const discoverProviderModels = vi.fn(async () => discovery({ state: "fresh", recordRevision: 3 }));
    const promoteProvider = vi.fn(async () => providerConnection({ activeRevisionId: "pcr_2", recordRevision: 4 }));
    const retireProvider = vi.fn(async () => providerConnection({ retiredAt: "2026-08-13T00:00:00.000Z", recordRevision: 5 }));
    const prompts = [
      scriptedPrompt({
        selects: ["environment", "responses"],
        inputs: ["Provider Revised", "https://api.openai.com/v1", "OPENAI_API_KEY"],
        confirms: [true, true],
      }),
      scriptedPrompt({ confirms: [true] }),
      scriptedPrompt({ selects: ["pcr_2"], confirms: [true] }),
      scriptedPrompt({ confirms: [true] }),
    ];
    const screen = new ProviderScreen({
      client: providerClient({ reviseProvider, discoverProviderModels, promoteProvider, retireProvider }),
      inspector,
      promptFactory: () => prompts.shift()!,
    });
    await screen.load();

    screen.handleInput("e");
    await screen.settled();
    expect(reviseProvider).toHaveBeenCalledWith("provider-one", expect.objectContaining({ expectedRevision: 2 }));
    expect(inspector.render(100).join("\n")).toContain("Affected Profiles: profile-one");

    screen.handleInput("d");
    await screen.settled();
    expect(discoverProviderModels).toHaveBeenCalledWith("pcr_2", { expectedRevision: 3 });
    expect(inspector.render(100).join("\n")).toContain("Proposed revision: remote discovery refresh");

    screen.handleInput("p");
    await screen.settled();
    expect(promoteProvider).toHaveBeenCalledWith("provider-one", {
      connectionRevisionId: "pcr_2",
      expectedRevision: 3,
    });

    screen.handleInput("x");
    await screen.settled();
    expect(inspector.render(100).join("\n")).toContain("Proposed revision: retired");
    expect(inspector.render(100).join("\n")).toContain("Affected Profiles: profile-one");
    expect(retireProvider).toHaveBeenCalledWith("provider-one", { expectedRevision: 4 });
  });

  it("locks all mutations after a revision conflict until an explicit reload and never retries silently", async () => {
    const inspector = new InspectorScreen();
    const promoteProvider = vi.fn(async () => {
      throw new TuiRevisionConflictError(new CliHttpError(409, "revision_conflict", "secret stale", "trace-secret"));
    });
    const client = providerClient({ promoteProvider });
    const screen = new ProviderScreen({
      client,
      inspector,
      promptFactory: () => scriptedPrompt({ selects: ["pcr_2"], confirms: [true] }),
    });
    await screen.load();

    screen.handleInput("p");
    await screen.settled();
    expect(promoteProvider).toHaveBeenCalledOnce();
    expect(inspector.render(100).join("\n")).toContain("Reload required");
    expect(inspector.render(100).join("\n")).not.toContain("secret stale");

    screen.handleInput("p");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(promoteProvider).toHaveBeenCalledOnce();
    screen.handleInput("r");
    await screen.settled();
    expect(client.listProviderConnections).toHaveBeenCalledTimes(2);
  });

  it("does not permit Promotion after failed remote discovery", async () => {
    const discoverProviderModels = vi.fn(async () => discovery({
      state: "failed",
      error: { code: "provider_unavailable", traceId: "trace_1" },
    }));
    const promoteProvider = vi.fn(async () => providerConnection({ activeRevisionId: "pcr_2" }));
    const prompts = [
      scriptedPrompt({ confirms: [true] }),
      scriptedPrompt({ selects: ["pcr_2"], confirms: [true] }),
    ];
    const inspector = new InspectorScreen();
    const screen = new ProviderScreen({
      client: providerClient({ discoverProviderModels, promoteProvider }),
      inspector,
      promptFactory: () => prompts.shift()!,
    });
    await screen.load();

    screen.handleInput("d");
    await screen.settled();
    screen.handleInput("p");
    await screen.settled();

    expect(discoverProviderModels).toHaveBeenCalledOnce();
    expect(promoteProvider).not.toHaveBeenCalled();
    expect(inspector.render(100).join("\n")).toContain("Remote discovery: failed");
    expect(screen.render(100).join("\n")).toContain("Promotion locked");
  });

  it("opens the focused Provider workspace inside the three-region workbench", async () => {
    const terminal = new FakeTerminal({ width: 120, height: 36 });
    const client = workbenchClient();
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Catalog Candidate");
    terminal.input("\r");
    await terminal.waitForFrame("Provider provider-one");
    terminal.input("\u001b");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    const output = plain(terminal.frames.at(-1) ?? "");
    expect(output).toContain("Navigation");
    expect(output).toContain("Providers");
    expect(output).toContain("Inspect");
  });
});

function providerClient(overrides: Partial<ReturnType<typeof baseProviderMethods>> = {}) {
  const methods = { ...baseProviderMethods(), ...overrides };
  return Object.fromEntries(Object.entries(methods).map(([key, value]) => [
    key,
    vi.isMockFunction(value) ? value : vi.fn(value),
  ])) as unknown as typeof methods & {
    readonly listProviderConnections: ReturnType<typeof vi.fn>;
  };
}

function baseProviderMethods() {
  return {
    listProviderConnections: async () => ({ connections: [{
      connectionId: "provider-one", displayName: "Provider One", activeRevisionId: "pcr_1", retiredAt: null,
    }] }),
    getProviderConnection: async () => providerConnection(),
    createProvider: async (...args: [unknown]) => { void args; return providerConnection(); },
    reviseProvider: async (...args: [string, unknown]) => { void args; return providerConnection({ recordRevision: 3 }); },
    discoverProviderModels: async (...args: [string, unknown]) => { void args; return discovery(); },
    getProviderModels: async (...args: [string]) => { void args; return discovery(); },
    promoteProvider: async (...args: [string, unknown]) => { void args; return providerConnection({ activeRevisionId: "pcr_2", recordRevision: 3 }); },
    retireProvider: async (...args: [string, unknown]) => { void args; return providerConnection({ retiredAt: "2026-08-13T00:00:00.000Z", recordRevision: 3 }); },
    listProviderDrivers: async () => ({
      piVersion: "0.73.1" as const,
      drivers: [{
        driverId: "pi/openai" as const,
        candidates: [{
          candidateId: "pi/openai:gpt-4.1-mini",
          displayName: "GPT-4.1 mini",
          modelId: "gpt-4.1-mini",
          credentialSupport: "bearer" as const,
        }],
      }],
    }),
    listModelProfiles: async () => ({ profiles: [{
      profileId: "profile-one", displayName: "Profile One", activeRevisionId: "mpr_1", retiredAt: null,
    }] }),
    getModelProfile: async () => modelProfile(),
  };
}

function providerConnection(overrides: Partial<ProviderConnectionResponse> = {}): ProviderConnectionResponse {
  return {
    connectionId: "provider-one",
    displayName: "Provider One",
    providerKind: "openai",
    providerDriver: "pi/openai",
    activeRevisionId: "pcr_1",
    retiredAt: null,
    recordRevision: 2,
    credentialConfigured: true,
    revisions: [
      providerRevision({ revisionId: "pcr_1", state: "active" }),
      providerRevision({ revisionId: "pcr_2", state: "verified" }),
    ],
    ...overrides,
  };
}

function providerRevision(overrides: Partial<ProviderConnectionResponse["revisions"][number]> = {}): ProviderConnectionResponse["revisions"][number] {
  return {
    revisionId: "pcr_1",
    connectionId: "provider-one",
    state: "active",
    baseUrl: "https://api.openai.com/v1",
    allowInsecureHttp: false,
    protocolPreference: "responses",
    presetVersion: "2026-08-01",
    credentialConfigured: true,
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function discovery(overrides: Partial<DiscoveryResponse> = {}): DiscoveryResponse {
  return {
    connectionRevisionId: "pcr_2",
    recordRevision: 2,
    state: "fresh",
    models: [{ id: "remote-model", owner: "provider", createdAt: "2026-08-13T00:00:00.000Z" }],
    cache: { fetchedAt: "2026-08-13T00:00:00.000Z", expiresAt: "2026-08-13T01:00:00.000Z" },
    error: null,
    ...overrides,
  };
}

function modelProfile(): ModelProfileResponse {
  return {
    profileId: "profile-one",
    displayName: "Profile One",
    activeRevisionId: "mpr_1",
    retiredAt: null,
    recordRevision: 1,
    revisions: [{
      revisionId: "mpr_1",
      profileId: "profile-one",
      connectionRevisionId: "pcr_2",
      providerModelId: "remote-model",
      invocationProtocol: "responses",
      maxInputTokens: 128000,
      contextWindowSource: "preset",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      state: "active",
      createdAt: "2026-08-13T00:00:00.000Z",
    }],
  };
}

function scriptedPrompt(values: {
  readonly selects?: string[];
  readonly inputs?: string[];
  readonly secrets?: string[];
  readonly confirms?: (boolean | Promise<boolean>)[];
}): CliPrompt {
  return {
    select: async <T extends string>() => values.selects?.shift() as T,
    selectChoice: async <T extends string>() => values.selects?.shift() as T,
    input: async () => values.inputs?.shift() ?? "",
    secret: async () => values.secrets?.shift() ?? "",
    confirm: async () => await (values.confirms?.shift() ?? false),
  };
}

function workbenchClient() {
  return {
    ...providerClient(),
    listAgents: async () => ({ agents: [], unavailable: [] }),
    runModelSetup: async () => 0,
    createRun: async () => ({ runId: "run_1", status: "queued" as const, eventsUrl: "/v1/runs/run_1/events" }),
    stream: async () => new Response("", { headers: { "content-type": "text/event-stream" } }),
    listPendingApprovals: async () => ({ approvals: [] }),
    decideApproval: async () => ({ approvalId: "apr_1", runId: "run_1", state: "approved" as const, resolvedAt: null }),
  };
}

class FakeTerminal implements Terminal {
  readonly frames: string[] = [];
  private onInput: ((data: string) => void) | undefined;
  constructor(private readonly size: { readonly width: number; readonly height: number }) {}
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  input(data: string): void { this.onInput?.(data); }
  async ready(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
  async waitForFrame(value: string): Promise<void> {
    await vi.waitFor(() => { expect(plain(this.frames.at(-1) ?? "")).toContain(value); });
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.frames.push(`${this.frames.at(-1) ?? ""}${data}`); }
  get columns(): number { return this.size.width; }
  get rows(): number { return this.size.height; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function plain(frame: string): string {
  let result = "";
  for (let index = 0; index < frame.length; index += 1) {
    if (frame.charCodeAt(index) !== 0x1b) {
      result += frame[index]!;
      continue;
    }
    const next = frame[index + 1];
    if (next === "[") {
      index += 2;
      while (index < frame.length && !isAnsiTerminator(frame[index]!)) index += 1;
    } else if (next === "]") {
      index += 2;
      while (index < frame.length && frame.charCodeAt(index) !== 0x07) index += 1;
    }
  }
  return result;
}

function isAnsiTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}
