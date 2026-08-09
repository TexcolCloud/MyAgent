import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  abortError,
  firstHeader,
  protocolError,
  providerError,
} from "./provider-http-response-policy.js";

export async function writeRequestBody(
  body: ReadableStream<Uint8Array>,
  request: ClientRequest,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  let cancellationStarted = false;
  try {
    while (true) {
      const result = await readRequestBodyChunk(reader, request, signal);
      if (result.done) break;
      if (!request.write(result.value)) {
        await waitForRequestDrain(request, signal);
      }
    }
    request.end();
  } catch (error) {
    cancellationStarted = true;
    void reader.cancel()
      .catch(() => undefined)
      .then(() => releaseRequestBodyReader(reader));
    request.destroy();
    throw error;
  } finally {
    if (!cancellationStarted) releaseRequestBodyReader(reader);
  }
}

export function responseFromIncoming(
  message: IncomingMessage,
  requestMethod: string,
  maxResponseBytes: number,
  deadline: number,
  signal: AbortSignal,
): Response {
  const status = message.statusCode;
  if (status === undefined) {
    message.destroy();
    throw protocolError();
  }
  const contentEncoding = firstHeader(message.headers["content-encoding"]);
  if (
    contentEncoding !== undefined &&
    contentEncoding.trim().toLowerCase() !== "identity"
  ) {
    message.destroy();
    throw protocolError(status);
  }
  const declaredLength = Number(firstHeader(message.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    message.destroy();
    throw protocolError(status);
  }

  const hasNoBody =
    requestMethod === "HEAD" || status === 204 || status === 205 || status === 304;
  const body = hasNoBody
    ? null
    : incomingBody(message, maxResponseBytes, deadline, signal);
  if (hasNoBody) message.resume();
  return new Response(body, {
    status,
    statusText: "",
    headers: responseHeaders(message.headers),
  });
}

type RequestBodyReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

async function readRequestBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  request: ClientRequest,
  signal: AbortSignal,
): Promise<RequestBodyReadResult> {
  if (signal.aborted) throw abortError();
  return new Promise<RequestBodyReadResult>((resolve, reject) => {
    const onAbort = (): void => finishReject(abortError());
    const onError = (error: unknown): void => finishReject(error);
    const cleanup = (): void => {
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (result: RequestBodyReadResult): void => {
      cleanup();
      resolve(result);
    };
    const finishReject = (error: unknown): void => {
      cleanup();
      reject(error);
    };

    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(finishResolve, finishReject);
  });
}

function releaseRequestBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read will be released after cancellation settles.
  }
}

async function waitForRequestDrain(
  request: ClientRequest,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortError();
  return new Promise<void>((resolve, reject) => {
    const onDrain = (): void => finishResolve();
    const onError = (error: unknown): void => finishReject(error);
    const onAbort = (): void => finishReject(abortError());
    const cleanup = (): void => {
      request.off("drain", onDrain);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (): void => {
      cleanup();
      resolve();
    };
    const finishReject = (error: unknown): void => {
      cleanup();
      reject(error);
    };

    request.once("drain", onDrain);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function incomingBody(
  message: IncomingMessage,
  maxResponseBytes: number,
  deadline: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let received = 0;
      let closed = false;
      const remainingMs = deadline - Date.now();
      const finish = (action: () => void): void => {
        if (closed) return;
        closed = true;
        cleanup();
        action();
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          finish(() => controller.error(protocolError(message.statusCode)));
          message.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      };
      const onEnd = (): void => finish(() => controller.close());
      const onError = (): void =>
        finish(() => controller.error(protocolError(message.statusCode)));
      const onAborted = (): void =>
        finish(() => controller.error(protocolError(message.statusCode)));
      const onSignalAbort = (): void => {
        finish(() => controller.error(abortError()));
        message.destroy();
      };
      const timeout = setTimeout(() => {
        finish(() => controller.error(providerError("provider_unavailable", true)));
        message.destroy();
      }, Math.max(0, remainingMs));
      const cleanup = (): void => {
        clearTimeout(timeout);
        message.off("data", onData);
        message.off("end", onEnd);
        message.off("error", onError);
        message.off("aborted", onAborted);
        signal.removeEventListener("abort", onSignalAbort);
      };

      if (signal.aborted) {
        onSignalAbort();
        return;
      }
      message.on("data", onData);
      message.once("end", onEnd);
      message.once("error", onError);
      message.once("aborted", onAborted);
      signal.addEventListener("abort", onSignalAbort, { once: true });
    },
    cancel() {
      message.destroy();
    },
  });
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const response = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) response.append(name, item);
    } else {
      response.append(name, value);
    }
  }
  return response;
}
