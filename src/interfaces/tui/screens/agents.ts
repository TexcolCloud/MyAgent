import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type ManagedAgentClient = Pick<TuiClient, "listAgents"> & Partial<Pick<TuiClient, "createManagedAgent">>;
type AgentSummary = { readonly id: string; readonly displayName: string };

interface AgentScreenOptions {
  readonly client: ManagedAgentClient;
  readonly inspector: InspectorScreen;
  readonly promptFactory?: () => CliPrompt;
  readonly onChange?: () => void;
  readonly onAssignments?: () => void;
  readonly onExit?: () => void;
}

export class AgentScreen implements Component, Focusable {
  focused = false;
  private agents: readonly AgentSummary[] = [];
  private catalogRevision = "";
  private pending = false;
  private reloadRequired = false;
  private review: readonly string[] = [];
  private operation: Promise<unknown> | undefined;

  constructor(private readonly options: AgentScreenOptions) {}

  async load(): Promise<void> {
    if (this.operation !== undefined) return;
    await this.trackOperation(this.loadAgents(), false);
  }

  async settled(): Promise<void> {
    await this.operation;
  }

  handleInput(data: string): void {
    if (this.pending) return;
    if (matchesKey(data, "escape")) {
      this.options.onExit?.();
      return;
    }
    if (this.reloadRequired) {
      if (data === "r") void this.load();
      return;
    }
    if (data === "n" && this.options.client.createManagedAgent !== undefined) void this.runCreate();
    if (data === "a") this.options.onAssignments?.();
    this.changed();
  }

  render(width: number): string[] {
    const agents = this.agents.length === 0
      ? ["No Agents are available."]
      : this.agents.map(({ id, displayName }) => `${displayName} (${id})`);
    const actions = this.reloadRequired
      ? ["Reload required. Press r."]
      : [this.options.client.createManagedAgent === undefined
        ? "[a] assignments  [Esc] navigation"
        : "[n] new Agent  [a] assignments  [Esc] navigation"];
    return ["Agents", ...agents, ...this.review, ...actions]
      .flatMap(safeDisplayLines)
      .map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private async loadAgents(): Promise<void> {
    try {
      const response = await this.options.client.listAgents();
      this.agents = response.agents;
      this.catalogRevision = response.catalogRevision ?? "";
      this.reloadRequired = false;
      this.review = [];
    } catch {
      this.options.inspector.showProblem({
        code: "agent_list_failed",
        detail: "Agents are unavailable.",
        traceId: "tui",
      });
    }
  }

  private async runCreate(): Promise<void> {
    if (this.operation !== undefined || this.reloadRequired) return;
    await this.trackOperation(this.create(), true);
  }

  private async create(): Promise<void> {
    const prompt = this.prompt();
    const id = await prompt.input("Agent ID");
    const displayName = await prompt.input("Display name");
    const workspace = await prompt.input("Workspace");
    const instructions = await prompt.input("Instructions");
    this.review = creationReview(id, displayName, workspace);
    this.changed();
    if (!await prompt.confirm("Confirm Agent creation?")) return;

    const createManagedAgent = this.options.client.createManagedAgent;
    if (createManagedAgent === undefined || this.catalogRevision.length === 0) throw new Error("agent_create_unavailable");
    const created = await createManagedAgent({
      id,
      displayName,
      prompt: instructions.endsWith("\n") ? instructions : `${instructions}\n`,
      workspace,
      policy: { rules: [] },
      expectedCatalogRevision: this.catalogRevision,
    });
    this.catalogRevision = created.catalogRevision;
    this.agents = [...this.agents, {
      id: created.agent.id,
      displayName: created.agent.displayName,
    }].sort((left, right) => left.id.localeCompare(right.id));
    this.review = createdReview(created.agent.id, created.agent.displayName);
  }

  private async trackOperation(operation: Promise<void>, handleConflict: boolean): Promise<void> {
    this.pending = true;
    const tracked = operation
      .catch((error: unknown) => this.showOperationError(error, handleConflict))
      .finally(() => {
        this.pending = false;
        if (this.operation === tracked) this.operation = undefined;
        this.changed();
      });
    this.operation = tracked;
    await tracked;
  }

  private showOperationError(error: unknown, handleConflict: boolean): void {
    if (handleConflict && isRevisionConflict(error)) {
      this.reloadRequired = true;
      this.options.inspector.showConflict();
      return;
    }
    this.options.inspector.showProblem({
      code: handleConflict ? "agent_create_failed" : "agent_list_failed",
      detail: handleConflict ? "The Agent was not created." : "Agents are unavailable.",
      traceId: "tui",
    });
  }

  private prompt(): CliPrompt {
    const prompt = this.options.promptFactory?.();
    if (prompt === undefined) throw new Error("agent_prompt_unavailable");
    return prompt;
  }

  private changed(): void {
    this.options.onChange?.();
  }
}

function creationReview(id: string, displayName: string, workspace: string): readonly string[] {
  return [
    `Review Agent: ${displayName} (${id})`,
    `Workspace: ${workspace}`,
    "Policy rules: 0 (no Tool authority)",
    "Model Assignment: unassigned",
    "Confirmation: required",
  ];
}

function createdReview(id: string, displayName: string): readonly string[] {
  return [
    `Created Agent: ${displayName} (${id})`,
    "Policy rules: 0 (no Tool authority)",
    "Model Assignment: unassigned",
    "Confirmation: confirmed",
  ];
}
