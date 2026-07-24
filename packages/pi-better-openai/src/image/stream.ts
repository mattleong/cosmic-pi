import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { sanitizeDiagnosticError, type StreamingHttpError } from "pi-cosmic-core";
import { decodeImageStreamEvent } from "./protocol.ts";
import { extractImageFromEvent } from "./helpers.ts";
import {
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_SSE_EVENT_CHARS,
  OpenAIImageError,
  fail,
  type ExtractedImageResult,
} from "./types.ts";

export const parseImageSse = Effect.fn("OpenAIImage.parseSse")(function* (
  body: Stream.Stream<Uint8Array, StreamingHttpError>,
  mimeType: string,
) {
  const fallbackId = `ig_${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, "0")}`;
  let totalBytes = 0;
  let buffer = "";
  let previousWasCarriageReturn = false;
  let completed: ExtractedImageResult | undefined;
  let providerFailure: OpenAIImageError | undefined;
  let terminated = false;

  const processBlock = Effect.fn("OpenAIImage.processSseBlock")(function* (block: string) {
    if (block.length > MAX_SSE_EVENT_CHARS)
      return yield* fail("stream", "Codex image response event was too large.");
    const data = block
      .split(/\r\n|\n|\r/)
      .filter((line) => !line.startsWith(":"))
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => (line === "data" ? "" : line.slice(5).replace(/^ /, "")))
      .join("\n")
      .trim();
    if (!data) return true;
    if (data === "[DONE]") {
      terminated = true;
      return false;
    }
    const rawEvent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      data,
    ).pipe(Effect.mapError(() => fail("stream", "Codex image response contained malformed JSON.")));
    const event: unknown = yield* decodeImageStreamEvent(rawEvent).pipe(
      Effect.mapError(() => fail("stream", "Codex image response contained a malformed event.")),
    );
    const image = extractImageFromEvent(event, mimeType, fallbackId);
    if (image?.data && image.status === "completed") {
      completed = image;
      return false;
    }
    if (Predicate.isObject(event) && event.type === "response.failed") {
      const response = Predicate.isObject(event.response) ? event.response : undefined;
      const error = Predicate.isObject(response?.error) ? response.error : undefined;
      providerFailure = fail(
        "response",
        sanitizeDiagnosticError(
          typeof error?.message === "string" ? error.message : "Codex image request failed.",
        ),
      );
      return false;
    }
    if (Predicate.isObject(event) && event.type === "error") {
      providerFailure = fail(
        "response",
        `Codex image error: ${sanitizeDiagnosticError(typeof event.message === "string" ? event.message : "Codex image request failed.")}`,
      );
      return false;
    }
    return true;
  });

  const appendNormalized = (chunk: string) => {
    let normalized = "";
    for (const character of chunk) {
      if (character === "\r") {
        normalized += "\n";
        previousWasCarriageReturn = true;
      } else if (character === "\n" && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
      } else {
        normalized += character;
        previousWasCarriageReturn = false;
      }
    }
    buffer += normalized;
  };
  const drainCompleteEvents = Effect.fn("OpenAIImage.drainSseEvents")(function* () {
    while (true) {
      const separator = buffer.indexOf("\n\n");
      if (separator < 0) break;
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (!(yield* processBlock(block))) return false;
    }
    if (buffer.length > MAX_SSE_EVENT_CHARS)
      return yield* fail("stream", "Codex image response event was too large.");
    return true;
  });
  const bounded = body.pipe(
    Stream.mapEffect((bytes) => {
      totalBytes += bytes.byteLength;
      return totalBytes > MAX_IMAGE_RESPONSE_BYTES
        ? Effect.fail(fail("stream", "Codex image response was too large."))
        : Effect.succeed(bytes);
    }),
    Stream.decodeText,
  );
  yield* bounded.pipe(
    Stream.runForEachWhile((chunk) =>
      Effect.gen(function* () {
        appendNormalized(chunk);
        return yield* drainCompleteEvents();
      }),
    ),
    Effect.mapError((error) =>
      error instanceof OpenAIImageError
        ? error
        : fail("stream", "Codex image response stream failed."),
    ),
  );
  if (!completed && !providerFailure && !terminated && buffer.trim()) yield* processBlock(buffer);
  if (completed) return completed;
  if (providerFailure) return yield* providerFailure;
  return yield* fail("stream", "No completed image_generation_call result returned by Codex.");
});
