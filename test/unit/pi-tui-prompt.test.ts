import type { Component, OverlayHandle } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";

import {
  PiTuiPrompt,
  type PiTuiDialogHost,
} from "../../src/interfaces/tui/pi-tui-prompt.js";

describe("PiTuiPrompt", () => {
  it("never renders a secret answer and clears it before hiding the overlay", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const answer = prompt.secret("API key");
    dialogs.type("provider-key");
    expect(dialogs.renderedText()).not.toContain("provider-key");
    dialogs.submit();

    await expect(answer).resolves.toBe("provider-key");
    expect(dialogs.renderedAtHide()).not.toContain("provider-key");
    expect(dialogs.renderedText()).not.toContain("provider-key");
    dialogs.interactHidden("\u001a");
    expect(dialogs.renderedHidden()).not.toContain("*");
  });

  it("maps Escape to one safe cancellation and accepts a later prompt", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const cancelled = prompt.input("Provider slug");
    dialogs.escape();
    await expect(cancelled).rejects.toMatchObject({ code: "prompt_cancelled" });

    const confirmed = prompt.confirm("Promote?");
    dialogs.select("no");
    await expect(confirmed).resolves.toBe(false);
  });

  it("restores focus when the registered overlay closes", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const answer = prompt.confirm("Promote?");
    dialogs.select("no");

    await expect(answer).resolves.toBe(false);
    expect(dialogs.focusRestored()).toBe(true);
  });

  it("scrubs cancelled secret value, undo, and pending paste state before hiding", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const answer = prompt.secret("API key");
    dialogs.type("provider-key");
    dialogs.escape();

    await expect(answer).rejects.toMatchObject({ code: "prompt_cancelled" });
    expect(dialogs.renderedAtHide()).not.toContain("*");
    dialogs.interactHidden("\u001a");
    expect(dialogs.renderedHidden()).not.toContain("*");
    expect(dialogs.renderedText()).not.toContain("provider-key");
  });

  it("scrubs an incomplete secret paste before Escape removes the overlay", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const answer = prompt.secret("API key");
    dialogs.startPaste("provider-key");
    dialogs.escape();

    await expect(answer).rejects.toMatchObject({ code: "prompt_cancelled" });
    dialogs.interactHidden("\u001b[201~");
    expect(dialogs.renderedHidden()).not.toContain("*");
  });

  it("scrubs a pending secret before programmatic cancellation hides the overlay", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const answer = prompt.secret("API key");
    dialogs.type("provider-key");
    prompt.cancel();

    await expect(answer).rejects.toMatchObject({ code: "prompt_cancelled" });
    expect(dialogs.renderedAtHide()).not.toContain("*");
    dialogs.interactHidden("\u001a");
    expect(dialogs.renderedHidden()).not.toContain("*");
  });

  it("renders disabled catalog choices but cannot select them", async () => {
    const dialogs = fakeDialogs();
    const prompt = new PiTuiPrompt(dialogs);

    const selected = prompt.selectChoice("Catalog model", [
      { value: "pi/deepseek:chat", label: "DeepSeek Chat - Pi catalog" },
      { value: "pi/deepseek:reasoner", label: "DeepSeek Reasoner - Pi catalog", disabled: true },
    ] as const);
    expect(dialogs.renderedText()).toContain("DeepSeek Reasoner - Pi catalog (unsupported credential)");
    dialogs.down();
    dialogs.submit();
    expect(dialogs.hasOverlay()).toBe(true);
    dialogs.up();
    dialogs.submit();

    await expect(selected).resolves.toBe("pi/deepseek:chat");
  });
});

function fakeDialogs(): PiTuiDialogHost & {
  type(value: string): void;
  submit(): void;
  escape(): void;
  select(value: string): void;
  down(): void;
  up(): void;
  renderedText(): string;
  renderedAtHide(): string;
  hasOverlay(): boolean;
  focusRestored(): boolean;
  startPaste(value: string): void;
  interactHidden(value: string): void;
  renderedHidden(): string;
} {
  let component: Component | undefined;
  let focused: Component | undefined;
  const previousFocus: Component = { render: () => [], invalidate: () => undefined };
  focused = previousFocus;
  let hiddenRender = "";
  let hiddenComponent: Component | undefined;
  const handle: OverlayHandle = {
    hide: () => {
      hiddenRender = component?.render(80).join("\n") ?? "";
      hiddenComponent = component;
      if (focused === component) focused = previousFocus;
      component = undefined;
    },
    setHidden: () => undefined,
    isHidden: () => false,
    focus: () => undefined,
    unfocus: () => undefined,
    isFocused: () => true,
  };
  return {
    terminal: { rows: 24 },
    showOverlay: (next) => {
      component = next;
      return handle;
    },
    setFocus: (next) => {
      if (focused !== undefined && "focused" in focused) {
        (focused as Component & { focused: boolean }).focused = false;
      }
      focused = next ?? undefined;
      if (focused !== undefined && "focused" in focused) {
        (focused as Component & { focused: boolean }).focused = true;
      }
    },
    requestRender: () => undefined,
    type: (value) => focused?.handleInput?.(value),
    submit: () => focused?.handleInput?.("\r"),
    escape: () => focused?.handleInput?.("\u001b"),
    select: (value) => {
      if (value === "no") focused?.handleInput?.("\u001b[B");
      focused?.handleInput?.("\r");
    },
    down: () => focused?.handleInput?.("\u001b[B"),
    up: () => focused?.handleInput?.("\u001b[A"),
    renderedText: () => component?.render(80).join("\n") ?? "",
    renderedAtHide: () => hiddenRender,
    hasOverlay: () => component !== undefined,
    focusRestored: () => focused === previousFocus,
    startPaste: (value) => focused?.handleInput?.(`\u001b[200~${value}`),
    interactHidden: (value) => hiddenComponent?.handleInput?.(value),
    renderedHidden: () => hiddenComponent?.render(80).join("\n") ?? "",
  };
}
