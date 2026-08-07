import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(os.tmpdir(), "myagent-"));

process.on("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});

export function tempPath(name: string): string {
  return path.join(directory, name);
}
