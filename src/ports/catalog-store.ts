import type { AgentRevisionSnapshot } from "../domain/agent-revision.js";

export interface CatalogRevisionStore {
  save(snapshot: AgentRevisionSnapshot): void;
  get(revisionId: string): AgentRevisionSnapshot | null;
}
