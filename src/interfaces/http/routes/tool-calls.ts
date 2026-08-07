import type { FastifyInstance } from "fastify";

import type { ReconcileToolCallService } from "../../../application/reconcile-tool-call.js";
import type { ToolCallId } from "../../../domain/ids.js";
import type { JsonValue } from "../../../domain/json.js";
import { identifierSchema, parseSchema, reconciliationResponseSchema, reconciliationSchema } from "../schemas.js";

export function registerToolCallRoutes(app: FastifyInstance, reconcileTools: ReconcileToolCallService): void {
  app.post("/tool-calls/:toolCallId/reconciliation", { schema: { response: { 200: reconciliationResponseSchema } } }, async (request) => {
    const toolCallId = parseSchema(identifierSchema, (request.params as { toolCallId: unknown }).toolCallId) as ToolCallId;
    const body = parseSchema(reconciliationSchema, request.body);
    const result = reconcileTools.execute({
      toolCallId,
      outcome: body.outcome,
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.result === undefined ? {} : { result: body.result as JsonValue }),
    });
    return { toolCallId: result.toolCall.toolCallId, state: result.toolCall.state, ...(result.retryToolCallId === undefined ? {} : { retryToolCallId: result.retryToolCallId }) };
  });
}
