import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import type { ModelVerificationResponse } from "../../http/model-control-schemas.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type VerificationClient = Pick<TuiClient, "verifyModel" | "getModelVerificationAt" | "cancelModelVerification">;

export class VerificationScreen implements Component, Focusable {
  focused = false;
  private verification: ModelVerificationResponse | undefined;
  private mutationPending = false;
  private reloadRequired = false;
  private controller: AbortController | undefined;
  private mutation: Promise<unknown> | undefined;
  private polling: Promise<unknown> | undefined;

  constructor(private readonly options: {
    readonly client: VerificationClient;
    readonly inspector: InspectorScreen;
    readonly promptFactory?: () => CliPrompt;
    readonly onChange?: () => void;
    readonly onExit?: () => void;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  }) {}

  async settled(): Promise<void> { await this.mutation; await this.polling; }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.controller?.abort();
      this.options.onExit?.();
      return;
    }
    if (this.reloadRequired) return;
    if (data === "q" && !this.mutationPending && this.polling === undefined) void this.runMutation(() => this.queue());
    if (data === "x" && !this.mutationPending) void this.runMutation(() => this.cancel());
    this.changed();
  }
  render(width: number): string[] { const current = this.verification; const lines = ["Verifications", ...(current === undefined ? ["No Verification selected."] : [`${current.verificationId} (${current.status})`, `Profile revision: ${current.profileRevisionId}`, `Capabilities: ${current.capabilities.length === 0 ? "none" : current.capabilities.join(", ")}`]), ...(this.reloadRequired ? ["Reload required."] : ["[q] queue  [x] cancel  [Esc] navigation"])]; return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width)); }
  invalidate(): void {}
  private async queue(): Promise<void> {
    const prompt = this.prompt();
    const profileRevisionId = required(await prompt.input("Profile revision ID"));
    const expectedRevision = revision(await prompt.input("Profile record revision"));
    const queued = await this.options.client.verifyModel(profileRevisionId, {
      expectedRevision,
      capabilityBaseline: "text_and_single_tool_call_v1",
    });
    this.options.inspector.showVerification({ verificationId: queued.verificationId, profileRevisionId: queued.profileRevisionId, status: queued.status, capabilities: [], confirmation: "confirmed" });
    this.startPolling(queued.operationUrl);
  }

  private async cancel(): Promise<void> {
    const current = this.verification;
    if (current === undefined || terminal(current.status)) return;
    const prompt = this.prompt();
    this.options.inspector.showVerification({ verificationId: current.verificationId, profileRevisionId: current.profileRevisionId, status: current.status, capabilities: current.capabilities, confirmation: "required" });
    if (!await prompt.confirm("Cancel this Verification?")) return;
    this.controller?.abort();
    this.verification = await this.options.client.cancelModelVerification(current.verificationId, { expectedRevision: current.recordRevision });
    this.options.inspector.showVerification({ verificationId: this.verification.verificationId, profileRevisionId: this.verification.profileRevisionId, status: this.verification.status, capabilities: this.verification.capabilities, confirmation: "confirmed" });
  }

  private startPolling(operationUrl: string): void {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const polling = this.poll(operationUrl, controller.signal).catch((error: unknown) => {
      if ((error as Error).message !== "verification_poll_cancelled") this.showProblem(error);
    }).finally(() => {
      if (this.polling === polling) this.polling = undefined;
      this.changed();
    });
    this.polling = polling;
  }

  private async poll(operationUrl: string, signal: AbortSignal): Promise<ModelVerificationResponse> {
    while (!signal.aborted) {
      const current = await this.options.client.getModelVerificationAt(operationUrl);
      if (signal.aborted || this.controller?.signal !== signal) {
        throw new Error("verification_poll_cancelled");
      }
      this.verification = current;
      this.options.inspector.showVerification({ verificationId: current.verificationId, profileRevisionId: current.profileRevisionId, status: current.status, capabilities: current.capabilities, confirmation: "confirmed" });
      this.changed();
      if (terminal(current.status)) return current;
      await (this.options.sleep ?? sleep)(250);
    }
    throw new Error("verification_poll_cancelled");
  }

  private async runMutation(action: () => Promise<void>): Promise<void> {
    if (this.mutation !== undefined || this.reloadRequired) return;
    this.mutationPending = true;
    const mutation = action().catch((error: unknown) => this.showProblem(error)).finally(() => {
      this.mutationPending = false;
      if (this.mutation === mutation) this.mutation = undefined;
      this.changed();
    });
    this.mutation = mutation;
    await mutation;
  }

  private showProblem(error: unknown): void {
    if (isRevisionConflict(error)) {
      this.reloadRequired = true;
      this.options.inspector.showConflict();
      return;
    }
    this.options.inspector.showProblem({ code: "verification_operation_failed", detail: "The Verification operation was not accepted.", traceId: "tui" });
  }
  private prompt(): CliPrompt { const prompt = this.options.promptFactory?.(); if (prompt === undefined) throw new Error("verification_prompt_unavailable"); return prompt; }
  private changed(): void { this.options.onChange?.(); }
}

function terminal(status: ModelVerificationResponse["status"]): boolean { return status === "passed" || status === "failed" || status === "cancelled"; }
function required(value: string): string { const normalized = value.trim(); if (normalized.length === 0) throw new Error("verification_input_invalid"); return normalized; }
function revision(value: string): number { const result = Number(value); if (!Number.isInteger(result) || result < 0) throw new Error("verification_input_invalid"); return result; }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
