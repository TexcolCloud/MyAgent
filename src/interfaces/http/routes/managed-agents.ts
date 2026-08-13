import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CreateManagedAgentService } from "../../../application/create-managed-agent.js";
import { policyRuleSchema } from "../../../config/schemas.js";
import { parseAgentId } from "../../../domain/ids.js";
import { agentIdSchema } from "../schemas.js";
import { parseSchema } from "../schemas.js";

export const createManagedAgentSchema = z.strictObject({
  id: agentIdSchema,
  displayName: z.string().min(1),
  prompt: z.string(),
  workspace: z.string().min(1),
  policy: z.strictObject({ rules: z.array(policyRuleSchema) }),
  expectedCatalogRevision: z.string().min(1),
});

export const createdManagedAgentResponseSchema = z.strictObject({
  catalogRevision: z.string().startsWith("catalog_"),
  agent: z.strictObject({
    id: agentIdSchema,
    displayName: z.string(),
    revisionId: z.string(),
    assignment: z.strictObject({ state: z.literal("unassigned") }),
  }),
});

export function registerManagedAgentRoutes(
  app: FastifyInstance,
  service: CreateManagedAgentService,
): void {
  app.post(
    "/agents",
    { schema: { response: { 201: createdManagedAgentResponseSchema } } },
    async (request, reply) => {
      const input = parseSchema(createManagedAgentSchema, request.body);
      const created = await service.execute({
        ...input,
        policy: { rules: input.policy.rules.map((rule) => ({
          tool: rule.tool,
          effect: rule.effect,
          ...(rule.agent === undefined ? {} : { agent: rule.agent === "*" ? "*" : parseAgentId(rule.agent) }),
          ...(rule.when === undefined ? {} : { when: rule.when }),
        })) },
      });
      return reply.code(201).send(created);
    },
  );
}
