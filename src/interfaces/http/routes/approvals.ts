import type { FastifyInstance } from "fastify";

import type { DecideApprovalService } from "../../../application/decide-approval.js";
import type { ApprovalStore } from "../../../ports/approval-store.js";
import type { ReconciliationStore } from "../../../ports/tool-store.js";
import type { ApprovalId } from "../../../domain/ids.js";
import { approvalDecisionResponseSchema, approvalsResponseSchema, decisionSchema, identifierSchema, parseSchema } from "../schemas.js";

export function registerApprovalRoutes(app: FastifyInstance, services: { approvals: Pick<ApprovalStore, "listPending">; decideApprovals: DecideApprovalService; tools: Pick<ReconciliationStore, "get"> }): void {
  app.get("/approvals", { schema: { response: { 200: approvalsResponseSchema } } }, async (request) => {
    const status = (request.query as { status?: unknown }).status;
    if (status !== undefined && status !== "pending") throw new Error("invalid_request");
    return { approvals: services.approvals.listPending().map((approval) => {
      const tool = services.tools.get(approval.toolCallId);
      return { approvalId: approval.approvalId, runId: approval.runId, toolCallId: approval.toolCallId, state: approval.state, toolName: tool.toolName, arguments: tool.arguments, expiresAt: approval.expiresAt.toISOString(), ...(tool.toolName === "run_command" ? { riskNotice: "This command runs on the host and is not isolated by an OS sandbox." } : {}) };
    }) };
  });
  app.post("/approvals/:approvalId/decision", { schema: { response: { 200: approvalDecisionResponseSchema } } }, async (request) => {
    const approvalId = parseSchema(identifierSchema, (request.params as { approvalId: unknown }).approvalId) as ApprovalId;
    const { decision } = parseSchema(decisionSchema, request.body);
    const approval = services.decideApprovals.execute({ approvalId, decision });
    return { approvalId: approval.approvalId, runId: approval.runId, state: approval.state, resolvedAt: approval.resolvedAt?.toISOString() ?? null };
  });
}
