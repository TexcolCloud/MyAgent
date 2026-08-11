import type { ModelChunk, ModelPort, ModelRequest } from "../../ports/model.js";

export interface ModelRuntimeRouterOptions {
  piAi: ModelPort;
  chatCompletions: ModelPort;
  responses: ModelPort;
}

export class ModelRuntimeRouter implements ModelPort {
  constructor(private readonly options: ModelRuntimeRouterOptions) {}

  streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    if (request.model.piRuntime !== undefined) {
      return this.options.piAi.streamAttempt(request, signal);
    }
    return request.model.invocationProtocol === "responses"
      ? this.options.responses.streamAttempt(request, signal)
      : this.options.chatCompletions.streamAttempt(request, signal);
  }
}
