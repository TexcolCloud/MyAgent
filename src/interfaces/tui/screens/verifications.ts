import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import type { ModelVerificationResponse } from "../../http/model-control-schemas.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type VerificationClient = Pick<TuiClient, "verifyModel" | "getModelVerification" | "cancelModelVerification">;

export class VerificationScreen implements Component, Focusable {
  focused = false;
  private verification: ModelVerificationResponse | undefined;
  private pending = false;
  private reloadRequired = false;
  private controller: AbortController | undefined;
  private operation: Promise<unknown> | undefined;
  constructor(private readonly options: { readonly client: VerificationClient; readonly inspector: InspectorScreen; readonly promptFactory?: () => CliPrompt; readonly onChange?: () => void; readonly onExit?: () => void; readonly sleep?: (milliseconds: number) => Promise<void> }) {}
  async settled(): Promise<void> { await this.operation; }
  handleInput(data: string): void { if (matchesKey(data, "escape")) { this.controller?.abort(); this.options.onExit?.(); return; } if (this.pending) return; if (this.reloadRequired) return; if (data === "q") void this.run(() => this.queue()); if (data === "x") void this.run(() => this.cancel()); this.changed(); }
  render(width: number): string[] { const current = this.verification; const lines = ["Verifications", ...(current === undefined ? ["No Verification selected."] : [`${current.verificationId} (${current.status})`, `Profile revision: ${current.profileRevisionId}`, `Capabilities: ${current.capabilities.length === 0 ? "none" : current.capabilities.join(", ")}`]), ...(this.reloadRequired ? ["Reload required."] : ["[q] queue  [x] cancel  [Esc] navigation"])]; return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width)); }
  invalidate(): void {}
  private async queue(): Promise<void> { const prompt = this.prompt(); const revisionId = (await prompt.input("Profile revision ID")).trim(); const expectedRevision = Number(await prompt.input("Profile record revision")); if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || revisionId.length === 0) throw new Error("verification_input_invalid"); const queued = await this.options.client.verifyModel(revisionId, { expectedRevision, capabilityBaseline: "text_and_single_tool_call_v1" }); this.options.inspector.showVerification({ verificationId: queued.verificationId, profileRevisionId: queued.profileRevisionId, status: queued.status, capabilities: [], confirmation: "confirmed" }); this.controller = new AbortController(); this.verification = await this.poll(queued.verificationId, this.controller.signal); }
  private async cancel(): Promise<void> { const current = this.verification; if (current === undefined || terminal(current.status)) return; const prompt = this.prompt(); this.options.inspector.showVerification({ verificationId: current.verificationId, profileRevisionId: current.profileRevisionId, status: current.status, capabilities: current.capabilities, confirmation: "required" }); if (!await prompt.confirm("Cancel this Verification?")) return; this.controller?.abort(); this.verification = await this.options.client.cancelModelVerification(current.verificationId, { expectedRevision: current.recordRevision }); this.options.inspector.showVerification({ verificationId: this.verification.verificationId, profileRevisionId: this.verification.profileRevisionId, status: this.verification.status, capabilities: this.verification.capabilities, confirmation: "confirmed" }); }
  private async poll(verificationId: string, signal: AbortSignal): Promise<ModelVerificationResponse> { while (!signal.aborted) { const current = await this.options.client.getModelVerification(verificationId); this.verification = current; this.options.inspector.showVerification({ verificationId: current.verificationId, profileRevisionId: current.profileRevisionId, status: current.status, capabilities: current.capabilities, confirmation: "confirmed" }); this.changed(); if (terminal(current.status)) return current; await (this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(250); } throw new Error("verification_poll_cancelled"); }
  private async run(action: () => Promise<void>): Promise<void> { if (this.operation !== undefined || this.reloadRequired) return; this.pending = true; const operation = action().catch((error: unknown) => { if (isRevisionConflict(error)) { this.reloadRequired = true; this.options.inspector.showConflict(); } else if ((error as Error).message !== "verification_poll_cancelled") this.options.inspector.showProblem({ code: "verification_operation_failed", detail: "The Verification operation was not accepted.", traceId: "tui" }); }).finally(() => { this.pending = false; if (this.operation === operation) this.operation = undefined; this.changed(); }); this.operation = operation; await operation; }
  private prompt(): CliPrompt { const prompt = this.options.promptFactory?.(); if (prompt === undefined) throw new Error("verification_prompt_unavailable"); return prompt; }
  private changed(): void { this.options.onChange?.(); }
}

function terminal(status: ModelVerificationResponse["status"]): boolean { return status === "passed" || status === "failed" || status === "cancelled"; }
