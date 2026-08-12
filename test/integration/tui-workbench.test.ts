import type { Terminal } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { CliPrompt } from "../../src/interfaces/cli/commands/model-setup.js";
import { runWorkbench } from "../../src/interfaces/tui/workbench.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";
import { runModelSetupScreen } from "../../src/interfaces/tui/screens/model-setup.js";

describe("TUI workbench", () => {
  it("renders three bounded regions and restores the terminal on exit", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36, inputs: ["\u0003"] });

    await expect(runWorkbench({ client: safeClient(), terminal })).resolves.toBe(0);

    expect(terminal.frames.at(-1)).toContain("Runs");
    expect(terminal.frames.at(-1)).toContain("Inspect");
    expect(terminal.stopCalls).toBe(1);
  });

  it("routes navigation input into the main pane and loads safe Agent summaries", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("\u001b[A");
    terminal.input("\r");
    await terminal.waitForFrame("Research Agent");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(terminal.frames.at(-1)).toContain("Agents");
    expect(terminal.frames.at(-1)).toContain("Research Agent");
  });

  it("loads safe Provider Connection and Model Profile summaries through navigation", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Provider One");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Model One");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(terminal.frames.at(-1)).toContain("Profiles");
    expect(terminal.frames.at(-1)).toContain("Model One");
  });

  it("does not render control sequences or credential lines from typed list summaries", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const client = safeClient({
      agents: [{ id: "research", displayName: "Research\u001b[31m Agent\nAuthorization: Bearer hidden-agent", revisionId: "rev_1" }],
      connections: [{ connectionId: "provider-one", displayName: "Provider One\nAPI key: hidden-provider", activeRevisionId: "pcr_1", retiredAt: null }],
      profiles: [{ profileId: "model-one", displayName: "Model One\nBearer\ntoken=hidden-model", activeRevisionId: "mpr_1", retiredAt: null }],
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("\u001b[A");
    terminal.input("\r");
    await terminal.waitForFrame("Research Agent");
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Provider One");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Model One");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    const output = plainLines(terminal.frames.join("\n")).join("\n");
    expect(output).toContain("Research Agent");
    expect(output).toContain("Provider One");
    expect(output).toContain("Model One");
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("hidden-agent");
    expect(output).not.toContain("API key");
    expect(output).not.toContain("hidden-provider");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("token=hidden-model");
  });

  it("opens the existing masked model-setup workflow with m", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("m");
    await terminal.waitForFrame("Provider");
    terminal.input("\u001b");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
  });

  it("waits for Ctrl+C to cancel active model setup without later polling or mutations", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const requests: { path: string; body: unknown }[] = [];
    let pollStarted: (() => void) | undefined;
    const pollStartedPromise = new Promise<void>((resolve) => { pollStarted = resolve; });
    const setup = setupClient(requests, () => "running");
    const client = safeClient({
      adminRequest: async <T>(path: string, init?: { readonly method?: string }) => {
        if (path === "/v1/admin/provider-drivers") return {
          piVersion: "0.73.1",
          drivers: [{
            driverId: "pi/openai",
            candidates: [{
              candidateId: "pi/openai:gpt-4.1-mini",
              displayName: "GPT-4.1 mini",
              modelId: "gpt-4.1-mini",
              credentialSupport: "bearer",
            }],
          }],
        } as T;
        if (path === "/v1/admin/model-verifications/ver_1") pollStarted?.();
        return setup.adminRequest<T>(path, init);
      },
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("m");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("\r");
    await terminal.waitForFrame("Provider slug");
    terminal.input("\r");
    await terminal.waitForFrame("Provider display name");
    terminal.input("\r");
    await terminal.waitForFrame("Base URL");
    terminal.input("\r");
    await terminal.waitForFrame("Catalog model");
    terminal.input("\r");
    await terminal.waitForFrame("Provider auth");
    terminal.input("\r");
    await terminal.waitForFrame("API key environment variable");
    terminal.input("OPENAI_API_KEY");
    terminal.input("\r");
    await terminal.waitForFrame("Model profile slug");
    terminal.input("\r");
    await terminal.waitForFrame("Model profile display name");
    terminal.input("\r");
    await terminal.waitForFrame("Context source");
    terminal.input("\r");
    await terminal.waitForFrame("Use resolved context limit");
    terminal.input("\r");
    await pollStartedPromise;
    const requestCountAtCancel = requests.length;
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(requests).toHaveLength(requestCountAtCancel);
    expect(requests.some((request) => request.path.includes("/promotions"))).toBe(false);
    expect(requests.some((request) => request.path.includes("model-assignment"))).toBe(false);
  });

  it("cancels model setup polling before later Admin mutations", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const controller = new AbortController();
    let sleepStarted: (() => void) | undefined;
    const sleepStartedPromise = new Promise<void>((resolve) => { sleepStarted = resolve; });
    const outcome = runModelSetupScreen({
      client: setupClient(requests, () => "running"),
      prompt: scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat"],
        confirmations: [true],
      }),
      write: vi.fn(),
      signal: controller.signal,
      sleep: async () => {
        sleepStarted?.();
        await new Promise<void>(() => undefined);
      },
    });

    await sleepStartedPromise;
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(requests.some((request) => request.path.includes("/promotions"))).toBe(false);
    expect(requests.some((request) => request.path.includes("model-assignment"))).toBe(false);
  });

  it("stops the terminal once when startup fails", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36, startError: new Error("terminal_start_failed") });

    await expect(runWorkbench({ client: safeClient(), terminal })).rejects.toThrow("terminal_start_failed");
    expect(terminal.stopCalls).toBe(1);
  });

  it("does not render credential-bearing multiline provider details", () => {
    const screen = new InspectorScreen();
    screen.showProblem({
      code: "provider_unavailable\u001b[31m",
      detail: "safe detail\nAuthorization: Bearer secret-value\nAPI key: hidden\ntoken=hidden\nshown",
      traceId: "t_1\u0007",
    });

    const text = screen.render(40).join("\n");
    expect(text).toContain("provider_unavailable");
    expect(text).toContain("shown");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("API key");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("\u001b");
  });

  it("keeps the composed three-region layout within a narrow render width", async () => {
    const terminal = new FakeTuiTerminal({ width: 24, height: 36, inputs: ["\u0003"] });

    await runWorkbench({ client: safeClient(), terminal });

    for (const frame of terminal.frames) {
      for (const line of plainLines(frame)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("model setup screen", () => {
  it("waits 250ms between verification reads by default", async () => {
    vi.useFakeTimers();
    try {
      const requests: { path: string; body: unknown }[] = [];
      let verificationReads = 0;
      const client = setupClient(requests, () => {
        verificationReads += 1;
        return verificationReads === 1 ? "running" : "passed";
      });
      const prompt = scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
        confirmations: [true, false, false],
      });

      const outcome = runModelSetupScreen({ prompt, client, write: vi.fn() });
      await vi.advanceTimersByTimeAsync(249);
      expect(verificationReads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toEqual({ status: "cancelled" });
      expect(verificationReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit promotion after successful verification", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
      confirmations: [true, false, false],
    });

    const outcome = await runModelSetupScreen({ prompt, client: setupClient(requests), write: vi.fn(), sleep: async () => undefined });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(requests.some((request) => request.path.endsWith("/promotions"))).toBe(false);
  });

  it("keeps Pi catalog candidates distinct from remote discovery and sends only Driver/Candidate identifiers", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const selections: { message: string; choices: readonly unknown[] }[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat"],
      confirmations: [false],
      selections,
    });

    await runModelSetupScreen({ prompt, client: setupClient(requests), write: vi.fn(), sleep: async () => undefined });

    const catalog = selections.find((entry) => entry.message === "Catalog model");
    expect(catalog?.choices).toEqual([
      expect.objectContaining({ value: "pi/deepseek:deepseek-chat", label: expect.stringContaining("Pi catalog"), disabled: false }),
      expect.objectContaining({ value: "pi/deepseek:unsupported", label: expect.stringContaining("Pi catalog"), disabled: true }),
    ]);
    expect(selections.some((entry) => entry.message === "Discovered model")).toBe(false);
    expect(requests.find((request) => request.path === "/v1/admin/provider-connections")?.body)
      .toEqual(expect.objectContaining({ driverId: "pi/deepseek" }));
    expect(requests.find((request) => request.path === "/v1/admin/model-profiles")?.body)
      .toEqual(expect.objectContaining({ catalogCandidateId: "pi/deepseek:deepseek-chat" }));
  });
});

class FakeTuiTerminal implements Terminal {
  readonly frames: string[] = [];
  stopCalls = 0;
  private onInput: ((data: string) => void) | undefined;

  constructor(private readonly options: { readonly width: number; readonly height: number; readonly inputs?: readonly string[]; readonly startError?: Error }) {}

  start(onInput: (data: string) => void): void {
    if (this.options.startError !== undefined) throw this.options.startError;
    this.onInput = onInput;
    setTimeout(() => this.options.inputs?.forEach((input) => this.onInput?.(input)), 0);
  }

  input(data: string): void { this.onInput?.(data); }
  async ready(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
  async waitForFrame(value: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.frames.at(-1)?.includes(value) === true) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`frame_not_found:${value}`);
  }

  stop(): void { this.stopCalls += 1; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.frames.push(`${this.frames.at(-1) ?? ""}${data}`); }
  get columns(): number { return this.options.width; }
  get rows(): number { return this.options.height; }
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

function safeClient(overrides: Partial<{
  agents: readonly { readonly id: string; readonly displayName: string; readonly revisionId: string }[];
  connections: readonly { readonly connectionId: string; readonly displayName: string; readonly activeRevisionId: string | null; readonly retiredAt: string | null }[];
  profiles: readonly { readonly profileId: string; readonly displayName: string; readonly activeRevisionId: string | null; readonly retiredAt: string | null }[];
  adminRequest: <T>(path: string, init?: { readonly method?: string }) => Promise<T>;
}> = {}) {
  return {
    listAgents: async () => ({ agents: overrides.agents ?? [{ id: "research", displayName: "Research Agent", revisionId: "rev_1" }], unavailable: [] }),
    listProviderConnections: async () => ({ connections: overrides.connections ?? [{ connectionId: "provider-one", displayName: "Provider One", activeRevisionId: "pcr_1", retiredAt: null }] }),
    listModelProfiles: async () => ({ profiles: overrides.profiles ?? [{ profileId: "model-one", displayName: "Model One", activeRevisionId: "mpr_1", retiredAt: null }] }),
    listProviderDrivers: async () => ({ piVersion: "0.73.1" as const, drivers: [] }),
    adminRequest: overrides.adminRequest ?? (async <T>(path: string) => (path === "/v1/admin/provider-drivers"
      ? { piVersion: "0.73.1", drivers: [] } as T
      : {} as T)),
  };
}


function plainLines(frame: string): string[] {
  let text = "";
  for (let index = 0; index < frame.length; index += 1) {
    if (frame.charCodeAt(index) !== 0x1b) {
      text += frame[index]!;
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
  return text.split(/\r?\n/u);
}

function isAnsiTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function scriptedPrompt(values: {
  selects: string[];
  inputs: string[];
  confirmations: boolean[];
  selections?: { message: string; choices: readonly unknown[] }[];
}): CliPrompt {
  return {
    select: async <T extends string>(message: string, choices: readonly unknown[]) => {
      values.selections?.push({ message, choices });
      return values.selects.shift() as T;
    },
    selectChoice: async <T extends string>(message: string, choices: readonly unknown[]) => {
      values.selections?.push({ message, choices });
      return values.selects.shift() as T;
    },
    input: async () => values.inputs.shift() ?? "",
    secret: async () => { throw new Error("unexpected_secret_prompt"); },
    confirm: async () => values.confirmations.shift() ?? false,
  } as CliPrompt;
}

function setupClient(
  requests: { path: string; body: unknown }[],
  verificationStatus: () => "running" | "passed" = () => "passed",
) {
  return {
    adminRequest: async <T>(path: string, options: { method?: string; body?: unknown } = {}) => {
      requests.push({ path, body: options.body });
      if (path === "/v1/admin/provider-drivers") return {
        piVersion: "0.73.1",
        drivers: [{
          driverId: "pi/deepseek",
          candidates: [
            { candidateId: "pi/deepseek:deepseek-chat", displayName: "DeepSeek Chat", modelId: "deepseek-chat", credentialSupport: "bearer" },
            { candidateId: "pi/deepseek:unsupported", displayName: "Unsupported", modelId: "unsupported", credentialSupport: "unsupported" },
          ],
        }],
      } as T;
      if (path === "/v1/admin/provider-connections") return { recordRevision: 0, revisions: [{ revisionId: "pcr_1", baseUrl: "https://api.deepseek.com/v1", protocolPreference: "responses" }] } as T;
      if (path.endsWith("/discover")) return { recordRevision: 1, state: "fresh", models: [{ id: "remote-only" }], error: null } as T;
      if (path === "/v1/admin/model-profiles") return { profileId: "deepseek-chat", recordRevision: 0, revisions: [{ revisionId: "mpr_1", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "preset" }] } as T;
      if (path.endsWith("/verifications")) return { operationUrl: "/v1/admin/model-verifications/ver_1" } as T;
      if (path === "/v1/admin/model-verifications/ver_1") return { verificationId: "ver_1", profileRevisionId: "mpr_1", status: verificationStatus(), resultCode: null, capabilities: [], traceId: "trace", fallbackProfileRevisionId: null, fallbackVerificationId: null } as T;
      if (path === "/v1/admin/model-profiles/deepseek-chat") return { profileId: "deepseek-chat", recordRevision: 1, revisions: [{ revisionId: "mpr_1", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "preset" }] } as T;
      return {} as T;
    },
  };
}
