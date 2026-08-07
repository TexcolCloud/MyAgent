import type { JsonValue } from "./json.js";

export class DomainError extends Error {
  readonly details: JsonValue | undefined;

  constructor(code: string, message: string = code, details?: JsonValue) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  readonly code: string;
}
