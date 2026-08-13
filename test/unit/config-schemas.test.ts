import { describe, expect, it } from "vitest";

import {
  agentConfigSchema,
  agentConfigV2Schema,
  globalConfigV2Schema,
  localProjectConfigSchema,
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

const VALID_V2 = {
  version: 2,
  server: {
    bearerToken: { fromEnvironment: "MYAGENT_BEARER_TOKEN" },
    adminToken: { fromEnvironment: "MYAGENT_ADMIN_TOKEN" },
  },
  database: { path: "./data/kernel.db" },
  agentRoots: ["./agents"],
};

const VALID_V2_AGENT = {
  id: "primary",
  displayName: "Primary",
  prompt: "./AGENT.md",
  workspace: "./workspace",
  policy: "./policy.yaml",
};

describe("configuration schemas", () => {
  it("accepts only model-free version 2 configuration", () => {
    const config = globalConfigV2Schema.parse(VALID_V2);

    expect(config.version).toBe(2);
    expect(config.modelControl).toEqual({
      discoveryCacheSeconds: 600,
      discoveryTimeoutMs: 10_000,
      verificationRequestTimeoutMs: 30_000,
      verificationJobTimeoutMs: 120_000,
      maxDiscoveredModels: 1_000,
      maxDiscoveryResponseBytes: 2_097_152,
      verificationConcurrency: 1,
    });
    expect(() => globalConfigV2Schema.parse({ ...VALID_V2, models: {} })).toThrow();
    expect(() => agentConfigV2Schema.parse({ ...VALID_V2_AGENT, model: "default" })).toThrow();
  });

  it("accepts the minimal local-project configuration without Model defaults", () => {
    expect(localProjectConfigSchema.parse(VALID_V2)).toMatchObject({ version: 2 });
    expect(() => localProjectConfigSchema.parse({ ...VALID_V2, models: {} })).toThrow();
    expect(() => localProjectConfigSchema.parse({
      ...VALID_V2,
      modelControl: {},
    })).toThrow();
  });

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
