import { describe, expect, it } from "vitest";

import {
  PI_RUNTIME_VERSION,
  listProviderCatalogCandidates,
  resolveProviderCatalogCandidate,
  resolveProviderCatalogCandidateForRuntime,
} from "../../src/config/pi-runtime-catalog.js";

describe("Pi runtime catalog", () => {
  it("returns a project-owned OpenAI candidate with a pinned invocation", () => {
    expect(resolveProviderCatalogCandidate("pi/openai:gpt-4.1-mini")).toMatchObject({
      driverId: "pi/openai",
      modelId: "gpt-4.1-mini",
      invocation: { piVersion: PI_RUNTIME_VERSION, api: expect.any(String) },
      credentialSupport: "bearer",
    });
  });

  it("surfaces an OAuth-only candidate as unsupported", () => {
    expect(resolveProviderCatalogCandidate("pi/github-copilot:any")).toMatchObject({
      driverId: "pi/github-copilot",
      credentialSupport: "unsupported",
    });
  });

  it("publishes explicit Chat Completions and Responses variants for DeepSeek V4 Flash", () => {
    const candidates = listProviderCatalogCandidates().filter((candidate) =>
      candidate.driverId === "pi/deepseek" && candidate.modelId === "deepseek-v4-flash",
    );

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateId: "pi/deepseek:deepseek-v4-flash",
        invocation: expect.objectContaining({
          api: "openai-completions",
          providerCompatibilityContract: "none",
        }),
      }),
      expect.objectContaining({
        candidateId: "pi/deepseek:deepseek-v4-flash-responses",
        displayName: "DeepSeek V4 Flash (Responses)",
        invocation: expect.objectContaining({
          api: "openai-responses",
          providerCompatibilityContract: "deepseek-responses-v1",
        }),
      }),
    ]));
  });

  it("resolves a runtime only when every immutable variant field matches", () => {
    const variant = resolveProviderCatalogCandidate(
      "pi/deepseek:deepseek-v4-flash-responses",
    );
    expect(variant).toBeDefined();
    expect(resolveProviderCatalogCandidateForRuntime(variant!.invocation))
      .toBe(variant);
    expect(resolveProviderCatalogCandidateForRuntime({
      ...variant!.invocation,
      providerCompatibilityContract: "none",
    })).toBeUndefined();
  });

  it("projects a frozen, project-owned catalog pinned to the Pi runtime version", () => {
    const candidates = listProviderCatalogCandidates();

    expect(candidates).not.toHaveLength(0);
    expect(Object.isFrozen(candidates)).toBe(true);
    for (const candidate of candidates) {
      expect(candidate.driverId).toMatch(/^pi\/[a-z0-9-]+$/u);
      expect(candidate.invocation.piVersion).toBe(PI_RUNTIME_VERSION);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.invocation)).toBe(true);
      expect(Object.isFrozen(candidate.invocation.compatibility)).toBe(true);
    }
  });

  it("does not expose provider transport or credential fields in catalog projections", () => {
    const projection = JSON.stringify(listProviderCatalogCandidates());

    expect(projection).not.toContain('"baseUrl"');
    expect(projection).not.toContain('"headers"');
    expect(projection).not.toContain('"apiKey"');
    expect(projection).not.toContain('"secret"');
    expect(projection).not.toContain('"authorization"');
  });

  it("admits bearer credentials only for native OpenAI and DeepSeek catalog Drivers", () => {
    const candidates = listProviderCatalogCandidates();

    expect(candidates.filter((candidate) => candidate.driverId === "pi/openai"))
      .not.toHaveLength(0);
    expect(candidates.filter((candidate) => candidate.driverId === "pi/deepseek"))
      .not.toHaveLength(0);
    for (const candidate of candidates) {
      expect(candidate.credentialSupport).toBe(
        candidate.driverId === "pi/openai" || candidate.driverId === "pi/deepseek"
          ? "bearer"
          : "unsupported",
      );
    }
  });
});
