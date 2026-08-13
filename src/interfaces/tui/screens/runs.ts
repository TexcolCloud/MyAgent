import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type RunView, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type RunHistoryClient = Pick<TuiClient, "listRunHistory" | "getRun" | "cancelRun">;

export class RunsScreen implements Component, Focusable {
  focused = false;
  private items: readonly RunView[] = [];
  private nextCursor: string | undefined;
  private selected = 0;
  private selectedDetail: RunView | undefined;
  private loading = false;
  private reloadRequired = false;
  private filter: { agentId: string; sessionKey: string } | undefined;
  private operation: Promise<void> | undefined;

  constructor(private readonly options: { readonly client: RunHistoryClient; readonly inspector: InspectorScreen; readonly promptFactory: () => CliPrompt; readonly onChange?: () => void; readonly onExit?: () => void }) {}

  async load(next = false): Promise<void> {
    if (this.loading || this.filter === undefined || (next && this.nextCursor === undefined)) return;
    this.loading = true; this.changed();
    try {
      const page = await this.options.client.listRunHistory({ ...this.filter, limit: 50, ...(next && this.nextCursor !== undefined ? { cursor: this.nextCursor } : {}) });
      this.items = next ? [...this.items, ...page.items] : page.items;
      this.nextCursor = page.nextCursor;
      this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
      this.reloadRequired = false;
    } catch { this.problem("run_history_unavailable", "Run history is unavailable."); } finally { this.loading = false; this.changed(); }
  }

  async loadFor(agentId: string, sessionKey: string): Promise<void> {
    this.filter = { agentId, sessionKey };
    this.nextCursor = undefined;
    this.items = [];
    this.selected = 0;
    await this.load();
  }

  handleInput(data: string): void {
    if (this.loading || this.operation !== undefined) return;
    if (matchesKey(data, "escape")) { this.options.onExit?.(); return; }
    if (this.reloadRequired) { if (data === "r") void this.load(); return; }
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (matchesKey(data, "enter")) void this.detail();
    else if (data === "f") void this.configure();
    else if (data === "x") void this.cancelSelected();
    else if (data === "r") void this.load();
    else if (data === "n") void this.load(true);
    this.changed();
  }

  render(width: number): string[] {
    const filter = this.filter === undefined ? "No filter selected." : `${this.filter.agentId} / ${this.filter.sessionKey}`;
    const rows = this.items.length === 0 ? [this.loading ? "Loading..." : "No Runs found."] : this.items.map((item, index) => `${index === this.selected ? ">" : " "} ${item.runId} ${item.status} ${item.updatedAt}`);
    return ["Runs", filter, ...rows, ...this.detailLines(), ...(this.reloadRequired ? ["Reload required. Press r."] : ["[f] filter  [Enter] detail  [x] cancel  [n] next page  [r] reload  [Esc] navigation"])]
      .flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }
  invalidate(): void {}
  async settled(): Promise<void> { await this.operation; }

  private async configure(): Promise<void> {
    const prompt = this.options.promptFactory();
    const agentId = (await prompt.input("Agent ID", this.filter?.agentId)).trim();
    const sessionKey = (await prompt.input("Session Key", this.filter?.sessionKey)).trim();
    if (agentId.length === 0 || sessionKey.length === 0) return;
    this.filter = { agentId, sessionKey }; this.nextCursor = undefined; this.items = []; this.selected = 0;
    this.selectedDetail = undefined;
    await this.load();
  }

  private async detail(): Promise<void> {
    const item = this.items[this.selected]; if (item === undefined) return;
    await this.track(async () => { const detail = await this.options.client.getRun(item.runId); this.selectedDetail = detail; this.replace(detail); });
  }

  private async cancelSelected(): Promise<void> {
    const item = this.items[this.selected]; if (item === undefined) return;
    await this.track(async () => {
      const detail = await this.options.client.getRun(item.runId);
      if (["completed", "failed", "cancelled"].includes(detail.status)) { this.replace(detail); return; }
      if (!await this.options.promptFactory().confirm(`Cancel Run ${detail.runId}?`)) return;
      await this.options.client.cancelRun(detail.runId, detail.updatedAt);
      this.replace(await this.options.client.getRun(detail.runId));
    });
  }

  private async track(action: () => Promise<void>): Promise<void> {
    const operation = action().catch((error: unknown) => {
      if (isRevisionConflict(error)) { this.reloadRequired = true; this.options.inspector.showConflict(); }
      else this.problem("run_operation_failed", "The Run operation was not accepted.");
    }).finally(() => { if (this.operation === operation) this.operation = undefined; this.changed(); });
    this.operation = operation; await operation;
  }
  private replace(detail: RunView): void { this.items = this.items.map((item) => item.runId === detail.runId ? detail : item); if (this.selectedDetail?.runId === detail.runId) this.selectedDetail = detail; this.changed(); }
  private detailLines(): readonly string[] {
    const detail = this.selectedDetail;
    if (detail === undefined) return [];
    const lines = [`Detail: ${detail.runId}`, `State: ${detail.status}`, `Updated: ${detail.updatedAt}`];
    if (detail.status === "completed") return [...lines, ...displayResult(detail.result)];
    if (detail.status === "failed") return [...lines, `Failure: ${detail.failure?.code ?? "run_failed"}`];
    return [...lines, "Run is not terminal."];
  }
  private problem(code: string, detail: string): void { this.options.inspector.showProblem({ code, detail, traceId: "tui" }); }
  private changed(): void { this.options.onChange?.(); }
}

function displayResult(result: RunView["result"]): readonly string[] {
  if (typeof result === "object" && result !== null && !Array.isArray(result) && result.type === "text" && typeof result.text === "string") return safeDisplayLines(result.text);
  return ["Result: recorded."];
}
