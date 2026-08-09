import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeModelsPage {
  readonly data: readonly unknown[];
  readonly has_more?: boolean;
  readonly last_id?: string;
}

export interface FakeModelsFailure {
  readonly status: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export class FakeOpenAiProvider {
  readonly requests: Array<{ path: string; after?: string }> = [];
  private readonly pages = new Map<string | undefined, FakeModelsPage>();
  private failure: FakeModelsFailure | undefined;
  private delayMs = 0;

  private constructor(private readonly server: Server) {}

  static async start(): Promise<FakeOpenAiProvider> {
    const server = createServer((request, response) => provider.handle(request, response));
    const provider = new FakeOpenAiProvider(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    return provider;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  modelsPages(pages: readonly FakeModelsPage[]): void {
    this.pages.clear();
    for (const [index, page] of pages.entries()) {
      const previous = pages[index - 1];
      this.pages.set(index === 0 ? undefined : previous?.last_id, page);
    }
    this.failure = undefined;
  }

  modelsFailure(failure: FakeModelsFailure): void {
    this.failure = failure;
  }

  delayResponses(milliseconds: number): void {
    this.delayMs = milliseconds;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://provider.test");
    if (request.method !== "GET" || url.pathname !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    const after = url.searchParams.get("after") ?? undefined;
    this.requests.push({ path: url.pathname, ...(after === undefined ? {} : { after }) });
    const failure = this.failure;
    const delay = failure?.delayMs ?? this.delayMs;
    setTimeout(() => {
      if (failure !== undefined) {
        response.writeHead(failure.status, { "content-type": "application/json" });
        response.end(JSON.stringify(failure.body ?? { error: { message: "provider-secret" } }));
        return;
      }
      const page = this.pages.get(after) ?? { data: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", ...page }));
    }, delay);
  }
}
