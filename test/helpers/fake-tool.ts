import type { JsonValue } from "../../src/domain/json.js";
import type {
  ToolDefinition,
  ToolPolicyFacts,
  ToolResult,
} from "../../src/ports/tool.js";

export interface FakeToolOptions {
  name: string;
  effect: ToolDefinition["effect"];
  normalizedArguments: JsonValue;
  policyFacts?: ToolPolicyFacts;
  result?: ToolResult;
  activateSkill?: string;
}

export class FakeTool implements ToolDefinition {
  readonly name: string;
  readonly effect: ToolDefinition["effect"];
  readonly description: string;
  readonly inputSchema: JsonValue = { type: "object" };
  executions = 0;

  constructor(private readonly options: FakeToolOptions) {
    this.name = options.name;
    this.effect = options.effect;
    this.description = `Fake ${options.name}`;
  }

  async parseAndNormalize(): Promise<{
    arguments: JsonValue;
    policyFacts: ToolPolicyFacts;
  }> {
    return {
      arguments: this.options.normalizedArguments,
      policyFacts: this.options.policyFacts ?? {},
    };
  }

  async execute(
    _args: JsonValue,
    context: Parameters<ToolDefinition["execute"]>[1],
  ): Promise<ToolResult> {
    this.executions += 1;
    if (this.options.activateSkill !== undefined) {
      context.activateSkill(this.options.activateSkill);
    }
    return this.options.result ?? {
      ok: true,
      summary: `${this.name} completed`,
      content: { completed: true },
      capturedBytes: 0,
      truncated: false,
    };
  }
}
