import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureProjectTextSurfaces,
  runLocalCliFixture,
  type CapturedTextSurface,
} from "../helpers/local-cli-fixture.js";

describe("Local Integrated Mode secret boundary", () => {
  it("keeps both in-memory capability tokens out of output, logs, project files, and SQLite text", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-local-leak-"));
    const projectRoot = path.join(workspace, ".myagent");
    const databasePath = path.join(projectRoot, "state.sqlite");
    const tokens = [
      "local-run-capability-sentinel-6d8c41",
      "local-admin-capability-sentinel-3a9f72",
    ] as const;

    try {
      const capture = await runLocalCliFixture({ workspace, tokens });
      expect(capture.exitCode).toBe(0);

      const surfaces: CapturedTextSurface[] = [
        { name: "stdout", text: capture.stdout.join("\n") },
        { name: "stderr", text: capture.stderr.join("\n") },
        { name: "logs", text: capture.logs.join("\n") },
        ...await captureProjectTextSurfaces(projectRoot, databasePath),
      ];
      const leakingSurfaceNames = surfaces
        .filter(({ text }) => tokens.some((token) => text.includes(token)))
        .map(({ name }) => name);

      expect(leakingSurfaceNames).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
