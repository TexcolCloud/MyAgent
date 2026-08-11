import type { ModelChunk, ModelPort, ModelRequest } from "../../ports/model.js";

export interface ModelRuntimeRouterOptions {
  chatCompletions: ModelPort;
  responses: ModelPort;
}

export class ModelRuntimeRouter implements ModelPort {
  constructor(private readonly options: ModelRuntimeRouterOptions) {}

  streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    return request.model.invocationProtocol === "responses"
      ? this.options.responses.streamAttempt(request, signal)
      : this.options.chatCompletions.streamAttempt(request, signal);
  }
}
