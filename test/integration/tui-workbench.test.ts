import { describe, expect, it, vi } from "vitest";

import type { CliPrompt } from "../../src/interfaces/cli/commands/model-setup.js";
import { runModelSetupScreen } from "../../src/interfaces/tui/screens/model-setup.js";

describe("model setup screen", () => {
  it("requires explicit promotion after successful verification", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const client = setupClient(requests);
    const prompt = scriptedPrompt({
      selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
      confirmations: [true, false, false],
    });

    const outcome = await runModelSetupScreen({ prompt, client, write: vi.fn(), sleep: async () => undefined });

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

    await runModelSetupScreen({
      prompt,
      client: setupClient(requests),
      write: vi.fn(),
      sleep: async () => undefined,
    });

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

function setupClient(requests: { path: string; body: unknown }[]) {
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
      if (path === "/v1/admin/model-verifications/ver_1") return { verificationId: "ver_1", profileRevisionId: "mpr_1", status: "passed", resultCode: null, capabilities: [], traceId: "trace", fallbackProfileRevisionId: null, fallbackVerificationId: null } as T;
      if (path === "/v1/admin/model-profiles/deepseek-chat") return { profileId: "deepseek-chat", recordRevision: 1, revisions: [{ revisionId: "mpr_1", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "preset" }] } as T;
      return {} as T;
    },
  };
}
