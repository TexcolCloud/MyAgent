import { describe, expect, it } from "vitest";

import {
  PROVIDER_PRESETS,
  providerPreset,
} from "../../src/config/provider-presets.js";

describe("provider presets", () => {
  it("returns an immutable copy for each connection revision suggestion", () => {
    const first = providerPreset("openai");
    const second = providerPreset("openai");

    expect(first).toEqual(PROVIDER_PRESETS.openai);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(PROVIDER_PRESETS.openai)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
