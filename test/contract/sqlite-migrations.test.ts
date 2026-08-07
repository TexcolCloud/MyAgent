import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("SQLite migrations", () => {
  it("migrates an empty database and reopens it with required pragmas", () => {
    const file = tempPath("kernel.db");
    const first = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    try {
      migrate(first.db);
      expect(first.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(first.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      first.close();
    }

    const reopened = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    try {
      migrate(reopened.db);
      expect(reopened.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 1 },
      ]);
    } finally {
      reopened.close();
    }
  });
});
