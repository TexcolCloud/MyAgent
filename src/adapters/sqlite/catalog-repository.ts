import { createHash } from "node:crypto";

import canonicalizeModule from "canonicalize";
import type { DatabaseSync } from "node:sqlite";

import type { AgentRevisionSnapshot } from "../../domain/agent-revision.js";
import type { PiRuntimeContract } from "../../domain/pi-runtime.js";
import { DomainError } from "../../domain/errors.js";
import type { CatalogRevisionStore } from "../../ports/catalog-store.js";

interface StoredRevision {
  content_json: string;
}

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export class SqliteCatalogRepository implements CatalogRevisionStore {
  constructor(private readonly db: DatabaseSync) {}

  save(snapshot: AgentRevisionSnapshot): void {
    const contentJson = canonicalizeJson(snapshot);
    if (contentJson === undefined) {
      throw new Error("revision_not_canonicalizable");
    }

    const contentSha256 = createHash("sha256").update(contentJson).digest("hex");
    const result = this.db
      .prepare(
        `INSERT INTO agent_revisions (
          revision_id, agent_id, content_json, content_sha256, created_at
        ) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(revision_id) DO NOTHING`,
      )
      .run(snapshot.revisionId, snapshot.agentId, contentJson, contentSha256);

    if (result.changes === 0) {
      const existing = this.db
        .prepare("SELECT content_json FROM agent_revisions WHERE revision_id = ?")
        .get(snapshot.revisionId) as StoredRevision | undefined;
      if (existing === undefined || existing.content_json !== contentJson) {
        throw new DomainError("revision_hash_collision");
      }
    }
  }

  get(revisionId: string): AgentRevisionSnapshot | null {
    const row = this.db
      .prepare("SELECT content_json FROM agent_revisions WHERE revision_id = ?")
      .get(revisionId) as StoredRevision | undefined;

    return row === undefined
      ? null
      : normalizeSnapshot(JSON.parse(row.content_json) as AgentRevisionSnapshot);
  }
}

function normalizeSnapshot(snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot {
  const runtime = snapshot.model.piRuntime;
  if (runtime === undefined || runtime.providerCompatibilityContract !== undefined) {
    return snapshot;
  }
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      piRuntime: {
        ...runtime,
        providerCompatibilityContract: "none",
      } as PiRuntimeContract,
    },
  };
}
