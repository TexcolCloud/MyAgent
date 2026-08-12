import {
  Box,
  CURSOR_MARKER,
  decodeKittyPrintable,
  Editor,
  matchesKey,
  SelectList,
  Text,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@mariozechner/pi-tui";

import {
  CliPromptCancelledError,
  type CliPrompt,
  type CliPromptChoice,
} from "../cli/commands/model-setup.js";

export interface PiTuiDialogHost {
  readonly terminal: { readonly rows: number };
  showOverlay(component: Component): OverlayHandle;
  setFocus(component: Component | null): void;
  requestRender(force?: boolean): void;
}

const theme: SelectListTheme = {
  selectedPrefix: (value) => `> ${value}`,
  selectedText: (value) => value,
  description: (value) => value,
  scrollInfo: (value) => value,
  noMatch: (value) => value,
};

export class PiTuiPrompt implements CliPrompt {
  private pending = false;

  constructor(private readonly dialogs: PiTuiDialogHost) {}

  select<T extends string>(message: string, choices: readonly T[]): Promise<T> {
    return this.selectChoice(message, choices.map((value) => ({ value, label: value })));
  }

  selectChoice<T extends string>(message: string, choices: readonly CliPromptChoice<T>[]): Promise<T> {
    return this.open<T>((finish, cancel) => {
      const items: SelectItem[] = choices.map((choice) => ({
        value: choice.value,
        label: choice.disabled === true
          ? `${choice.label} (unsupported credential)`
          : choice.label,
        ...(choice.description === undefined ? {} : { description: choice.description }),
      }));
      const list = new SelectList(items, Math.min(8, Math.max(1, items.length)), theme);
      list.onSelect = (item) => {
        const choice = choices.find((candidate) => candidate.value === item.value);
        if (choice?.disabled === true) {
          this.dialogs.requestRender();
          return;
        }
        finish(item.value as T);
      };
      list.onCancel = cancel;
      return modal(message, list);
    });
  }

  input(message: string, initial?: string): Promise<string> {
    return this.editor(message, initial ?? "");
  }

  secret(message: string): Promise<string> {
    return this.open<string>((finish, cancel) => modal(
      "",
      new MaskedSecretInput(message, finish, cancel),
    ));
  }

  confirm(message: string): Promise<boolean> {
    return this.selectChoice(message, [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ] as const).then((value) => value === "yes");
  }

  private editor(message: string, initial: string): Promise<string> {
    return this.open<string>((finish, cancel) => {
      const editor = new Editor(this.dialogs as unknown as TUI, {
        borderColor: (value) => value,
        selectList: theme,
      }, { paddingX: 0 });
      editor.setText(initial);
      return modal("", new DialogEditor(message, editor, finish, cancel));
    });
  }

  private open<T>(create: (
    finish: (value: T, clear?: () => void) => void,
    cancel: (clear?: () => void) => void,
  ) => Component): Promise<T> {
    if (this.pending) return Promise.reject(new Error("pi_tui_prompt_already_pending"));
    this.pending = true;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const overlay: { handle?: OverlayHandle } = {};
      const close = (complete: () => void, clear?: () => void) => {
        if (settled) return;
        settled = true;
        clear?.();
        overlay.handle?.hide();
        this.pending = false;
        complete();
      };
      const dialog = create(
        (value, clear) => close(() => resolve(value), clear),
        (clear) => close(() => reject(new CliPromptCancelledError()), clear),
      );
      overlay.handle = this.dialogs.showOverlay(dialog);
      this.dialogs.setFocus(dialog);
      this.dialogs.requestRender();
    });
  }
}

class DialogEditor implements Component, Focusable {
  constructor(
    protected readonly message: string,
    protected readonly editor: Editor,
    private readonly finish: (value: string, clear?: () => void) => void,
    protected readonly cancel: (clear?: () => void) => void,
  ) {
    editor.onSubmit = (value) => finish(value);
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.cancel();
    else this.editor.handleInput(data);
  }

  render(width: number): string[] {
    return [this.message, ...this.editor.render(width)];
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

class MaskedSecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  private cursor = 0;
  private pasteBuffer = "";
  private receivingPaste = false;
  private scrubbed = false;

  constructor(
    private readonly message: string,
    private readonly finish: (value: string) => void,
    private readonly cancel: () => void,
  ) {}

  handleInput(data: string): void {
    if (this.scrubbed) return;
    if (matchesKey(data, "escape")) {
      this.scrub();
      this.cancel();
      return;
    }
    if (this.consumePaste(data)) return;
    if (matchesKey(data, "enter") || data === "\n") {
      const answer = this.value;
      this.scrub();
      this.finish(answer);
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return;
    }
    if (matchesKey(data, "delete")) {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      return;
    }
    if (matchesKey(data, "left")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, "end")) {
      this.cursor = this.value.length;
      return;
    }
    const printable = decodeKittyPrintable(data) ?? printableText(data);
    if (printable !== undefined) this.insert(printable);
  }

  render(): string[] {
    if (this.scrubbed) return [this.message, ""];
    const masked = "*".repeat(this.value.length);
    if (!this.focused) return [this.message, masked];
    return [this.message, `${masked.slice(0, this.cursor)}${CURSOR_MARKER}${masked.slice(this.cursor)}`];
  }

  invalidate(): void {}

  private consumePaste(data: string): boolean {
    if (data.includes("\u001b[200~")) {
      this.receivingPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\u001b[200~", "");
    }
    if (!this.receivingPaste) return false;
    this.pasteBuffer += data;
    const end = this.pasteBuffer.indexOf("\u001b[201~");
    if (end === -1) return true;
    const pasted = this.pasteBuffer.slice(0, end);
    const remaining = this.pasteBuffer.slice(end + 6);
    this.pasteBuffer = "";
    this.receivingPaste = false;
    this.insert(pasted);
    if (remaining.length > 0) this.handleInput(remaining);
    return true;
  }

  private insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  private scrub(): void {
    this.value = "";
    this.cursor = 0;
    this.pasteBuffer = "";
    this.receivingPaste = false;
    this.scrubbed = true;
  }
}

class DialogOverlay implements Component, Focusable {
  private readonly box = new Box(1, 1);

  constructor(title: string, private readonly child: Component) {
    if (title.length > 0) this.box.addChild(new Text(title));
    this.box.addChild(child);
  }

  get focused(): boolean {
    return "focused" in this.child && this.child.focused === true;
  }

  set focused(value: boolean) {
    if ("focused" in this.child) {
      (this.child as Component & Focusable).focused = value;
    }
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}

function modal(title: string, child: Component): DialogOverlay {
  return new DialogOverlay(title, child);
}

function printableText(data: string): string | undefined {
  return data.length > 0 && !data.includes("\u001b") && [...data].every((character) => character >= " ")
    ? data
    : undefined;
}
