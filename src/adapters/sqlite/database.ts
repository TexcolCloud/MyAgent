import { DatabaseSync } from "node:sqlite";

export interface OpenDatabaseOptions {
  path: string;
  busyTimeoutMs: number;
}

export interface SqliteDatabase {
  readonly db: DatabaseSync;
  close(): void;
}

export function withImmediateTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
): Result {
  if (database.isTransaction) return operation();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs <= 0) {
    throw new Error("invalid_busy_timeout");
  }

  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);

  return {
    db,
    close(): void {
      db.close();
    },
  };
}
