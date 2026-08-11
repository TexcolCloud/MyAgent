export type CliWrite = (line: string) => void;

export function writeJson(write: CliWrite, value: unknown): void {
  write(JSON.stringify(value));
}

export interface CliProblemOutput {
  readonly code: string;
  readonly detail: string;
  readonly traceId: string;
}

export function writeProblem(write: CliWrite, problem: CliProblemOutput, json: boolean): void {
  if (json) {
    writeJson(write, problem);
    return;
  }
  write(`${problem.code}: ${problem.detail} (traceId: ${problem.traceId})`);
}
