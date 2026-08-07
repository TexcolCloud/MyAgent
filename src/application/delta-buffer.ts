import type { Clock } from "../ports/clock.js";

export interface DeltaBufferOptions {
  maxBytes: number;
  maxDelayMs: number;
  clock: Clock;
}

export class DeltaBuffer {
  private readonly parts: string[] = [];
  private byteLength = 0;
  private startedAt: number | null = null;

  constructor(private readonly options: DeltaBufferOptions) {
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes <= 0 ||
      !Number.isFinite(options.maxDelayMs) ||
      options.maxDelayMs <= 0
    ) {
      throw new Error("invalid_delta_buffer_options");
    }
  }

  push(text: string): string | null {
    if (text.length === 0) {
      return null;
    }
    const now = this.options.clock.now().getTime();
    this.startedAt ??= now;
    this.parts.push(text);
    this.byteLength += Buffer.byteLength(text);
    if (
      this.byteLength >= this.options.maxBytes ||
      now - this.startedAt >= this.options.maxDelayMs
    ) {
      return this.flush();
    }
    return null;
  }

  flush(): string | null {
    if (this.parts.length === 0) {
      return null;
    }
    const text = this.parts.join("");
    this.parts.length = 0;
    this.byteLength = 0;
    this.startedAt = null;
    return text;
  }
}
