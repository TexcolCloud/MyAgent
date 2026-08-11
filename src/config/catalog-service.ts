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

  resolve(agentId: AgentId): AvailableAgent {
    const agent = this.#snapshot.byId.get(agentId);
    if (agent === undefined) {
      throw new ApplicationError("agent_unavailable", 422);
    }
    return agent;
  }
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
