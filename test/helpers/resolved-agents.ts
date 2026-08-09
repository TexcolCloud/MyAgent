import type { CatalogService } from "../../src/config/catalog-service.js";
import type {
  AgentResolverPort,
  AgentRevisionSnapshot,
  EffectiveModelRuntime,
} from "../../src/domain/agent-revision.js";
import type { AgentId } from "../../src/domain/ids.js";

import {
  TEST_MODEL_PROFILE_REVISION_ID,
  testModelRuntime,
} from "./model-fixtures.js";

export function resolvedAgents(
  catalog: Pick<CatalogService, "resolve">,
  modelOverrides: Partial<EffectiveModelRuntime> = {},
): Pick<AgentResolverPort, "resolve"> {
  return {
    resolve(agentId: AgentId): AgentRevisionSnapshot {
      const definition = catalog.resolve(agentId).definition;
      return {
        ...definition,
        revisionId: `rev_${definition.contentSha256}`,
        modelProfileRevisionId: TEST_MODEL_PROFILE_REVISION_ID,
        model: testModelRuntime(modelOverrides),
      };
    },
  };
}
