import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { SkillSnapshot } from "../domain/agent-revision.js";
import { DomainError } from "../domain/errors.js";
import { skillFrontmatterSchema } from "./schemas.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export interface SkillCatalog {
  available: ReadonlyMap<string, SkillSnapshot>;
  unavailable: ReadonlyMap<string, DomainError>;
}

export async function loadSkills(
  configuredRoots: readonly string[],
): Promise<ReadonlyMap<string, SkillSnapshot>> {
  const catalog = await loadSkillCatalog(configuredRoots);
  const firstError = catalog.unavailable.values().next().value as
    | DomainError
    | undefined;
  if (firstError !== undefined) {
    throw firstError;
  }
  return catalog.available;
}

export async function loadSkillCatalog(
  configuredRoots: readonly string[],
): Promise<SkillCatalog> {
  const available = new Map<string, SkillSnapshot>();
  const unavailable = new Map<string, DomainError>();

  for (const configuredRoot of configuredRoots) {
    const root = await realpath(configuredRoot);
    for (const candidate of await discoverSkillFiles(root)) {
      try {
        const file = await confinedSkillFile(root, candidate.file);
        const skill = parseSkillMarkdown(await readFile(file, "utf8"));
        if (available.has(skill.name) || unavailable.has(skill.name)) {
          available.delete(skill.name);
          unavailable.set(
            skill.name,
            new DomainError(
              "duplicate_skill_name",
              `duplicate_skill_name: ${skill.name}`,
            ),
          );
          continue;
        }
        available.set(skill.name, skill);
      } catch (error) {
        unavailable.set(candidate.name, asSkillError(error));
      }
    }
  }

  return {
    available,
    unavailable,
  };
}

export function parseSkillMarkdown(source: string): SkillSnapshot {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (match === null) {
    throw new DomainError("invalid_skill", "invalid_skill: missing leading frontmatter");
  }

  try {
    const metadata = skillFrontmatterSchema.parse(parseYaml(match[1] ?? ""));
    return Object.freeze({
      ...metadata,
      requiredTools: Object.freeze(metadata.requiredTools),
      body: match[2] ?? "",
      contentSha256: createHash("sha256").update(source).digest("hex"),
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "invalid_skill",
      "invalid_skill: invalid frontmatter",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
}

interface SkillFileCandidate {
  name: string;
  file: string;
}

async function discoverSkillFiles(root: string): Promise<SkillFileCandidate[]> {
  const candidates: SkillFileCandidate[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      candidates.push({ name: path.basename(root), file: path.join(root, entry.name) });
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      candidates.push({
        name: entry.name,
        file: path.join(root, entry.name, "SKILL.md"),
      });
    }
  }

  return candidates.sort((left, right) => left.file.localeCompare(right.file));
}

async function confinedSkillFile(root: string, candidate: string): Promise<string> {
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    throw new DomainError(
      "invalid_skill",
      "invalid_skill: missing SKILL.md",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }

  const relative = path.relative(root, canonicalCandidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new DomainError("skill_root_escape", "skill_root_escape");
  }

  return canonicalCandidate;
}

function asSkillError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  return new DomainError(
    "invalid_skill",
    "invalid_skill",
    { cause: error instanceof Error ? error.message : "unknown" },
  );
}
