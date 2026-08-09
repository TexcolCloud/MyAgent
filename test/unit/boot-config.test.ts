import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadBootConfig } from "../../src/config/boot-config.js";

const legacyFixture = fileURLToPath(
  new URL("../fixtures/config/legacy-v1/myagent.yaml", import.meta.url),
);
const version2Fixture = fileURLToPath(
  new URL("../fixtures/config/version-2/myagent.yaml", import.meta.url),
);

describe("loadBootConfig", () => {
  it("keeps legacy aliases only as import seeds", async () => {
    const boot = await loadBootConfig(legacyFixture);

    expect(boot.legacyModelImport?.models.default?.modelId).toBe("test-model");
    expect(boot.legacyModelImport?.agentAliases).toEqual({ primary: "default" });
    expect(boot.version).toBe(1);
  });

  it("loads immutable version 2 static configuration without an import seed", async () => {
    const boot = await loadBootConfig(version2Fixture);

    expect(boot.version).toBe(2);
    if (boot.version !== 2) throw new Error("expected version 2 configuration");
    expect(boot.legacyModelImport).toBeUndefined();
    expect(Object.isFrozen(boot)).toBe(true);
    expect(Object.isFrozen(boot.modelControl)).toBe(true);
  });
});
