import { describe, expect, it } from "vitest";

import { DeltaBuffer } from "../../src/application/delta-buffer.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("DeltaBuffer", () => {
  it("flushes at 1 KiB or 100 ms, whichever occurs first", () => {
    const clock = new FakeClock();
    const bySize = new DeltaBuffer({ maxBytes: 1_024, maxDelayMs: 100, clock });
    expect(bySize.push("a".repeat(1_023))).toBeNull();
    expect(bySize.push("b")).toBe("a".repeat(1_023) + "b");

    const byTime = new DeltaBuffer({ maxBytes: 1_024, maxDelayMs: 100, clock });
    expect(byTime.push("first")).toBeNull();
    clock.advanceBy(100);
    expect(byTime.push(" second")).toBe("first second");
  });

  it("returns remaining text from flush and never emits empty input", () => {
    const buffer = new DeltaBuffer({
      maxBytes: 8,
      maxDelayMs: 100,
      clock: new FakeClock(),
    });

    expect(buffer.push("")).toBeNull();
    expect(buffer.flush()).toBeNull();
    expect(buffer.push("pending")).toBeNull();
    expect(buffer.flush()).toBe("pending");
    expect(buffer.flush()).toBeNull();
  });
});
