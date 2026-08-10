import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("serialized Vitest argument routing", () => {
  it.each([
    [["-t", "approval recovery"], ["-t", "approval recovery", "--dir=test/e2e"]],
    [["--reporter", "default"], ["--reporter", "default", "--dir=test/e2e"]],
    [["--exclude", "test/unit/slow.test.ts"], [
      "--exclude",
      "test/unit/slow.test.ts",
      "--dir=test/e2e",
    ]],
    [["test/e2e/m1-vertical.test.ts"], [
      "test/e2e/m1-vertical.test.ts",
      "--dir=test/e2e",
    ]],
  ] as const)("keeps option values in the configured suite for %j", (forwarded, expected) => {
    const modulePath = path.resolve("scripts/run-vitest-args.mjs");
    const script = [
      `import { buildVitestArguments } from ${JSON.stringify(new URL(`file:///${modulePath.replaceAll("\\", "/")}`).href)};`,
      `process.stdout.write(JSON.stringify(buildVitestArguments("test/e2e", ${JSON.stringify(forwarded)})));`,
    ].join("\n");

    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(JSON.parse(output)).toEqual(expected);
  });
});
