import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadSkills,
  parseSkillMarkdown,
} from "../../src/config/skill-loader.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/config", import.meta.url));

describe("loadSkills", () => {
  it("parses strict frontmatter and retains the complete Skill body", async () => {
    const skills = await loadSkills([path.join(FIXTURE_ROOT, "valid", "skills")]);
    const research = skills.get("research");

    expect(research).toMatchObject({
      name: "research",
      description: "Research a question using cited local sources.",
      version: 1,
      requiredTools: ["read_file"],
    });
    expect(research?.body).toBe(
      "Use the available local sources and preserve source paths in the answer.\n",
    );
    expect(research?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a Skill symlink or junction that escapes its configured root", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-skill-root-"));
    const root = path.join(temporary, "skills");
    await mkdir(root);

    try {
      const outside = path.join(FIXTURE_ROOT, "escaped-skill", "outside", "research");
      await symlink(outside, path.join(root, "research"), process.platform === "win32" ? "junction" : "dir");

      await expect(loadSkills([root])).rejects.toMatchObject({
        code: "skill_root_escape",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects non-positive versions and duplicate Skill names", async () => {
    expect(() =>
      parseSkillMarkdown("---\nname: bad\ndescription: Invalid\nversion: 0\n---\nbody\n"),
    ).toThrowError(expect.objectContaining({ code: "invalid_skill" }));

    const root = path.join(FIXTURE_ROOT, "valid", "skills");
    await expect(loadSkills([root, root])).rejects.toMatchObject({
      code: "duplicate_skill_name",
    });
  });
});
