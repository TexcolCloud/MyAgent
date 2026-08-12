import { describe, expect, it } from "vitest";

import { assertInteractiveTty } from "../../src/interfaces/tui/tty.js";

describe("assertInteractiveTty", () => {
  it("rejects TUI startup when stdin is not a TTY", () => {
    expect(() => assertInteractiveTty({ stdinIsTTY: false, stdoutIsTTY: true }))
      .toThrow(expect.objectContaining({ code: "interactive_tty_required" }));
  });

  it("rejects TUI startup when stdout is not a TTY", () => {
    expect(() => assertInteractiveTty({ stdinIsTTY: true, stdoutIsTTY: false }))
      .toThrow(expect.objectContaining({ code: "interactive_tty_required" }));
  });

  it("accepts an interactive stdin and stdout pair", () => {
    expect(() => assertInteractiveTty({ stdinIsTTY: true, stdoutIsTTY: true })).not.toThrow();
  });
});
