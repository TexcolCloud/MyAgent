import type { ToolDefinition } from "../../ports/tool.js";

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate Tool: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }
}
