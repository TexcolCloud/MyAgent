export interface TtyCapabilities {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export class InteractiveTtyRequiredError extends Error {
  readonly code = "interactive_tty_required";
  readonly detail = "An interactive TTY is required.";
  readonly traceId = "cli";

  constructor() {
    super("interactive_tty_required");
  }
}

export function assertInteractiveTty(capabilities: TtyCapabilities): void {
  if (!capabilities.stdinIsTTY || !capabilities.stdoutIsTTY) {
    throw new InteractiveTtyRequiredError();
  }
}
