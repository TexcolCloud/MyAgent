import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/config/catalog-loader.js";
import { parseAgentId } from "../../src/domain/ids.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/config", import.meta.url));

function fixture(...segments: string[]): string {
  return path.join(FIXTURE_ROOT, ...segments);
}

describe("loadCatalog", () => {
  it("rejects global listener errors but isolates an invalid Agent", async () => {
    await expect(loadCatalog(fixture("bad-global", "myagent.yaml"))).rejects.toMatchObject({
      code: "invalid_global_config",
    });

    const result = await loadCatalog(fixture("invalid-agent", "myagent.yaml"));
    expect(result.available.map((agent) => agent.id)).toEqual(["primary"]);
    expect(result.unavailable).toEqual([
      expect.objectContaining({ id: "broken", code: "invalid_agent_config" }),
    ]);
  });

  it("builds deterministic revisions with full Skill bodies and unresolved secrets", async () => {
    const first = await loadCatalog(fixture("valid", "myagent.yaml"));
    const second = await loadCatalog(fixture("valid", "myagent.yaml"));
    const primary = first.available.find((agent) => agent.id === "primary");

    expect(primary?.revision.skills).toEqual([
      expect.objectContaining({
        name: "research",
        body: "Use the available local sources and preserve source paths in the answer.\n",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(primary?.revision.model.apiKey).toEqual({
      fromEnvironment: "MODEL_API_KEY",
    });
    expect(primary?.revision.revisionId).toBe(
      second.available.find((agent) => agent.id === "primary")?.revision.revisionId,
    );
    expect(primary?.revision.revisionId).toBe(
      `rev_${primary?.revision.contentSha256 ?? "missing"}`,
    );
    expect(Object.isFrozen(primary?.revision)).toBe(true);
  });

  it("freezes every nested value in an immutable Agent revision", async () => {
    const catalog = await loadCatalog(fixture("valid", "myagent.yaml"));
    const revision = catalog.byId.get(parseAgentId("primary"))?.revision;

    expect(Object.isFrozen(catalog.global)).toBe(true);
    expect(Object.isFrozen(catalog.global.server)).toBe(true);
    expect(Object.isFrozen(catalog.global.server.bearerToken)).toBe(true);
    expect(Object.isFrozen(catalog.global.database)).toBe(true);
    expect(Object.isFrozen(catalog.global.models)).toBe(true);
    expect(Object.isFrozen(catalog.global.models.default)).toBe(true);
    expect(Object.isFrozen(catalog.global.toolEnvironmentAllowlist)).toBe(true);
    expect(Object.isFrozen(revision?.model)).toBe(true);
    expect(Object.isFrozen(revision?.model.apiKey)).toBe(true);
    expect(Object.isFrozen(revision?.skills)).toBe(true);
    expect(Object.isFrozen(revision?.policy)).toBe(true);
    expect(Object.isFrozen(revision?.policy[0])).toBe(true);
    expect(Object.isFrozen(revision?.delegates)).toBe(true);
    expect(Object.isFrozen(revision?.limits)).toBe(true);
  });

  it("isolates duplicate Agent IDs instead of publishing an ambiguous revision", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-duplicate-agent-"));
    const configRoot = path.join(temporary, "config");
    await cp(fixture("valid"), configRoot, { recursive: true });
    await cp(
      path.join(configRoot, "agents", "primary"),
      path.join(configRoot, "agents", "duplicate-primary"),
      { recursive: true },
    );
    await rm(path.join(configRoot, "agents", "duplicate-primary", "AGENT.md"));

    try {
      const result = await loadCatalog(path.join(configRoot, "myagent.yaml"));
      expect(result.available.map((agent) => agent.id)).toEqual(["researcher"]);
      expect(result.unavailable).toContainEqual(
        expect.objectContaining({
          id: "primary",
          code: "invalid_agent_config",
          detail: expect.stringContaining("duplicate Agent ID"),
        }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("marks only an Agent with a missing allowlisted Skill unavailable", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-missing-skill-"));
    const configRoot = path.join(temporary, "config");
    await cp(fixture("valid"), configRoot, { recursive: true });

    try {
      const agentPath = path.join(configRoot, "agents", "primary", "agent.yaml");
      const yaml = await readFile(agentPath, "utf8");
      await writeFile(agentPath, yaml.replace("  - research", "  - missing"));

      const result = await loadCatalog(path.join(configRoot, "myagent.yaml"));
      expect(result.available.map((agent) => agent.id)).toEqual(["researcher"]);
      expect(result.unavailable).toContainEqual(
        expect.objectContaining({ id: "primary", code: "invalid_agent_config" }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("isolates a malformed referenced Skill from Agents that do not use it", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-invalid-skill-"));
    const configRoot = path.join(temporary, "config");
    await cp(fixture("valid"), configRoot, { recursive: true });

    try {
      const researcherPath = path.join(
        configRoot,
        "agents",
        "researcher",
        "agent.yaml",
      );
      const researcherYaml = await readFile(researcherPath, "utf8");
      await writeFile(
        researcherPath,
        researcherYaml.replace("skills:\n  - research", "skills: []"),
      );
      const skillPath = path.join(configRoot, "skills", "research", "SKILL.md");
      const skill = await readFile(skillPath, "utf8");
      await writeFile(skillPath, skill.replace("version: 1", "version: 0"));

      const result = await loadCatalog(path.join(configRoot, "myagent.yaml"));
      expect(result.available.map((agent) => agent.id)).toEqual(["researcher"]);
      expect(result.unavailable).toContainEqual(
        expect.objectContaining({ id: "primary", code: "invalid_agent_config" }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
