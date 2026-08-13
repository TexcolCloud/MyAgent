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
      stat: async () => ({}),
    })).rejects.toMatchObject({ code: "local_config_outside_project_state" });
  });

  it("rejects a dangling link when realpath does not expose the missing target", async () => {
    const root = path.resolve("workspace", ".myagent");
    const candidate = path.join(root, "state.sqlite");

    await expect(assertPhysicallyConfinedPath(root, candidate, {
      lstat: async (value) => ({ isSymbolicLink: () => value === candidate }),
      realpath: async (value) => value,
      stat: async (value) => {
        if (value === candidate) {
          throw Object.assign(new Error("missing link target"), { code: "ENOENT" });
        }
        return {};
      },
    })).rejects.toMatchObject({ code: "local_config_outside_project_state" });
  });
});
