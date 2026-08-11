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
  while (applyNextMigration(db, migrations)) {
    // Reacquire the write lock and revalidate history before every migration.
  }
}

function applyNextMigration(db: DatabaseSync, migrations: readonly Migration[]): boolean {
  db.exec("PRAGMA foreign_keys = OFF");
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const appliedVersions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    assertForwardOnlyHistory(appliedVersions, migrations);
    const migration = migrations[appliedVersions.length];

    if (migration !== undefined) {
      db.exec(migration.sql);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`migration_foreign_key_violation:${JSON.stringify(violations)}`);
      }
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
      ).run(migration.version);
    }

    db.exec("COMMIT");
    transactionStarted = false;
    return migration !== undefined;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } finally {
        transactionStarted = false;
      }
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function assertForwardOnlyHistory(
  appliedVersions: readonly { version: number }[],
  migrations: readonly Migration[],
): void {
  const highestKnownVersion = migrations.at(-1)?.version ?? 0;
  if (appliedVersions.some(({ version }) => version > highestKnownVersion)) {
    throw new Error("database_newer_than_binary");
  }

  for (const [index, applied] of appliedVersions.entries()) {
    if (migrations[index]?.version !== applied.version) {
      throw new Error("inconsistent_migration_history");
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
