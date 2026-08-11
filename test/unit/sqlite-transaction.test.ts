import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import * as databaseAdapter from "../../src/adapters/sqlite/database.js";

type ImmediateTransaction = <Result>(
  database: DatabaseSync,
  operation: () => Result,
) => Result;

describe("withImmediateTransaction", () => {
  it("commits standalone work and rolls nested work back with its outer transaction", () => {
    const transact = (databaseAdapter as {
      withImmediateTransaction?: ImmediateTransaction;
    }).withImmediateTransaction;
    expect(transact).toBeTypeOf("function");
    if (transact === undefined) return;

    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE values_under_test (value TEXT NOT NULL)");
      transact(database, () => {
        database.prepare(
          "INSERT INTO values_under_test (value) VALUES ('committed')",
        ).run();
      });

      expect(() => transact(database, () => {
        database.prepare(
          "INSERT INTO values_under_test (value) VALUES ('outer')",
        ).run();
        transact(database, () => {
          database.prepare(
            "INSERT INTO values_under_test (value) VALUES ('nested')",
          ).run();
        });
        throw new Error("late_transaction_failure");
      })).toThrow("late_transaction_failure");

      expect(database.isTransaction).toBe(false);
      expect(database.prepare(
        "SELECT value FROM values_under_test ORDER BY rowid",
      ).all()).toEqual([{ value: "committed" }]);
    } finally {
      database.close();
    }
  });
});
