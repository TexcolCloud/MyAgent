export type CliWrite = (line: string) => void;

export function writeJson(write: CliWrite, value: unknown): void {
  write(JSON.stringify(value));
}
