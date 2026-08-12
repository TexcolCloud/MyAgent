import { describe, expect, it } from "vitest";

import { ModelRuntimeRouter } from "../../src/adapters/model/model-runtime-router.js";
import type { ModelChunk, ModelPort, ModelRequest } from "../../src/ports/model.js";
import { providerConnectionRevisionIdFromUuid } from "../../src/domain/ids.js";

describe("ModelRuntimeRouter", () => {
  it("routes a persisted Pi runtime only to the Pi adapter", async () => {
    let piCalls = 0;
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
      piAi: port(async function* () {
        piCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
      chatCompletions: port(async function* () {
        chatCalls += 1;
        yield* [] as ModelChunk[];
        throw new Error("legacy Chat adapter must not be called");
      }),
      responses: port(async function* () {
        responseCalls += 1;
        yield* [] as ModelChunk[];
        throw new Error("legacy Responses adapter must not be called");
      }),
    });

    const piRuntimeRequest = request("chat_completions");
    piRuntimeRequest.model.piRuntime = {
      kind: "pi_ai",
      piVersion: "0.73.1",
      driverId: "pi/deepseek",
      catalogProviderId: "deepseek",
      api: "openai-completions",
      providerCompatibilityContract: "none",
      modelId: piRuntimeRequest.model.modelId,
      contextWindow: piRuntimeRequest.model.maxInputTokens,
      compatibility: {},
    };

    await expect(collect(router.streamAttempt(piRuntimeRequest, new AbortController().signal)))
      .resolves.toEqual([{ type: "completed", finishReason: "completed" }]);
    expect(piCalls).toBe(1);
    expect(chatCalls).toBe(0);
    expect(responseCalls).toBe(0);
  });

  it("does not fall back to either legacy adapter when the selected Pi adapter fails", async () => {
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
      piAi: port(async function* () {
        yield { type: "text_delta", text: "partial" };
        throw new Error("selected-pi-error");
      }),
      chatCompletions: port(async function* () {
        chatCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
      responses: port(async function* () {
        responseCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
    });
    const piRuntimeRequest = request("responses");
    piRuntimeRequest.model.piRuntime = {
      kind: "pi_ai",
      piVersion: "0.73.1",
      driverId: "pi/deepseek",
      catalogProviderId: "deepseek",
      api: "openai-responses",
      providerCompatibilityContract: "none",
      modelId: piRuntimeRequest.model.modelId,
      contextWindow: piRuntimeRequest.model.maxInputTokens,
      compatibility: {},
    };

    await expect(collect(router.streamAttempt(piRuntimeRequest, new AbortController().signal)))
      .rejects.toThrow("selected-pi-error");
    expect(chatCalls).toBe(0);
    expect(responseCalls).toBe(0);
  });

  it("routes a legacy Chat snapshot only to the old Chat adapter", async () => {
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
      piAi: port(async function* () {
        yield* [] as ModelChunk[];
        throw new Error("Pi adapter must not be called");
      }),
      chatCompletions: port(async function* () {
        chatCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
      responses: port(async function* () {
        responseCalls += 1;
        yield* [] as ModelChunk[];
        throw new Error("Responses adapter must not be called");
      }),
    });

    await expect(collect(router.streamAttempt(request("chat_completions"), new AbortController().signal)))
      .resolves.toEqual([{ type: "completed", finishReason: "completed" }]);
    expect(chatCalls).toBe(1);
    expect(responseCalls).toBe(0);
  });

  it("routes a Responses runtime snapshot only to the Responses adapter", async () => {
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
      piAi: port(async function* () {
        yield* [] as ModelChunk[];
        throw new Error("Pi adapter must not be called");
      }),
      chatCompletions: port(async function* () {
        chatCalls += 1;
        yield { type: "completed", finishReason: "completed" };
        throw new Error("chat adapter must not be called");
      }),
      responses: port(async function* () {
        responseCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
    });

    const chunks = await collect(router.streamAttempt(request("responses"), new AbortController().signal));

    expect(chunks).toEqual([{ type: "completed", finishReason: "completed" }]);
    expect(responseCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });

  it("does not fall back to Chat when the selected Responses adapter fails", async () => {
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
      piAi: port(async function* () {
        yield* [] as ModelChunk[];
        throw new Error("Pi adapter must not be called");
      }),
      chatCompletions: port(async function* () {
        chatCalls += 1;
        yield { type: "completed", finishReason: "completed" };
      }),
      responses: port(async function* () {
        responseCalls += 1;
        yield { type: "text_delta", text: "partial" };
        throw new Error("selected-responses-error");
      }),
    });

    await expect(collect(router.streamAttempt(request("responses"), new AbortController().signal)))
      .rejects.toThrow("selected-responses-error");
    expect(responseCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });
});

function port(
  streamAttempt: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelChunk>,
): ModelPort {
  return { streamAttempt };
}

function request(invocationProtocol: "chat_completions" | "responses"): ModelRequest {
  return {
    purpose: "run",
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid("00000000-0000-7000-8000-000000000501"),
      providerKind: "openai_compatible",
      baseUrl: "https://provider.example/v1",
      providerAuth: { type: "none" },
      allowInsecureHttp: false,
      modelId: "deepseek-v4-flash",
      invocationProtocol,
      maxInputTokens: 8_192,
      verifiedCapabilities: ["streaming_text"],
      compatibilityPresetVersion: "openai-responses-v1",
    },
    input: [{ type: "message", role: "user", content: "Hello" }],
    tools: [],
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
