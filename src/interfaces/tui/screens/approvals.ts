import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import { safeDisplayLines } from "../safe-display-text.js";
import type {
  ApprovalDecision,
  PendingApproval,
  TuiClient,
} from "../tui-client.js";

type ApprovalClient = Pick<TuiClient, "listPendingApprovals" | "decideApproval">;

export class ApprovalScreen implements Component, Focusable {
  focused = false;
  private approvals: readonly PendingApproval[] = [];
  private selectedIndex = 0;
  private pending = false;
  private operation: Promise<unknown> | undefined;
  private outcome: ApprovalDecision | undefined;
  private problem: { readonly code: string; readonly detail: string } | undefined;

  constructor(private readonly options: {
    readonly client: ApprovalClient;
    readonly onChange?: () => void;
    readonly onExit?: () => void;
  }) {}

  get controlsEnabled(): boolean {
    return !this.pending && this.selected !== undefined;
  }

  async load(): Promise<void> {
    if (this.operation !== undefined) return;
    const operation = this.loadPending();
    this.operation = operation;
    try { await operation; } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  async settled(): Promise<void> {
    await this.operation;
  }

  private async loadPending(): Promise<void> {
    this.pending = true;
    this.problem = undefined;
    this.outcome = undefined;
    this.changed();
    try {
      const response = await this.options.client.listPendingApprovals();
      this.approvals = response.approvals;
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.approvals.length - 1));
    } catch (error) {
      this.problem = safeProblem(error, "approval_list_failed", "Pending Approvals are unavailable.");
    } finally {
      this.pending = false;
      this.changed();
    }
  }

  async select(approvalId: string): Promise<boolean> {
    const index = this.approvals.findIndex((approval) => approval.approvalId === approvalId);
    if (index < 0 || this.pending) return false;
    this.selectedIndex = index;
    this.outcome = undefined;
    this.problem = undefined;
    this.changed();
    return true;
  }

  async decide(decision: "approved" | "denied"): Promise<boolean> {
    const selected = this.selected;
    if (selected === undefined || this.pending) return false;
    const operation = this.dispatch(selected, decision);
    this.operation = operation;
    try { return await operation; } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  private async dispatch(selected: PendingApproval, decision: "approved" | "denied"): Promise<boolean> {
    this.pending = true;
    this.problem = undefined;
    this.changed();
    try {
      this.outcome = await this.options.client.decideApproval(
        selected.approvalId,
        decision === "approved" ? "approve" : "deny",
      );
      return true;
    } catch (error) {
      this.problem = safeProblem(error, "approval_decision_failed", "The Approval decision was not accepted.");
      return false;
    } finally {
      this.pending = false;
      this.changed();
    }
  }

  handleInput(data: string): void {
    if (this.pending) return;
    if (matchesKey(data, "escape")) {
      this.options.onExit?.();
      return;
    }
    if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (matchesKey(data, "down")) this.selectedIndex = Math.min(this.approvals.length - 1, this.selectedIndex + 1);
    if (data === "y") void this.decide("approved");
    if (data === "n") void this.decide("denied");
    this.changed();
  }

  render(width: number): string[] {
    const lines = ["Approvals"];
    if (this.problem !== undefined) lines.push(this.problem.code, this.problem.detail);
    if (this.outcome !== undefined) {
      lines.push(`Server state: ${this.outcome.state}`, `Approval ${this.outcome.approvalId}`);
    } else if (this.approvals.length === 0) {
      lines.push(this.pending ? "Loading..." : "No pending Approvals.");
    } else {
      lines.push(...this.approvals.map((approval, index) => `${index === this.selectedIndex ? ">" : " "} ${approval.toolName} (${approval.approvalId})`));
      const selected = this.selected;
      if (selected !== undefined) {
        lines.push(`Tool Call: ${selected.toolCallId}`);
        lines.push(...safeDisplayLines(`Arguments: ${JSON.stringify(selected.arguments)}`));
        lines.push(...safeDisplayLines(`Expires: ${selected.expiresAt}`));
        if (selected.riskNotice !== undefined) lines.push(...safeDisplayLines(selected.riskNotice));
        lines.push(this.pending ? "Decision pending..." : "[y] approve  [n] deny  [Esc] close");
      }
    }
    return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private get selected(): PendingApproval | undefined {
    return this.approvals[this.selectedIndex];
  }

  private changed(): void { this.options.onChange?.(); }
}

function safeProblem(
  error: unknown,
  fallbackCode: string,
  fallbackDetail: string,
): { readonly code: string; readonly detail: string } {
  if (typeof error !== "object" || error === null) return { code: fallbackCode, detail: fallbackDetail };
  const candidate = error as { code?: unknown; detail?: unknown };
  return {
    code: safeDisplayLines(typeof candidate.code === "string" ? candidate.code : fallbackCode).join(" ") || fallbackCode,
    detail: safeDisplayLines(typeof candidate.detail === "string" ? candidate.detail : fallbackDetail).join(" ") || fallbackDetail,
  };
}
