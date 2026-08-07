import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations", import.meta.url));

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at TEXT NOT NULL
    )
  `);

  const migrations = loadMigrations();
  const highestKnownVersion = migrations.at(-1)?.version ?? 0;
  const appliedVersions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;

  if (appliedVersions.some(({ version }) => version > highestKnownVersion)) {
    throw new Error("database_newer_than_binary");
  }

  const applied = new Set(appliedVersions.map(({ version }) => version));
  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      applyMigration(db, migration);
    }
  }
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .map((name) => {
      const match = /^(\d+)-.+\.sql$/.exec(name);
      const versionText = match?.[1];
      if (versionText === undefined) {
        return null;
      }

      return {
        version: Number.parseInt(versionText, 10),
        sql: readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8"),
      };
    })
    .filter((migration): migration is Migration => migration !== null)
    .sort((left, right) => left.version - right.version);
}

function applyMigration(db: DatabaseSync, migration: Migration): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
    ).run(migration.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
