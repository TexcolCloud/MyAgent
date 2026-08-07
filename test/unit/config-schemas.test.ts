import { describe, expect, it } from "vitest";

import {
  agentConfigSchema,
  policyConfigSchema,
} from "../../src/config/schemas.js";

const VALID_AGENT = {
  id: "primary",
  displayName: "Primary",
  prompt: "./AGENT.md",
  model: "default",
  workspace: "./workspace",
  skills: [],
  policy: "./policy.yaml",
  delegates: [],
  limits: {},
};

describe("configuration schemas", () => {
  it("rejects unknown Policy fields and unsupported M2 Agent fields", () => {
    expect(() =>
      policyConfigSchema.parse({
        version: 1,
        rules: [{ tool: "read_file", effect: "allow", surprise: true }],
      }),
    ).toThrow();

    expect(() =>
      agentConfigSchema.parse({
        ...VALID_AGENT,
        context: { memory: "optional" },
        knowledgeCollections: ["personal"],
      }),
    ).toThrow();
  });
});
