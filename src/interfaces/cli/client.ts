export interface CliClientOptions {
  baseUrl: string;
  bearerToken?: string;
  adminToken?: string;
  fetcher?: typeof fetch;
}

export class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly traceId: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export class CliCredentialError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly traceId = "cli";

  constructor(authority: "run" | "admin") {
    super(`${authority}_token_required`);
    this.code = `${authority}_token_required`;
    this.detail = authority === "admin"
      ? "Admin authentication is required."
      : "Run authentication is required.";
  }
}

export class CliValidationError extends Error {
  readonly traceId = "cli";

  constructor(readonly code: string, readonly detail: string) {
    super(code);
  }
}

export class CliClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: CliClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
  }

  async request<T>(path: string, init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    authority?: "run" | "admin";
    signal?: AbortSignal;
  } = {}): Promise<T> {
    const authority = init.authority ?? "run";
    const token = authority === "admin" ? this.options.adminToken : this.options.bearerToken;
    if (token === undefined || token.length === 0) throw new CliCredentialError(authority);
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (!response.ok) throw await problem(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    const token = this.options.bearerToken;
    if (token === undefined || token.length === 0) {
      return Promise.reject(new CliCredentialError("run"));
    }
    return this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

async function problem(response: Response): Promise<CliHttpError> {
  try {
    const value = await response.json() as { code?: unknown; detail?: unknown; traceId?: unknown };
    return new CliHttpError(
      response.status,
      typeof value.code === "string" ? value.code : "http_error",
      typeof value.detail === "string" ? value.detail : "The request failed.",
      typeof value.traceId === "string" ? value.traceId : "unknown",
    );
  } catch {
    return new CliHttpError(response.status, "http_error", "The request failed.", "unknown");
  }
}
