export interface CliClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetcher?: typeof fetch;
}

export class CliHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

export class CliClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: CliClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        ...(init.idempotencyKey === undefined ? {} : { "idempotency-key": init.idempotencyKey }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw await problem(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  stream(path: string, lastEventId?: string): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
    });
  }
}

async function problem(response: Response): Promise<CliHttpError> {
  try {
    const value = await response.json() as { code?: unknown; detail?: unknown };
    return new CliHttpError(response.status, typeof value.code === "string" ? value.code : "http_error", typeof value.detail === "string" ? value.detail : "The request failed.");
  } catch {
    return new CliHttpError(response.status, "http_error", "The request failed.");
  }
}
