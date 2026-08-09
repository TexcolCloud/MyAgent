import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup as backupDatabase, type DatabaseSync } from "node:sqlite";

import type { BackupManifest, BackupSummary, BackupWriter } from "../../application/create-backup.js";
import type { CatalogSourceFile } from "../../config/catalog-loader.js";
import { ApplicationError, DomainError } from "../../domain/errors.js";

const DATABASE_FILE = "kernel.db";
const MANIFEST_FILE = "manifest.json";

export class SqliteBackupWriter implements BackupWriter {
  constructor(private readonly database: DatabaseSync) {}

  async create(input: {
    destination: string;
    catalog: Parameters<BackupWriter["create"]>[0]["catalog"];
    occurredAt: Date;
  }): Promise<BackupSummary> {
    const destination = path.resolve(input.destination);
    if (await exists(destination)) throw new ApplicationError("backup_destination_exists", 409);

    const parent = path.dirname(destination);
    const name = path.basename(destination);
    const partial = path.join(parent, `.${name}.partial-${randomUUID()}`);
    assertPartialTarget(parent, name, partial);
    await mkdir(partial);
    try {
      await backupDatabase(this.database, path.join(partial, DATABASE_FILE));
      for (const source of input.catalog.sources) await writeCatalogSource(partial, source);

      const files = [DATABASE_FILE, ...input.catalog.sources.map((source) => source.relativePath)].sort();
      const sha256: Record<string, string> = {};
      for (const file of files) {
        sha256[file] = createHash("sha256").update(await readFile(resolveBackupFile(partial, file))).digest("hex");
      }
      const activeRevisionIds = input.catalog.available
        .map((agent) => agent.definition.definitionRevisionId)
        .sort();
      const manifest: BackupManifest = {
        schemaVersion: 1,
        createdAt: input.occurredAt.toISOString(),
        database: DATABASE_FILE,
        files,
        sha256,
        activeRevisionIds,
      };
      await writeFile(path.join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await rename(partial, destination);
      return { destination, database: DATABASE_FILE, fileCount: files.length, activeRevisionIds };
    } catch (error) {
      await removePartial(parent, name, partial);
      if (isDestinationCollision(error)) {
        throw new ApplicationError("backup_destination_exists", 409);
      }
      throw error;
    }
  }
}

async function writeCatalogSource(root: string, source: CatalogSourceFile): Promise<void> {
  const destination = resolveBackupFile(root, source.relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source.content, { flag: "wx" });
}

function resolveBackupFile(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new DomainError("invalid_backup_source_path");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === ".." || normalized.startsWith("../")) {
    throw new DomainError("invalid_backup_source_path");
  }
  const destination = path.resolve(root, ...relativePath.split("/"));
  const confined = path.relative(root, destination);
  if (path.isAbsolute(confined) || confined === ".." || confined.startsWith(`..${path.sep}`)) {
    throw new DomainError("invalid_backup_source_path");
  }
  return destination;
}

function assertPartialTarget(parent: string, name: string, partial: string): void {
  if (path.dirname(partial) !== parent || !path.basename(partial).startsWith(`.${name}.partial-`)) {
    throw new DomainError("invalid_backup_partial_path");
  }
}

async function removePartial(parent: string, name: string, partial: string): Promise<void> {
  assertPartialTarget(parent, name, partial);
  await rm(partial, { recursive: true, force: true });
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isDestinationCollision(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}
