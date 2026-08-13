import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertPhysicallyConfinedPath } from "../../src/interfaces/cli/main.js";

describe("local state physical confinement", () => {
  it("rejects an existing dangling link instead of treating it as absent", async () => {
    const root = path.resolve("workspace", ".myagent");
    const candidate = path.join(root, "state.sqlite");

    await expect(assertPhysicallyConfinedPath(root, candidate, {
      lstat: async () => undefined,
      realpath: async (value) => {
        if (value === root) return root;
        throw Object.assign(new Error("dangling link"), { code: "ENOENT" });
      },
    })).rejects.toMatchObject({ code: "local_config_outside_project_state" });
  });
});
