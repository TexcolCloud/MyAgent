import { describe, expect, it } from "vitest";

import { ModelRuntimeRouter } from "../../src/adapters/model/model-runtime-router.js";
import type { ModelChunk, ModelPort, ModelRequest } from "../../src/ports/model.js";
import { providerConnectionRevisionIdFromUuid } from "../../src/domain/ids.js";

describe("ModelRuntimeRouter", () => {
  it("routes a Responses runtime snapshot only to the Responses adapter", async () => {
    let chatCalls = 0;
    let responseCalls = 0;
    const router = new ModelRuntimeRouter({
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
