import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { CliPrompt } from "../../cli/commands/model-setup.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type ManagedAgentClient = Pick<TuiClient, "listAgents" | "createManagedAgent">;

export class AgentScreen implements Component, Focusable {
  focused = false;
  private agents: readonly { readonly id: string; readonly displayName: string }[] = [];
  private catalogRevision = "";
  private pending = false;
  private reloadRequired = false;
  private review: readonly string[] = [];
  private operation: Promise<unknown> | undefined;
  constructor(private readonly options: { readonly client: ManagedAgentClient; readonly inspector: InspectorScreen; readonly promptFactory?: () => CliPrompt; readonly onChange?: () => void; readonly onAssignments?: () => void; readonly onExit?: () => void }) {}
  async load(): Promise<void> { if (this.operation !== undefined) return; this.pending = true; const operation = this.options.client.listAgents().then((response) => { if (response.catalogRevision === undefined) throw new Error("catalog_revision_unavailable"); this.agents = response.agents; this.catalogRevision = response.catalogRevision; this.reloadRequired = false; this.review = []; }).catch(() => this.options.inspector.showProblem({ code: "agent_list_failed", detail: "Agents are unavailable.", traceId: "tui" })).finally(() => { this.pending = false; if (this.operation === operation) this.operation = undefined; this.changed(); }); this.operation = operation; await operation; }
  async settled(): Promise<void> { await this.operation; }
  handleInput(data: string): void { if (this.pending) return; if (matchesKey(data, "escape")) return this.options.onExit?.(); if (this.reloadRequired) { if (data === "r") void this.load(); return; } if (data === "n") void this.run(() => this.create()); if (data === "a") this.options.onAssignments?.(); this.changed(); }
  render(width: number): string[] { const lines = ["Agents", ...(this.agents.length === 0 ? ["No Agents are available."] : this.agents.map(({ id, displayName }) => `${displayName} (${id})`)), ...this.review, ...(this.reloadRequired ? ["Reload required. Press r."] : ["[n] new Agent  [a] assignments  [Esc] navigation"])]; return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width)); }
  invalidate(): void {}
  private async create(): Promise<void> { const prompt = this.options.promptFactory?.(); if (prompt === undefined) throw new Error("agent_prompt_unavailable"); const id = await prompt.input("Agent ID"); const displayName = await prompt.input("Display name"); const workspace = await prompt.input("Workspace"); const instructions = await prompt.input("Instructions"); this.review = [`Review Agent: ${displayName} (${id})`, `Workspace: ${workspace}`, "Policy rules: 0 (no Tool authority)", "Model Assignment: unassigned", "Confirmation: required"]; this.changed(); if (!await prompt.confirm("Confirm Agent creation?")) return; const created = await this.options.client.createManagedAgent({ id, displayName, prompt: instructions.endsWith("\n") ? instructions : `${instructions}\n`, workspace, policy: { rules: [] }, expectedCatalogRevision: this.catalogRevision }); this.catalogRevision = created.catalogRevision; this.agents = [...this.agents, { id: created.agent.id, displayName: created.agent.displayName }].sort((left, right) => left.id.localeCompare(right.id)); this.review = [`Created Agent: ${created.agent.displayName} (${created.agent.id})`, "Policy rules: 0 (no Tool authority)", "Model Assignment: unassigned", "Confirmation: confirmed"]; }
  private async run(action: () => Promise<void>): Promise<void> { if (this.operation !== undefined || this.reloadRequired) return; this.pending = true; const operation = action().catch((error: unknown) => { if (isRevisionConflict(error)) { this.reloadRequired = true; this.options.inspector.showConflict(); } else this.options.inspector.showProblem({ code: "agent_create_failed", detail: "The Agent was not created.", traceId: "tui" }); }).finally(() => { this.pending = false; if (this.operation === operation) this.operation = undefined; this.changed(); }); this.operation = operation; await operation; }
  private changed(): void { this.options.onChange?.(); }
}
