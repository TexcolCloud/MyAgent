import type { AvailableAgent, CatalogSnapshot } from "./catalog-loader.js";
import { loadCatalog } from "./catalog-loader.js";
import { ApplicationError } from "../domain/errors.js";
import type { AgentId } from "../domain/ids.js";

export class CatalogService {
  #snapshot: CatalogSnapshot;

  constructor(snapshot: CatalogSnapshot) {
    this.#snapshot = snapshot;
  }

  current(): CatalogSnapshot {
    return this.#snapshot;
  }

  revision(): string {
    return catalogRevision(this.#snapshot);
  }

  assertRevision(expectedRevision: string): void {
    if (this.revision() !== expectedRevision) {
      throw new ApplicationError("revision_conflict", 409);
    }
  }

  validate(): Promise<CatalogSnapshot> {
    return loadCatalog(this.#snapshot.configPath);
  }

  reload(): Promise<CatalogSnapshot>;
  reload<Result>(
    prepare: (candidate: CatalogSnapshot) => Result,
  ): Promise<Result>;
  async reload<Result>(
    prepare?: (candidate: CatalogSnapshot) => Result,
  ): Promise<CatalogSnapshot | Result> {
    const candidate = await this.validate();
    assertReloadableGlobal(this.#snapshot, candidate);
    const result = prepare === undefined ? candidate : prepare(candidate);
    this.#snapshot = Object.freeze(candidate);
    return result;
  }

  reloadExpected<Result>(
    expectedRevision: string,
    prepare: (candidate: CatalogSnapshot) => Result,
  ): Promise<Result>;
  async reloadExpected<Result>(
    expectedRevision: string,
    prepare: (candidate: CatalogSnapshot) => Result,
  ): Promise<Result> {
    this.assertRevision(expectedRevision);
    const candidate = await this.validate();
    this.assertRevision(expectedRevision);
    assertReloadableGlobal(this.#snapshot, candidate);
    const result = prepare(candidate);
    this.#snapshot = Object.freeze(candidate);
    return result;
  }

  resolve(agentId: AgentId): AvailableAgent {
    const agent = this.#snapshot.byId.get(agentId);
    if (agent === undefined) {
      throw new ApplicationError("agent_unavailable", 422);
    }
    return agent;
  }
}

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

function catalogRevision(snapshot: CatalogSnapshot): string {
  const canonical = canonicalizeJson({
    sources: snapshot.sources,
    unavailable: snapshot.unavailable,
  });
  if (canonical === undefined) throw new Error("catalog_revision_not_canonicalizable");
  return `catalog_${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertReloadableGlobal(
  active: CatalogSnapshot,
  candidate: CatalogSnapshot,
): void {
  const activeStatic = staticGlobalFields(active);
  const candidateStatic = staticGlobalFields(candidate);
  if (JSON.stringify(activeStatic) !== JSON.stringify(candidateStatic)) {
    throw new ApplicationError("restart_required", 409);
  }
}

function staticGlobalFields(snapshot: CatalogSnapshot): object {
  return {
    version: snapshot.global.version,
    server: {
      host: snapshot.global.server.host,
      port: snapshot.global.server.port,
      bearerToken: snapshot.global.server.bearerToken,
      adminToken: snapshot.global.server.adminToken,
    },
    database: snapshot.global.database,
    toolEnvironmentAllowlist: snapshot.global.toolEnvironmentAllowlist,
    ...(snapshot.global.version === 2
      ? { modelControl: snapshot.global.modelControl }
      : {
          legacyModelImportSourceSha256:
            snapshot.global.legacyModelImport?.sourceSha256 ?? null,
        }),
  };
}
import { createHash } from "node:crypto";

import canonicalizeModule from "canonicalize";
