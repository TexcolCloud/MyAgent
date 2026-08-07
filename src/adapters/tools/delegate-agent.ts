import { z } from "zod";
import type { DelegateAgentService } from "../../application/delegate-agent.js";
import { DomainError } from "../../domain/errors.js";
import { parseAgentId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { ToolDefinition } from "../../ports/tool.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));
const delegateSchema = z.strictObject({ targetAgentId: z.string(), task: z.string().min(1).max(32_768), context: z.record(z.string(), jsonValueSchema).default({}) });
type DelegateArguments = { targetAgentId: string; task: string; context: Record<string, JsonValue> };
export function createDelegateAgentTool(service: DelegateAgentService): ToolDefinition<DelegateArguments> { return createTool(service); }
export const delegateAgentTool = createTool(undefined);
function createTool(service: DelegateAgentService | undefined): ToolDefinition<DelegateArguments> {
  return { name: "delegate_agent", effect: "side_effect",
    async parseAndNormalize(raw, context) { const parsed = delegateSchema.parse(raw); const targetAgentId = parseAgentId(parsed.targetAgentId); if (!context.revision.delegates.includes(targetAgentId)) throw new DomainError("delegate_not_allowed"); return { arguments: { ...parsed, targetAgentId }, policyFacts: { targetAgentInDelegates: true } }; },
    async execute(args, context) { if (service === undefined) throw new Error("delegate_agent_not_configured"); const child = service.execute({ parentRunId: context.runId, parentToolCallId: context.toolCallId, targetAgentId: parseAgentId(args.targetAgentId), task: args.task, context: args.context, leaseOwner: context.leaseOwner }); const content = { childRunId: child.childRunId, state: "queued" }; return { ok: true, summary: "delegation_started", content, capturedBytes: Buffer.byteLength(JSON.stringify(content), "utf8"), truncated: false, deferred: true }; },
  };
}
