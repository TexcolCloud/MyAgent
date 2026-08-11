import { describe, expect, it } from "vitest";

import {
  PI_RUNTIME_VERSION,
  resolveProviderCatalogCandidate,
} from "../../src/config/pi-runtime-catalog.js";

describe("Pi runtime catalog", () => {
  it("returns a project-owned OpenAI candidate with a pinned invocation", () => {
    expect(resolveProviderCatalogCandidate("pi/openai", "gpt-4.1-mini")).toMatchObject({
      driverId: "pi/openai",
      modelId: "gpt-4.1-mini",
      invocation: { piVersion: PI_RUNTIME_VERSION, api: expect.any(String) },
      credentialSupport: "bearer",
    });
  });

  it("surfaces an OAuth-only candidate as unsupported", () => {
    expect(resolveProviderCatalogCandidate("pi/github-copilot", "any")).toMatchObject({
      driverId: "pi/github-copilot",
      credentialSupport: "unsupported",
    });
  });
});
