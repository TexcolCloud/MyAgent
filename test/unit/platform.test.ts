import { describe, expect, it } from "vitest";
import { assertSupportedRuntime } from "../../src/platform.js";

describe("assertSupportedRuntime", () => {
  it("accepts Node 24 and rejects other majors", () => {
    expect(() => assertSupportedRuntime({ node: "24.3.0" } as NodeJS.ProcessVersions)).not.toThrow();
    expect(() => assertSupportedRuntime({ node: "23.11.0" } as NodeJS.ProcessVersions)).toThrow(
      "MyAgent requires Node.js 24 LTS",
    );
  });
});
