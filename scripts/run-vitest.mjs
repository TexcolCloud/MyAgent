import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildVitestArguments } from "./run-vitest-args.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [configuredSuite = "--all", ...forwarded] = process.argv.slice(2);
const filters = buildVitestArguments(configuredSuite, forwarded);
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const child = spawn(process.execPath, [
  vitest,
  "run",
  ...filters,
  "--maxWorkers=1",
  "--fileParallelism=false",
], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1;
});
