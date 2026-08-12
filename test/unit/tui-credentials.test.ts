import { describe, expect, it } from "vitest";

import { readTuiCredentials } from "../../src/interfaces/tui/credentials.js";

describe("readTuiCredentials", () => {
  it("uses separate hidden inputs when Run and Admin tokens are absent", async () => {
    const labels: string[] = [];

    await expect(readTuiCredentials({
      environment: {},
      promptSecret: async (label) => { labels.push(label); return `${labels.length}`; },
    })).resolves.toEqual({ runToken: "1", adminToken: "2" });

    expect(labels).toEqual(["Run token", "Admin token"]);
  });

  it("uses configured tokens without prompting and freezes the returned credentials", async () => {
    const promptSecret = async (): Promise<string> => { throw new Error("unexpected_prompt"); };

    const credentials = await readTuiCredentials({
      environment: { MYAGENT_RUN_TOKEN: "run-secret", MYAGENT_ADMIN_TOKEN: "admin-secret" },
      promptSecret,
    });

    expect(credentials).toEqual({ runToken: "run-secret", adminToken: "admin-secret" });
    expect(Object.isFrozen(credentials)).toBe(true);
  });

  it("rejects blank hidden Run credentials without returning token text", async () => {
    await expect(readTuiCredentials({
      environment: {},
      promptSecret: async () => " ",
    })).rejects.toThrow(expect.objectContaining({ code: "run_token_required" }));
  });

  it("rejects a blank configured Admin token without prompting", async () => {
    await expect(readTuiCredentials({
      environment: { MYAGENT_RUN_TOKEN: "run-token", MYAGENT_ADMIN_TOKEN: "" },
      promptSecret: async () => { throw new Error("unexpected_prompt"); },
    })).rejects.toThrow(expect.objectContaining({ code: "admin_token_required" }));
  });

  it("rejects equal Run and Admin tokens without including the token in the error", async () => {
    const repeatedToken = "shared-token-must-not-appear";

    const error = await readTuiCredentials({
      environment: { MYAGENT_RUN_TOKEN: repeatedToken, MYAGENT_ADMIN_TOKEN: repeatedToken },
      promptSecret: async () => { throw new Error("unexpected_prompt"); },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "tui_tokens_must_differ" });
    expect(String(error)).not.toContain(repeatedToken);
  });
});
