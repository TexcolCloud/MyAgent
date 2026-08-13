import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import { safeDisplayLines } from "../safe-display-text.js";
import type {
  ApprovalDecision,
  PendingApproval,
  TuiClient,
} from "../tui-client.js";
import type { JsonValue } from "../../../domain/json.js";

type ApprovalClient = Pick<TuiClient, "listPendingApprovals" | "decideApproval">;

interface SafePendingApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentSummary: readonly string[];
  readonly expiresAt: string;
  readonly riskNotice?: string;
}

export class ApprovalScreen implements Component, Focusable {
  focused = false;
  private approvals: readonly SafePendingApproval[] = [];
  private selectedIndex = 0;
  private pending = false;
  private operation: Promise<unknown> | undefined;
  private outcome: ApprovalDecision | undefined;
  private problem: { readonly code: string; readonly detail: string } | undefined;
  private locked = false;

  constructor(private readonly options: {
    readonly client: ApprovalClient;
    readonly onChange?: () => void;
    readonly onExit?: () => void;
  }) {}

  get controlsEnabled(): boolean {
    return !this.pending && !this.locked && this.selected !== undefined;
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
    this.locked = false;
    this.changed();
    try {
      const response = await this.options.client.listPendingApprovals();
      this.approvals = response.approvals.map(projectApproval);
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
    if (index < 0 || this.pending || this.locked) return false;
    this.selectedIndex = index;
    this.outcome = undefined;
    this.problem = undefined;
    this.changed();
    return true;
  }

  async decide(decision: "approved" | "denied"): Promise<boolean> {
    const selected = this.selected;
    if (selected === undefined || this.pending || this.locked) return false;
    const operation = this.dispatch(selected, decision);
    this.operation = operation;
    try { return await operation; } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  private async dispatch(selected: SafePendingApproval, decision: "approved" | "denied"): Promise<boolean> {
    this.pending = true;
    this.problem = undefined;
    this.changed();
    try {
      this.outcome = await this.options.client.decideApproval(
        selected.approvalId,
        decision === "approved" ? "approve" : "deny",
      );
      this.retire(selected.approvalId);
      this.locked = true;
      return true;
    } catch (error) {
      this.problem = safeProblem(error, "approval_decision_failed", "The Approval decision was not accepted.");
      if (problemCode(error) === "approval_already_resolved") {
        this.retire(selected.approvalId);
        this.locked = true;
      }
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
    if (this.locked) return;
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
        lines.push(`Run: ${selected.runId}`);
        lines.push(`Tool Call: ${selected.toolCallId}`);
        lines.push("Argument shape:", ...selected.argumentSummary);
        lines.push(...safeDisplayLines(`Expires: ${selected.expiresAt}`));
        if (selected.riskNotice !== undefined) lines.push(...safeDisplayLines(selected.riskNotice));
        lines.push(this.pending ? "Decision pending..." : "[y] approve  [n] deny  [Esc] close");
      }
    }
    return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private get selected(): SafePendingApproval | undefined {
    return this.approvals[this.selectedIndex];
  }

  private retire(approvalId: string): void {
    this.approvals = this.approvals.filter((approval) => approval.approvalId !== approvalId);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.approvals.length - 1));
  }

  private changed(): void { this.options.onChange?.(); }
}

function projectApproval(approval: PendingApproval): SafePendingApproval {
  return {
    approvalId: approval.approvalId,
    runId: approval.runId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    argumentSummary: summarizeArguments(approval.arguments),
    expiresAt: approval.expiresAt,
    ...(approval.riskNotice === undefined
      ? {}
      : { riskNotice: safeDisplayLines(approval.riskNotice).join(" ") }),
  };
}

function summarizeArguments(value: JsonValue): readonly string[] {
  if (!isObject(value)) return [`root: ${shape(value)}`];
  const summary: string[] = [];
  for (const [key, nested] of Object.entries(value)) summarizeValue(nested, key, summary);
  return summary.length === 0 ? ["object (empty)"] : summary;
}

function summarizeValue(value: JsonValue, path: string, summary: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      summary.push(`${path}[]: empty`);
      return;
    }
    const shapes = [...new Set(value.map(shape))];
    for (const itemShape of shapes) summary.push(`${path}[]: ${itemShape}`);
    const object = value.find(isObject);
    if (object !== undefined) {
      for (const [key, nested] of Object.entries(object)) summarizeValue(nested, `${path}[].${key}`, summary);
    }
    return;
  }
  if (isObject(value)) {
    summary.push(`${path}: object`);
    for (const [key, nested] of Object.entries(value)) summarizeValue(nested, `${path}.${key}`, summary);
    return;
  }
  summary.push(`${path}: ${shape(value)}`);
}

function shape(value: JsonValue): "array" | "object" | "null" | "string" | "number" | "boolean" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
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
