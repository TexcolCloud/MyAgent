import { afterEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import {
  openDatabase,
  type SqliteDatabase,
  withImmediateTransaction,
} from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import { ApplicationError, DomainError } from "../../src/domain/errors.js";
import { managedSecretVersionIdFromUuid } from "../../src/domain/ids.js";
import type { ManagedSecretVersionId } from "../../src/domain/ids.js";
import { tempPath } from "../helpers/temp-dir.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";

const CURRENT_KEY = "ERERERERERERERERERERERERERERERERERERERERERE=";
const CURRENT_KEY_ID = "mk_AtRJox-7JnyPNS6ZaKeePl_JXBu-qlAv1kVOveWkvtw";
const NEXT_KEY = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=";
const NEXT_KEY_ID = "mk_n3LqDPSVNuPGbHh_cFGG35pDeAg3U66VNtZbOtf83cQ";
const NOW = new Date("2026-08-09T00:00:00.000Z");
const LATER = new Date("2026-08-09T01:00:00.000Z");

interface SecretRow {
  version_id: string;
  secret_id: string;
  purpose: string;
  key_id: string;
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  authentication_tag: Uint8Array | null;
  state: "active" | "destroyed";
  record_revision: number;
  created_at: string;
  destroyed_at: string | null;
}

interface KeyringRow {
  current_key_id: string;
  record_revision: number;
  updated_at: string;
}

const opened: SqliteDatabase[] = [];

afterEach(() => {
  for (const connection of opened.splice(0)) {
    try {
      connection.close();
    } catch {
      // Some restart tests close a connection before opening the next generation.
    }
  }
});

describe("SqliteEncryptedSecretStore", () => {
  it("round trips plaintext while persisting only an AES-GCM envelope and a non-secret key ID", () => {
    const path = tempPath("managed-secret-round-trip.db");
    const { db, store } = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const versionId = version("round-trip");

    const created = store.createVersion({
      versionId,
      secretId: "provider:deepseek:api-key",
      purpose: "provider_api_key",
      plaintext: "deep-secret-needle",
      now: NOW,
    });

    expect(created).toEqual({
      versionId,
      secretId: "provider:deepseek:api-key",
      purpose: "provider_api_key",
      keyId: CURRENT_KEY_ID,
      state: "active",
      recordRevision: 0,
      createdAt: NOW,
      destroyedAt: null,
    });
    expect(store.resolve(versionId)).toBe("deep-secret-needle");

    const row = readSecretRow(db, versionId);
    expect(row.key_id).toBe(CURRENT_KEY_ID);
    expect(Buffer.from(row.nonce!)).toHaveLength(12);
    expect(Buffer.from(row.authentication_tag!)).toHaveLength(16);
    expect(Buffer.from(row.ciphertext!).toString("utf8")).not.toContain(
      "deep-secret-needle",
    );
    const file = readFileSync(path);
    expect(file.includes(Buffer.from("deep-secret-needle", "utf8"))).toBe(false);
    expect(file.includes(Buffer.from(CURRENT_KEY, "utf8"))).toBe(false);
    expect(file.includes(Buffer.alloc(8, 0x11))).toBe(false);
  });

  it("accepts only canonical Base64 that decodes to exactly 32 bytes", () => {
    const accepted = createStore(tempPath("managed-secret-valid-key.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    }).store;
    expect(() => accepted.createVersion(createInput(version("valid"), "valid")))
      .not.toThrow();

    const malformed = [
      "",
      Buffer.alloc(31, 0x11).toString("base64"),
      Buffer.alloc(33, 0x11).toString("base64"),
      CURRENT_KEY.slice(0, -1),
      ` ${CURRENT_KEY}`,
      `${CURRENT_KEY}\n`,
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ];
    for (const [index, encoded] of malformed.entries()) {
      const store = createStore(tempPath(`managed-secret-invalid-key-${index}.db`), {
        MYAGENT_MASTER_KEY: encoded,
      }).store;
      expect(() => store.createVersion(createInput(version(`invalid-${index}`), "value")))
        .toThrowError("secret_locked");
    }
  });

  it("initializes the singleton keyring only with the first successful creation", () => {
    const path = tempPath("managed-secret-keyring-init.db");
    const locked = createStore(path, {}).store;

    expect(() => locked.createVersion(createInput(version("locked"), "value")))
      .toThrowError("secret_locked");
    expect(readKeyring(opened[0]!.db)).toBeUndefined();

    opened[0]!.close();
    const { db, store } = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    store.createVersion(createInput(version("created"), "value"));
    expect(readKeyring(db)).toEqual({
      current_key_id: CURRENT_KEY_ID,
      record_revision: 0,
      updated_at: NOW.toISOString(),
    });
  });

  it("never reuses a random 12-byte nonce", () => {
    const { db, store } = createStore(tempPath("managed-secret-nonces.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });

    for (let index = 0; index < 256; index += 1) {
      store.createVersion(createInput(version(`nonce-${index}`), "same-value"));
    }

    const nonces = (db.prepare(
      "SELECT nonce FROM managed_secret_versions ORDER BY version_id",
    ).all() as unknown as Array<{ nonce: Uint8Array }>).map(({ nonce }) =>
      Buffer.from(nonce).toString("base64"));
    expect(nonces).toHaveLength(256);
    expect(new Set(nonces)).toHaveLength(256);
    expect(nonces.every((nonce) => Buffer.from(nonce, "base64").length === 12)).toBe(true);
  });

  it.each([
    ["secret_id", "provider:tampered:api-key"],
    ["purpose", "different"],
    ["version_id", "msv_tampered-version"],
  ] as const)("authenticates %s as AES-GCM AAD", (column, replacement) => {
    const { db, store } = createStore(tempPath(`managed-secret-aad-${column}.db`), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const originalVersionId = version(`aad-${column}`);
    store.createVersion(createInput(originalVersionId, "aad-secret"));

    if (column === "purpose") db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      `UPDATE managed_secret_versions SET ${column} = ? WHERE version_id = ?`,
    ).run(replacement, originalVersionId);
    if (column === "purpose") db.exec("PRAGMA ignore_check_constraints = OFF");

    const lookup = column === "version_id"
      ? replacement as ManagedSecretVersionId
      : originalVersionId;
    expect(() => store.resolve(lookup)).toThrowError("secret_locked");
  });

  it.each(["ciphertext", "authentication_tag"] as const)(
    "maps %s tampering to the generic locked error",
    (column) => {
      const { db, store } = createStore(tempPath(`managed-secret-tamper-${column}.db`), {
        MYAGENT_MASTER_KEY: CURRENT_KEY,
      });
      const versionId = version(`tamper-${column}`);
      store.createVersion(createInput(versionId, "tamper-secret"));
      const original = readSecretRow(db, versionId)[column]!;
      const tampered = Buffer.from(original);
      tampered[0] = tampered[0]! ^ 0xff;
      db.prepare(
        `UPDATE managed_secret_versions SET ${column} = ? WHERE version_id = ?`,
      ).run(tampered, versionId);

      expect(() => store.resolve(versionId)).toThrowError("secret_locked");
    },
  );

  it("maps missing and wrong key generations to the same locked error", () => {
    const path = tempPath("managed-secret-wrong-key.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const versionId = version("wrong-key");
    initial.store.createVersion(createInput(versionId, "wrong-key-secret"));
    initial.connection.close();

    const missing = createStore(path, {}).store;
    expect(() => missing.resolve(versionId)).toThrowError("secret_locked");
    opened.at(-1)!.close();

    const wrong = createStore(path, { MYAGENT_MASTER_KEY: NEXT_KEY }).store;
    expect(() => wrong.resolve(versionId)).toThrowError("secret_locked");
  });

  it("keeps an existing version immutable when duplicate creation fails", () => {
    const { store } = createStore(tempPath("managed-secret-immutable.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const versionId = version("immutable");
    store.createVersion(createInput(versionId, "original-secret"));

    expect(() => store.createVersion(createInput(versionId, "replacement-secret")))
      .toThrow();
    expect(store.resolve(versionId)).toBe("original-secret");
  });

  it("destroys only the exact revision and overwrites every crypto blob", () => {
    const { db, store } = createStore(tempPath("managed-secret-destroy.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const versionId = version("destroy");
    store.createVersion(createInput(versionId, "destroy-secret"));

    expect(() => store.destroy({ versionId, expectedRevision: 1, now: LATER }))
      .toThrowError(ApplicationError);
    const destroyed = store.destroy({ versionId, expectedRevision: 0, now: LATER });

    expect(destroyed).toMatchObject({
      versionId,
      state: "destroyed",
      recordRevision: 1,
      destroyedAt: LATER,
    });
    const row = readSecretRow(db, versionId);
    expect(row.ciphertext).not.toBeNull();
    expect(Buffer.from(row.ciphertext!)).toHaveLength(0);
    expect(Buffer.from(row.nonce!)).toHaveLength(0);
    expect(Buffer.from(row.authentication_tag!)).toHaveLength(0);
    expect(row.secret_id).toBe("provider:deepseek:api-key");
    expect(row.key_id).toBe(CURRENT_KEY_ID);
    expect(row.created_at).toBe(NOW.toISOString());
    expect(() => store.resolve(versionId)).toThrowError("secret_locked");
    expect(() => store.destroy({ versionId, expectedRevision: 1, now: LATER }))
      .toThrowError("secret_locked");
  });

  it("refuses destruction when the configured master key is missing or wrong", () => {
    for (const [index, environment] of [
      {},
      { MYAGENT_MASTER_KEY: NEXT_KEY },
    ].entries()) {
      const path = tempPath(`managed-secret-destroy-key-${index}.db`);
      const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
      const versionId = version(`destroy-key-${index}`);
      initial.store.createVersion(createInput(versionId, "destroy-locked-secret"));
      initial.connection.close();
      const restarted = createStore(path, environment);

      expect(() => restarted.store.destroy({
        versionId,
        expectedRevision: 0,
        now: LATER,
      })).toThrowError("secret_locked");
      expect(readSecretRow(restarted.db, versionId)).toMatchObject({
        state: "active",
        record_revision: 0,
        destroyed_at: null,
      });
    }
  });

  it("refuses destruction when the Keyring is absent or mismatched", () => {
    for (const [index, mutateKeyring] of [
      (db: DatabaseSync) => db.prepare(
        "DELETE FROM managed_secret_keyring WHERE singleton_id = 1",
      ).run(),
      (db: DatabaseSync) => db.prepare(
        "UPDATE managed_secret_keyring SET current_key_id = ? WHERE singleton_id = 1",
      ).run(NEXT_KEY_ID),
    ].entries()) {
      const { db, store } = createStore(
        tempPath(`managed-secret-destroy-keyring-${index}.db`),
        { MYAGENT_MASTER_KEY: CURRENT_KEY },
      );
      const versionId = version(`destroy-keyring-${index}`);
      store.createVersion(createInput(versionId, "destroy-keyring-secret"));
      mutateKeyring(db);

      expect(() => store.destroy({ versionId, expectedRevision: 0, now: LATER }))
        .toThrowError("secret_locked");
      expect(readSecretRow(db, versionId)).toMatchObject({
        state: "active",
        record_revision: 0,
        destroyed_at: null,
      });
    }
  });

  it("authenticates the envelope before allowing irreversible destruction", () => {
    const { db, store } = createStore(tempPath("managed-secret-destroy-tamper.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const versionId = version("destroy-tamper");
    store.createVersion(createInput(versionId, "destroy-tamper-secret"));
    const ciphertext = Buffer.from(readSecretRow(db, versionId).ciphertext!);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    db.prepare(
      "UPDATE managed_secret_versions SET ciphertext = ? WHERE version_id = ?",
    ).run(ciphertext, versionId);

    expect(() => store.destroy({ versionId, expectedRevision: 0, now: LATER }))
      .toThrowError("secret_locked");
    expect(readSecretRow(db, versionId)).toMatchObject({
      state: "active",
      record_revision: 0,
      destroyed_at: null,
    });
  });

  it("blocks destruction when the real registry retains a reference", () => {
    const { db, store } = createStore(tempPath("managed-secret-referenced.db"), {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const versionId = version("referenced-real-sqlite");
    store.createVersion(createInput(versionId, "referenced-secret"));
    db.prepare(
      `INSERT INTO provider_connections (
         connection_id, display_name, provider_kind, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run("deepseek", "DeepSeek", "deepseek", NOW.toISOString(), NOW.toISOString());
    db.prepare(
      `INSERT INTO provider_connection_revisions (
         revision_id, connection_id, state, base_url, auth_json,
         allow_insecure_http, protocol_preference, preset_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "pcr_referenced",
      "deepseek",
      "draft",
      "https://api.deepseek.example/v1",
      JSON.stringify({
        type: "bearer",
        secret: { managedSecretVersionId: versionId },
      }),
      0,
      "responses",
      "2026-08-09",
      NOW.toISOString(),
    );
    const service = new ManageSecretsService(
      store,
      new SqliteModelRegistryRepository(db),
      new FakeClock(LATER),
      new FakeIds(),
      { run: (operation) => withImmediateTransaction(db, operation) },
    );

    expect(() => service.destroyVersion({ versionId, expectedRevision: 0 }))
      .toThrowError("resource_in_use");
    expect(store.resolve(versionId)).toBe("referenced-secret");
    expect(readSecretRow(db, versionId)).toMatchObject({
      state: "active",
      record_revision: 0,
      destroyed_at: null,
    });
  });

  it("serializes a two-connection reference race before destruction", () => {
    const databasePath = tempPath("managed-secret-reference-race.db");
    const owner = createStore(databasePath, {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const contender = openDatabase({ path: databasePath, busyTimeoutMs: 10 });
    opened.push(contender);
    const versionId = version("reference-race");
    owner.store.createVersion(createInput(versionId, "race-secret"));
    const contenderStore = new SqliteEncryptedSecretStore(contender.db, {
      MYAGENT_MASTER_KEY: CURRENT_KEY,
    });
    const contenderService = new ManageSecretsService(
      contenderStore,
      new SqliteModelRegistryRepository(contender.db),
      new FakeClock(LATER),
      new FakeIds(),
      { run: (operation) => withImmediateTransaction(contender.db, operation) },
    );
    let referenceTransactionOpen = false;
    try {
      owner.db.exec("BEGIN IMMEDIATE");
      referenceTransactionOpen = true;
      owner.db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run("racing", "Racing", "openai", NOW.toISOString(), NOW.toISOString());
      owner.db.prepare(
        `INSERT INTO provider_connection_revisions (
           revision_id, connection_id, state, base_url, auth_json,
           allow_insecure_http, protocol_preference, preset_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "pcr_racing",
        "racing",
        "draft",
        "https://api.openai.example/v1",
        JSON.stringify({
          type: "bearer",
          secret: { managedSecretVersionId: versionId },
        }),
        0,
        "responses",
        "2026-08-09",
        NOW.toISOString(),
      );

      expect(() => contenderService.destroyVersion({
        versionId,
        expectedRevision: 0,
      })).toThrowError(expect.objectContaining({ errcode: 5 }));
      expect(readSecretRow(owner.db, versionId).state).toBe("active");

      owner.db.exec("COMMIT");
      referenceTransactionOpen = false;
      expect(() => contenderService.destroyVersion({
        versionId,
        expectedRevision: 0,
      })).toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: { ownerCategories: ["provider_connection_revision"] },
      }));
      expect(readSecretRow(owner.db, versionId)).toMatchObject({
        state: "active",
        record_revision: 0,
      });
    } finally {
      if (referenceTransactionOpen) owner.db.exec("ROLLBACK");
    }
  });

  it("uses the new key for writes while resolving both generations before rotation", () => {
    const path = tempPath("managed-secret-two-generations.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const oldVersionId = version("old-generation");
    const newVersionId = version("new-generation");
    initial.store.createVersion(createInput(oldVersionId, "old-secret"));
    initial.connection.close();

    const restarted = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });
    expect(restarted.store.resolve(oldVersionId)).toBe("old-secret");
    expect(restarted.store.createVersion(createInput(newVersionId, "new-secret")))
      .toMatchObject({ keyId: NEXT_KEY_ID });
    expect(restarted.store.resolve(newVersionId)).toBe("new-secret");
    expect(readKeyring(restarted.db)).toMatchObject({
      current_key_id: CURRENT_KEY_ID,
      record_revision: 0,
    });
    expect(readSecretRow(restarted.db, oldVersionId).key_id).toBe(CURRENT_KEY_ID);
    expect(readSecretRow(restarted.db, newVersionId).key_id).toBe(NEXT_KEY_ID);

    expect(restarted.store.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toEqual({ reencrypted: 1, currentKeyId: NEXT_KEY_ID, recordRevision: 1 });
    expect(readKeyring(restarted.db)).toMatchObject({
      current_key_id: NEXT_KEY_ID,
      record_revision: 1,
    });
    expect(readSecretRow(restarted.db, oldVersionId)).toMatchObject({
      key_id: NEXT_KEY_ID,
      record_revision: 1,
    });
    expect(readSecretRow(restarted.db, newVersionId)).toMatchObject({
      key_id: NEXT_KEY_ID,
      record_revision: 0,
    });
    expect(restarted.store.resolve(oldVersionId)).toBe("old-secret");
    expect(restarted.store.resolve(newVersionId)).toBe("new-secret");
    restarted.connection.close();

    const currentOnly = createStore(path, { MYAGENT_MASTER_KEY: NEXT_KEY });
    expect(currentOnly.store.resolve(oldVersionId)).toBe("old-secret");
    expect(currentOnly.store.resolve(newVersionId)).toBe("new-secret");
    currentOnly.connection.close();
  });

  it("rotates every active old-key row atomically with fresh nonces", () => {
    const path = tempPath("managed-secret-rotate.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const firstId = version("rotate-first");
    const secondId = version("rotate-second");
    initial.store.createVersion(createInput(firstId, "first-secret"));
    initial.store.createVersion(createInput(secondId, "second-secret"));
    const previousNonces = new Map(
      readActiveRows(initial.db).map((row) => [
        row.version_id,
        Buffer.from(row.nonce!).toString("base64"),
      ]),
    );
    initial.connection.close();

    const rotated = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });
    expect(rotated.store.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toEqual({ reencrypted: 2, currentKeyId: NEXT_KEY_ID, recordRevision: 1 });
    expect(readKeyring(rotated.db)).toEqual({
      current_key_id: NEXT_KEY_ID,
      record_revision: 1,
      updated_at: LATER.toISOString(),
    });
    const rows = readActiveRows(rotated.db);
    expect(rows.every((row) => row.key_id === NEXT_KEY_ID)).toBe(true);
    expect(rows.every((row) => row.record_revision === 1)).toBe(true);
    expect(rows.some((row) => row.key_id === CURRENT_KEY_ID)).toBe(false);
    for (const row of rows) {
      expect(Buffer.from(row.nonce!).toString("base64"))
        .not.toBe(previousNonces.get(row.version_id));
    }
    expect(rotated.store.resolve(firstId)).toBe("first-secret");
    expect(rotated.store.resolve(secondId)).toBe("second-secret");
    expect(() => rotated.store.rotateMasterKey({ expectedRevision: 1, now: LATER }))
      .toThrowError("secret_locked");
    rotated.connection.close();

    const currentOnly = createStore(path, { MYAGENT_MASTER_KEY: NEXT_KEY }).store;
    expect(currentOnly.resolve(firstId)).toBe("first-secret");
    expect(currentOnly.resolve(secondId)).toBe("second-secret");
  });

  it("rejects a valid old envelope replayed after the Keyring advances", () => {
    const path = tempPath("managed-secret-old-envelope-replay.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const versionId = version("old-envelope-replay");
    initial.store.createVersion(createInput(versionId, "old-envelope-secret"));
    const oldEnvelope = readSecretRow(initial.db, versionId);
    initial.connection.close();

    const rotated = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });
    rotated.store.rotateMasterKey({ expectedRevision: 0, now: LATER });
    rotated.db.prepare(
      `UPDATE managed_secret_versions
       SET key_id = ?, ciphertext = ?, nonce = ?, authentication_tag = ?
       WHERE version_id = ?`,
    ).run(
      oldEnvelope.key_id,
      oldEnvelope.ciphertext,
      oldEnvelope.nonce,
      oldEnvelope.authentication_tag,
      versionId,
    );

    expect(() => rotated.store.resolve(versionId)).toThrowError("secret_locked");
  });

  it.each([
    [{ MYAGENT_MASTER_KEY: NEXT_KEY }, "missing previous generation"],
    [{ MYAGENT_MASTER_KEY: CURRENT_KEY, MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY }, "equal generations"],
    [{ MYAGENT_MASTER_KEY: NEXT_KEY, MYAGENT_PREVIOUS_MASTER_KEY: "bad" }, "invalid previous generation"],
  ] as const)("rejects rotation with %s", (environment, description) => {
    const previous = "MYAGENT_PREVIOUS_MASTER_KEY" in environment
      ? environment.MYAGENT_PREVIOUS_MASTER_KEY
      : "none";
    const path = tempPath(`managed-secret-invalid-rotate-${description}-${previous}.db`);
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    initial.store.createVersion(createInput(version("invalid-rotate"), "secret"));
    initial.connection.close();
    const restarted = createStore(path, environment).store;

    expect(() => restarted.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toThrowError("secret_locked");
  });

  it("rejects rotation when the keyring is absent or does not match the previous generation", () => {
    const absent = createStore(tempPath("managed-secret-rotate-absent.db"), {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    }).store;
    expect(() => absent.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toThrowError("secret_locked");

    const path = tempPath("managed-secret-rotate-mismatch.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    initial.store.createVersion(createInput(version("mismatch"), "secret"));
    initial.connection.close();
    const mismatched = createStore(path, {
      MYAGENT_MASTER_KEY: Buffer.alloc(32, 0x33).toString("base64"),
      MYAGENT_PREVIOUS_MASTER_KEY: NEXT_KEY,
    }).store;
    expect(() => mismatched.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toThrowError("secret_locked");
  });

  it("rolls back every row and the keyring when any old envelope fails verification", () => {
    const path = tempPath("managed-secret-rotate-rollback.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const firstId = version("rollback-first");
    const secondId = version("rollback-second");
    initial.store.createVersion(createInput(firstId, "first-secret"));
    initial.store.createVersion(createInput(secondId, "second-secret"));
    const second = readSecretRow(initial.db, secondId);
    const badCiphertext = Buffer.from(second.ciphertext!);
    badCiphertext[0] = badCiphertext[0]! ^ 0xff;
    initial.db.prepare(
      "UPDATE managed_secret_versions SET ciphertext = ? WHERE version_id = ?",
    ).run(badCiphertext, secondId);
    const before = snapshotCryptoRows(initial.db);
    initial.connection.close();

    const restarted = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });
    expect(() => restarted.store.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toThrowError("secret_locked");

    expect(snapshotCryptoRows(restarted.db)).toEqual(before);
    expect(readKeyring(restarted.db)).toEqual({
      current_key_id: CURRENT_KEY_ID,
      record_revision: 0,
      updated_at: NOW.toISOString(),
    });
  });

  it("rolls back an earlier row update when SQLite aborts a later re-encryption", () => {
    const path = tempPath("managed-secret-rotate-sql-rollback.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    const firstId = version("sql-rollback-first");
    const secondId = version("sql-rollback-second");
    initial.store.createVersion(createInput(firstId, "first-secret"));
    initial.store.createVersion(createInput(secondId, "second-secret"));
    initial.db.exec(`
      CREATE TRIGGER force_second_rotation_failure
      BEFORE UPDATE OF key_id ON managed_secret_versions
      FOR EACH ROW
      WHEN OLD.version_id = '${secondId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_rotation_failure');
      END
    `);
    const before = snapshotCryptoRows(initial.db);
    initial.connection.close();

    const restarted = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });
    expect(() => restarted.store.rotateMasterKey({ expectedRevision: 0, now: LATER }))
      .toThrowError("forced_rotation_failure");

    expect(snapshotCryptoRows(restarted.db)).toEqual(before);
    expect(readKeyring(restarted.db)).toEqual({
      current_key_id: CURRENT_KEY_ID,
      record_revision: 0,
      updated_at: NOW.toISOString(),
    });
    expect(restarted.store.resolve(firstId)).toBe("first-secret");
    expect(restarted.store.resolve(secondId)).toBe("second-secret");
  });

  it("rejects a stale Keyring revision before changing any envelope", () => {
    const path = tempPath("managed-secret-rotate-conflict.db");
    const initial = createStore(path, { MYAGENT_MASTER_KEY: CURRENT_KEY });
    initial.store.createVersion(createInput(version("rotate-conflict"), "secret"));
    const before = snapshotCryptoRows(initial.db);
    initial.connection.close();
    const restarted = createStore(path, {
      MYAGENT_MASTER_KEY: NEXT_KEY,
      MYAGENT_PREVIOUS_MASTER_KEY: CURRENT_KEY,
    });

    expect(() => restarted.store.rotateMasterKey({ expectedRevision: 1, now: LATER }))
      .toThrowError(ApplicationError);
    expect(snapshotCryptoRows(restarted.db)).toEqual(before);
    expect(readKeyring(restarted.db)?.record_revision).toBe(0);
  });

  it("uses generic DomainError instances for every locked Secret boundary", () => {
    const { store } = createStore(tempPath("managed-secret-generic-error.db"), {});
    let thrown: unknown;
    try {
      store.resolve(version("missing"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({ code: "secret_locked", message: "secret_locked" });
    expect(String(thrown)).not.toContain("missing");
  });
});

function createStore(
  path: string,
  environment: Readonly<{
    MYAGENT_MASTER_KEY?: string;
    MYAGENT_PREVIOUS_MASTER_KEY?: string;
  }>,
): {
  connection: SqliteDatabase;
  db: DatabaseSync;
  store: SqliteEncryptedSecretStore;
} {
  const connection = openDatabase({ path, busyTimeoutMs: 5_000 });
  opened.push(connection);
  migrate(connection.db);
  return {
    connection,
    db: connection.db,
    store: new SqliteEncryptedSecretStore(connection.db, environment),
  };
}

function version(suffix: string): ManagedSecretVersionId {
  return managedSecretVersionIdFromUuid(suffix);
}

function createInput(versionId: ManagedSecretVersionId, plaintext: string) {
  return {
    versionId,
    secretId: "provider:deepseek:api-key",
    purpose: "provider_api_key" as const,
    plaintext,
    now: NOW,
  };
}

function readSecretRow(db: DatabaseSync, versionId: ManagedSecretVersionId): SecretRow {
  const row = db.prepare(
    `SELECT version_id, secret_id, purpose, key_id, ciphertext, nonce,
            authentication_tag, state, record_revision, created_at, destroyed_at
     FROM managed_secret_versions WHERE version_id = ?`,
  ).get(versionId) as unknown as SecretRow | undefined;
  if (row === undefined) throw new Error("missing_test_secret_row");
  return row;
}

function readActiveRows(db: DatabaseSync): SecretRow[] {
  return db.prepare(
    `SELECT version_id, secret_id, purpose, key_id, ciphertext, nonce,
            authentication_tag, state, record_revision, created_at, destroyed_at
     FROM managed_secret_versions WHERE state = 'active' ORDER BY version_id`,
  ).all() as unknown as SecretRow[];
}

function readKeyring(db: DatabaseSync): KeyringRow | undefined {
  return db.prepare(
    `SELECT current_key_id, record_revision, updated_at
     FROM managed_secret_keyring WHERE singleton_id = 1`,
  ).get() as unknown as KeyringRow | undefined;
}

function snapshotCryptoRows(db: DatabaseSync): Array<{
  versionId: string;
  keyId: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  recordRevision: number;
}> {
  return readActiveRows(db).map((row) => ({
    versionId: row.version_id,
    keyId: row.key_id,
    ciphertext: Buffer.from(row.ciphertext!).toString("base64"),
    nonce: Buffer.from(row.nonce!).toString("base64"),
    tag: Buffer.from(row.authentication_tag!).toString("base64"),
    recordRevision: row.record_revision,
  }));
}
